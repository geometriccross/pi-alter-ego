import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseConfig, type AlterEgoConfig } from "./config-schema.js";
import { andThen, attempt, err, ok, type Result } from "./result.js";

export { parseConfig, questionsForHook, type AlterEgoConfig, type ConfiguredQuestion } from "./config-schema.js";

function readOptionalFile(path: string): Result<string | null> {
  const text = attempt(() => readFileSync(path, "utf-8"), (error) => error);
  if (text.ok) return text;
  return (text.error as NodeJS.ErrnoException | null)?.code === "ENOENT"
    ? ok(null)
    : err(`${path}: 質問設定を読み取れません（未評価）`);
}

function loadFirstConfig(paths: readonly string[], apiKey: string | undefined): Result<AlterEgoConfig> {
  const [path, ...remaining] = paths;
  if (path === undefined) return ok({ questions: {}, apiKey });
  return andThen(readOptionalFile(path), (text) => text === null
    ? loadFirstConfig(remaining, apiKey)
    : parseConfig(text, path, apiKey));
}

export function loadConfig(projectCwd: string): Result<AlterEgoConfig> {
  return loadFirstConfig([
    join(projectCwd, ".pi", "alter-ego.json"),
    join(getAgentDir(), "alter-ego.json"),
  ], process.env.TYPESAFE_API_KEY);
}
