import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JevRequest } from "./jev.js";

export function loadQuestions(
  projectCwd: string,
  agentDir: string,
): JevRequest["questions"] {
  const paths = [
    join(projectCwd, ".pi", "alter-ego.json"),
    join(agentDir, "alter-ego.json"),
  ];

  for (const path of paths) {
    let text: string;

    try {
      text = readFileSync(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new Error(`${path}: 質問設定を読み取れません（未評価）`);
    }

    let config: { questions?: JevRequest["questions"] };

    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(`${path}: JSONが不正です（未評価）`);
    }

    return config.questions ?? {};
  }

  return {};
}
