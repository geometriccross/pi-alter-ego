export interface StateSnapshot {
  readonly enabled: boolean;
  // null denotes a restored assessment; symbols identify claims made in this process.
  readonly processedLeaves: Readonly<Record<string, symbol | null>>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function restoreState(branch: readonly unknown[]): StateSnapshot {
  const entries = branch.map(record);
  // SessionManager.getBranch() is ordered root -> leaf.
  const toggles = entries.flatMap((entry) => {
    const enabled = record(entry?.data)?.enabled;
    return entry?.type === "custom" && entry.customType === "alter-ego-toggle" && typeof enabled === "boolean"
      ? [enabled] : [];
  });
  const leaves = entries.flatMap((entry) => {
    const result = entry?.type === "custom" && entry.customType === "alter-ego-assessment" ? record(entry.data)
      : entry?.type === "custom_message" && entry.customType === "alter-ego" ? record(entry.details)
      : undefined;
    return typeof result?.sourceLeafId === "string" &&
      (record(result.response)?.answers || record(result.assessment)?.version === 1)
      ? [[result.sourceLeafId, null] as const] : [];
  });
  return { enabled: toggles.at(-1) ?? true, processedLeaves: Object.fromEntries(leaves) };
}

export function toggleState(state: StateSnapshot): StateSnapshot {
  return { ...state, enabled: !state.enabled };
}

export function claimStateLeaf(state: StateSnapshot, leafId: string, token: symbol): StateSnapshot | null {
  return !leafId || Object.hasOwn(state.processedLeaves, leafId)
    ? null
    : { ...state, processedLeaves: { ...state.processedLeaves, [leafId]: token } };
}

export function releaseStateLeaf(state: StateSnapshot, leafId: string, token: symbol): StateSnapshot {
  // A cancelled old request must not release a newer claim after tree navigation/reload.
  if (state.processedLeaves[leafId] !== token) return state;
  const { [leafId]: _released, ...remaining } = state.processedLeaves;
  return { ...state, processedLeaves: remaining };
}

export function resetStateClaims(state: StateSnapshot): StateSnapshot {
  return { ...state, processedLeaves: {} };
}
