import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareRequest, type QuestionEvent, type JevRequest } from "../src/evaluation.js";
import { freeze } from "./helpers.js";

const user = freeze({ role: "user", content: "Ship it?", timestamp: 0 } as const);
const assistant = freeze<AssistantMessage>({
  role: "assistant",
  api: "openai-completions",
  provider: "synthetic",
  model: "test",
  stopReason: "stop",
  content: [
    { type: "thinking", thinking: "Input validation is untested." },
    { type: "text", text: "Fully verified." },
  ],
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 1,
});
const questions = freeze<JevRequest["questions"]>({
  release: { type: "noul", instructions: "Does `assistantTrace.text` recommend a release?" },
});

function session() {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage(user);
  manager.appendMessage(assistant);
  manager.appendCompaction("Earlier checks remain incomplete.", userId, 100);
  manager.appendMessage(assistant);
  const leafId = manager.appendCustomEntry("metadata", { label: "after answer" });
  return { manager, userId, leafId };
}

describe("pure dissent preparation", () => {
  it("composes frozen snapshots without mutation and uses only the selected leaf's context", () => {
    const { manager, userId, leafId } = session();
    manager.branch(userId);
    manager.appendCompaction("Unrelated branch summary.", userId, 200);
    const entries = freeze(manager.getEntries());
    const event = freeze({ type: "agent_end" as const, messages: [user, assistant] });

    const request = prepareRequest(event, entries, leafId, questions);
    expect(request).toEqual({
      state: {
        event: { type: "agent_end" },
        userText: "Ship it?",
        assistantTrace: {
          thinking: "Input validation is untested.",
          text: "Fully verified.",
        },
        compactionSummaries: ["Earlier checks remain incomplete."],
      },
      questions,
    });
    expect(prepareRequest(event, entries, leafId, questions)).toEqual(request);
  });

  it("uses the event's final answer without requiring a persisted source ID", () => {
    expect(prepareRequest({ type: "agent_end", messages: [user, assistant] }, [], null, questions)?.state).toMatchObject({
      userText: "Ship it?", assistantTrace: { thinking: "Input validation is untested.", text: "Fully verified." },
    });
  });

  it("does not skip an answer because an Alter Ego message follows it", () => {
    const { manager, leafId } = session();
    const event = freeze({
      type: "agent_end",
      messages: [user, assistant, { role: "custom", customType: "alter-ego", content: "Previous judgment" }],
    } as QuestionEvent);
    expect(prepareRequest(event, manager.getEntries(), leafId, questions)).toEqual(
      prepareRequest({ type: "agent_end", messages: [user, assistant] }, manager.getEntries(), leafId, questions),
    );
  });

  it.each([
    { name: "empty run", messages: [] },
    { name: "no assistant", messages: [user] },
    { name: "tool turn", messages: [user, { ...assistant, stopReason: "toolUse" }] },
    { name: "aborted answer", messages: [user, { ...assistant, stopReason: "aborted" }] },
    { name: "failed answer", messages: [user, { ...assistant, stopReason: "error" }] },
    { name: "blank answer", messages: [user, { ...assistant, content: " " }] },
    {
      name: "tool call despite stop reason",
      messages: [user, {
        ...assistant,
        content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }],
      }],
    },
  ])("skips $name", ({ messages }) => {
    const { manager, leafId } = session();
    const event = freeze({ type: "agent_end", messages } as QuestionEvent);
    expect(prepareRequest(event, manager.getEntries(), leafId, questions)).toBeNull();
  });
});
