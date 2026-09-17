import {
  extractAssistantTrace,
  extractCompactionSummaries,
  extractLastUserText,
  findLastAssistant,
  hasAlterEgoAfterAssistant,
  isDissentableAssistant,
  type AssistantTrace,
} from "./extract.js";
import type { JevResponse } from "./jev.js";

export interface DissentInput {
  userText: string;
  assistantTrace: AssistantTrace;
  compactionSummaries: string[];
}

export interface DissentDeps {
  evaluate: (input: DissentInput) => Promise<JevResponse>;
  claimLeaf: (leafId: string) => (() => void) | null;
  isCurrent: () => boolean;
}

export async function runDissent(
  messages: readonly unknown[],
  sessionContext: unknown,
  leafId: string,
  deps: DissentDeps,
): Promise<JevResponse | null> {
  if (!deps.isCurrent() || hasAlterEgoAfterAssistant(messages)) {
    return null;
  }
  if (!isDissentableAssistant(findLastAssistant(messages))) {
    return null;
  }

  const assistantTrace = extractAssistantTrace(messages);
  const release = deps.claimLeaf(leafId);
  if (!release) {
    return null;
  }

  try {
    const response = await deps.evaluate({
      userText: extractLastUserText(messages),
      assistantTrace,
      compactionSummaries: extractCompactionSummaries(sessionContext),
    });

    if (!deps.isCurrent()) {
      release();
      return null;
    }
    return response;
  } catch (error) {
    release();
    if (!deps.isCurrent()) {
      return null;
    }
    throw error;
  }
}
