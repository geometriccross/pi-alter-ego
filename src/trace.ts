// ponytail: delegated to extract.ts for single source of truth.
export {
  extractAssistantTrace,
  extractLastUserText,
  escapeXmlSectionText,
} from "./extract.js";
export type { AssistantTrace } from "./extract.js";
