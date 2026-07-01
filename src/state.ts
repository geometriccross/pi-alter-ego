export interface AlterEgoState {
  isEnabled(): boolean;
  restoreFromBranch(branch: readonly unknown[]): void;
  toggle(): boolean;
  markLeafIfNew(leafId: string | null | undefined): boolean;
  resetProcessedLeaves(): void;
}

export function createAlterEgoState(): AlterEgoState {
  let enabled = true;
  const processedLeaves = new Set<string>();

  return {
    isEnabled: () => enabled,
    restoreFromBranch(branch) {
      enabled = true;
      processedLeaves.clear();
      for (const entry of branch) {
        if (isToggleEntry(entry)) {
          enabled = entry.data.enabled;
          break;
        }
      }
    },
    toggle() {
      enabled = !enabled;
      return enabled;
    },
    markLeafIfNew(leafId) {
      if (!leafId || processedLeaves.has(leafId)) return false;
      processedLeaves.add(leafId);
      return true;
    },
    resetProcessedLeaves() {
      processedLeaves.clear();
    },
  };
}

// ponytail: delegated to extract.ts for single source of truth.
export { hasAlterEgoMessage, isDissentableAssistant } from "./extract.js";

function isToggleEntry(entry: unknown): entry is { type: "custom"; customType: "alter-ego-toggle"; data: { enabled: boolean } } {
  const value = entry as any;
  return value?.type === "custom" && value.customType === "alter-ego-toggle" && typeof value.data?.enabled === "boolean";
}
