import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunDissent = vi.fn().mockResolvedValue("counterpoint");
vi.mock("../src/cycle.js", () => ({
  runDissent: mockRunDissent,
}));

describe("extension adapter wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunDissent.mockResolvedValue("counterpoint");
    // Re-import to pick up fresh module state
    vi.resetModules();
  });

  // Helper: create the extension and return handlers + pi mock
  async function setupExtension() {
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
    return { handlers, sent, commands, pi };
  }

  function makeCtx(overrides?: Record<string, unknown>) {
    return {
      hasUI: true,
      model: { provider: "provider", id: "model" },
      cwd: "/tmp/project",
      signal: undefined,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      sessionManager: {
        getBranch: () => [],
        getLeafId: () => "leaf-1",
        getEntries: () => [
          { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Ship it?" } },
          { type: "message", id: "leaf-1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Yes." }] } },
        ],
      },
      ...overrides,
    };
  }

  const basicEvent = {
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "考える。" }, { type: "text", text: "Yes." }] }],
  };

  it("routes dissent from runDissent to sendMessage", async () => {
    const { handlers, sent } = await setupExtension();
    const ctx = makeCtx();

    await handlers.session_start({}, ctx);
    await handlers.agent_end(basicEvent, ctx);

    expect(mockRunDissent).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({ customType: "alter-ego", content: "counterpoint", display: true }),
    ]);
  });

  it("skips sendMessage when runDissent returns null", async () => {
    mockRunDissent.mockResolvedValue(null);
    const { handlers, pi } = await setupExtension();
    const ctx = makeCtx();

    await handlers.session_start({}, ctx);
    await handlers.agent_end(basicEvent, ctx);

    expect(mockRunDissent).toHaveBeenCalledOnce();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("skips cycle entirely when state is disabled", async () => {
    const { handlers } = await setupExtension();
    const ctx = makeCtx();
    const branch = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: false } }];
    Object.assign(ctx.sessionManager, { getBranch: () => branch });

    await handlers.session_tree({}, ctx);
    await handlers.agent_end(basicEvent, ctx);

    expect(mockRunDissent).not.toHaveBeenCalled();
  });

  it("restores branch-local toggle state from session_tree", async () => {
    const { handlers } = await setupExtension();
    const ctx = makeCtx();

    // Disable via branch
    const branchOff = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: false } }];
    Object.assign(ctx.sessionManager, { getBranch: () => branchOff });
    await handlers.session_tree({}, ctx);

    // Re-enable via branch
    const branchOn = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: true } }];
    Object.assign(ctx.sessionManager, { getBranch: () => branchOn });
    await handlers.session_tree({}, ctx);

    await handlers.agent_end(basicEvent, ctx);
    expect(mockRunDissent).toHaveBeenCalledOnce();
  });

  it("notifies on error from runDissent", async () => {
    mockRunDissent.mockRejectedValue(new Error("spawn failed"));
    const { handlers } = await setupExtension();
    const ctx = makeCtx();

    await handlers.session_start({}, ctx);
    await handlers.agent_end(basicEvent, ctx);

    expect(mockRunDissent).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith("alter ego: spawn failed", "error");
  });
});
