import { describe, expect, it } from "vitest";
import { buildAlterEgoArgs, extractFinalAssistantText } from "../src/spawn.ts";

describe("JSONL extraction", () => {
  it("returns the last successful assistant text and ignores malformed/error lines", () => {
    const jsonl = [
      "not json",
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "bad" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final" }] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("final");
  });
});

describe("spawn invocation args", () => {
  it("runs pi in isolated print JSON mode with model and temp system prompt", () => {
    const args = buildAlterEgoArgs({ model: "openai/gpt-4.1", systemPromptPath: "/tmp/system.txt", context: "ctx" });
    expect(args).toEqual([
      "-p", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-context-files", "--no-skills",
      "--model", "openai/gpt-4.1", "--system-prompt", "/tmp/system.txt", "ctx",
    ]);
  });

  it("truncates overlong context from the head so latest Dissentable text survives", () => {
    const args = buildAlterEgoArgs({ model: "m", systemPromptPath: "s", context: `old ${"x".repeat(20)} latest-assistant`, maxPromptLength: 16 });
    expect(args.at(-1)).toBe("[古いコンテキストは長さ制限のため省略されました]\n\nlatest-assistant");
  });
});
