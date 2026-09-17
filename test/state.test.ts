import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAlterEgoState } from "../src/state.js";

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
