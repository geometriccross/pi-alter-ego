import { describe, expect, it, vi } from "vitest";
import { spawnAlterEgo } from "../src/spawn.ts";

vi.mock("../src/spawn.ts", () => ({
  spawnAlterEgo: vi.fn().mockResolvedValue("counterpoint"),
}));

describe("extension wiring", () => {
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
    await handlers.agent_end(event, ctx);
    expect(spawnAlterEgo).not.toHaveBeenCalled();

    branch = [{ type: "custom", customType: "alter-ego-toggle", data: { enabled: true } }];
    leafId = "leaf-2";
    await handlers.session_tree({}, ctx);
    await handlers.agent_end(event, ctx);

    expect(spawnAlterEgo).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({ customType: "alter-ego", content: "counterpoint", display: true }),
    ]);
    expect(commands["alter-ego"]).toBeDefined();
  });
});
