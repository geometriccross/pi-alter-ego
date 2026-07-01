// ponytail: single module for all XML escaping — one concern, one home.
// Text content (element body) uses one set of escapes; attribute values use another.
// Both are XML-serialization correctness rules, not business logic.

/** Escape text content for XML element bodies (& < >). */
export function escapeXmlSectionText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for XML attribute double-quoted values (& " < >). */
export function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
