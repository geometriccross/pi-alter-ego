import { describe, expect, it, vi } from "vitest";
import { andThen, andThenAsync, attempt, err, map, mapError, ok, recoverAsync, traverse } from "../src/result.js";
import { freeze } from "./helpers.js";

describe("Result composition", () => {
  it("transforms successes and short-circuits synchronous and asynchronous failures", async () => {
    const failure = freeze(err("invalid"));
    const next = vi.fn((value: number) => ok(value + 1));
    const nextAsync = vi.fn(async (value: number) => next(value));
    expect(map(ok(2), (value) => value * 3)).toEqual(ok(6));
    expect(andThen(ok(2), next)).toEqual(ok(3));
    next.mockClear();

    expect(map(failure, next)).toBe(failure);
    expect(andThen(failure, next)).toBe(failure);
    await expect(andThenAsync(failure, nextAsync)).resolves.toBe(failure);
    expect(next).not.toHaveBeenCalled();
    expect(nextAsync).not.toHaveBeenCalled();
    await expect(andThenAsync(ok(2), nextAsync)).resolves.toEqual(ok(3));
  });

  it("maps only errors and preserves the success value", () => {
    const success = freeze(ok({ text: "ready" }));
    const describeError = vi.fn((error: string) => `config: ${error}`);
    expect(mapError(success, describeError)).toBe(success);
    expect(describeError).not.toHaveBeenCalled();
    expect(mapError(freeze(err("invalid")), describeError)).toEqual(err("config: invalid"));
  });

  it("traverses in order, stopping at the first failure without touching later elements", () => {
    const inputs = freeze([1, 2, 3]);
    const failure = freeze(err("invalid second item"));
    const transform = vi.fn((value: number) => value === 2 ? failure : ok(value * 10));
    expect(traverse(inputs, transform)).toBe(failure);
    expect(transform.mock.calls).toEqual([[1], [2]]);
    expect(traverse(inputs, (value) => ok(value * 10))).toEqual(ok([10, 20, 30]));
    expect(traverse([], transform)).toEqual(ok([]));
    expect(inputs).toEqual([1, 2, 3]);
  });

  it("catches exceptions only at explicit boundaries, preserving returned failures", async () => {
    const throwError = () => { throw new Error("private details"); };
    const sanitize = () => "unavailable";
    expect(attempt(throwError, sanitize)).toEqual(err("unavailable"));
    expect(() => andThen(ok(1), throwError)).toThrow("private details");
    await expect(recoverAsync(async () => throwError(), sanitize)).resolves.toEqual(err("unavailable"));
    const failure = err("already handled");
    await expect(recoverAsync(async () => failure, sanitize)).resolves.toBe(failure);
  });
});
