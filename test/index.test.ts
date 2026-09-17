import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import alterEgoExtension from "../src/index.js";
import type { JevRequest, JevResponse } from "../src/jev.js";
import type { AlterEgoConfig } from "../src/config.js";

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
      handlers[event] = (payload, ctx) => handler({ ...payload, type: event }, ctx);
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
    const init = fetchImpl.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
    const request = JSON.parse(init.body as string);
    expect(request).toEqual({
      model: "jev-latest",
      questions: sampleQuestions,
      state: {
        event: { type: "agent_end" },
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

  it("batches only matching questions per hook, strips on, and keeps final-answer deduplication independent", async () => {
    const questions: AlterEgoConfig["questions"] = {
      final: sampleQuestions.release_recommendation,
      tool: { ...sampleQuestions.next_step, on: "tool_call" },
      both: { ...sampleQuestions.readiness, on: ["turn_end", "agent_end", "turn_end"] },
    };
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({ questions }));
    const fetchImpl = respond();
    const env = setup();
    const tool = { toolName: "bash", toolCallId: "check", input: { command: "npm test" } };
    expect(await env.handlers.tool_call(tool, env.ctx)).toBeUndefined();
    await env.handlers.turn_end({ turnIndex: 0, message: messages[1], toolResults: [] }, env.ctx);
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool_call"), "info");
    expect(env.manager.buildSessionContext().messages).toHaveLength(messages.length);

    await env.handlers.session_start({}, env.ctx);
    await env.run();
    await env.run();
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(requests.map((request) => request.questions)).toEqual([
      { tool: sampleQuestions.next_step },
      { both: sampleQuestions.readiness },
      { final: sampleQuestions.release_recommendation, both: sampleQuestions.readiness },
    ]);
    expect(requests.map((request) => request.state.event.type)).toEqual(["tool_call", "turn_end", "agent_end"]);
    expect(requests[0].state.event).toEqual({ type: "tool_call", ...tool });
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([{ name: "empty session", history: [] }, { name: "previous run", history: messages }])("evaluates startup/input hooks without a final answer or stale assistant trace ($name)", async ({ history }) => {
    const question = sampleQuestions.release_recommendation;
    const questions = { check: { ...question, on: ["session_start", "input", "before_agent_start", "agent_start"] } };
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({ questions }));
    const fetchImpl = respond();
    const env = setup(undefined, history);
    await env.handlers.session_start({ reason: "startup" }, env.ctx);
    expect(await env.handlers.input({ text: "New request", images: [{ data: "image-secret" }], source: "interactive" }, env.ctx)).toBeUndefined();
    const before = { prompt: "Expanded request", systemPrompt: "private system prompt", systemPromptOptions: { secret: "private config" } };
    expect(await env.handlers.before_agent_start(before, env.ctx)).toBeUndefined();
    await env.handlers.agent_start({}, env.ctx);
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(requests).toHaveLength(4);
    expect(requests.slice(1).map((request) => request.state)).toEqual([
      { event: { type: "input", text: "New request", source: "interactive" }, userText: "New request", assistantTrace: { thinking: "", text: "" }, compactionSummaries: [] },
      { event: { type: "before_agent_start", prompt: "Expanded request" }, userText: "Expanded request", assistantTrace: { thinking: "", text: "" }, compactionSummaries: [] },
      { event: { type: "agent_start" }, userText: "Expanded request", assistantTrace: { thinking: "", text: "" }, compactionSummaries: [] },
    ]);
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("observes message_end before persistence, including tool turns, without evaluating its own messages", async () => {
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({
      questions: { check: { ...sampleQuestions.release_recommendation, on: "message_end" } },
    }));
    const fetchImpl = respond();
    const env = setup(undefined, [messages[0]]);
    const message = {
      role: "assistant", stopReason: "toolUse", timestamp: 2,
      content: [
        { type: "thinking", thinking: "Run a check first.", thinkingSignature: "private signature" },
        { type: "text", text: "Checking." },
        { type: "toolCall", id: "check", name: "bash", arguments: { command: "npm test" } },
      ],
    };
    expect(await env.handlers.message_end({ message }, env.ctx)).toBeUndefined();
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request.state.assistantTrace).toEqual({ thinking: "Run a check first.", text: "Checking." });
    expect(request.state.event.message).toEqual({ role: "assistant", content: "Checking.", thinking: "Run a check first.", stopReason: "toolUse" });
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    await env.handlers.message_end({ message: { role: "custom", customType: "alter-ego", content: "own output" } }, env.ctx);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(env.manager.buildSessionContext().messages).toHaveLength(1);
  });

  it("evaluates each tool result on the same leaf and sends text, not images or opaque details", async () => {
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({
      questions: { check: { ...sampleQuestions.release_recommendation, on: "tool_result" } },
    }));
    const deferred = deferredResponse();
    const env = setup();
    const tool = {
      toolName: "bash", input: { command: "npm test" }, isError: true,
      content: [{ type: "text", text: "One test failed." }, { type: "image", data: "private-image", mimeType: "image/png" }],
      details: { private: "not sent" },
    };
    const first = env.handlers.tool_result({ ...tool, toolCallId: "first" }, env.ctx);
    const second = env.handlers.tool_result({ ...tool, toolCallId: "second" }, env.ctx);
    // Normal progress (and another assessment's custom entry) must not discard a hook result.
    env.manager.appendMessage({ role: "toolResult", ...tool, toolCallId: "first", timestamp: 3 } as any);
    deferred.finish();
    await Promise.all([first, second]);
    expect(deferred.fetchImpl).toHaveBeenCalledTimes(2);
    expect(env.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).toHaveBeenCalledTimes(2);
    const events = deferred.fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string).state.event);
    expect(events).toEqual(["first", "second"].map((toolCallId) => ({
      type: "tool_result", toolName: "bash", toolCallId, input: tool.input, isError: true, content: "One test failed.",
    })));
  });

  it.each([
    { type: "session_tree", newLeafId: null, oldLeafId: null },
    { type: "session_compact", compactionEntry: { summary: "Prior checks are incomplete." }, fromExtension: false },
    { type: "turn_start", turnIndex: 1, timestamp: 2 },
    { type: "context", messages },
    { type: "tool_execution_start", toolCallId: "check", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_end", toolCallId: "check", toolName: "bash", result: { content: [{ type: "text", text: "OK" }] }, isError: false },
  ])("runs questions registered for $type without returning a hook action", async (event) => {
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({
      questions: { check: { ...sampleQuestions.release_recommendation, on: event.type } },
    }));
    const fetchImpl = respond();
    const env = setup();
    expect(await env.handlers[event.type](event, env.ctx)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({
      questions: { check: sampleQuestions.release_recommendation }, state: { event: { type: event.type } },
    });
    expect(env.pi.appendEntry).toHaveBeenCalledWith("alter-ego-hook-assessment", {
      hook: event.type, sourceLeafId: env.sourceId, response: expect.objectContaining({ answers: { check: { type: "noul", noul: 0.01 } } }),
    });
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("hook failures never block tool execution and retry on the next event; disabled/non-UI hooks stay silent", async () => {
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({
      questions: { check: { ...sampleQuestions.release_recommendation, on: "tool_call" } },
    }));
    const fetchImpl = respond().mockResolvedValueOnce(new Response("", { status: 422 }));
    const env = setup();
    const call = () => env.handlers.tool_call({ toolName: "bash", toolCallId: "check", input: {} }, env.ctx);
    expect(await call()).toBeUndefined();
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("HTTP 422"), "error");
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    await call();
    expect(env.pi.appendEntry).toHaveBeenCalledOnce();
    env.ctx.hasUI = false;
    await call();
    env.ctx.hasUI = true;
    await env.commands["alter-ego"].handler("", env.ctx);
    await call();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reloads changed hook routing and reports invalid hooks without evaluating or falling back", async () => {
    const path = join(agentDir, "alter-ego.json");
    const configure = (on: string) => writeFileSync(path, JSON.stringify({ questions: { check: { ...sampleQuestions.release_recommendation, on } } }));
    configure("typo");
    const fetchImpl = respond();
    const env = setup();
    await env.handlers.input({ text: "Hello", source: "interactive" }, env.ctx);
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).toHaveBeenCalledOnce();
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("questions.check.on"), "error");
    configure("input");
    await env.run();
    await env.handlers.input({ text: "Hello", source: "interactive" }, env.ctx);
    expect(fetchImpl).toHaveBeenCalledOnce();
    configure("agent_end");
    await env.handlers.input({ text: "Hello", source: "interactive" }, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["session_tree", "session_shutdown", "agent_start", "toggle", "signal", "branch"])("discards in-flight hook results after %s", async (action) => {
    writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({
      questions: { check: { ...sampleQuestions.release_recommendation, on: "tool_call" } },
    }));
    const deferred = deferredResponse();
    const env = setup();
    const controller = new AbortController();
    env.ctx.signal = controller.signal;
    const running = env.handlers.tool_call({ toolName: "bash", toolCallId: "check", input: {} }, env.ctx);
    if (action === "toggle") await env.commands["alter-ego"].handler("", env.ctx);
    else if (action === "signal") controller.abort();
    else if (action === "branch") env.manager.resetLeaf();
    else await env.handlers[action]({}, env.ctx);
    deferred.finish();
    await running;
    expect(env.pi.appendEntry.mock.calls.filter(([type]) => type === "alter-ego-hook-assessment")).toEqual([]);
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify.mock.calls.filter(([text]) => text.includes("tool_call"))).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
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

  it("skips an already aborted run, cleans up listeners, and permits retry", async () => {
    const fetchImpl = respond();
    const env = setup();
    const aborted = new AbortController();
    aborted.abort();
    env.ctx.signal = aborted.signal;

    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).not.toHaveBeenCalled();
    expect(getEventListeners(aborted.signal, "abort")).toEqual([]);

    const retry = new AbortController();
    env.ctx.signal = retry.signal;
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
    expect(getEventListeners(retry.signal, "abort")).toEqual([]);
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
