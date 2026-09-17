import * as fs from "node:fs";
import * as path from "node:path";

export interface AlterEgoSettings {
  model: string;
  timeout: number;
  threshold: number;
  quoteConfidence: number;
}

export const DEFAULT_SETTINGS: Readonly<AlterEgoSettings> = {
  model: "jev-latest",
  timeout: 30,
  threshold: 0.85,
  quoteConfidence: 0.5,
};

export function resolveAlterEgoSettings(projectCwd: string, agentDir: string): AlterEgoSettings {
  const globalPath = path.join(agentDir, "alter-ego.json");
  const projectPath = path.join(projectCwd, ".pi", "alter-ego.json");
  const global = readSettings(globalPath);
  const project = readSettings(projectPath);
  const value = { ...DEFAULT_SETTINGS, ...global, ...project };
  const origin = (key: string) => Object.hasOwn(project, key) ? projectPath : globalPath;
  // Validate effective values: a project Jev setting can override an old global Pi model.
  if (typeof value.model !== "string" || !/^jev-[\w.-]+$/.test(value.model.trim())) {
    throw new Error(`${origin("model")}: model は Jev のモデルIDに変更してください（例: jev-latest）。旧Piモデル設定は使用できません`);
  }
  if (!validNumber(value.timeout) || value.timeout <= 0 || value.timeout > 300) {
    throw new Error(`${origin("timeout")}: timeout は 0 より大きく 300 以下の秒数です`);
  }
  if (!validNumber(value.threshold) || value.threshold <= 0.5 || value.threshold > 1) {
    throw new Error(`${origin("threshold")}: threshold は 0.5 より大きく 1 以下です`);
  }
  if (!validNumber(value.quoteConfidence) || value.quoteConfidence < 0 || value.quoteConfidence > 1) {
    throw new Error(`${origin("quoteConfidence")}: quoteConfidence は 0〜1 です`);
  }
  return { model: value.model.trim(), timeout: value.timeout, threshold: value.threshold, quoteConfidence: value.quoteConfidence };
}

function readSettings(configPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${configPath}: 設定を読み取れません`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${configPath}: JSONが不正です`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${configPath}: オブジェクトが必要です`);
  const value = parsed as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`${configPath}: 未対応の設定項目（model, timeout, threshold, quoteConfidence のみ）`);
  }
  return value;
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
