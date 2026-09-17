import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  extractAssistantTrace,
  extractCompactionSummaries,
  extractLastUserText,
  findLastAssistant,
  hasAlterEgoAfterAssistant,
  isDissentableAssistant,
  type AssistantTrace,
} from "./extract.js";
import type { JevRequest, JevResponse } from "./jev.js";

export interface DissentSource {
  leafId: string;
  sourceLeafId: string;
}

export interface DissentInput {
  userText: string;
  assistantTrace: AssistantTrace;
  compactionSummaries: string[];
}

export function findDissentSource(
  leafId: string | null,
  branch: readonly SessionEntry[],
): DissentSource | null {
  if (!leafId) {
    return null;
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return { leafId, sourceLeafId: entry.id };
    }
  }
  return null;
}

export function prepareDissentRequest(
  messages: readonly unknown[],
  entries: readonly SessionEntry[],
  leafId: string,
  questions: JevRequest["questions"],
): JevRequest | null {
  if (
    Object.keys(questions).length === 0 ||
    hasAlterEgoAfterAssistant(messages) ||
    !isDissentableAssistant(findLastAssistant(messages))
  ) {
    return null;
  }

  const sessionContext = buildSessionContext([...entries], leafId);
  const state: DissentInput = {
    userText: extractLastUserText(messages),
    assistantTrace: extractAssistantTrace(messages),
    compactionSummaries: extractCompactionSummaries(sessionContext),
  };
  return { state, questions };
}

export function buildDissentMessage(sourceLeafId: string, response: JevResponse) {
  return {
    customType: "alter-ego",
    content: JSON.stringify(response.answers, null, 2),
    display: true,
    details: { sourceLeafId, response },
  };
}

export function formatDissentError(message: string): string {
  return `alter ego: ${message}`;
}
