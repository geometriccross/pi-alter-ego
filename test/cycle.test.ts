import { describe, expect, it, vi } from "vitest";
import { runDissent, type DissentDeps } from "../src/cycle.js";

function makeDeps(overrides?: Partial<DissentDeps>): DissentDeps {
  return {
    spawn: vi.fn().mockResolvedValue("counterpoint"),
    isEnabled: () => true,
    markLeafIfNew: () => true,
    getCurrentLeafId: () => "leaf-1",
    ...overrides,
  };
}

const basicMessages = [
  { role: "user", content: "Ship it?" },
  { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "考え中。" },
    { type: "text", text: "Ship it." },
  ] },
];

describe("runDissent", () => {
  // ── Tracer Bullet 1 ──
  it("returns dissent when spawn succeeds", async () => {
    const deps = makeDeps({ spawn: vi.fn().mockResolvedValue("counterpoint") });
    const result = await runDissent(basicMessages, {}, "leaf-1", deps);

    expect(result).toBe("counterpoint");
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  // ── Tracer Bullet 2 ──
  it("returns null when spawn returns NO_DISSENT", async () => {
    const deps = makeDeps({ spawn: vi.fn().mockResolvedValue("NO_DISSENT") });
    const result = await runDissent(basicMessages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  // ── Tracer Bullet 3 ──
  it("returns null without spawning when assistant has no thinking trace", async () => {
    const messages = [
      { role: "user", content: "Done?" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] },
    ];
    const deps = makeDeps();
    const result = await runDissent(messages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // ── Tracer Bullet 4 ──
  it("returns null when assistant is not dissentable (toolUse stopReason)", async () => {
    const messages = [
      { role: "user", content: "Check" },
      { role: "assistant", stopReason: "toolUse", content: [
        { type: "thinking", thinking: "理由" },
        { type: "text", text: "text" },
        { type: "toolCall", id: "1", name: "read" },
      ] },
    ];
    const deps = makeDeps();
    const result = await runDissent(messages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // ── Tracer Bullet 5 ──
  it("returns null when alter-ego message already exists in the batch", async () => {
    const messages = [
      { role: "user", content: "Ship?" },
      { customType: "alter-ego", content: "previous" },
      { role: "assistant", stopReason: "stop", content: [
        { type: "thinking", thinking: "考え" },
        { type: "text", text: "Yes." },
      ] },
    ];
    const deps = makeDeps();
    const result = await runDissent(messages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // ── Tracer Bullet 6 ──
  it("returns null when leaf was already processed (duplicate)", async () => {
    const deps = makeDeps({ markLeafIfNew: () => false });
    const result = await runDissent(basicMessages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // ── Tracer Bullet 7 ──
  it("returns null when state was toggled off while spawn was running", async () => {
    let enabled = true;
    const deps = makeDeps({
      spawn: vi.fn().mockImplementation(async () => {
        enabled = false; // simulate toggle-off during spawn
        return "counterpoint";
      }),
      isEnabled: () => enabled,
    });
    const result = await runDissent(basicMessages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  // ── Tracer Bullet 8 ──
  it("returns null when leaf changed while spawn was running (race)", async () => {
    let leafId = "leaf-1";
    const deps = makeDeps({
      spawn: vi.fn().mockImplementation(async () => {
        leafId = "leaf-2"; // simulate navigation during spawn
        return "counterpoint";
      }),
      getCurrentLeafId: () => leafId,
    });
    const result = await runDissent(basicMessages, {}, "leaf-1", deps);

    expect(result).toBeNull();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });
});
