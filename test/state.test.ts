import { describe, expect, it } from "vitest";
import { createAlterEgoState, hasAlterEgoMessage, isDissentableAssistant } from "../src/state.ts";

describe("extension state helpers", () => {
  it("restores latest toggle from a leaf-to-root branch", () => {
    const state = createAlterEgoState();
    state.restoreFromBranch([
      { type: "custom", customType: "alter-ego-toggle", data: { enabled: false } },
      { type: "custom", customType: "alter-ego-toggle", data: { enabled: true } },
    ] as any);
    expect(state.isEnabled()).toBe(false);
  });

  it("toggles, deduplicates leaves, and resets processed leaves", () => {
    const state = createAlterEgoState();
    expect(state.toggle()).toBe(false);
    expect(state.markLeafIfNew("leaf")).toBe(true);
    expect(state.markLeafIfNew("leaf")).toBe(false);
    state.resetProcessedLeaves();
    expect(state.markLeafIfNew("leaf")).toBe(true);
  });



  it("detects an Alter Ego message in the current event", () => {
    expect(hasAlterEgoMessage([
      { role: "assistant", content: [] },
      { role: "custom", customType: "alter-ego", content: "old" },
    ] as any)).toBe(true);
    expect(hasAlterEgoMessage([
      { role: "assistant", customType: "alter-ego", content: "already in context" },
    ] as any)).toBe(true);
    expect(hasAlterEgoMessage([
      { role: "custom", customType: "other", content: "keep" },
    ] as any)).toBe(false);
  });

  it("recognizes only final assistant messages with text as Dissentable", () => {
    expect(isDissentableAssistant({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: " ok " }] } as any)).toBe(true);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] } as any)).toBe(true);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "intermediate" }, { type: "toolCall" }] } as any)).toBe(false);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "bad" }] } as any)).toBe(false);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] } as any)).toBe(false);
  });
});
