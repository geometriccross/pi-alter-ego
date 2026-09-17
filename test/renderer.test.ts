import { describe, expect, it } from "vitest";
import { renderAlterEgoMessage } from "../src/renderer.js";

const theme = { fg: (_color: string, text: string) => text } as any;
const message = {
  role: "custom",
  customType: "alter-ego",
  display: true,
  timestamp: 0,
  content: "Jev judgment\nsource: **verbatim** [quote](https://example.invalid)",
  details: {
    response: {
      model: "jev-test",
      answers: { custom: { type: "noul", noul: 0.97 } },
    },
  },
} as const;

describe("Jev message renderer", () => {
  it("renders quotes literally, not as Markdown links or formatting", () => {
    const component = renderAlterEgoMessage(message, { expanded: false }, theme)!;
    const output = component.render(100).join("\n");
    expect(output).toContain("Alter Ego / Jev");
    expect(output).toContain("**verbatim**");
    expect(output).toContain("[quote](https://example.invalid)");
    expect(output).not.toContain("jev-test");
  });

  it("makes raw judgments available when expanded", () => {
    const output = renderAlterEgoMessage(message, { expanded: true }, theme)!.render(100).join("\n");
    expect(output).toContain('"noul": 0.97');
    expect(output).toContain("jev-test");
  });

  it("does not relabel historical generated messages as Jev, or execute terminal controls in details", () => {
    const legacy = {
      ...message,
      content: "old response",
      details: { quote: "\u009b2J\u001b[2J" },
    };
    const output = renderAlterEgoMessage(legacy, { expanded: true }, theme)!.render(100).join("\n");
    expect(output).not.toContain("/ Jev");
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u001b");
  });

  it("renders persisted text blocks too", () => {
    const storedMessage = {
      ...message,
      content: [{ type: "text" as const, text: "stored" }],
    };
    const output = renderAlterEgoMessage(storedMessage, { expanded: false }, theme)!
      .render(80)
      .join("\n");
    expect(output).toContain("stored");
  });
});
