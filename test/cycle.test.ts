import { describe, expect, it, vi } from "vitest";
import { runDissent, type DissentDeps } from "../src/cycle.js";
import { createAlterEgoState } from "../src/state.js";
import type { JevRequest, JevResponse } from "../src/jev.js";

const request: JevRequest = {
  state: { text: "Synthetic check" },
  questions: { check: { type: "noul", instructions: "Is this ready?" } },
};
const response: JevResponse = {
  model: "jev-test",
  answers: { check: { type: "noul", noul: 0.5 } },
  usage: { input_tokens: 10, output_tokens: 5 },
};

function setup() {
  const state = createAlterEgoState();
  const deps: DissentDeps = {
    evaluate: vi.fn<DissentDeps["evaluate"]>(),
    claimLeaf: (id) => state.claimLeaf(id),
    isCurrent: () => true,
  };
  return { state, deps, evaluate: vi.mocked(deps.evaluate) };
}

describe("dissent result lifecycle", () => {
  it.each(["no request", "stale request"])("skips %s without claiming a leaf or evaluating", async (kind) => {
    const { deps, evaluate } = setup();
    const claimLeaf = vi.fn(deps.claimLeaf);
    await expect(runDissent(kind === "no request" ? null : request, "leaf", {
      ...deps, claimLeaf, isCurrent: () => kind !== "stale request",
    })).resolves.toEqual({ ok: true, value: null });
    expect(claimLeaf).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(["failure result", "unexpected rejection"])("releases the claim after %s and permits retry", async (kind) => {
    const { state, deps, evaluate } = setup();
    if (kind === "failure result") {
      evaluate.mockResolvedValueOnce({ ok: false, error: "Unavailable" });
    } else {
      evaluate.mockRejectedValueOnce(new Error("Unexpected failure"));
    }
    await expect(runDissent(request, "leaf", deps)).resolves.toEqual({
      ok: false, error: kind === "failure result" ? "Unavailable" : "Jev評価に失敗しました",
    });

    evaluate.mockResolvedValueOnce({ ok: true, value: response });
    await expect(runDissent(request, "leaf", deps)).resolves.toEqual({ ok: true, value: response });
    expect(state.claimLeaf("leaf")).toBeNull();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("turns stale %s into a skip and releases the claim", async (kind) => {
    const { state, deps, evaluate } = setup();
    let current = true;
    deps.isCurrent = () => current;
    evaluate.mockImplementationOnce(async () => {
      current = false;
      return kind === "failure" ? { ok: false, error: "Late failure" } : { ok: true, value: response };
    });
    await expect(runDissent(request, "leaf", deps)).resolves.toEqual({ ok: true, value: null });
    expect(state.claimLeaf("leaf")).not.toBeNull();
  });
});
