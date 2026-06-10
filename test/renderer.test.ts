import { describe, expect, it, vi } from "vitest";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { alterEgoContentToText, renderAlterEgoMessage } from "../src/renderer.ts";

// Mock getMarkdownTheme to avoid Theme not initialized error.
// Uses a Proxy so any unmocked method throws instead of silently returning undefined.
const passthrough = (t: string) => t;
const markdownThemeHandlers: Record<string, (t: string) => string> = {
  heading: passthrough,
  link: passthrough,
  linkUrl: passthrough,
  code: passthrough,
  codeBlock: passthrough,
  codeBlockBorder: passthrough,
  quote: passthrough,
  quoteBorder: passthrough,
  hr: passthrough,
  listBullet: passthrough,
  bold: passthrough,
  italic: passthrough,
  strikethrough: passthrough,
  underline: passthrough,
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getMarkdownTheme: () =>
      new Proxy(markdownThemeHandlers, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          throw new Error(`Unexpected markdownTheme method: ${prop}`);
        },
      }),
  };
});

/** Build a mock theme that tags all calls. Unknown methods throw. */
function mockTheme() {
  const handler: Record<string, (...args: string[]) => string> = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
    italic: (text: string) => `<italic>${text}</italic>`,
    bold: (text: string) => `<bold>${text}</bold>`,
    underline: (text: string) => `<underline>${text}</underline>`,
    strikethrough: (text: string) => `<strike>${text}</strike>`,
    inverse: (text: string) => `<inverse>${text}</inverse>`,
  };
  return new Proxy(handler, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      throw new Error(`Unexpected theme method: ${prop}`);
    },
  });
}

function renderOutput(message: any, options: { expanded?: boolean } = {}) {
  const theme = mockTheme();
  const component = renderAlterEgoMessage(message, options, theme);
  return { component, output: component.render(80).join("\n") };
}

describe("alterEgoContentToText", () => {
  it("extracts text from string content", () => {
    expect(alterEgoContentToText("plain")).toBe("plain");
  });

  it("extracts text from content blocks, skipping non-text types", () => {
    expect(alterEgoContentToText([
      { type: "text", text: "first" },
      { type: "image", data: "ignored" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });
});

describe("renderAlterEgoMessage", () => {
  it("returns a Container without DynamicBorder", () => {
    const { component } = renderOutput({ content: "hello" });
    expect(component).toBeInstanceOf(Container);
    expect(component.children.some((child) => child instanceof DynamicBorder)).toBe(false);
  });

  it("renders the label line with thinkingText color and italic", () => {
    const { output } = renderOutput({ content: "hello" });
    expect(output).toContain("<italic><thinkingText>");
    expect(output).toContain("Alter Ego");
  });

  it("renders body text via Markdown with thinkingText color and italic", () => {
    const { output } = renderOutput({ content: "**counterpoint**" });
    // Markdown processes ** into bold; the text content must be present
    expect(output).toContain("counterpoint");
    // thinkingText color must appear beyond the label line (i.e., in the body)
    const matches = output.match(/<thinkingText>/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it("does not use error-colored borders", () => {
    const { output } = renderOutput({ content: "hello" });
    expect(output).not.toContain("<error>");
  });

  it("shows details in dim color when expanded", () => {
    const { output } = renderOutput(
      { content: "test", details: { key: "val" } },
      { expanded: true },
    );
    expect(output).toContain("<dim>");
    expect(output).toContain('"key"');
  });

  it("hides details when not expanded", () => {
    const { output } = renderOutput(
      { content: "test", details: { key: "val" } },
      {},
    );
    expect(output).not.toContain("<dim>");
  });
});
