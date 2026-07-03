import { describe, expect, it } from "vitest";
import { buildEvidenceDigest, serializeEvidence } from "../src/evidence.ts";
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

  it("returns null when no valid message_end exists", () => {
    const jsonl = [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
  });

  it("handles string content on assistant messages", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "plain string response" } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("plain string response");
  });

  it("handles content with no text blocks (thinking-only response)", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "thought" }] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
  });

  it("falls back to agent_end when no message_end has valid text", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO_DISSENT" }] },
        ],
      }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("NO_DISSENT");
  });

  it("prefers message_end over agent_end when both are present", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "from message_end" }] } }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "from agent_end" }] },
        ],
      }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("from message_end");
  });

  it("skips aborted messages in agent_end fallback", () => {
    const jsonl = [
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "nope" }] },
        ],
      }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
  });

  it("returns last assistant text from agent_end when multiple messages present", () => {
    const jsonl = [
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }] },
          { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second" }] },
        ],
      }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("second");
  });

  it("handles empty content array", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
  });

  it("handles whitespace-only text", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "   " }] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
  });

  it("joins multiple text blocks in one message", () => {
    const jsonl = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }] } }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBe("hello world");
  });

  it("ignores non-assistant roles in agent_end", () => {
    const jsonl = [
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: "q" },
          { role: "toolResult", content: "result" },
        ],
      }),
    ].join("\n");
    expect(extractFinalAssistantText(jsonl)).toBeNull();
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

  it("preserves core sections over long visible_execution_evidence under truncation", () => {
    const messages = [];
    // Create 20 tool calls to generate large evidence
    for (let i = 1; i <= 20; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${i}`, toolName: "bash", args: { command: `echo test${i}` } }],
      });
      messages.push({
        role: "toolResult",
        toolCallId: `call-${i}`,
        toolName: "bash",
        isError: false,
        content: "x".repeat(200),
      });
    }

    const evidence = buildEvidenceDigest(messages);
    const serialized = serializeEvidence(evidence);

    const context = buildUserPrompt({
      userMessage: "hello",
      assistantThinking: "think",
      assistantFinal: "answer",
      compactionSummaries: [],
      visibleExecutionEvidence: serialized,
    });

    const args = buildAlterEgoArgs({ model: "m", systemPromptPath: "s", context, maxPromptLength: 300 });
    const prompt = args.at(-1)!;

    // Core sections must survive tail-preserving truncation.
    expect(prompt).toContain("<user_message>");
    expect(prompt).toContain("hello");
    expect(prompt).toContain("<assistant_thinking>");
    expect(prompt).toContain("think");
    expect(prompt).toContain("<assistant_final>");
    expect(prompt).toContain("answer");

    // Evidence is lower priority and should be dropped.
    expect(prompt).not.toContain("<visible_execution_evidence>");
  });
});
