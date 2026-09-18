import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import alterEgoExtension from "../src/index.js";
import type { JevRequest, JevResponse } from "../src/evaluation.js";
import type { AlterEgoConfig } from "../src/config.js";

const sampleQuestions: JevRequest["questions"] = {
  release_recommendation: { type: "noul", instructions: "Does `assistantTrace.text` recommend a release?" },
  next_step: {
    type: "choice", instructions: { question: "What should happen next?" },
    criteria: { verify: { action: "Run tests" }, release: null },
  },
  readiness: {
    type: "score", instructions: ["Rate release readiness."],
    criteria: ["Not ready", { status: "Partly verified" }, ["Ready", "Verified"]],
  },
};

function jevResponse(request: JevRequest): JevResponse {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type === "noul") return [id, { type: "noul", noul: 0.01 }];
    const keys = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]));
    return [id, question.type === "choice"
      ? { type: "choice", choice: keys[0], confidence: 1, probabilities }
      : {
          type: "score", score: 0, confidence: 1, probabilities,
          legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
        }];
  })) as JevResponse["answers"];
  return { model: "jev-test", answers, usage: { input_tokens: 320, output_tokens: 48 } };
}

const messages = [
  { role: "user", content: "Ship it?", timestamp: 0 },
  {
    role: "assistant", stopReason: "stop",
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
  for (const message of runMessages) manager.appendMessage(message as any);
  const pi = {
    on: (event: string, handler: any) => {
      handlers[event] = (payload, ctx) => handler({ ...payload, type: event }, ctx);
    },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn((name, data) => manager.appendCustomEntry(name, data)),
    sendMessage: vi.fn((message) => manager.appendCustomMessageEntry(
      message.customType, message.content, message.display, message.details,
    )),
  };
  const ctx = {
    hasUI: true, cwd, signal: undefined as AbortSignal | undefined,
    sessionManager: manager,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  alterEgoExtension(pi as any);
  return { handlers, commands, pi, ctx, manager, run: () => handlers.agent_end({ messages: runMessages }, ctx) };
}

let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "alter-ego-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({ questions: sampleQuestions }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

function configure(questions: AlterEgoConfig["questions"]) {
  writeFileSync(join(agentDir, "alter-ego.json"), JSON.stringify({ questions }));
}

function respond() {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json(jevResponse(JSON.parse(init!.body as string))));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function deferredResponse() {
  const finishes: Array<() => void> = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
    signals.push(init!.signal);
    const request = JSON.parse(init!.body as string);
    return new Promise((resolve) => finishes.push(() => resolve(Response.json(jevResponse(request)))));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { finish: () => finishes.forEach((finish) => finish()), signals, fetchImpl };
}

describe("extension -> Jev -> display", () => {
  it("sends questions and the visible trace, then displays all answers without an assessment log", async () => {
    const fetchImpl = respond();
    const env = setup(undefined, [
      messages[0],
      {
        role: "assistant", stopReason: "toolUse", timestamp: 1,
        content: [
          { type: "thinking", thinking: "I should run tests." },
          { type: "toolCall", id: "test-run", name: "bash", arguments: { command: "npm test" } },
        ],
      },
      {
        role: "toolResult", toolCallId: "test-run", toolName: "bash", timestamp: 2,
        content: [{ type: "text", text: "Tests 1 failed" }], isError: true,
      },
      { ...messages[1], timestamp: 3 },
    ]);
    await env.handlers.session_start({ reason: "startup" }, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
    const request = JSON.parse(init.body as string);
    expect(request).toEqual({
      model: "jev-latest", questions: sampleQuestions,
      state: {
        event: { type: "agent_end" }, userText: "Ship it?",
        assistantTrace: { thinking: "I should run tests.\n\nInput validation is untested.", text: "Fully verified." },
        compactionSummaries: [],
      },
    });
    const response = jevResponse(request);
    expect(env.pi.sendMessage).toHaveBeenCalledExactlyOnceWith({
      customType: "alter-ego", display: true,
      content: JSON.stringify(response.answers, null, 2), details: { response },
    });
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    expect(env.manager.buildSessionContext().messages.some((message: any) =>
      message.role === "custom" && message.customType === "alter-ego")).toBe(true);
  });

  it("preserves arbitrary IDs and criteria without merging global questions", async () => {
    const cwd = join(agentDir, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const questions = {
      language: { type: "noul", instructions: null },
      custom_source: { type: "choice", instructions: { question: "Choose a category" }, criteria: { a: null, b: ["Category B"] } },
      ...JSON.parse('{"__proto__":{"type":"score","instructions":"Rate readiness","criteria":["Not ready","Ready"]}}'),
    };
    writeFileSync(join(cwd, ".pi", "alter-ego.json"), JSON.stringify({ model: "ignored", questions }));
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

  it("evaluates a final answer without thinking or tools", async () => {
    const fetchImpl = respond();
    const env = setup(undefined, [messages[0], { role: "assistant", stopReason: "stop", content: "A final answer.", timestamp: 1 }]);
    await env.run();
    const request: JevRequest = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request.state).toMatchObject({ assistantTrace: { thinking: "", text: "A final answer." } });
    expect(request.questions).toEqual(sampleQuestions);
  });

  it.each(["missing", "empty", "no questions"])("does nothing for %s configuration and observes later changes", async (kind) => {
    const path = join(agentDir, "alter-ego.json");
    if (kind === "missing") rmSync(path);
    else writeFileSync(path, JSON.stringify(kind === "empty" ? { questions: {} } : { model: "old-model" }));
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).not.toHaveBeenCalled();
    configure(sampleQuestions);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reloads questions on every event, including repeated final answers", async () => {
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    const questions = { new_question: { type: "noul", instructions: "An updated question" } } as const;
    configure(questions);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string).questions).toEqual(questions);
  });

  it("propagates malformed configuration without an error notification", async () => {
    writeFileSync(join(agentDir, "alter-ego.json"), "{bad JSON");
    const fetchImpl = respond();
    const env = setup();
    await expect(env.run()).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).not.toHaveBeenCalled();
    configure(sampleQuestions);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["agent_end", "tool_call"] as const)("propagates %s transport errors without notification or fallback", async (hook) => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: hook } });
    const failure = new Error("Network failure");
    const fetchImpl = respond().mockRejectedValueOnce(failure);
    const env = setup();
    const payload = hook === "agent_end" ? { messages } : { toolName: "bash", toolCallId: "check", input: {} };
    await expect(env.handlers[hook](payload, env.ctx)).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(env.ctx.ui.notify).not.toHaveBeenCalled();
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("evaluates identical answers again, including after session restoration", async () => {
    const fetchImpl = respond();
    const env = setup();
    await env.run();
    await env.run();
    await env.handlers.session_start({ reason: "reload" }, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(env.pi.sendMessage).toHaveBeenCalledTimes(3);
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("does not deduplicate in-flight requests", async () => {
    const deferred = deferredResponse();
    const env = setup();
    const first = env.run();
    const second = env.run();
    expect(deferred.fetchImpl).toHaveBeenCalledTimes(2);
    deferred.finish();
    await Promise.all([first, second]);
    expect(env.pi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("batches only matching questions and notifies intermediate answers without persisting logs", async () => {
    configure({
      final: sampleQuestions.release_recommendation,
      tool: { ...sampleQuestions.next_step, on: "tool_call" },
      both: { ...sampleQuestions.readiness, on: ["turn_end", "agent_end", "turn_end"] },
    });
    const fetchImpl = respond();
    const env = setup();
    const tool = { toolName: "bash", toolCallId: "check", input: { command: "npm test" } };
    expect(await env.handlers.tool_call(tool, env.ctx)).toBeUndefined();
    await env.handlers.turn_end({ turnIndex: 0, message: messages[1], toolResults: [] }, env.ctx);
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    expect(env.manager.getEntries()).toHaveLength(messages.length);
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool_call"), "info");
    await env.run();
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(requests.map((request) => request.questions)).toEqual([
      { tool: sampleQuestions.next_step }, { both: sampleQuestions.readiness },
      { final: sampleQuestions.release_recommendation, both: sampleQuestions.readiness },
    ]);
    expect(requests.map((request) => request.state.event.type)).toEqual(["tool_call", "turn_end", "agent_end"]);
    expect(requests[0].state.event).toEqual({ type: "tool_call", ...tool });
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([{ name: "empty session", history: [] }, { name: "previous run", history: messages }])("evaluates startup/input hooks without borrowing an old trace ($name)", async ({ history }) => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: ["session_start", "input", "before_agent_start", "agent_start"] } });
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
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("observes message_end before persistence without evaluating custom messages", async () => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: "message_end" } });
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
    await env.handlers.message_end({ message: { role: "custom", customType: "alter-ego", content: "own output" } }, env.ctx);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    expect(env.manager.getEntries()).toHaveLength(1);
  });

  it("evaluates each tool result on the same leaf using text, not images or opaque details", async () => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: "tool_result" } });
    const deferred = deferredResponse();
    const env = setup();
    const tool = {
      toolName: "bash", input: { command: "npm test" }, isError: true,
      content: [{ type: "text", text: "One test failed." }, { type: "image", data: "private-image", mimeType: "image/png" }],
      details: { private: "not sent" },
    };
    const first = env.handlers.tool_result({ ...tool, toolCallId: "first" }, env.ctx);
    const second = env.handlers.tool_result({ ...tool, toolCallId: "second" }, env.ctx);
    deferred.finish();
    await Promise.all([first, second]);
    expect(deferred.fetchImpl).toHaveBeenCalledTimes(2);
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
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
  ] as const)("runs questions for $type without returning a hook action or writing a log", async (event) => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: event.type } });
    const fetchImpl = respond();
    const env = setup();
    expect(await env.handlers[event.type](event, env.ctx)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({
      questions: { check: sampleQuestions.release_recommendation }, state: { event: { type: event.type } },
    });
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(event.type), "info");
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["agent_end", "tool_call"] as const)("does not discard or cancel in-flight %s results after state changes", async (hook) => {
    configure({ check: { ...sampleQuestions.release_recommendation, on: hook } });
    const deferred = deferredResponse();
    const env = setup();
    const parent = new AbortController();
    env.ctx.signal = parent.signal;
    const payload = hook === "agent_end" ? { messages } : { toolName: "bash", toolCallId: "check", input: {} };
    const running = env.handlers[hook](payload, env.ctx);
    env.manager.resetLeaf();
    await env.handlers.session_tree({}, env.ctx);
    await env.handlers.agent_start({}, env.ctx);
    await env.commands["alter-ego"].handler("", env.ctx);
    await env.handlers.session_shutdown({}, env.ctx);
    expect(deferred.signals).toEqual([parent.signal]);
    expect(parent.signal.aborted).toBe(false);
    deferred.finish();
    await running;
    if (hook === "agent_end") expect(env.pi.sendMessage).toHaveBeenCalledOnce();
    else expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool_call"), "info");
    expect(env.pi.appendEntry).toHaveBeenCalledExactlyOnceWith("alter-ego-toggle", { enabled: false });
  });

  it("keeps ON/OFF persistence, branch restoration, and the non-UI behavior", async () => {
    const fetchImpl = respond();
    const env = setup();
    const originalLeaf = env.manager.getLeafId()!;
    env.ctx.hasUI = false;
    await env.run();
    env.ctx.hasUI = true;
    await env.commands["alter-ego"].handler("", env.ctx);
    const disabledLeaf = env.manager.getLeafId()!;
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ctx.ui.setStatus).toHaveBeenCalledWith("alter-ego", "Alter Ego / Jev: OFF");
    await env.commands["alter-ego"].handler("", env.ctx);
    await env.run();
    env.manager.branch(disabledLeaf);
    await env.handlers.session_tree({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledOnce();
    env.manager.branch(originalLeaf);
    await env.handlers.session_tree({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(env.ctx.ui.setStatus).toHaveBeenCalledWith("alter-ego", "Alter Ego / Jev: ON");
  });
});
