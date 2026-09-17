import { setTimeout as delay } from "node:timers/promises";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 30_000;

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
): Promise<JevResponse> {
  if (!options.apiKey?.trim()) {
    throw new Error("TYPESAFE_API_KEY を設定してください（Jev未評価）");
  }

  const body = JSON.stringify({
    model: "jev-latest",
    state: request.state,
    questions: request.questions,
  });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    controller.abort();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body,
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
        throw new JevServiceError(`Jev API: HTTP ${response.status}（未評価）`);
      }

      const payload: unknown = await response.json();
      controller.signal.throwIfAborted();
      return parseResponse(payload, request.questions);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        throw new Error(`Jev タイムアウト (${TIMEOUT_MS / 1000}s、未評価)`);
      }
      throw new Error("Jev評価をキャンセルしました", { cause: error });
    }
    if (error instanceof JevServiceError) {
      throw error;
    }
    throw new Error("Jevとの通信または応答形式に問題があります（未評価）");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

class JevServiceError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid object");
  }
  return value as Record<string, unknown>;
}

function probability(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("Invalid probability");
  }
  return value;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid usage");
  }
  return value;
}

function parseResponse(
  payload: unknown,
  questions: Record<string, JevQuestion>,
): JevResponse {
  const root = object(payload);
  if (typeof root.model !== "string" || !/^jev-[\w.-]+$/.test(root.model)) {
    throw new Error("Invalid model");
  }

  const rawAnswers = object(root.answers);
  const answers: JevResponse["answers"] = Object.create(null);

  for (const [id, question] of Object.entries(questions)) {
    const answer = object(rawAnswers[id]);
    if (answer.type !== question.type) {
      throw new Error("Wrong answer type");
    }

    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: probability(answer.noul) };
      continue;
    }

    const rawProbabilities = object(answer.probabilities);
    const options =
      question.type === "score"
        ? question.criteria.map((_, index) => String(index))
        : Object.keys(question.criteria);

    if (Object.keys(rawProbabilities).length !== options.length) {
      throw new Error("Incomplete distribution");
    }

    const probabilities = Object.fromEntries(
      options.map((key) => [key, probability(rawProbabilities[key])]),
    );
    const values = Object.values(probabilities);
    const totalProbability = values.reduce((sum, p) => sum + p, 0);

    if (Math.abs(totalProbability - 1) > 0.001) {
      throw new Error("Invalid distribution");
    }

    const confidence = probability(answer.confidence);

    if (question.type === "choice") {
      if (
        typeof answer.choice !== "string" ||
        !Object.hasOwn(question.criteria, answer.choice)
      ) {
        throw new Error("Unknown choice");
      }
      if (probabilities[answer.choice] < Math.max(...values)) {
        throw new Error("Choice is not the most probable option");
      }

      answers[id] = {
        type: "choice",
        choice: answer.choice,
        confidence,
        probabilities,
      };
    } else {
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > options.length - 1
      ) {
        throw new Error("Invalid score");
      }

      const rawLegend = object(answer.legend);
      if (Object.keys(rawLegend).length !== options.length) {
        throw new Error("Incomplete legend");
      }

      const legend = Object.fromEntries(
        options.map((key) => {
          const description = rawLegend[key];
          if (
            description !== null &&
            typeof description !== "string" &&
            typeof description !== "object"
          ) {
            throw new Error("Invalid legend");
          }
          return [key, description as JevDescription];
        }),
      );

      answers[id] = {
        type: "score",
        score: answer.score,
        legend,
        confidence,
        probabilities,
      };
    }
  }

  const usage = object(root.usage);
  return {
    model: root.model,
    answers,
    usage: {
      input_tokens: tokenCount(usage.input_tokens),
      output_tokens: tokenCount(usage.output_tokens),
    },
  };
}
