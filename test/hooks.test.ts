import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareRequest, type QuestionEvent, type JevRequest } from "../src/evaluation.js";
import { freeze } from "./helpers.js";

const questions: JevRequest["questions"] = {
  check: { type: "noul", instructions: "Does the event need attention?" },
};
const user = { role: "user", content: "Current request", timestamp: 1 } as const;
const assistant = {
  role: "assistant", stopReason: "toolUse", timestamp: 2,
  content: [{ type: "thinking", thinking: "Check the result." }, { type: "text", text: "Checking." }],
};
const toolResult = {
  role: "toolResult", toolName: "bash", toolCallId: "check", timestamp: 3,
  content: [{ type: "text", text: "Failed." }], isError: true,
};

function session() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Old request", timestamp: 0 });
  manager.appendMessage({ ...assistant, timestamp: 0, content: [{ type: "thinking", thinking: "Old thinking." }] } as any);
  const userId = manager.appendMessage(user);
  return { manager, userId };
}

describe("hook state snapshots", () => {
  it("uses the current branch's summary and does not duplicate an already persisted turn_end message", () => {
    const { manager, userId } = session();
    manager.appendCompaction("Current branch summary", userId, 100);
    manager.appendMessage(assistant as any);
    manager.appendMessage(toolResult as any);
    const leafId = manager.getLeafId()!;
    manager.branch(userId);
    manager.appendCompaction("Other branch summary", userId, 200);

    const event = freeze({
      type: "turn_end", turnIndex: 0, message: structuredClone(assistant), toolResults: [toolResult],
    } as QuestionEvent);
    const entries = freeze(manager.getEntries());
    const request = prepareRequest(event, entries, leafId, freeze(questions));
    expect(prepareRequest(event, entries, leafId, questions)).toEqual(request);
    expect(request?.state).toEqual({
      event: {
        type: "turn_end", turnIndex: 0,
        message: { role: "assistant", content: "Checking.", thinking: "Check the result.", stopReason: "toolUse" },
        toolResults: [{ role: "toolResult", toolName: "bash", toolCallId: "check", content: "Failed.", isError: true }],
      },
      userText: "Current request",
      assistantTrace: { thinking: "Check the result.", text: "Checking." },
      compactionSummaries: ["Current branch summary"],
    });
  });

  it("uses an incoming user message before persistence without borrowing the previous run's trace", () => {
    const { manager } = session();
    manager.appendMessage(assistant as any);
    const request = prepareRequest({
      type: "message_end", message: { role: "user", content: "Next request", timestamp: 4 },
    }, manager.getEntries(), manager.getLeafId(), questions);
    expect(request?.state).toMatchObject({
      event: { type: "message_end", message: { role: "user", content: "Next request" } },
      userText: "Next request", assistantTrace: { thinking: "", text: "" },
    });
  });

  it("uses context event messages rather than older session messages and excludes non-text metadata", () => {
    const { manager } = session();
    const request = prepareRequest({
      type: "context",
      messages: [
        { ...user, content: [{ type: "text", text: "Transformed request" }, { type: "image", data: "image", mimeType: "image/png" }] },
        { ...assistant, content: [{ type: "thinking", thinking: "Visible thought", thinkingSignature: "signature" }, { type: "text", text: "Visible answer" }] },
        { ...toolResult, details: { secret: "private metadata" } },
        { role: "custom", customType: "alter-ego", content: "Earlier judgment" },
      ],
    } as QuestionEvent, manager.getEntries(), manager.getLeafId(), questions);
    expect(request?.state).toEqual({
      event: {
        type: "context",
        messages: [
          { role: "user", content: "Transformed request" },
          { role: "assistant", content: "Visible answer", thinking: "Visible thought", stopReason: "toolUse" },
          { role: "toolResult", toolName: "bash", toolCallId: "check", content: "Failed.", isError: true },
        ],
      },
      userText: "Transformed request", assistantTrace: { thinking: "Visible thought", text: "Visible answer" },
      compactionSummaries: [],
    });
  });
});
