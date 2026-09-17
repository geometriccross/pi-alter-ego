import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import alterEgoExtension from "../src/index.js";
import { DEFAULT_SETTINGS } from "../src/config.js";
import { jevResponse } from "./fixtures.js";
import type { JevRequest } from "../src/jev.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, resolveAlterEgoSettings: () => actual.DEFAULT_SETTINGS };
});

const messages = [
  { role: "user", content: "Ship it?", timestamp: 0 },
  { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Input validation is untested." }, { type: "text", text: "Fully verified." }], timestamp: 1 },
];

function setup() {
  const handlers: Record<string, (...args: any[]) => Promise<void>> = {};
  const commands: Record<string, any> = {};
  const manager = SessionManager.inMemory("/synthetic-project");
  for (const message of messages) manager.appendMessage(message as any);
  const sourceId = manager.getLeafId()!;
  const pi = {
    on: (event: string, handler: any) => { handlers[event] = handler; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn((name, data) => manager.appendCustomEntry(name, data)),
    sendMessage: vi.fn((message) => manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details)),
  };
  const ctx = {
    hasUI: true, cwd: "/synthetic-project", model: undefined,
    signal: undefined as AbortSignal | undefined,
    sessionManager: manager, ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  alterEgoExtension(pi as any);
  return { handlers, commands, pi, ctx, manager, sourceId, run: () => handlers.agent_end({ messages }, ctx) };
}

beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", "test-key"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function respond(clear = false) {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const request: JevRequest = JSON.parse(init!.body as string);
    return Response.json(jevResponse(request, clear ? {} : { overconfidence: { probability: 0.98, source: "t0" } }));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function deferredResponse() {
  const finishes: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
    signals.push(init!.signal!);
    const request = JSON.parse(init!.body as string);
    return new Promise((resolve) => { finishes.push(() => resolve(Response.json(jevResponse(request, { overconfidence: { probability: 0.98, source: "t0" } })))); });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { finish: () => finishes.forEach((finish) => finish()), signals, fetchImpl };
}

describe("extension -> Jev -> session integration", () => {
  it("uses Jev independently of the main model, stores typed data, and does not trigger another agent turn", async () => {
    const fetchImpl = respond();
    const env = setup();
    await env.handlers.session_start({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).model).toBe(DEFAULT_SETTINGS.model);
    expect(env.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "alter-ego", display: true,
      content: expect.stringContaining("P(yes)=0.98"),
      details: expect.objectContaining({ sourceLeafId: env.sourceId, assessment: expect.objectContaining({ model: "jev-test", outcome: "dissent" }) }),
    }));
    const context = env.manager.buildSessionContext();
    expect(context.messages.some((m: any) => m.role === "custom" && m.customType === "alter-ego")).toBe(true);
  });

  it.each([false, true])("deduplicates before and after session restore, including clear=%s results", async (clear) => {
    const fetchImpl = respond(clear);
    const env = setup();
    await env.run();
    await env.run();
    await env.handlers.session_start({}, env.ctx);
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    if (clear) {
      expect(env.pi.sendMessage).not.toHaveBeenCalled();
      expect(env.pi.appendEntry).toHaveBeenCalledWith("alter-ego-assessment", expect.objectContaining({ sourceLeafId: env.sourceId }));
      expect(env.manager.buildSessionContext().messages).toHaveLength(2);
    }
  });

  it("reports missing auth as unavailable and allows a later retry; no fallback model", async () => {
    const fetchImpl = respond();
    const env = setup();
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await env.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TYPESAFE_API_KEY"), "error");
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.pi.appendEntry).not.toHaveBeenCalled();
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    await env.run();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
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
    expect(deferred.fetchImpl).toHaveBeenCalledTimes(7);
    expect(env.pi.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["session_tree", "session_shutdown", "agent_start", "toggle", "signal", "leaf"])("discards stale results after %s", async (event) => {
    const deferred = deferredResponse();
    const env = setup();
    const controller = new AbortController();
    env.ctx.signal = controller.signal;
    const running = env.run();
    if (event === "toggle") {
      await env.commands["alter-ego"].handler("", env.ctx);
      await env.commands["alter-ego"].handler("", env.ctx);
    } else if (event === "signal") controller.abort();
    else if (event === "leaf") env.manager.appendMessage({ role: "user", content: "new prompt", timestamp: 2 });
    else await env.handlers[event]({}, env.ctx);
    expect(deferred.signals).toHaveLength(7);
    if (event !== "leaf") expect(deferred.signals.every((signal) => signal.aborted)).toBe(true);
    deferred.finish();
    await running;
    expect(env.pi.sendMessage).not.toHaveBeenCalled();
    expect(env.ctx.ui.notify.mock.calls.filter((call) => call[1] === "error")).toEqual([]);
  });
});
