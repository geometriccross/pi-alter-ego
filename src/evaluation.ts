import { buildSessionContext, type ExtensionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JevDescription = string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type JevQuestion =
  | {
      readonly type: "noul";
      readonly instructions: JevDescription;
      readonly criteria?: {
        readonly true?: JevDescription;
        readonly false?: JevDescription;
      };
    }
  | {
      readonly type: "choice";
      readonly instructions: JevDescription;
      readonly criteria: Readonly<Record<string, JevDescription>>;
    }
  | {
      readonly type: "score";
      readonly instructions: JevDescription;
      readonly criteria: readonly JevDescription[];
    };

export interface JevRequest {
  readonly state: object | string;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, JevDescription>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>>;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}

const QUESTION_HOOKS = [
  "session_start", "session_tree", "session_compact",
  "input", "before_agent_start", "agent_start", "agent_end",
  "turn_start", "turn_end", "context", "message_end",
  "tool_call", "tool_result", "tool_execution_start", "tool_execution_end",
] as const satisfies readonly ExtensionEvent["type"][];

export type QuestionHook = typeof QUESTION_HOOKS[number];
export type QuestionEvent = Extract<ExtensionEvent, { type: QuestionHook }>;
type HookEvent = Exclude<QuestionEvent, { type: "agent_end" }>;
type Message = Extract<ExtensionEvent, { type: "message_end" }>["message"];

export function prepareRequest(
  event: QuestionEvent,
  entries: readonly SessionEntry[],
  leafId: string | null,
  questions: JevRequest["questions"],
  prompt?: string,
): JevRequest | null {
  if (Object.keys(questions).length === 0) return null;
  if (event.type === "agent_end" && !isDissentableAssistant(findLastAssistant(event.messages))) return null;
  if (event.type === "message_end" && snapshotMessage(event.message) === null) return null;

  const context = buildSessionContext([...entries], leafId);
  const messages = event.type === "agent_end"
    ? event.messages : currentRun(messagesForEvent(event, context.messages));
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
function snapshotEvent(event: QuestionEvent): object {
  switch (event.type) {
    case "input":
      return { type: event.type, text: event.text, source: event.source, streamingBehavior: event.streamingBehavior };
    case "before_agent_start":
      return { type: event.type, prompt: event.prompt };
    case "agent_start":
    case "agent_end":
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function textParts(content: unknown, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const value = record(part);
    return value?.type === type && typeof value[type] === "string" ? [value[type]] : [];
  }).join("");
}

function extractText(content: unknown): string {
  return textParts(content, "text");
}

/** Includes visible thinking from tool turns of this run, not just the final message. */
function extractAssistantTrace(messages: readonly unknown[]) {
  const last = findLastAssistant(messages);
  return {
    thinking: messages.flatMap((message) => {
      const value = record(message);
      if (value?.role !== "assistant" || value.stopReason === "error" || value.stopReason === "aborted") return [];
      const thinking = textParts(value.content, "thinking");
      return thinking ? [thinking] : [];
    }).join("\n\n"),
    text: textParts(record(last)?.content, "text"),
  };
}

function extractLastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = record(messages[i]);
    if (message?.role === "user") return textParts(message.content, "text");
  }
  return "";
}

function isDissentableAssistant(message: unknown): boolean {
  const value = record(message);
  if (value?.role !== "assistant" || !["stop", "length"].includes(String(value.stopReason))) return false;
  if (Array.isArray(value.content) && value.content.some((part) => record(part)?.type === "toolCall")) return false;
  return textParts(value.content, "text").trim().length > 0;
}

function findLastAssistant(messages: readonly unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (record(messages[i])?.role === "assistant") return messages[i];
  }
  return null;
}

function extractCompactionSummaries(sessionContext: unknown): string[] {
  const messages = record(sessionContext)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    const value = record(message);
    return value?.role === "compactionSummary" && typeof value.summary === "string" ? [value.summary] : [];
  });
}

export function prepareJevRequest(request: JevRequest): string {
  return JSON.stringify({ model: "jev-latest", state: request.state, questions: request.questions });
}

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface JevOptions {
  readonly apiKey: string | undefined;
  readonly signal?: AbortSignal;
}

export async function askJev(
  request: JevRequest,
  options: JevOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<JevResponse> {
  const response = await fetchImpl(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey?.trim() ?? ""}`,
      "Content-Type": "application/json",
    },
    body: prepareJevRequest(request),
    signal: options.signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Jev API: HTTP ${response.status}`);
  }
  return response.json() as Promise<JevResponse>;
}
