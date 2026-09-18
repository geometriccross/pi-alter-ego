import { andThen, attempt, err, map, ok, traverse, type Result } from "./result.js";

export const JEV_UNAVAILABLE = "Jevとの通信または応答形式に問題があります（未評価）";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JevDescription = string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JevQuestion =
  | {
      readonly type: "noul";
      readonly instructions: JevDescription;
      readonly criteria?: {
        readonly true?: JevDescription;
        readonly false?: JevDescription;
      };
    }
  | {
      readonly type: "choice";
      readonly instructions: JevDescription;
      readonly criteria: Readonly<Record<string, JevDescription>>;
    }
  | {
      readonly type: "score";
      readonly instructions: JevDescription;
      readonly criteria: readonly JevDescription[];
    };

export interface JevRequest {
  readonly state: object | string;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, JevDescription>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

export interface PreparedJevRequest {
  readonly apiKey: string;
  readonly body: string;
}

export function prepareJevRequest(request: JevRequest, apiKey: string | undefined): Result<PreparedJevRequest> {
  const key = apiKey?.trim();
  if (!key) return err("TYPESAFE_API_KEY を設定してください（Jev未評価）");
  return map(attempt(
    () => JSON.stringify({ model: "jev-latest", state: request.state, questions: request.questions }),
    () => JEV_UNAVAILABLE,
  ), (body) => ({ apiKey: key, body }));
}

export function retryDelay(status: number, retryAfter: string | null, attempt: number, now: number): number | null {
  if ((status !== 429 && status !== 529) || attempt >= 2) return null;
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const retryAt = retryAfter === null ? NaN : Date.parse(retryAfter);
  const serverWait = Number.isFinite(seconds) ? seconds * 1000 : retryAt - now;
  // Never retry earlier than requested, or overflow Node's timer range.
  return Math.min(2_147_483_647, Math.max(500 * 2 ** attempt, Number.isFinite(serverWait) ? serverWait : 0));
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

function parseProbabilities(raw: unknown, options: readonly string[]): Result<Record<string, number>> {
  if (!isObject(raw) || Object.keys(raw).length !== options.length) return err(JEV_UNAVAILABLE);
  const entries = traverse(options, (key): Result<readonly [string, number]> => {
    const value = raw[key];
    return isProbability(value) ? ok([key, value]) : err(JEV_UNAVAILABLE);
  });
  return andThen(entries, (entries) => {
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    return Math.abs(total - 1) > 0.001 ? err(JEV_UNAVAILABLE) : ok(Object.fromEntries(entries));
  });
}

function parseLegend(raw: unknown, options: readonly string[]): Result<ScoreAnswer["legend"]> {
  if (!isObject(raw) || Object.keys(raw).length !== options.length) return err(JEV_UNAVAILABLE);
  return map(traverse(options, (key): Result<readonly [string, JevDescription]> => {
    const description = raw[key];
    return description === null || typeof description === "string" || typeof description === "object"
      ? ok([key, description as JevDescription])
      : err(JEV_UNAVAILABLE);
  }), (entries) => Object.fromEntries(entries));
}

function parseAnswer(raw: unknown, question: JevQuestion): Result<JevResponse["answers"][string]> {
  if (!isObject(raw) || !isObject(question) || raw.type !== question.type) return err(JEV_UNAVAILABLE);
  if (question.type === "noul") {
    return isProbability(raw.noul) ? ok({ type: "noul", noul: raw.noul }) : err(JEV_UNAVAILABLE);
  }
  if (
    (question.type !== "choice" && question.type !== "score") ||
    (question.type === "choice" && !isObject(question.criteria)) ||
    (question.type === "score" && !Array.isArray(question.criteria)) ||
    !isProbability(raw.confidence)
  ) {
    return err(JEV_UNAVAILABLE);
  }

  const options = question.type === "score"
    ? question.criteria.map((_, index) => String(index))
    : Object.keys(question.criteria);
  const confidence = raw.confidence;
  return andThen(parseProbabilities(raw.probabilities, options), (probabilities): Result<JevResponse["answers"][string]> => {
    if (question.type === "choice") {
      const choice = raw.choice;
      return typeof choice === "string" && Object.hasOwn(question.criteria, choice) &&
        probabilities[choice] >= Math.max(...Object.values(probabilities))
        ? ok({ type: "choice", choice, confidence, probabilities })
        : err(JEV_UNAVAILABLE);
    }

    const score = raw.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > options.length - 1) {
      return err(JEV_UNAVAILABLE);
    }
    return map(parseLegend(raw.legend, options), (legend) => ({ type: "score", score, legend, confidence, probabilities }));
  });
}

export function parseJevResponse(payload: unknown, questions: JevRequest["questions"]): Result<JevResponse> {
  if (
    !isObject(payload) || typeof payload.model !== "string" || !/^jev-[\w.-]+$/.test(payload.model) ||
    !isObject(payload.answers) || !isObject(payload.usage) || !isObject(questions) ||
    !isTokenCount(payload.usage.input_tokens) || !isTokenCount(payload.usage.output_tokens)
  ) {
    return err(JEV_UNAVAILABLE);
  }
  const { model, answers } = payload;
  const { input_tokens, output_tokens } = payload.usage;
  return map(traverse(Object.entries(questions), ([id, question]) =>
    map(parseAnswer(answers[id], question), (answer) => [id, answer] as const)), (entries) => ({
    model,
    answers: Object.assign(Object.create(null), Object.fromEntries(entries)),
    usage: { input_tokens, output_tokens },
  }));
}
