import { claimStateLeaf, releaseStateLeaf, resetStateClaims, restoreState, toggleState } from "./state-model.js";

export interface AlterEgoState {
  isEnabled(): boolean;
  restoreFromBranch(branch: readonly unknown[]): void;
  toggle(): boolean;
  claimLeaf(leafId: string): (() => void) | null;
  resetProcessedLeaves(): void;
}

export function createAlterEgoState(): AlterEgoState {
  let state = restoreState([]);

  return {
    isEnabled: () => state.enabled,

    restoreFromBranch(branch) {
      state = restoreState(branch);
    },

    toggle() {
      state = toggleState(state);
      return state.enabled;
    },

    claimLeaf(leafId) {
      const token = Symbol();
      const claimed = claimStateLeaf(state, leafId, token);
      if (claimed === null) return null;
      state = claimed;
      return () => {
        state = releaseStateLeaf(state, leafId, token);
      };
    },

    resetProcessedLeaves() {
      state = resetStateClaims(state);
    },
  };
}
