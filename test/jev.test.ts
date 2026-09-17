import { afterEach, describe, expect, it, vi } from "vitest";
import { askJev, JEV_ENDPOINT, MAX_REQUEST_BYTES, type JevRequest } from "../src/jev.js";
import { jevResponse } from "./fixtures.js";

const request: JevRequest = {
  model: "jev-latest", state: { text: "synthetic input" },
  questions: {
    contradiction: { type: "noul", instructions: "Does the final contradict the source?" },
    contradiction_source: { type: "choice", instructions: "Which source contradicts the final?", criteria: { none: "None", t0: "Source 0" } },
  },
};
const options = { apiKey: "test-key", timeoutMs: 1000 };

function pendingResponse() {
  return vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
}

afterEach(() => vi.useRealTimers());

describe("Jev HTTP boundary", () => {
  it("uses the v1 endpoint and validates typed answers without forwarding unknown fields", async () => {
    const payload = { ...jevResponse(request), debug: "private service data" };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    expect(await askJev(request, options, fetchImpl)).toEqual(jevResponse(request));
    expect(fetchImpl).toHaveBeenCalledWith(JEV_ENDPOINT, expect.objectContaining({
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual(request);
  });

  it("rejects absent credentials and oversized state before any request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(askJev(request, { ...options, apiKey: " " }, fetchImpl)).rejects.toThrow("TYPESAFE_API_KEY");
    await expect(askJev({ ...request, state: "あ".repeat(MAX_REQUEST_BYTES / 2) }, options, fetchImpl)).rejects.toThrow("切り詰めず未評価");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing answer", (p: any) => { delete p.answers.contradiction; }],
    ["wrong type", (p: any) => { p.answers.contradiction.type = "choice"; }],
    ["string probability", (p: any) => { p.answers.contradiction.noul = "0.99"; }],
    ["out of range", (p: any) => { p.answers.contradiction.noul = 1.01; }],
    ["unknown selection", (p: any) => { p.answers.contradiction_source.choice = "invented"; }],
    ["missing option", (p: any) => { delete p.answers.contradiction_source.probabilities.t0; }],
    ["unnormalized distribution", (p: any) => { p.answers.contradiction_source.probabilities.t0 = 0.8; }],
    ["wrong argmax", (p: any) => { p.answers.contradiction_source.choice = "t0"; }],
    ["missing confidence", (p: any) => { delete p.answers.contradiction_source.confidence; }],
    ["missing usage", (p: any) => { delete p.usage; }],
    ["negative tokens", (p: any) => { p.usage.input_tokens = -1; }],
    ["non Jev model", (p: any) => { p.model = "gpt-test"; }],
  ])("rejects %s instead of interpreting failure as no dissent", async (_name, mutate) => {
    const payload = jevResponse(request);
    mutate(payload);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await expect(askJev(request, options, fetchImpl)).rejects.toThrow("応答形式");
  });

  it.each([401, 422, 500])("reports HTTP %s without leaking the response body or retrying", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("SECRET echoed state", { status }));
    await expect(askJev(request, options, fetchImpl)).rejects.toThrow(`HTTP ${status}（未評価）`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failures and invalid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("test-key SECRET state"))
      .mockResolvedValueOnce(new Response("not json SECRET"));
    for (let i = 0; i < 2; i++) {
      await expect(askJev(request, options, fetchImpl)).rejects.toThrow("Jevとの通信または応答形式に問題があります（未評価）");
    }
  });

  it("honors Retry-After with exponential backoff and a single total deadline", async () => {
    // node:timers/promises uses real timers, independently of Vitest's global fake clock.
    const calls: number[] = [];
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      new Response("", { status: 529 }),
      Response.json(jevResponse(request)),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => { calls.push(performance.now()); return responses.shift()!; });
    await expect(askJev(request, { ...options, timeoutMs: 5000 }, fetchImpl)).resolves.toEqual(jevResponse(request));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1990);
    expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(990);
  });

  it("does not retry indefinitely on overload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 529 }));
    await expect(askJev(request, { ...options, timeoutMs: 5000 }, fetchImpl)).rejects.toThrow("HTTP 529");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("times out during fetch and while consuming the body", async () => {
    vi.useFakeTimers();
    const fetchImpl = pendingResponse();
    const result = expect(askJev(request, options, fetchImpl)).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);

    const bodyFetch = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    })));
    const bodyResult = expect(askJev(request, options, bodyFetch)).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(1000);
    await bodyResult;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before fetch, in flight, and during backoff", async () => {
    vi.useFakeTimers();
    const aborted = new AbortController();
    aborted.abort();
    const untouched = vi.fn<typeof fetch>();
    await expect(askJev(request, { ...options, signal: aborted.signal }, untouched)).rejects.toThrow("キャンセル");
    expect(untouched).not.toHaveBeenCalled();

    for (const fetchImpl of [pendingResponse(), vi.fn<typeof fetch>(async () => new Response("", { status: 429 }))]) {
      const controller = new AbortController();
      const result = expect(askJev(request, { ...options, signal: controller.signal }, fetchImpl)).rejects.toThrow("キャンセル");
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await result;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
