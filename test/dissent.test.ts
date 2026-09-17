import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findDissentSource, prepareDissentRequest } from "../src/dissent.js";
import type { JevRequest } from "../src/jev.js";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

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
  const sourceLeafId = manager.appendMessage(assistant);
  const leafId = manager.appendCustomEntry("metadata", { label: "after answer" });
  return { manager, userId, sourceLeafId, leafId };
}

describe("pure dissent preparation", () => {
  it("composes frozen snapshots without mutation and uses only the selected leaf's context", () => {
    const { manager, userId, sourceLeafId, leafId } = session();
    const branch = freeze(manager.getBranch());
    manager.branch(userId);
    manager.appendCompaction("Unrelated branch summary.", userId, 200);
    const entries = freeze(manager.getEntries());
    const messages = freeze([user, assistant]);

    const source = findDissentSource(leafId, branch)!;
    expect(source).toEqual({ leafId, sourceLeafId });
    expect(findDissentSource(leafId, branch)).toEqual(source);

    const request = prepareDissentRequest(messages, entries, source.leafId, questions);
    expect(request).toEqual({
      state: {
        userText: "Ship it?",
        assistantTrace: {
          thinking: "Input validation is untested.",
          text: "Fully verified.",
        },
        compactionSummaries: ["Earlier checks remain incomplete."],
      },
      questions,
    });
    expect(prepareDissentRequest(messages, entries, source.leafId, questions)).toEqual(request);
  });

  it("requires both a leaf and an assistant source", () => {
    const { manager, leafId } = session();
    expect(findDissentSource(null, manager.getBranch())).toBeNull();
    expect(findDissentSource(leafId, [])).toBeNull();
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
    {
      name: "already evaluated answer",
      messages: [user, assistant, { role: "custom", customType: "alter-ego", content: "Already evaluated" }],
    },
  ])("skips $name", ({ messages }) => {
    const { manager, leafId } = session();
    expect(prepareDissentRequest(freeze(messages), manager.getEntries(), leafId, questions)).toBeNull();
  });
});
