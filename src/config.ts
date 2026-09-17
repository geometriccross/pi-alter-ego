import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevRequest } from "./jev.js";
import { andThen, attempt, err, ok, type Result } from "./result.js";

export interface AlterEgoConfig {
  questions: JevRequest["questions"];
  apiKey: string | undefined;
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
      const config = value as { questions?: JevRequest["questions"] };
      return ok({ questions: config.questions ?? {}, apiKey: process.env.TYPESAFE_API_KEY });
    });
  }

  return ok({ questions: {}, apiKey: process.env.TYPESAFE_API_KEY });
}
