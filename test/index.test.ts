import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import alterEgoExtension from "../src/index.js";
import type { JevRequest, JevResponse } from "../src/jev.js";

const sampleQuestions: JevRequest["questions"] = {
  release_recommendation: {
    type: "noul",
    instructions: "Does `assistantTrace.text` recommend a release?",
  },
  next_step: {
    type: "choice",
    instructions: { question: "What should happen next?" },
    criteria: {
      verify: { action: "Run tests" },
      release: null,
    },
  },
  readiness: {
    type: "score",
    instructions: ["Rate release readiness."],
    criteria: ["Not ready", { status: "Partly verified" }, ["Ready", "Verified"]],
  },
};

function jevResponse(request: JevRequest): JevResponse {
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "noul") {
        return [id, { type: "noul", noul: 0.01 }];
      }

      const keys = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(
        keys.map((key, index) => [key, index === 0 ? 1 : 0]),
      );

      if (question.type === "choice") {
        return [
          id,
          { type: "choice", choice: keys[0], confidence: 1, probabilities },
        ];
      }

      return [
        id,
        {
          type: "score",
          score: 0,
          confidence: 1,
          probabilities,
          legend: Object.fromEntries(
            question.criteria.map((level, index) => [String(index), level]),
          ),
        },
      ];
    }),
  ) as JevResponse["answers"];

  return {
    model: "jev-test",
    answers,
    usage: { input_tokens: 320, output_tokens: 48 },
  };
}

const messages = [
  { role: "user", content: "Ship it?", timestamp: 0 },
  {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "Input validation is untested." },
      { type: "text", text: "Fully verified." },
    ],
    timestamp: 1,
  },
];

function setup(cwd = "/synthetic-project", runMessages: unknown[] = messages) {
  const handlers: Record<string, (...args: any[]) => Promise<void>> = {};
  const commands: Record<string, any> = {};
  const manager = SessionManager.inMemory(cwd);
  for (const message of runMessages) {
    manager.appendMessage(message as any);
  }
  const sourceId = manager.getLeafId()!;

  const pi = {
    on: (event: string, handler: any) => {
      handlers[event] = handler;
    },
    registerCommand: (name: string, command: any) => {
      commands[name] = command;
    },
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn((name, data) => manager.appendCustomEntry(name, data)),
    sendMessage: vi.fn((message) =>
      manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      ),
    ),
  };
  const ctx = {
    hasUI: true,
    cwd,
    model: undefined,
    signal: undefined as AbortSignal | undefined,
    sessionManager: manager,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  alterEgoExtension(pi as any);

  return {
    handlers,
    commands,
    pi,
    ctx,
    manager,
    sourceId,
    run: () => handlers.agent_end({ messages: runMessages }, ctx),
  };
}

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "alter-ego-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  writeFileSync(
    join(agentDir, "alter-ego.json"),
    JSON.stringify({ questions: sampleQuestions }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

function respond() {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json(jevResponse(JSON.parse(init!.body as string))),
  );
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function deferredResponse() {
  const finishes: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
    signals.push(init!.signal!);
    const request = JSON.parse(init!.body as string);
    return new Promise((resolve) => {
      finishes.push(() => resolve(Response.json(jevResponse(request))));
    });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { finish: () => finishes.forEach((finish) => finish()), signals, fetchImpl };
}

describe("extension -> Jev -> session integration", () => {
  it("sends questions and assistant trace without tool data, and displays and persists every typed answer", async () => {
    const fetchImpl = respond();
    const env = setup(undefined, [
      messages[0],
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "I should run tests." },
          { type: "toolCall", id: "test-run", name: "bash", arguments: { command: "npm test" } },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "test-run",
        toolName: "bash",
        content: [{ type: "text", text: "Tests 1 failed" }],
        isError: true,
        timestamp: 2,
      },
      { ...messages[1], timestamp: 3 },
    ]);
    await env.handlers.session_start({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request).toEqual({
      model: "jev-latest",
      questions: sampleQuestions,
      state: {
        userText: "Ship it?",
        assistantTrace: {
          thinking: "I should run tests.\n\nInput validation is untested.",
          text: "Fully verified.",
        },
        compactionSummaries: [],
      },
    });
    const response = jevResponse(request);
    expect(env.pi.sendMessage).toHaveBeenCalledWith({
      customType: "alter-ego",
      display: true,
      content: expect.any(String),
      details: { sourceLeafId: env.sourceId, response },
    });
    expect(JSON.parse(env.pi.sendMessage.mock.calls[0][0].content)).toEqual(response.answers);
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    const contextMessages = env.manager.buildSessionContext().messages;
    expect(
      contextMessages.some((message: any) =>
        message.role === "custom" && message.customType === "alter-ego",
      ),
    ).toBe(true);
  });

  it("does not reinterpret reserved-looking IDs, inject extra choices, or merge global questions", async () => {
    const cwd = join(agentDir, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const questions = {
      language: { type: "noul", instructions: null },
      custom_source: {
        type: "choice",
        instructions: { question: "Choose a category" },
        criteria: { a: null, b: ["Category B"] },
      },
      ...JSON.parse(
        '{"__proto__":{"type":"score","instructions":"Rate readiness","criteria":["Not ready","Ready"]}}',
      ),
    };
    writeFileSync(
      join(cwd, ".pi", "alter-ego.json"),
      JSON.stringify({ model: "ignored", questions }),
    );
    const fetchImpl = respond();
    const env = setup(cwd);
    await env.run();
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request.questions).toEqual(questions);
    expect(request.model).toBe("jev-latest");
    const content = JSON.parse(env.pi.sendMessage.mock.calls[0][0].content);
    expect(content).toEqual(jevResponse(request).answers);
    expect(Object.hasOwn(content, "__proto__")).toBe(true);
  });

  it("evaluates configured questions even without thinking or tools", async () => {
    const fetchImpl = respond();
    const env = setup(undefined, [
      messages[0],
      {
        role: "assistant",
        stopReason: "stop",
        content: "A final answer.",
        timestamp: 1,
      },
    ]);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request: JevRequest = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request.state).toMatchObject({ assistantTrace: { thinking: "", text: "A final answer." } });
    expect(request.questions).toEqual(sampleQuestions);
  });

  it.each(["missing", "empty", "no questions"])(
    "does nothing for %s configuration and can evaluate after questions are added",
    async (kind) => {
      const path = join(agentDir, "alter-ego.json");
      if (kind === "missing") {
        rmSync(path);
      } else {
        const config = kind === "empty" ? { questions: {} } : { model: "old-model" };
        writeFileSync(path, JSON.stringify(config));
      }

      const fetchImpl = respond();
      const env = setup();
      await env.run();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(env.pi.sendMessage).not.toHaveBeenCalled();
      expect(env.ctx.ui.notify).not.toHaveBeenCalled();

      writeFileSync(path, JSON.stringify({ questions: sampleQuestions }));
      await env.run();
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("reloads question changes for the next answer", async () => {
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    const questions = { new_question: { type: "noul", instructions: "An updated question" } };
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({ questions }));
    env.manager.appendMessage(messages[1] as any);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string).questions).toEqual(questions);
  });

  it("reports JSON syntax errors without sending input and permits retry", async () => {
    const path = join(agentDir, "alter-ego.json");
    writeFileSync(path, "{bad JSON");
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("JSONが不正"), "error");
    writeFileSync(path, JSON.stringify({ questions: sampleQuestions }));
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("lets TypeSafe validate questions and reports API rejection without falling back", async () => {
    const path = join(agentDir, "alter-ego.json");
    const questions = {
      arbitrary: {
        type: "score",
        instructions: "Incomplete scale",
        criteria: ["One level"],
      },
    };
    writeFileSync(path, JSON.stringify({ questions }));
    const fetchImpl = respond().mockResolvedValueOnce(new Response("", { status: 422 }));
    const env = setup();
    await env.run();
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).questions).toEqual(questions);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("HTTP 422"), "error");
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    writeFileSync(path, JSON.stringify({ questions: sampleQuestions }));
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it("deduplicates before and after session restore", async () => {
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    await env.run();
    await env.handlers.session_start({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports missing auth as unavailable and allows a later retry; no fallback model", async () => {
    const fetchImpl = respond();
    const env = setup();
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("TYPESAFE_API_KEY"),
      "error",
    );
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("ignores non-UI execution and a disabled branch", async () => {
    const fetchImpl = respond();
    const env = setup();
    env.ctx.hasUI = false;
    await env.run();
    env.ctx.hasUI = true;
    env.manager.appendCustomEntry("alter-ego-toggle", { enabled: false });
    await env.handlers.session_tree({}, env.ctx);
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deduplicates requests already in flight", async () => {
    const deferred = deferredResponse();
    const env = setup();
    const first = env.run();
    await env.run();
    deferred.finish();
    await first;
    expect(deferred.fetchImpl).toHaveBeenCalledOnce();
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    "session_tree",
    "session_shutdown",
    "agent_start",
    "toggle",
    "signal",
    "leaf",
  ])("discards stale results after %s", async (event) => {
    const deferred = deferredResponse();
    const env = setup();
    const controller = new AbortController();
    env.ctx.signal = controller.signal;

    const running = env.run();
    if (event === "toggle") {
      await env.commands["alter-ego"].handler("", env.ctx);
      await env.commands["alter-ego"].handler("", env.ctx);
    } else if (event === "signal") {
      controller.abort();
    } else if (event === "leaf") {
      env.manager.appendMessage({ role: "user", content: "new prompt", timestamp: 2 });
    } else {
      await env.handlers[event]({}, env.ctx);
    }

    expect(deferred.signals).toHaveLength(1);
    if (event !== "leaf") {
      expect(deferred.signals[0].aborted).toBe(true);
    }

    deferred.finish();
    await running;

    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify.mock.calls.filter((call) => call[1] === "error")).toEqual([]);
  });
});
