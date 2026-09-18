import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { restoreEnabled } from "../src/index.js";
import { freeze } from "./helpers.js";

describe("branch-local enabled state", () => {
  it("restores the latest toggle using the real SessionManager branch order", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("alter-ego-toggle", { enabled: false });
    const off = manager.getLeafId()!;
    manager.appendCustomEntry("alter-ego-toggle", { enabled: true });
    expect(restoreEnabled(manager.getBranch())).toBe(true);
    manager.branch(off);
    expect(restoreEnabled(manager.getBranch())).toBe(false);
    expect(restoreEnabled([])).toBe(true);
  });

  it("restores frozen snapshots without consuming or changing unrelated entries", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("alter-ego-toggle", { enabled: false });
    manager.appendCustomMessageEntry("alter-ego", "Previous judgment", true, {
      response: { answers: { check: { type: "noul", noul: 0.5 } } },
    });
    manager.appendCustomEntry("other-extension", { enabled: true });
    const branch = freeze(manager.getBranch());
    expect(restoreEnabled(branch)).toBe(false);
    expect(restoreEnabled(branch)).toBe(false);
    expect(branch).toHaveLength(3);
  });
});
