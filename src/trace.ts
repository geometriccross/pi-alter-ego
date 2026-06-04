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

export interface AssistantTrace {
  thinking: string;
  text: string;
}

export function extractAssistantTrace(messages: readonly unknown[]): AssistantTrace {
  const assistant = [...(messages as any[])].reverse().find((msg) => msg?.role === "assistant");
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

export function escapeXmlSectionText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
