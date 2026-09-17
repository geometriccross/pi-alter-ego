import { describe, expect, it, vi } from "vitest";
import { runDissent, type DissentDeps } from "../src/cycle.js";
import type { DissentAssessment } from "../src/assessment.js";
import { createAlterEgoState } from "../src/state.js";

const assessment: DissentAssessment = { version: 1, outcome: "clear", language: "en", model: "jev-test", checks: [], policy: { threshold: 0.85, quoteConfidence: 0.5 }, usage: { input_tokens: 1, output_tokens: 1 } };
const basicMessages = [
  { role: "user", content: "Ship it?" },
  { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Not verified." }, { type: "text", text: "Ship it." }] },
];
function makeDeps(overrides: Partial<DissentDeps> = {}): DissentDeps {
  const state = createAlterEgoState();
  return { evaluate: vi.fn().mockResolvedValue(assessment), isCurrent: () => true, claimLeaf: state.claimLeaf, ...overrides };
}

describe("dissent cycle", () => {
  it("returns a typed assessment and supplies context with current-run evidence", async () => {
    const deps = makeDeps();
    expect(await runDissent(basicMessages, { messages: [{ role: "compactionSummary", summary: "Earlier work" }] }, "leaf", deps)).toBe(assessment);
    expect(deps.evaluate).toHaveBeenCalledWith({
      userText: "Ship it?", assistantTrace: { thinking: "Not verified.", text: "Ship it." }, evidenceDigest: [], compactionSummaries: ["Earlier work"],
    });
  });
  it("skips when neither thinking nor execution evidence is visible", async () => {
    const deps = makeDeps();
    expect(await runDissent([{ role: "assistant", stopReason: "stop", content: "Done." }], {}, "leaf", deps)).toBeNull();
    expect(deps.evaluate).not.toHaveBeenCalled();
  });
  it("compares a no-thinking final against earlier tool-turn thinking and tool results", async () => {
    const deps = makeDeps();
    const messages = [
      { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "Need tests." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: "Tests 1 failed (1)" },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Passed." }] },
    ];
    await runDissent(messages, {}, "leaf", deps);
    expect(deps.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      assistantTrace: { thinking: "Need tests.", text: "Passed." },
      evidenceDigest: [{ toolName: "bash", summary: "bash test → 1 test failed", isError: true }],
    }));
    const withoutThinking = messages.slice(1);
    expect(await runDissent(withoutThinking, {}, "leaf2", deps)).toBe(assessment);
  });
  it.each(["toolUse", "error", "aborted", "pending"])("skips %s final messages", async (stopReason) => {
    const deps = makeDeps();
    expect(await runDissent([{ ...basicMessages[1], stopReason }], {}, "leaf", deps)).toBeNull();
    expect(deps.evaluate).not.toHaveBeenCalled();
  });
  it("does not suppress a new answer merely because older Alter Ego feedback is in the run", async () => {
    const deps = makeDeps();
    const old = { role: "custom", customType: "alter-ego", content: "old" };
    expect(await runDissent([old, ...basicMessages], {}, "leaf", deps)).toBe(assessment);
    expect(await runDissent([...basicMessages, old], {}, "other", deps)).toBeNull();
    expect(deps.evaluate).toHaveBeenCalledOnce();
  });
  it("deduplicates concurrent and completed evaluations of a source leaf", async () => {
    const deps = makeDeps();
    const first = runDissent(basicMessages, {}, "leaf", deps);
    expect(await runDissent(basicMessages, {}, "leaf", deps)).toBeNull();
    await first;
    expect(await runDissent(basicMessages, {}, "leaf", deps)).toBeNull();
    expect(deps.evaluate).toHaveBeenCalledOnce();
  });
  it("releases a failed leaf so a later attempt can retry", async () => {
    const evaluate = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(assessment);
    const deps = makeDeps({ evaluate });
    await expect(runDissent(basicMessages, {}, "leaf", deps)).rejects.toThrow("unavailable");
    expect(await runDissent(basicMessages, {}, "leaf", deps)).toBe(assessment);
  });
  it.each([false, true])("discards a stale result (error=%s) and releases its claim", async (fail) => {
    let current = true;
    const evaluate = vi.fn(async () => { current = false; if (fail) throw new Error("stale"); return assessment; });
    const deps = makeDeps({ evaluate, isCurrent: () => current });
    expect(await runDissent(basicMessages, {}, "leaf", deps)).toBeNull();
    current = true;
    expect(deps.claimLeaf("leaf")).not.toBeNull();
  });
});
