import type { MessageRenderer } from "@earendil-works/pi-coding-agent";

type DisplayMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

export interface AlterEgoMessageView {
  readonly heading: string;
  readonly content: string;
  readonly details: string | undefined;
}

export function buildAlterEgoMessageView(message: DisplayMessage, expanded: boolean): AlterEgoMessageView {
  const content = typeof message.content === "string" ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const details = message.details as {
    response?: unknown;
    assessment?: { version?: number };
  } | undefined;
  const label = details?.response || details?.assessment?.version === 1 ? "Alter Ego / Jev" : "Alter Ego";
  return {
    heading: `── ${label} ──`,
    content: safeDisplay(content),
    details: expanded && message.details ? safeDisplay(JSON.stringify(message.details, null, 2)) : undefined,
  };
}

// Quotes are data: don't interpret source Markdown or terminal controls.
export function safeDisplay(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
