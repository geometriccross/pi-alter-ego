import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export const renderAlterEgoMessage: MessageRenderer = (message, options, theme) => {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

  const details = message.details as {
    response?: unknown;
    assessment?: { version?: number };
  } | undefined;
  const label =
    details?.response || details?.assessment?.version === 1
      ? "Alter Ego / Jev"
      : "Alter Ego";

  const container = new Container();
  container.addChild(new Text(theme.fg("accent", `── ${label} ──`), 1, 0));
  // Quotes are data: don't interpret source Markdown or terminal controls.
  container.addChild(new Text(safeDisplay(content), 1, 0));

  if (options.expanded && message.details) {
    const detailsText = safeDisplay(JSON.stringify(message.details, null, 2));
    container.addChild(new Text(theme.fg("dim", detailsText), 1, 0));
  }

  return container;
};

function safeDisplay(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
