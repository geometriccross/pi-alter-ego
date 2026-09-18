import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { JevResponse, QuestionHook } from "./evaluation.js";

type DisplayMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

export interface AlterEgoMessageView {
  readonly heading: string;
  readonly content: string;
  readonly details: string | undefined;
}

export function formatEnabledStatus(enabled: boolean): string {
  return `Alter Ego / Jev: ${enabled ? "ON" : "OFF"}`;
}

export function buildDissentMessage(response: JevResponse) {
  return {
    customType: "alter-ego",
    content: JSON.stringify(response.answers, null, 2),
    display: true,
    details: { response },
  };
}

export function buildHookNotification(hook: Exclude<QuestionHook, "agent_end">, response: JevResponse): string {
  return safeDisplay(`Alter Ego / Jev (${hook})\n${JSON.stringify(response.answers, null, 2)}`);
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
function safeDisplay(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export const renderAlterEgoMessage: MessageRenderer = (message, options, theme) => {
  const view = buildAlterEgoMessageView(message, options.expanded);
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", view.heading), 1, 0));
  container.addChild(new Text(view.content, 1, 0));
  if (view.details !== undefined) {
    container.addChild(new Text(theme.fg("dim", view.details), 1, 0));
  }
  return container;
};
