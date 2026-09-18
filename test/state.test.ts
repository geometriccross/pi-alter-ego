import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAlterEgoState } from "../src/state.js";
import { claimStateLeaf, releaseStateLeaf, resetStateClaims, restoreState, toggleState } from "../src/state-model.js";
import { freeze } from "./helpers.js";

describe("pure state transitions", () => {
  it("restores deterministic snapshots without generating claim identities or modifying entries", () => {
    const branch = freeze([
      { type: "custom", customType: "alter-ego-toggle", data: { enabled: false } },
      { type: "custom_message", customType: "alter-ego", details: { sourceLeafId: "leaf", response: { answers: {} } } },
    ]);
    const snapshot = restoreState(branch);
    expect(snapshot).toEqual({ enabled: false, processedLeaves: { leaf: null } });
    expect(restoreState(branch)).toEqual(snapshot);
  });

  it("creates new snapshots while retaining old claims and protecting newer ones from late release", () => {
    const original = freeze(restoreState([]));
    const oldToken = Symbol("old");
    const newToken = Symbol("new");
    const claimed = freeze(claimStateLeaf(original, "leaf", oldToken)!);
    expect(claimStateLeaf(original, "leaf", oldToken)).toEqual(claimed);
    expect(claimStateLeaf(claimed, "leaf", newToken)).toBeNull();
    const toggled = freeze(toggleState(claimed));
    const reset = freeze(resetStateClaims(toggled));
    const reclaimed = freeze(claimStateLeaf(reset, "leaf", newToken)!);
    expect(releaseStateLeaf(reclaimed, "leaf", oldToken)).toBe(reclaimed);
    expect(releaseStateLeaf(reclaimed, "leaf", newToken)).toEqual(reset);
    expect(releaseStateLeaf(claimed, "leaf", oldToken)).toEqual(original);
    expect(original).toEqual({ enabled: true, processedLeaves: {} });
    expect(claimed).toEqual({ enabled: true, processedLeaves: { leaf: oldToken } });
    expect(toggled).toEqual({ enabled: false, processedLeaves: { leaf: oldToken } });
    expect(reset).toEqual({ enabled: false, processedLeaves: {} });
  });

  it("treats prototype-looking IDs as ordinary leaves", () => {
    const state = freeze(restoreState([]));
    const token = Symbol();
    for (const leafId of ["__proto__", "constructor", "toString"]) {
      const claimed = freeze(claimStateLeaf(state, leafId, token)!);
      expect(Object.hasOwn(claimed.processedLeaves, leafId)).toBe(true);
      expect(claimStateLeaf(claimed, leafId, token)).toBeNull();
      expect(releaseStateLeaf(claimed, leafId, token)).toEqual(state);
    }
  });
});

describe("branch-local state", () => {
  it("restores the latest toggle using the real SessionManager branch order", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("alter-ego-toggle", { enabled: false });
    const off = manager.getLeafId()!;
    manager.appendCustomEntry("alter-ego-toggle", { enabled: true });
    const state = createAlterEgoState();
    state.restoreFromBranch(manager.getBranch());
    expect(state.isEnabled()).toBe(true);
    manager.branch(off);
    state.restoreFromBranch(manager.getBranch());
    expect(state.isEnabled()).toBe(false);
    state.restoreFromBranch([]);
    expect(state.isEnabled()).toBe(true);
  });

  it("toggles and allows releasing unsuccessful claims", () => {
    const state = createAlterEgoState();
    expect(state.toggle()).toBe(false);
    expect(state.claimLeaf("")).toBeNull();
    const release = state.claimLeaf("leaf")!;
    expect(state.claimLeaf("leaf")).toBeNull();
    release();
    expect(state.claimLeaf("leaf")).not.toBeNull();
    state.resetProcessedLeaves();
    expect(state.claimLeaf("leaf")).not.toBeNull();
  });

  it("a late cancellation cannot release a newer claim", () => {
    const state = createAlterEgoState();
    const oldRelease = state.claimLeaf("leaf")!;
    state.restoreFromBranch([]);
    state.claimLeaf("leaf");
    oldRelease();
    expect(state.claimLeaf("leaf")).toBeNull();
  });

  it("restores only evaluated leaves from this branch, including quiet clear results", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("alter-ego-assessment", {
      sourceLeafId: "clear",
      assessment: { version: 1 },
    });
    manager.appendCustomMessageEntry("alter-ego", "dissent", true, {
      sourceLeafId: "dissent",
      assessment: { version: 1 },
    });
    manager.appendCustomMessageEntry("alter-ego", "raw answers", true, {
      sourceLeafId: "current",
      response: {
        answers: { custom: { type: "noul", noul: 0.5 } },
      },
    });
    manager.appendCustomMessageEntry("alter-ego", "legacy", true, {
      sourceLeafId: "legacy",
    });
    const state = createAlterEgoState();
    state.restoreFromBranch(manager.getBranch());
    expect(state.claimLeaf("clear")).toBeNull();
    expect(state.claimLeaf("dissent")).toBeNull();
    expect(state.claimLeaf("current")).toBeNull();
    expect(state.claimLeaf("legacy")).not.toBeNull();
    state.restoreFromBranch([]);
    expect(state.claimLeaf("clear")).not.toBeNull();
  });
});
