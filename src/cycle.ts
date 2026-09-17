import { extractAssistantTrace, extractCompactionSummaries, extractLastUserText, findLastAssistant, hasAlterEgoAfterAssistant, isDissentableAssistant } from "./extract.js";
import { buildEvidenceDigest } from "./evidence.js";
import type { DissentAssessment, DissentInput } from "./assessment.js";

export interface DissentDeps {
  evaluate: (input: DissentInput) => Promise<DissentAssessment>;
  claimLeaf: (leafId: string) => (() => void) | null;
  isCurrent: () => boolean;
}

export async function runDissent(
  messages: readonly unknown[],
  sessionContext: unknown,
  leafId: string,
  deps: DissentDeps,
): Promise<DissentAssessment | null> {
  if (!deps.isCurrent() || hasAlterEgoAfterAssistant(messages)) return null;
  if (!isDissentableAssistant(findLastAssistant(messages))) return null;

  const assistantTrace = extractAssistantTrace(messages);
  const evidenceDigest = buildEvidenceDigest(messages);
  // No visible basis for a comparison. Missing thinking alone is never evidence of a failure.
  if (!assistantTrace.thinking.trim() && evidenceDigest.length === 0) return null;
  const release = deps.claimLeaf(leafId);
  if (!release) return null;
  try {
    const assessment = await deps.evaluate({
      userText: extractLastUserText(messages),
      assistantTrace,
      evidenceDigest,
      compactionSummaries: extractCompactionSummaries(sessionContext),
    });
    if (!deps.isCurrent()) {
      release();
      return null;
    }
    return assessment;
  } catch (error) {
    release();
    if (!deps.isCurrent()) return null;
    throw error;
  }
}
