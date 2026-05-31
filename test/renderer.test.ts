import { describe, expect, it } from "vitest";
import { alterEgoContentToText } from "../src/renderer.ts";

describe("message renderer helpers", () => {
  it("extracts text from string and text content blocks", () => {
    expect(alterEgoContentToText("plain")).toBe("plain");
    expect(alterEgoContentToText([
      { type: "text", text: "first" },
      { type: "image", data: "ignored" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });
});
