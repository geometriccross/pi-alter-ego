import { describe, expect, it } from "vitest";
import { createAlterEgoState, filterAlterEgoMessages, isDissentableAssistant } from "../src/state.ts";

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

  it("filters prior Alter Ego dissents from context", () => {
    const messages = filterAlterEgoMessages([
      { role: "custom", customType: "alter-ego", content: "old" },
      { role: "custom", customType: "other", content: "keep" },
    ] as any);
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).customType).toBe("other");
  });

  it("recognizes only final assistant messages with text as Dissentable", () => {
    expect(isDissentableAssistant({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: " ok " }] } as any)).toBe(true);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] } as any)).toBe(true);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "intermediate" }, { type: "toolCall" }] } as any)).toBe(false);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "bad" }] } as any)).toBe(false);
    expect(isDissentableAssistant({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall" }] } as any)).toBe(false);
  });
});
