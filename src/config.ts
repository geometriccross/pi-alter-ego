import * as fs from "node:fs";
import * as path from "node:path";

// ponytail: .pi is pi's project config dir name (CONFIG_DIR_NAME not exported from pi-coding-agent)
const CONFIG_DIR = ".pi";
const CONFIG_FILE = "alter-ego.json";

export interface AlterEgoSettings {
  model?: string;
  timeout?: number; // seconds, > 0
}

export const DEFAULT_TIMEOUT_SECONDS = 90;

function readModel(configPath: string): string | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "model" in parsed &&
      typeof (parsed as AlterEgoSettings).model === "string" &&
      (parsed as AlterEgoSettings).model!.trim().length > 0
    ) {
      return (parsed as AlterEgoSettings).model!.trim();
    }
  } catch {
    // Missing file, bad JSON, or wrong shape → silently skip.
  }
  return null;
}

function readTimeout(configPath: string): number | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "timeout" in parsed &&
      typeof (parsed as AlterEgoSettings).timeout === "number" &&
      Number.isFinite((parsed as AlterEgoSettings).timeout!) &&
      (parsed as AlterEgoSettings).timeout! > 0
    ) {
      return (parsed as AlterEgoSettings).timeout!;
    }
  } catch {
    // Missing file, bad JSON, or wrong shape → silently skip.
  }
  return null;
}

export function resolveAlterEgoTimeout(
  projectCwd: string,
  agentDir: string,
): number {
  const timeout = readTimeout(path.join(projectCwd, CONFIG_DIR, CONFIG_FILE));
  if (timeout !== null) return timeout;

  const globalTimeout = readTimeout(path.join(agentDir, CONFIG_FILE));
  if (globalTimeout !== null) return globalTimeout;

  return DEFAULT_TIMEOUT_SECONDS;
}

export function resolveAlterEgoModel(
  projectCwd: string,
  agentDir: string,
  fallback: string,
): string {
  const model = readModel(path.join(projectCwd, CONFIG_DIR, CONFIG_FILE));
  if (model !== null) return model;

  const globalModel = readModel(path.join(agentDir, CONFIG_FILE));
  if (globalModel !== null) return globalModel;

  return fallback;
}
