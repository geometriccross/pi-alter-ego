import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

export function alterEgoContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  }
  return String(content ?? "");
}

export function renderAlterEgoMessage(message: any, options: { expanded?: boolean }, theme: any) {
  const contentText = alterEgoContentToText(message.content);
  const markdownTheme = getMarkdownTheme();
  const container = new Container();

  container.addChild(new Text(
    theme.italic(theme.fg("thinkingText", "── 🤔 Alter Ego ──")),
    1,
    0,
  ));
  container.addChild(new Markdown(contentText, 1, 0, markdownTheme, {
    color: (text: string) => theme.fg("thinkingText", text),
    italic: true,
  }));

  if (options.expanded && message.details) {
    container.addChild(new Text(theme.fg("dim", JSON.stringify(message.details, null, 2)), 1, 0));
  }

  return container;
}
