import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAlterEgoSettings, DEFAULT_SETTINGS } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "alter-ego-config-"));
  dirs.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  return {
    resolve: () => resolveAlterEgoSettings(cwd, agentDir),
    project: (value: unknown) => writeFileSync(join(cwd, ".pi/alter-ego.json"), JSON.stringify(value)),
    global: (value: unknown) => writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify(value)),
    malformed: () => writeFileSync(join(cwd, ".pi/alter-ego.json"), "{bad"),
  };
}

describe("Jev settings", () => {
  it("defaults exclusively to Jev", () => expect(setup().resolve()).toEqual(DEFAULT_SETTINGS));
  it("resolves each field project > global > default", () => {
    const config = setup();
    config.global({ model: "jev-1.12", timeout: 60, quoteConfidence: 0.6 });
    config.project({ timeout: 15, threshold: 0.9 });
    expect(config.resolve()).toEqual({ model: "jev-1.12", timeout: 15, threshold: 0.9, quoteConfidence: 0.6 });
  });
  it("accepts and trims a Jev model ID", () => {
    const config = setup();
    config.project({ model: " jev-latest " });
    expect(config.resolve().model).toBe("jev-latest");
  });
  it("lets a project opt into Jev without modifying an old global model setting", () => {
    const config = setup();
    config.global({ model: "anthropic/claude", timeout: 60 });
    config.project({ model: "jev-latest" });
    expect(config.resolve()).toEqual({ ...DEFAULT_SETTINGS, timeout: 60 });
  });
  it("requires explicit migration of the old model configuration, without fallback", () => {
    const config = setup();
    config.global({ model: "anthropic/claude" });
    expect(config.resolve).toThrow("旧Piモデル設定");
  });
  it.each([
    null, [], "text", { model: "" }, { model: 42 }, { model: "other-model" },
    { timeout: 0 }, { timeout: -1 }, { timeout: 301 }, { timeout: "30" }, { timeout: null },
    { threshold: 0.5 }, { threshold: 1.1 }, { threshold: "0.85" },
    { quoteConfidence: -0.1 }, { quoteConfidence: 1.1 },
    { apiKey: "must-not-be-in-config" }, { endpoint: "https://untrusted.invalid" },
  ])("rejects invalid config %j", (value) => {
    const config = setup();
    config.project(value);
    expect(config.resolve).toThrow();
  });
  it("rejects malformed JSON rather than silently changing providers or policy", () => {
    const config = setup();
    config.malformed();
    expect(config.resolve).toThrow("JSONが不正");
  });
});
