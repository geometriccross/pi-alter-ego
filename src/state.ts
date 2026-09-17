export interface AlterEgoState {
  isEnabled(): boolean;
  restoreFromBranch(branch: readonly unknown[]): void;
  toggle(): boolean;
  claimLeaf(leafId: string): (() => void) | null;
  resetProcessedLeaves(): void;
}

export function createAlterEgoState(): AlterEgoState {
  let enabled = true;
  const processedLeaves = new Map<string, symbol>();

  return {
    isEnabled: () => enabled,

    restoreFromBranch(branch) {
      enabled = true;
      processedLeaves.clear();

      // SessionManager.getBranch() is ordered root -> leaf.
      for (const raw of branch) {
        const entry = raw as {
          type?: string;
          customType?: string;
          data?: any;
          details?: any;
        } | null;

        if (
          entry?.type === "custom" &&
          entry.customType === "alter-ego-toggle" &&
          typeof entry.data?.enabled === "boolean"
        ) {
          enabled = entry.data.enabled;
        }

        let result;
        if (entry?.type === "custom" && entry.customType === "alter-ego-assessment") {
          result = entry.data;
        } else if (entry?.type === "custom_message" && entry.customType === "alter-ego") {
          result = entry.details;
        }

        if (
          typeof result?.sourceLeafId === "string" &&
          (result?.response?.answers || result?.assessment?.version === 1)
        ) {
          processedLeaves.set(result.sourceLeafId, Symbol());
        }
      }
    },

    toggle() {
      enabled = !enabled;
      return enabled;
    },

    claimLeaf(leafId) {
      if (!leafId || processedLeaves.has(leafId)) {
        return null;
      }

      const token = Symbol();
      processedLeaves.set(leafId, token);

      // A cancelled old request must not release a newer claim after tree navigation/reload.
      return () => {
        if (processedLeaves.get(leafId) === token) {
          processedLeaves.delete(leafId);
        }
      };
    },

    resetProcessedLeaves() {
      processedLeaves.clear();
    },
  };
}
