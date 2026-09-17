import { setTimeout as delay } from "node:timers/promises";
import { attempt, err, ok, recoverAsync, type Result } from "./result.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 30_000;
const UNAVAILABLE = "Jevとの通信または応答形式に問題があります（未評価）";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JevDescription = string | null | JsonValue[] | { [key: string]: JsonValue };

export type JevQuestion =
  | {
      type: "noul";
      instructions: JevDescription;
      criteria?: {
        true?: JevDescription;
        false?: JevDescription;
      };
    }
  | {
      type: "choice";
      instructions: JevDescription;
      criteria: Record<string, JevDescription>;
    }
  | {
      type: "score";
      instructions: JevDescription;
      criteria: JevDescription[];
    };

export interface JevRequest {
  state: object | string;
  questions: Record<string, JevQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, JevDescription>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface JevOptions {
  apiKey: string | undefined;
  signal?: AbortSignal;
}

export async function askJev(
  request: JevRequest,
  options: JevOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Result<JevResponse>> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return err("TYPESAFE_API_KEY を設定してください（Jev未評価）");
  }

  const body = attempt(
    () => JSON.stringify({ model: "jev-latest", state: request.state, questions: request.questions }),
    () => UNAVAILABLE,
  );
  if (!body.ok) {
    return body;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    controller.abort();
  }

  let timedOut = false;
  const abortMessage = () => timedOut
    ? `Jev タイムアウト (${TIMEOUT_MS / 1000}s、未評価)`
    : "Jev評価をキャンセルしました";
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  return recoverAsync(async () => {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) {
        return err(abortMessage());
      }
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: body.value,
        signal: controller.signal,
        redirect: "error",
      });

      if ((response.status === 429 || response.status === 529) && attempt < 2) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAt = retryAfter === null ? NaN : Date.parse(retryAfter);
        const serverWait = Number.isFinite(seconds) ? seconds * 1000 : retryAt - Date.now();

        // All attempts and backoff share the same deadline; never retry earlier than requested.
        const wait = Math.min(
          2_147_483_647,
          Math.max(500 * 2 ** attempt, Number.isFinite(serverWait) ? serverWait : 0),
        );
        await delay(wait, undefined, { signal: controller.signal });
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        // Service bodies may echo state or credentials. Do not expose them in notifications.
        return err(controller.signal.aborted ? abortMessage() : `Jev API: HTTP ${response.status}（未評価）`);
      }

      const payload: unknown = await response.json();
      return controller.signal.aborted
        ? err(abortMessage())
        : parseResponse(payload, request.questions);
    }
  }, () => controller.signal.aborted ? abortMessage() : UNAVAILABLE).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseProbabilities(
  raw: unknown,
  options: readonly string[],
): Result<Record<string, number>> {
  if (!isObject(raw) || Object.keys(raw).length !== options.length) {
    return err(UNAVAILABLE);
  }

  const entries: [string, number][] = [];
  for (const key of options) {
    const value = raw[key];
    if (!isProbability(value)) {
      return err(UNAVAILABLE);
    }
    entries.push([key, value]);
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Math.abs(total - 1) > 0.001 ? err(UNAVAILABLE) : ok(Object.fromEntries(entries));
}

function parseLegend(raw: unknown, options: readonly string[]): Result<ScoreAnswer["legend"]> {
  if (!isObject(raw) || Object.keys(raw).length !== options.length) {
    return err(UNAVAILABLE);
  }

  const entries: [string, JevDescription][] = [];
  for (const key of options) {
    const description = raw[key];
    if (description !== null && typeof description !== "string" && typeof description !== "object") {
      return err(UNAVAILABLE);
    }
    entries.push([key, description as JevDescription]);
  }
  return ok(Object.fromEntries(entries));
}

function parseAnswer(raw: unknown, question: JevQuestion): Result<JevResponse["answers"][string]> {
  if (!isObject(raw) || !isObject(question) || raw.type !== question.type) {
    return err(UNAVAILABLE);
  }
  if (question.type === "noul") {
    return isProbability(raw.noul) ? ok({ type: "noul", noul: raw.noul }) : err(UNAVAILABLE);
  }
  if (
    (question.type !== "choice" && question.type !== "score") ||
    (question.type === "choice" && !isObject(question.criteria)) ||
    (question.type === "score" && !Array.isArray(question.criteria)) ||
    !isProbability(raw.confidence)
  ) {
    return err(UNAVAILABLE);
  }

  const options = question.type === "score"
    ? question.criteria.map((_, index) => String(index))
    : Object.keys(question.criteria);
  const distribution = parseProbabilities(raw.probabilities, options);
  if (!distribution.ok) {
    return distribution;
  }
  const probabilities = distribution.value;
  const confidence = raw.confidence;

  if (question.type === "choice") {
    if (
      typeof raw.choice !== "string" ||
      !Object.hasOwn(question.criteria, raw.choice) ||
      probabilities[raw.choice] < Math.max(...Object.values(probabilities))
    ) {
      return err(UNAVAILABLE);
    }
    return ok({ type: "choice", choice: raw.choice, confidence, probabilities });
  }

  if (
    typeof raw.score !== "number" || !Number.isFinite(raw.score) ||
    raw.score < 0 || raw.score > options.length - 1
  ) {
    return err(UNAVAILABLE);
  }
  const legend = parseLegend(raw.legend, options);
  return legend.ok
    ? ok({ type: "score", score: raw.score, legend: legend.value, confidence, probabilities })
    : legend;
}

function parseResponse(payload: unknown, questions: JevRequest["questions"]): Result<JevResponse> {
  if (
    !isObject(payload) || typeof payload.model !== "string" || !/^jev-[\w.-]+$/.test(payload.model) ||
    !isObject(payload.answers) || !isObject(payload.usage) || !isObject(questions) ||
    !isTokenCount(payload.usage.input_tokens) || !isTokenCount(payload.usage.output_tokens)
  ) {
    return err(UNAVAILABLE);
  }

  const answers: JevResponse["answers"] = Object.create(null);
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseAnswer(payload.answers[id], question);
    if (!answer.ok) {
      return answer;
    }
    answers[id] = answer.value;
  }
  return ok({
    model: payload.model,
    answers,
    usage: {
      input_tokens: payload.usage.input_tokens,
      output_tokens: payload.usage.output_tokens,
    },
  });
}
