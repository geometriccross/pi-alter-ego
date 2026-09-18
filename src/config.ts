import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevQuestion, JevRequest, QuestionHook } from "./evaluation.js";

export type ConfiguredQuestion = JevQuestion & { readonly on?: QuestionHook | readonly QuestionHook[] };

export interface AlterEgoConfig {
  readonly questions: Readonly<Record<string, ConfiguredQuestion>>;
  readonly apiKey: string | undefined;
}

export function parseConfig(text: string, apiKey: string | undefined): AlterEgoConfig {
  const config = JSON.parse(text) as { questions?: AlterEgoConfig["questions"] };
  return { questions: config.questions ?? {}, apiKey };
}

export function questionsForHook(questions: AlterEgoConfig["questions"], hook: QuestionHook): JevRequest["questions"] {
  return Object.fromEntries(Object.entries(questions).flatMap(([id, { on = "agent_end", ...question }]) => {
    const hooks = typeof on === "string" ? [on] : on;
    return hooks.includes(hook) ? [[id, question]] : [];
  }));
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function loadConfig(projectCwd: string): AlterEgoConfig {
  const text = readOptionalFile(join(projectCwd, ".pi", "alter-ego.json"))
    ?? readOptionalFile(join(getAgentDir(), "alter-ego.json"))
    ?? "{}";
  return parseConfig(text, process.env.TYPESAFE_API_KEY);
}
