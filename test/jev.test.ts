import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { askJev, type JevRequest } from "../src/jev.js";

const request: JevRequest = {
  state: { text: "Synthetic release check" },
  questions: {
    flag: { type: "noul", instructions: "Is this ready?" },
    action: { type: "choice", instructions: "Choose an action", criteria: { verify: null, ship: null } },
    readiness: { type: "score", instructions: "Rate readiness", criteria: ["Low", { state: "High" }] },
  },
};
const options = { apiKey: "synthetic-key" };
const unavailable = { ok: false, error: "Jevとの通信または応答形式に問題があります（未評価）" };
const choice = { type: "choice", choice: "verify", confidence: 0.5, probabilities: { verify: 0.8, ship: 0.2 } };
const score = {
  type: "score", score: 0.4, confidence: 0.1,
  probabilities: { "0": 0.6, "1": 0.4 }, legend: { "0": "Low", "1": { state: "High" } },
};

function response(answers: Record<string, unknown> = {}) {
  return {
    model: "jev-test",
    answers: { flag: { type: "noul", noul: 0.3 }, action: choice, readiness: score, ...answers },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function respond(payload: unknown = response()) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Jev result boundary", () => {
  it("returns all validated answers on the success track", async () => {
    await expect(askJev(request, options, respond())).resolves.toEqual({ ok: true, value: response() });
  });

  it.each([
    { name: "null response", payload: null },
    { name: "wrong model", payload: { ...response(), model: "other-model" } },
    { name: "missing answers", payload: { ...response(), answers: {} } },
    { name: "negative usage", payload: { ...response(), usage: { input_tokens: -1, output_tokens: 0 } } },
    { name: "fractional usage", payload: { ...response(), usage: { input_tokens: 1, output_tokens: 0.5 } } },
    { name: "wrong answer type", payload: response({ flag: { type: "choice", noul: 0.3 } }) },
    { name: "invalid noul", payload: response({ flag: { type: "noul", noul: 1.1 } }) },
    { name: "missing probability", payload: response({ action: { ...choice, probabilities: { verify: 1 } } }) },
    { name: "invalid probability", payload: response({ action: { ...choice, probabilities: { verify: 1.1, ship: -0.1 } } }) },
    { name: "invalid total", payload: response({ action: { ...choice, probabilities: { verify: 0.4, ship: 0.2 } } }) },
    { name: "unknown choice", payload: response({ action: { ...choice, choice: "unknown" } }) },
    { name: "less probable choice", payload: response({ action: { ...choice, choice: "ship" } }) },
    { name: "invalid confidence", payload: response({ action: { ...choice, confidence: "high" } }) },
    { name: "invalid score", payload: response({ readiness: { ...score, score: 2 } }) },
    { name: "missing legend level", payload: response({ readiness: { ...score, legend: { "0": "Low" } } }) },
    { name: "invalid legend level", payload: response({ readiness: { ...score, legend: { "0": "Low", "1": true } } }) },
  ])("returns failure instead of throwing for $name", async ({ payload }) => {
    await expect(askJev(request, options, respond(payload))).resolves.toEqual(unavailable);
  });

  it("returns authentication and serialization failures without making a request", async () => {
    const fetchImpl = respond();
    await expect(askJev(request, { apiKey: undefined }, fetchImpl)).resolves.toEqual({
      ok: false, error: "TYPESAFE_API_KEY を設定してください（Jev未評価）",
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(askJev({ ...request, state: circular }, options, fetchImpl)).resolves.toEqual(unavailable);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes rejected HTTP bodies, fetch rejections, and malformed JSON", async () => {
    const fetchImpl = respond()
      .mockResolvedValueOnce(new Response("synthetic-secret", { status: 422 }))
      .mockRejectedValueOnce(new Error("synthetic-secret"))
      .mockResolvedValueOnce(new Response("{synthetic-secret"));
    await expect(askJev(request, options, fetchImpl)).resolves.toEqual({
      ok: false, error: "Jev API: HTTP 422（未評価）",
    });
    await expect(askJev(request, options, fetchImpl)).resolves.toEqual(unavailable);
    await expect(askJev(request, options, fetchImpl)).resolves.toEqual(unavailable);
  });

  it("retries 429 and 529 before returning success", async () => {
    const fetchImpl = respond()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 529 }));
    await expect(askJev(request, options, fetchImpl)).resolves.toEqual({ ok: true, value: response() });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Set(fetchImpl.mock.calls.map(([, init]) => init!.signal)).size).toBe(1);
  });

  it("returns a service failure when retries are exhausted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 529 }));
    await expect(askJev(request, options, fetchImpl)).resolves.toEqual({
      ok: false, error: "Jev API: HTTP 529（未評価）",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "invalid payload", "already aborted"])("releases resources after %s", async (kind) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    if (kind === "already aborted") parent.abort();
    const fetchImpl = kind === "invalid payload" ? respond(null) : respond();
    const result = await askJev(request, { ...options, signal: parent.signal }, fetchImpl);
    expect(result).toEqual(kind === "success" ? { ok: true, value: response() }
      : kind === "invalid payload" ? unavailable : { ok: false, error: "Jev評価をキャンセルしました" });
    expect(fetchImpl).toHaveBeenCalledTimes(kind === "already aborted" ? 0 : 1);
    expect(getEventListeners(parent.signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "timeout"])("returns %s and releases the timer and abort listener", async (kind) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("synthetic-secret")), { once: true });
    }));
    const running = askJev(request, { ...options, signal: parent.signal }, fetchImpl);
    if (kind === "cancel") {
      parent.abort();
    } else {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await expect(running).resolves.toEqual({
      ok: false,
      error: kind === "cancel" ? "Jev評価をキャンセルしました" : "Jev タイムアウト (30s、未評価)",
    });
    expect(getEventListeners(parent.signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the shared deadline while waiting for Retry-After", async () => {
    vi.useFakeTimers();
    const fetchImpl = respond().mockResolvedValueOnce(new Response("", {
      status: 429, headers: { "Retry-After": "60" },
    }));
    const running = askJev(request, options, fetchImpl);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(running).resolves.toEqual({ ok: false, error: "Jev タイムアウト (30s、未評価)" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
