// ponytail: single module consolidating all pi message shape knowledge.
// trace.ts / state.ts re-export from here for backward compat.

export { EvidenceItem, buildEvidenceDigest, serializeEvidence } from "./evidence.js";

// ─── Assistant trace ─────────────────────────────────────────────────

export interface AssistantTrace {
  thinking: string;
  text: string;
}

export function extractAssistantTrace(messages: readonly unknown[]): AssistantTrace {
  const assistant = findLastAssistant(messages);
  return extractTraceFromAssistant(assistant);
}

/** Extract trace from a single assistant message (avoids double-scan when caller already found it). */
export function extractTraceFromAssistant(message: unknown): AssistantTrace {
  const assistant = message as any;
  if (!assistant) return { thinking: "", text: "" };
  if (typeof assistant.content === "string") return { thinking: "", text: assistant.content };
  if (!Array.isArray(assistant.content)) return { thinking: "", text: "" };

  const thinking = assistant.content
    .filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part: any) => part.thinking)
    .join("");
  const text = assistant.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
  return { thinking, text };
}

// ─── Last user text ──────────────────────────────────────────────────

export function extractLastUserText(messages: readonly unknown[]): string {
  for (const msg of [...(messages as any[])].reverse()) {
    if (msg?.role !== "user") continue;
    return extractText(msg.content);
  }
  return "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
  }
  return "";
}

// ─── Message checks ──────────────────────────────────────────────────

export function hasAlterEgoMessage(messages: readonly unknown[]): boolean {
  return (messages as any[]).some((msg) => msg?.customType === "alter-ego");
}

export function isDissentableAssistant(message: unknown): boolean {
  const msg = message as any;
  if (msg?.role !== "assistant") return false;
  if (["toolUse", "error", "aborted"].includes(msg.stopReason)) return false;
  return Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "text" && part.text.trim().length > 0);
}

/** Find the last assistant message (avoids double-scanning in callers). */
export function findLastAssistant(messages: readonly unknown[]): unknown {
  return [...(messages as any[])].reverse().find((msg) => msg?.role === "assistant") ?? null;
}

// ─── Compaction summaries ────────────────────────────────────────────

export function extractCompactionSummaries(sessionContext: unknown): string[] {
  const ctx = sessionContext as any;
  const msgs: unknown[] = ctx?.messages ?? [];
  return (msgs as any[])
    .filter((m: any) => m?.role === "compactionSummary" && typeof m.summary === "string")
    .map((m: any) => m.summary);
}
