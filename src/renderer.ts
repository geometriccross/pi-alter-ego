import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { buildAlterEgoMessageView } from "./message-view.js";

export { safeDisplay } from "./message-view.js";

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
