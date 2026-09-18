import { describe, expect, it } from "vitest";
import { parseJevResponse, prepareJevRequest, retryDelay, type JevRequest } from "../src/jev-protocol.js";
import { freeze } from "./helpers.js";

const request = freeze<JevRequest>({
  state: { text: "Synthetic check" },
  questions: { check: { type: "noul", instructions: "Is this ready?" } },
});
const payload = freeze({
  model: "jev-test",
  answers: { check: { type: "noul", noul: 0.4 } },
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("pure Jev protocol", () => {
  it("prepares and parses replayable frozen data without transport or ambient credentials", () => {
    const prepared = prepareJevRequest(request, " explicit-key ");
    expect(prepared).toEqual({
      ok: true,
      value: { apiKey: "explicit-key", body: JSON.stringify({ model: "jev-latest", ...request }) },
    });
    expect(prepareJevRequest(request, " explicit-key ")).toEqual(prepared);
    const parsed = parseJevResponse(payload, request.questions);
    expect(parsed).toEqual({ ok: true, value: payload });
    expect(parseJevResponse(payload, request.questions)).toEqual(parsed);
  });

  it("preserves arbitrary question and option IDs without prototype setters", () => {
    const questions = freeze(JSON.parse('{"__proto__":{"type":"choice","instructions":"Choose","criteria":{"__proto__":null,"constructor":null}}}'));
    const response = freeze({
      ...payload,
      answers: JSON.parse('{"__proto__":{"type":"choice","choice":"__proto__","confidence":1,"probabilities":{"__proto__":1,"constructor":0}}}'),
    });
    const parsed = parseJevResponse(response, questions);
    expect(parsed).toEqual({ ok: true, value: response });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.getPrototypeOf(parsed.value.answers)).toBeNull();
    expect(Object.hasOwn(parsed.value.answers, "__proto__")).toBe(true);
  });

  const now = Date.parse("2026-01-01T00:00:00Z");
  it.each([
    { status: 429, attempt: 0, header: null, expected: 500 },
    { status: 529, attempt: 1, header: "invalid", expected: 1000 },
    { status: 429, attempt: 0, header: "2", expected: 2000 },
    { status: 529, attempt: 0, header: "0.75", expected: 750 },
    { status: 429, attempt: 1, header: "0.1", expected: 1000 },
    { status: 429, attempt: 0, header: "Thu, 01 Jan 2026 00:00:03 GMT", expected: 3000 },
    { status: 529, attempt: 0, header: "Wed, 31 Dec 2025 23:59:59 GMT", expected: 500 },
    { status: 429, attempt: 0, header: "9999999999", expected: 2_147_483_647 },
    { status: 429, attempt: 2, header: "10", expected: null },
    { status: 529, attempt: 2, header: null, expected: null },
    { status: 500, attempt: 0, header: "10", expected: null },
    { status: 200, attempt: 0, header: null, expected: null },
  ])("computes retry policy from explicit time: $status / $attempt / $header", ({ status, attempt, header, expected }) => {
    expect(retryDelay(status, header, attempt, now)).toBe(expected);
  });
});
