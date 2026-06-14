import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnAlterEgo } from "../src/spawn.ts";

vi.mock("../src/spawn.ts", () => ({
  spawnAlterEgo: vi.fn().mockResolvedValue("counterpoint"),
}));

describe("extension wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores branch-local toggle state on session_tree before spawning", async () => {
    const handlers: Record<string, Function> = {};
    const sent: any[] = [];
    const commands: Record<string, any> = {};
    const pi = {
      on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
      registerCommand: vi.fn((name: string, command: any) => { commands[name] = command; }),
      registerMessageRenderer: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn((message: any) => { sent.push(message); }),
    };

    const { default: alterEgoExtension } = await import("../src/index.ts");
    alterEgoExtension(pi as any);

    let branch: any[] = [];
    let leafId = "leaf-1";
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Ship it?" } },
      { type: "message", id: "leaf-2", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Yes." }] } },
    ];
    const ctx = {
      hasUI: true,
      model: { provider: "provider", id: "model" },
      cwd: "/tmp/project",
      signal: undefined,
      getSystemPrompt: () => "parent prompt",
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      sessionManager: {
        getBranch: () => branch,
        getLeafId: () => leafId,
        getEntries: () => entries,
      },
    };
    const event = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Yes." }] }] };

    branch = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: false } }];
    await handlers.session_tree({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("alter-ego", "\x1b[90mAlter Ego: OFF\x1b[39m");
    await handlers.agent_end(event, ctx);
    expect(spawnAlterEgo).not.toHaveBeenCalled();

    branch = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: true } }];
    leafId = "leaf-2";
    await handlers.session_tree({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("alter-ego", "\x1b[90mAlter Ego: ON\x1b[39m");
    await handlers.agent_end(event, ctx);

    expect(spawnAlterEgo).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({ customType: "alter-ego", content: "counterpoint", display: true }),
    ]);
    expect(commands["alter-ego"]).toBeDefined();
  });

  it("does not inject an Alter Ego message when the child returns NO_DISSENT", async () => {
    vi.mocked(spawnAlterEgo).mockResolvedValueOnce("NO_DISSENT");

    const handlers: Record<string, Function> = {};
    const pi = {
      on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    };

    const { default: alterEgoExtension } = await import("../src/index.ts");
    alterEgoExtension(pi as any);

    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "こんにちは" } },
      { type: "message", id: "leaf-1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "こんにちは。" }] } },
    ];
    const ctx = {
      hasUI: true,
      model: { provider: "provider", id: "model" },
      cwd: "/tmp/project",
      signal: undefined,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      sessionManager: {
        getBranch: () => [],
        getLeafId: () => "leaf-1",
        getEntries: () => entries,
      },
    };
    const event = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "こんにちは。" }] }] };

    await handlers.session_start({}, ctx);
    await handlers.agent_end(event, ctx);

    expect(spawnAlterEgo).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
