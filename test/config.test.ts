import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAlterEgoModel, resolveAlterEgoTimeout, DEFAULT_TIMEOUT_SECONDS } from "../src/config.ts";

describe("resolveAlterEgoModel", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function tmpdir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-alter-ego-test-"));
    dirs.push(d);
    return d;
  }

  function writeConfig(base: string, subdir: string | null, content: unknown): void {
    const target = subdir ? path.join(base, subdir) : base;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "alter-ego.json"), JSON.stringify(content), "utf-8");
  }

  it("returns fallback when no config file exists", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("fb/prov");
  });

  it("uses project config when present and valid", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "anthropic/claude" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("anthropic/claude");
  });

  it("trims whitespace from project model value", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "  openai/gpt-5  " });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("openai/gpt-5");
  });

  it("falls through to global when project config has no model key", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { other: true });
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("global/model");
  });

  it("falls through to global when project model is empty string", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "" });
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("global/model");
  });

  it("falls through to global when project model is whitespace only", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "   " });
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("global/model");
  });

  it("falls through to global when project model is non-string", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: 42 });
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("global/model");
  });

  it("falls through to fallback when project JSON is malformed", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "alter-ego.json"), "{bad json", "utf-8");
    // global also missing
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("fb/prov");
  });

  it("uses global config when project config absent but global present", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("global/model");
  });

  it("falls through to fallback when global model is empty", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(agentDir, null, { model: "" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("fb/prov");
  });

  it("does not read global when project config is valid (early return)", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "proj/model" });
    writeConfig(agentDir, null, { model: "global/model" });
    expect(resolveAlterEgoModel(cwd, agentDir, "fb/prov")).toBe("proj/model");
  });
});

describe("resolveAlterEgoTimeout", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function tmpdir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-alter-ego-test-"));
    dirs.push(d);
    return d;
  }

  function writeConfig(base: string, subdir: string | null, content: unknown): void {
    const target = subdir ? path.join(base, subdir) : base;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "alter-ego.json"), JSON.stringify(content), "utf-8");
  }

  it("returns default 90 when no config file exists", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  it("uses project config timeout when present and valid", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: 120 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(120);
  });

  it("falls through to global when project config has no timeout key", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { model: "some/model" });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("falls through to default when project timeout is zero", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: 0 });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("falls through to default when project timeout is negative", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: -5 });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("falls through to default when project timeout is NaN", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: NaN });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("falls through to default when project timeout is Infinity", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: Infinity });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("falls through to default when project timeout is a string", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: "120" });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(60);
  });

  it("project timeout overrides global", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    writeConfig(cwd, ".pi", { timeout: 180 });
    writeConfig(agentDir, null, { timeout: 60 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(180);
  });

  it("handles malformed project JSON and falls to global", () => {
    const cwd = tmpdir();
    const agentDir = tmpdir();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "alter-ego.json"), "{bad json", "utf-8");
    writeConfig(agentDir, null, { timeout: 30 });
    expect(resolveAlterEgoTimeout(cwd, agentDir)).toBe(30);
  });
});
