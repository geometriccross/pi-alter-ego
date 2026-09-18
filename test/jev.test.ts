import { afterEach, describe, expect, it, vi } from "vitest";
import { askJev, JEV_ENDPOINT, prepareJevRequest, type JevRequest, type JevResponse } from "../src/evaluation.js";
import { freeze } from "./helpers.js";

const request = freeze<JevRequest>({
  state: { text: "Synthetic release check" },
  questions: {
    flag: { type: "noul", instructions: "Is this ready?" },
    action: { type: "choice", instructions: "Choose an action", criteria: { verify: null, ship: null } },
    readiness: { type: "score", instructions: "Rate readiness", criteria: ["Low", { state: "High" }] },
  },
});
const options = { apiKey: "synthetic-key" };
const response = freeze<JevResponse>({
  model: "jev-test",
  answers: {
    flag: { type: "noul", noul: 0.3 },
    action: { type: "choice", choice: "verify", confidence: 0.5, probabilities: { verify: 0.8, ship: 0.2 } },
    readiness: {
      type: "score", score: 0.4, confidence: 0.1,
      probabilities: { "0": 0.6, "1": 0.4 }, legend: { "0": "Low", "1": { state: "High" } },
    },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Jev flow", () => {
  it("serializes frozen requests deterministically", () => {
    const body = prepareJevRequest(request);
    expect(JSON.parse(body)).toEqual({ model: "jev-latest", ...request });
    expect(prepareJevRequest(request)).toBe(body);
  });

  it("sends one request and returns typed answers directly, forwarding the caller's signal", async () => {
    const parent = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    await expect(askJev(request, { apiKey: " synthetic-key ", signal: parent.signal }, fetchImpl)).resolves.toEqual(response);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(JEV_ENDPOINT, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-key", "Content-Type": "application/json" },
      body: prepareJevRequest(request), signal: parent.signal, redirect: "error",
    });
  });

  it.each([401, 422, 429, 529])("propagates HTTP %s without retrying or exposing the response body", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-secret", {
      status, headers: { "Retry-After": "60" },
    }));
    await expect(askJev(request, options, fetchImpl)).rejects.toThrow(`Jev API: HTTP ${status}`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("propagates transport, JSON, and serialization errors without Result conversion", async () => {
    const failure = new Error("Network failure");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(new Response("{invalid JSON"));
    await expect(askJev(request, options, fetchImpl)).rejects.toBe(failure);
    await expect(askJev(request, options, fetchImpl)).rejects.toBeInstanceOf(SyntaxError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(askJev({ ...request, state: circular }, options, fetchImpl)).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not preempt authentication with a local guard", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    await expect(askJev(request, { apiKey: undefined }, fetchImpl)).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not impose a timeout on a pending request", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve; }));
    const running = askJev(request, options, fetchImpl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    finish(Response.json(response));
    await expect(running).resolves.toEqual(response);
  });
});
