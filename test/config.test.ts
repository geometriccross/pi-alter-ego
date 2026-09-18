import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, questionsForHook, type AlterEgoConfig } from "../src/config.js";
import { freeze } from "./helpers.js";

const sampleQuestions = {
  custom_check: { type: "noul", instructions: "A custom question" },
  category: {
    type: "choice", instructions: { question: "Which category?" },
    criteria: { a: null, b: ["Category B"] },
  },
  level: {
    type: "score", instructions: ["Rate the level"],
    criteria: ["Low", { description: "High" }],
  },
};
const dirs: string[] = [];

beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "alter-ego-config-"));
  dirs.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const projectPath = join(cwd, ".pi", "alter-ego.json");
  const globalPath = join(agentDir, "alter-ego.json");
  return {
    load: () => loadConfig(cwd), projectPath, globalPath,
    project: (value: unknown) => writeFileSync(projectPath, JSON.stringify(value)),
    global: (value: unknown) => writeFileSync(globalPath, JSON.stringify(value)),
  };
}

describe("pure configuration", () => {
  it("parses supplied text using explicit credentials, not the filesystem or environment", () => {
    const text = JSON.stringify({ questions: sampleQuestions });
    const expected = { questions: sampleQuestions, apiKey: "explicit-key" };
    expect(parseConfig(text, "explicit-key")).toEqual(expected);
    vi.stubEnv("TYPESAFE_API_KEY", "ambient-key");
    expect(parseConfig(text, "explicit-key")).toEqual(expected);
  });

  it("routes frozen questions without removing their routing metadata in place", () => {
    const questions = freeze<AlterEgoConfig["questions"]>({
      check: { type: "noul", instructions: "Check", on: ["input", "agent_end"] },
    });
    const routed = questionsForHook(questions, "input");
    expect(routed).toEqual({ check: { type: "noul", instructions: "Check" } });
    expect(questionsForHook(questions, "agent_end")).toEqual(routed);
    expect(questions.check.on).toEqual(["input", "agent_end"]);
  });
});

describe("Alter Ego configuration", () => {
  it("has no built-in questions or credentials", () => {
    expect(setup().load()).toEqual({ questions: {}, apiKey: undefined });
  });

  it("uses a project's questions as a whole, without adding global questions or defaults", () => {
    const config = setup();
    config.global({ questions: sampleQuestions });
    expect(config.load()).toEqual({ questions: sampleQuestions, apiKey: undefined });
    const questions = { custom_check: sampleQuestions.custom_check };
    config.project({ questions });
    expect(config.load()).toEqual({ questions, apiKey: undefined });
    config.project({ questions: {} });
    expect(config.load()).toEqual({ questions: {}, apiKey: undefined });
  });

  it("passes arbitrary question content through without local schema validation", () => {
    const config = setup();
    const questions = {
      ...sampleQuestions,
      language: { type: "noul", instructions: null },
      anything: { type: "future-type", arbitrary: { field: [1, true, null] } },
    };
    config.project({ questions });
    expect(config.load()).toEqual({ questions, apiKey: undefined });
  });

  it("routes and batches by Pi hook names, defaults to agent_end, and strips only routing metadata", () => {
    const config = setup();
    const questions: AlterEgoConfig["questions"] = {
      legacy: { type: "noul", instructions: "Final answer?" },
      before_tool: { type: "noul", instructions: "Safe tool call?", on: "tool_call" },
      multiple: { ...sampleQuestions.category, type: "choice", on: ["tool_call", "agent_end", "tool_call"] },
      ...JSON.parse('{"__proto__":{"type":"noul","instructions":{"on":"This is question content"},"on":"tool_call"}}'),
    };
    config.project({ questions });
    const loaded = config.load();
    expect(loaded).toEqual({ questions, apiKey: undefined });
    expect(questionsForHook(loaded.questions, "tool_call")).toEqual({
      before_tool: { type: "noul", instructions: "Safe tool call?" },
      multiple: sampleQuestions.category,
      ...JSON.parse('{"__proto__":{"type":"noul","instructions":{"on":"This is question content"}}}'),
    });
    expect(questionsForHook(loaded.questions, "agent_end")).toEqual({ legacy: questions.legacy, multiple: sampleQuestions.category });
    expect(questionsForHook(loaded.questions, "input")).toEqual({});
    expect(loaded.questions).toEqual(questions);
  });

  it("does not reroute an unknown hook to agent_end", () => {
    const config = setup();
    config.project({ questions: { check: { type: "noul", instructions: "Check", on: "unknown_hook" } } });
    expect(questionsForHook(config.load().questions, "agent_end")).toEqual({});
  });

  it("reloads file and environment changes and ignores unrelated settings", () => {
    const config = setup();
    config.project({ model: "old-model", timeout: 0, apiKey: "ignored-file-key" });
    expect(config.load()).toEqual({ questions: {}, apiKey: undefined });
    vi.stubEnv("TYPESAFE_API_KEY", "first-key");
    config.project({ model: "other", state: "ignored", questions: sampleQuestions });
    expect(config.load()).toEqual({ questions: sampleQuestions, apiKey: "first-key" });
    vi.stubEnv("TYPESAFE_API_KEY", "updated-key");
    config.project({ questions: {} });
    expect(config.load()).toEqual({ questions: {}, apiKey: "updated-key" });
  });

  it("does not read an overridden global file", () => {
    const config = setup();
    writeFileSync(config.globalPath, "{bad JSON");
    config.project({ questions: sampleQuestions });
    expect(config.load()).toEqual({ questions: sampleQuestions, apiKey: undefined });
  });

  it("propagates native JSON and read errors rather than returning a Result or another configuration", () => {
    const config = setup();
    config.global({ questions: sampleQuestions });
    writeFileSync(config.projectPath, "{invalid JSON");
    expect(config.load).toThrow(SyntaxError);
    writeFileSync(config.projectPath, "");
    expect(config.load).toThrow(SyntaxError);
    rmSync(config.projectPath);
    mkdirSync(config.projectPath);
    expect(config.load).toThrow();
  });
});
