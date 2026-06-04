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

export function hasAlterEgoMessage(messages: readonly unknown[]): boolean {
  return (messages as any[]).some((msg) => msg?.customType === "alter-ego");
}


export function isDissentableAssistant(message: unknown): boolean {
  const msg = message as any;
  if (msg?.role !== "assistant") return false;
  if (["toolUse", "error", "aborted"].includes(msg.stopReason)) return false;
  return Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "text" && part.text.trim().length > 0);
}

function isToggleEntry(entry: unknown): entry is { type: "custom"; customType: "alter-ego-toggle"; data: { enabled: boolean } } {
  const value = entry as any;
  return value?.type === "custom" && value.customType === "alter-ego-toggle" && typeof value.data?.enabled === "boolean";
}
