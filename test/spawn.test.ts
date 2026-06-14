import { describe, expect, it } from "vitest";
import { buildUserPrompt } from "../src/prompt.ts";
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

  it("preserves core sections over long compaction summaries under truncation", () => {
    const context = buildUserPrompt({
      userMessage: "hello",
      assistantThinking: "think",
      assistantFinal: "answer",
      compactionSummaries: ["s".repeat(2000)],
    });
    const args = buildAlterEgoArgs({ model: "m", systemPromptPath: "s", context, maxPromptLength: 250 });
    const prompt = args.at(-1)!;

    // Core sections must survive tail-preserving truncation.
    expect(prompt).toContain("<user_message>");
    expect(prompt).toContain("hello");
    expect(prompt).toContain("<assistant_thinking>");
    expect(prompt).toContain("think");
    expect(prompt).toContain("<assistant_final>");
    expect(prompt).toContain("answer");

    // Compaction summaries are lower priority and should be dropped.
    expect(prompt).not.toContain("<compaction_summaries>");
  });
});
