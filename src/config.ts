import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevQuestion, JevRequest } from "./jev.js";
import { QUESTION_HOOKS, type QuestionHook } from "./hooks.js";
import { andThen, attempt, err, ok, type Result } from "./result.js";

export type ConfiguredQuestion = JevQuestion & { on?: QuestionHook | QuestionHook[] };

export interface AlterEgoConfig {
  questions: Record<string, ConfiguredQuestion>;
  apiKey: string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateQuestions(value: unknown): Result<AlterEgoConfig["questions"]> {
  if (!isObject(value)) return err("questions はJSONオブジェクトで指定してください（未評価）");
  for (const [id, question] of Object.entries(value)) {
    if (!isObject(question)) return err(`questions.${id} はJSONオブジェクトで指定してください（未評価）`);
    if (!Object.hasOwn(question, "on")) continue;
    const hooks = Array.isArray(question.on) ? question.on : [question.on];
    if (hooks.length === 0 || hooks.some((hook) => !(QUESTION_HOOKS as readonly unknown[]).includes(hook))) {
      return err(`questions.${id}.on は対応するPiフック名、または空でない配列で指定してください（未評価）。対応: ${QUESTION_HOOKS.join(", ")}`);
    }
  }
  // TypeSafe owns validation of the question primitives; only routing is local.
  return ok(value as AlterEgoConfig["questions"]);
}

export function questionsForHook(questions: AlterEgoConfig["questions"], hook: QuestionHook): JevRequest["questions"] {
  return Object.fromEntries(Object.entries(questions).flatMap(([id, { on = "agent_end", ...question }]) => {
    const hooks = Array.isArray(on) ? on : [on];
    return hooks.includes(hook) ? [[id, question]] : [];
  }));
}

export function loadConfig(projectCwd: string): Result<AlterEgoConfig> {
  const paths = [
    join(projectCwd, ".pi", "alter-ego.json"),
    join(getAgentDir(), "alter-ego.json"),
  ];
  for (const path of paths) {
    const text = attempt(() => readFileSync(path, "utf-8"), (error) => error);
    if (!text.ok) {
      if ((text.error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        continue;
      }
      return err(`${path}: 質問設定を読み取れません（未評価）`);
    }

    const parsed = attempt(
      () => JSON.parse(text.value) as unknown,
      () => `${path}: JSONが不正です（未評価）`,
    );
    return andThen(parsed, (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return err(`${path}: 設定はJSONオブジェクトで指定してください（未評価）`);
      }
      const config = value as { questions?: unknown };
      const questions = validateQuestions(config.questions ?? {});
      return questions.ok
        ? ok({ questions: questions.value, apiKey: process.env.TYPESAFE_API_KEY })
        : err(`${path}: ${questions.error}`);
    });
  }

  return ok({ questions: {}, apiKey: process.env.TYPESAFE_API_KEY });
}
