import { describe, expect, it } from "vitest";
import { extractAssistantTrace, extractLastUserText, isDissentableAssistant } from "../src/extract.js";

describe("reasoning trace extraction", () => {
  it("returns the latest user text from event messages", () => {
    const text = extractLastUserText([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "latest" },
    ] as any);

    expect(text).toBe("latest");
  });

  it("extracts assistant final text and thinking from the latest assistant message", () => {
    expect(extractAssistantTrace([
      { role: "assistant", content: [
        { type: "thinking", thinking: "check risks" },
        { type: "text", text: "Ship it." },
      ] },
    ] as any)).toEqual({ thinking: "check risks", text: "Ship it." });
  });

  it("handles partial or non-array assistant content without inventing trace data", () => {
    expect(extractAssistantTrace([{ role: "assistant", content: [{ type: "thinking", thinking: "only thought" }] }] as any)).toEqual({ thinking: "only thought", text: "" });
    expect(extractAssistantTrace([{ role: "assistant", content: [{ type: "text", text: "only text" }] }] as any)).toEqual({ thinking: "", text: "only text" });
    expect(extractAssistantTrace([{ role: "assistant", content: "string content" }] as any)).toEqual({ thinking: "", text: "string content" });
    expect(extractAssistantTrace([{ role: "assistant", content: [
      { type: "thinking", thinking: "visible" },
      { type: "redacted", thinking: "secret" },
      { type: "text", text: "answer" },
    ] }] as any)).toEqual({ thinking: "visible", text: "answer" });
    expect(extractAssistantTrace([])).toEqual({ thinking: "", text: "" });
  });


  it("rejects malformed, pending, and tool-call messages without throwing", () => {
    for (const value of [null, {}, { role: "assistant", content: [null, { type: "text", text: 42 }] },
      { role: "assistant", stopReason: "pending", content: "hello" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x" }, { type: "toolCall" }] }]) {
      expect(isDissentableAssistant(value)).toBe(false);
    }
    expect(isDissentableAssistant({ role: "assistant", stopReason: "stop", content: "Done." })).toBe(true);
  });

});
