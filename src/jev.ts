import { setTimeout as delay } from "node:timers/promises";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// Application budget, not a claim about the service's context window.
export const MAX_REQUEST_BYTES = 100_000;

type Instructions = string | Record<string, string | string[]>;
export type JevQuestion =
  | { type: "noul"; instructions: Instructions; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: Instructions; criteria: Record<string, string> };

export interface JevRequest {
  model: string;
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

export interface JevResponse {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function encodeJevRequest(request: JevRequest): string {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw new Error(`Jev入力が ${MAX_REQUEST_BYTES} bytes を超えています（切り詰めず未評価）`);
  }
  return body;
}

export async function askJev(
  request: JevRequest,
  options: JevOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<JevResponse> {
  if (!options.apiKey?.trim()) throw new Error("TYPESAFE_API_KEY を設定してください（Jev未評価）");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error("Jev timeoutMs が不正です");
  }
  const body = encodeJevRequest(request);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey.trim()}`, "Content-Type": "application/json" },
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
        const wait = Math.min(2_147_483_647, Math.max(500 * 2 ** attempt, Number.isFinite(serverWait) ? serverWait : 0));
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
      if (timedOut) throw new Error(`Jev タイムアウト (${options.timeoutMs / 1000}s、未評価)`);
      throw new Error("Jev評価をキャンセルしました", { cause: error });
    }
    if (error instanceof JevServiceError) throw error;
    throw new Error("Jevとの通信または応答形式に問題があります（未評価）");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

class JevServiceError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid probability");
  return value;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid usage");
  return value;
}

function parseResponse(payload: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const root = object(payload);
  if (typeof root.model !== "string" || !/^jev-[\w.-]+$/.test(root.model)) throw new Error("Invalid model");
  const rawAnswers = object(root.answers);
  const answers: JevResponse["answers"] = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = object(rawAnswers[id]);
    if (answer.type !== question.type) throw new Error("Wrong answer type");
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: probability(answer.noul) };
      continue;
    }
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) throw new Error("Unknown choice");
    const rawProbabilities = object(answer.probabilities);
    const options = Object.keys(question.criteria);
    if (Object.keys(rawProbabilities).length !== options.length) throw new Error("Incomplete distribution");
    const probabilities = Object.fromEntries(options.map((key) => [key, probability(rawProbabilities[key])]));
    const values = Object.values(probabilities);
    if (Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > 0.001) throw new Error("Invalid distribution");
    if (probabilities[answer.choice] < Math.max(...values)) throw new Error("Choice is not the most probable option");
    answers[id] = { type: "choice", choice: answer.choice, confidence: probability(answer.confidence), probabilities };
  }
  const usage = object(root.usage);
  return {
    model: root.model,
    answers,
    usage: { input_tokens: tokenCount(usage.input_tokens), output_tokens: tokenCount(usage.output_tokens) },
  };
}
