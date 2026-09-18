import type { JevQuestion, JevRequest } from "./jev.js";
import { QUESTION_HOOKS, type QuestionHook } from "./hooks.js";
import { andThen, attempt, err, map, mapError, ok, traverse, type Result } from "./result.js";

export type ConfiguredQuestion = JevQuestion & { readonly on?: QuestionHook | readonly QuestionHook[] };

export interface AlterEgoConfig {
  readonly questions: Readonly<Record<string, ConfiguredQuestion>>;
  readonly apiKey: string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateQuestion([id, question]: [string, unknown]): Result<void> {
  if (!isObject(question)) return err(`questions.${id} はJSONオブジェクトで指定してください（未評価）`);
  if (!Object.hasOwn(question, "on")) return ok(undefined);
  const hooks = Array.isArray(question.on) ? question.on : [question.on];
  return hooks.length > 0 && hooks.every((hook) => (QUESTION_HOOKS as readonly unknown[]).includes(hook))
    ? ok(undefined)
    : err(`questions.${id}.on は対応するPiフック名、または空でない配列で指定してください（未評価）。対応: ${QUESTION_HOOKS.join(", ")}`);
}

function validateQuestions(value: unknown): Result<AlterEgoConfig["questions"]> {
  if (!isObject(value)) return err("questions はJSONオブジェクトで指定してください（未評価）");
  // TypeSafe owns validation of the question primitives; only routing is local.
  return map(traverse(Object.entries(value), validateQuestion), () => value as AlterEgoConfig["questions"]);
}

export function parseConfig(text: string, path: string, apiKey: string | undefined): Result<AlterEgoConfig> {
  const parsed = attempt(() => JSON.parse(text) as unknown, () => "JSONが不正です（未評価）");
  const questions = andThen(parsed, (value) => isObject(value)
    ? validateQuestions(value.questions ?? {})
    : err("設定はJSONオブジェクトで指定してください（未評価）"));
  return map(mapError(questions, (error) => `${path}: ${error}`), (questions) => ({ questions, apiKey }));
}

export function questionsForHook(questions: AlterEgoConfig["questions"], hook: QuestionHook): JevRequest["questions"] {
  return Object.fromEntries(Object.entries(questions).flatMap(([id, { on = "agent_end", ...question }]) => {
    const hooks = typeof on === "string" ? [on] : on;
    return hooks.includes(hook) ? [[id, question]] : [];
  }));
}
