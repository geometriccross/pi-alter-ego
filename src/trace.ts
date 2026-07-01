// ponytail: delegated to extract.ts / xml.ts for single source of truth.
export {
  extractAssistantTrace,
  extractLastUserText,
} from "./extract.js";
export { escapeXmlSectionText } from "./xml.js";
export type { AssistantTrace } from "./extract.js";
