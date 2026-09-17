import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQuestions } from "../src/questions.js";

const sampleQuestions = {
  custom_check: { type: "noul", instructions: "A custom question" },
  category: {
    type: "choice",
    instructions: { question: "Which category?" },
    criteria: { a: null, b: ["Category B"] },
  },
  level: {
    type: "score",
    instructions: ["Rate the level"],
    criteria: ["Low", { description: "High" }],
  },
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "alter-ego-questions-"));
  dirs.push(root);

  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);

  const projectPath = join(cwd, ".pi", "alter-ego.json");
  const globalPath = join(agentDir, "alter-ego.json");

  return {
    load: () => loadQuestions(cwd, agentDir),
    projectPath,
    globalPath,
    project: (value: unknown) => writeFileSync(projectPath, JSON.stringify(value)),
    global: (value: unknown) => writeFileSync(globalPath, JSON.stringify(value)),
  };
}

describe("TypeSafe questions from local configuration", () => {
  it("has no built-in questions", () => {
    expect(setup().load()).toEqual({});
  });

  it("uses a project's questions as a whole, without adding global questions or defaults", () => {
    const config = setup();
    config.global({ questions: sampleQuestions });
    expect(config.load()).toEqual(sampleQuestions);
    const questions = {
      custom_check: { type: "noul", instructions: "A custom question" },
    };
    config.project({ questions });
    expect(config.load()).toEqual(questions);
    config.project({ questions: {} });
    expect(config.load()).toEqual({});
  });

  it("passes arbitrary IDs, all primitive types, and structured JSON through unchanged", () => {
    const config = setup();
    const questions = {
      ...sampleQuestions,
      language: { type: "noul", instructions: null },
      custom_source: {
        type: "choice",
        instructions: "Pick",
        criteria: { first: null, second: ["Option two"] },
      },
    };
    config.project({ questions });
    expect(config.load()).toEqual(questions);
  });

  it("leaves question validation to TypeSafe rather than imposing an application schema", () => {
    const config = setup();
    const questions = {
      anything: {
        type: "future-type",
        arbitrary: { field: [1, true, null] },
      },
    };
    config.project({ questions });
    expect(config.load()).toEqual(questions);
  });

  it("reloads changes and ignores unrelated settings", () => {
    const config = setup();
    config.project({ model: "old-model", timeout: 0 });
    expect(config.load()).toEqual({});
    config.project({ model: "other", state: "ignored", questions: sampleQuestions });
    expect(config.load()).toEqual(sampleQuestions);
    config.project({ questions: {} });
    expect(config.load()).toEqual({});
  });

  it("does not read an overridden global file", () => {
    const config = setup();
    writeFileSync(config.globalPath, "{bad JSON");
    config.project({ questions: sampleQuestions });
    expect(config.load()).toEqual(sampleQuestions);
  });

  it("reports malformed JSON and unreadable files without using another configuration", () => {
    const config = setup();
    config.global({ questions: sampleQuestions });
    writeFileSync(config.projectPath, "{invalid JSON");
    expect(config.load).toThrow(`${config.projectPath}: JSONが不正です（未評価）`);
    rmSync(config.projectPath);
    mkdirSync(config.projectPath);
    expect(config.load).toThrow("質問設定を読み取れません");
  });
});
