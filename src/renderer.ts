import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export function alterEgoContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  }
  return String(content ?? "");
}

export function renderAlterEgoMessage(message: any, options: { expanded?: boolean }, theme: any) {
  let text = theme.fg("warning", "⚠️ Alter Ego:");
  text += "\n" + alterEgoContentToText(message.content);

  if (options.expanded && message.details) {
    text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  }

  const container = new Container();
  const border = (s: string) => theme.fg("error", s);
  container.addChild(new DynamicBorder(border));
  container.addChild(new Text(text, 1, 0));
  container.addChild(new DynamicBorder(border));
  return container;
}
