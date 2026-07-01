// ponytail: deep module — full dissent cycle behind one interface.
import { extractTraceFromAssistant, extractCompactionSummaries, extractLastUserText, findLastAssistant, hasAlterEgoMessage, isDissentableAssistant, buildEvidenceDigest, type EvidenceItem, type AssistantTrace } from "./extract.js";

export interface DissentInput {
  userText: string;
  assistantTrace: AssistantTrace;
  evidenceDigest: EvidenceItem[];
  compactionSummaries: string[];
}

export interface DissentDeps {
  spawn: (input: DissentInput) => Promise<string>;
  isEnabled: () => boolean;
  markLeafIfNew: (leafId: string) => boolean;
  getCurrentLeafId: () => string | null;
}

export async function runDissent(
  messages: readonly unknown[],
  sessionContext: unknown,
  leafId: string,
  deps: DissentDeps,
): Promise<string | null> {
  if (hasAlterEgoMessage(messages)) return null;

  const lastAssistant = findLastAssistant(messages);
  if (!isDissentableAssistant(lastAssistant)) return null;

  const assistantTrace = extractTraceFromAssistant(lastAssistant);
  // Models that never emit a thinking trace (e.g. openai-codex) yield an empty
  // thinking. Alter ego compares thinking against the final answer, so with no
  // thinking there is nothing to dissent on — skip silently.
  if (!assistantTrace.thinking.trim()) return null;

  if (!deps.markLeafIfNew(leafId)) return null;

  const input: DissentInput = {
    userText: extractLastUserText(messages),
    assistantTrace,
    evidenceDigest: buildEvidenceDigest(messages),
    compactionSummaries: extractCompactionSummaries(sessionContext),
  };
  const dissent = await deps.spawn(input);

  // Race guards: state may have changed while spawn was running.
  if (!deps.isEnabled()) return null;
  if (deps.getCurrentLeafId() !== leafId) return null;

  if (dissent.trim() === "NO_DISSENT") return null;
  return dissent;
}
