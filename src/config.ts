import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JevRequest } from "./jev.js";

export interface AlterEgoConfig {
  questions: JevRequest["questions"];
  apiKey: string | undefined;
}

export function loadConfig(projectCwd: string): AlterEgoConfig {
  const paths = [
    join(projectCwd, ".pi", "alter-ego.json"),
    join(getAgentDir(), "alter-ego.json"),
  ];
  let questions: JevRequest["questions"] = {};

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

    questions = config.questions ?? {};
    break;
  }

  return { questions, apiKey: process.env.TYPESAFE_API_KEY };
}
