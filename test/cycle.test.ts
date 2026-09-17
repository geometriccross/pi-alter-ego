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

  it("turns stale failures into skips and releases their claims", async () => {
    const { state, deps, evaluate } = setup();
    let current = true;
    deps.isCurrent = () => current;
    evaluate.mockImplementationOnce(async () => {
      current = false;
      return { ok: false, error: "Late failure" };
    });
    await expect(runDissent(request, "leaf", deps)).resolves.toEqual({ ok: true, value: null });
    expect(state.claimLeaf("leaf")).not.toBeNull();
  });
});
