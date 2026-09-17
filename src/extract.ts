export interface AssistantTrace {
  thinking: string;
  text: string;
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

/** Includes visible thinking from tool turns of this run, not just the final message. */
export function extractAssistantTrace(messages: readonly unknown[]): AssistantTrace {
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

export function extractLastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = record(messages[i]);
    if (message?.role === "user") return textParts(message.content, "text");
  }
  return "";
}

export function hasAlterEgoAfterAssistant(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = record(messages[i]);
    if (message?.customType === "alter-ego") return true;
    if (message?.role === "assistant") return false;
  }
  return false;
}

export function isDissentableAssistant(message: unknown): boolean {
  const value = record(message);
  if (value?.role !== "assistant" || !["stop", "length"].includes(String(value.stopReason))) return false;
  if (Array.isArray(value.content) && value.content.some((part) => record(part)?.type === "toolCall")) return false;
  return textParts(value.content, "text").trim().length > 0;
}

export function findLastAssistant(messages: readonly unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (record(messages[i])?.role === "assistant") return messages[i];
  }
  return null;
}

export function extractCompactionSummaries(sessionContext: unknown): string[] {
  const messages = record(sessionContext)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    const value = record(message);
    return value?.role === "compactionSummary" && typeof value.summary === "string" ? [value.summary] : [];
  });
}
