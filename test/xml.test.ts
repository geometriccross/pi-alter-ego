import { describe, expect, it } from "vitest";
import { escapeXmlAttr } from "../src/xml.ts";

describe("escapeXmlAttr", () => {
  it("escapes double-quote for XML attribute values", () => {
    expect(escapeXmlAttr('he said "hello"')).toBe("he said &quot;hello&quot;");
  });
});
