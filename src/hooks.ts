import { buildSessionContext, type ExtensionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractAssistantTrace, extractCompactionSummaries, extractLastUserText, extractText } from "./extract.js";
import type { JevRequest } from "./jev.js";

export const QUESTION_HOOKS = [
  "session_start", "session_tree", "session_compact",
  "input", "before_agent_start", "agent_start", "agent_end",
  "turn_start", "turn_end", "context", "message_end",
  "tool_call", "tool_result", "tool_execution_start", "tool_execution_end",
] as const satisfies readonly ExtensionEvent["type"][];

export type QuestionHook = typeof QUESTION_HOOKS[number];
export type QuestionEvent = Extract<ExtensionEvent, { type: QuestionHook }>;
export type HookEvent = Exclude<QuestionEvent, { type: "agent_end" }>;

type Message = Extract<ExtensionEvent, { type: "message_end" }>["message"];

function snapshotMessage(message: Message) {
  if (message.role === "assistant") {
    const trace = extractAssistantTrace([message]);
    return { role: message.role, content: trace.text, thinking: trace.thinking, stopReason: message.stopReason };
  }
  if (message.role === "toolResult") {
    return {
      role: message.role, toolCallId: message.toolCallId, toolName: message.toolName,
      content: extractText(message.content), isError: message.isError,
    };
  }
  if (message.role === "user") {
    return { role: message.role, content: extractText(message.content) };
  }
  return null;
}

// Select text and event data explicitly: never forward system prompts, images,
// provider metadata, or opaque tool details just because a hook gained a field.
function snapshotEvent(event: HookEvent): object {
  switch (event.type) {
    case "input":
      return { type: event.type, text: event.text, source: event.source, streamingBehavior: event.streamingBehavior };
    case "before_agent_start":
      return { type: event.type, prompt: event.prompt };
    case "agent_start":
      return { type: event.type };
    case "session_start":
      return { type: event.type, reason: event.reason };
    case "session_tree":
      return { type: event.type, newLeafId: event.newLeafId, oldLeafId: event.oldLeafId };
    case "session_compact":
      return { type: event.type, summary: event.compactionEntry.summary, fromExtension: event.fromExtension };
    case "turn_start":
      return { type: event.type, turnIndex: event.turnIndex, timestamp: event.timestamp };
    case "turn_end":
      return {
        type: event.type, turnIndex: event.turnIndex,
        message: snapshotMessage(event.message), toolResults: event.toolResults.map(snapshotMessage),
      };
    case "context":
      return { type: event.type, messages: event.messages.map(snapshotMessage).filter((message) => message !== null) };
    case "message_end":
      return { type: event.type, message: snapshotMessage(event.message) };
    case "tool_call":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    case "tool_result":
      return {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        input: event.input, content: extractText(event.content), isError: event.isError,
      };
    case "tool_execution_start":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_end":
      return {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        content: extractText(event.result?.content), isError: event.isError,
      };
  }
}

function messagesForEvent(event: HookEvent, messages: readonly Message[]): readonly Message[] {
  if (event.type === "context") return event.messages;
  if (event.type !== "message_end" && event.type !== "turn_end") return messages;
  // message_end runs before Pi persists the message. turn_end normally runs after it.
  const index = messages.findIndex((message) =>
    message.role === event.message.role && message.timestamp === event.message.timestamp);
  return index < 0 ? [...messages, event.message]
    : messages.map((message, i) => i === index ? event.message : message);
}

function currentRun(messages: readonly Message[]): readonly Message[] {
  const lastUser = messages.reduce((last, message, index) => message.role === "user" ? index : last, 0);
  return messages.slice(lastUser);
}

export function prepareHookRequest(
  event: HookEvent,
  entries: readonly SessionEntry[],
  leafId: string | null,
  questions: JevRequest["questions"],
  prompt?: string,
): JevRequest | null {
  if (Object.keys(questions).length === 0) return null;
  if (event.type === "message_end" && snapshotMessage(event.message) === null) return null;

  const context = buildSessionContext([...entries], leafId);
  const messages = currentRun(messagesForEvent(event, context.messages));

  const starting = event.type === "input" || event.type === "before_agent_start" || event.type === "agent_start";
  const userText = event.type === "input" ? event.text
    : event.type === "before_agent_start" ? event.prompt
    : event.type === "agent_start" ? prompt ?? ""
    : extractLastUserText(messages);
  return {
    questions,
    state: {
      event: snapshotEvent(event),
      userText,
      assistantTrace: starting ? { thinking: "", text: "" } : extractAssistantTrace(messages),
      compactionSummaries: extractCompactionSummaries(context),
    },
  };
}
