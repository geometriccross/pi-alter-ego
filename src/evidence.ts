import { escapeXmlAttr, escapeXmlSectionText } from "./xml.js";

/** Maximum number of evidence items kept in the digest (latest wins). */
export const MAX_EVIDENCE_ITEMS = 12;

/** Maximum character length for any evidence summary (including ellipsis). */
export const MAX_SUMMARY_LENGTH = 160;

/** Maximum number of individual test facts included in a test summary. */
export const MAX_FACTS = 6;

/** Maximum character length of tool-result text inspected for summarization. */
export const MAX_TOOL_RESULT_TEXT_LENGTH = 4096;

/** Maximum character length of command text scanned for classification. */
export const MAX_COMMAND_SCAN_LENGTH = 512;

/** Maximum number of pending (unpaired) tool calls kept in memory. */
export const MAX_PENDING_CALLS = MAX_EVIDENCE_ITEMS * 2;

/** Maximum character length for a toolCall id before it is considered malformed. */
export const MAX_TOOL_CALL_ID_LENGTH = 256;

/** Maximum character length for a raw tool name before it is rejected as malformed. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Known tool names that are safe to appear in serialized evidence. */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash", "read", "edit", "write", "grep", "find", "ls", "web_search",
]);

/**
 * Normalize a raw tool name to a safe, bounded label.
 * Known names pass through (lowercased); everything else becomes "other".
 * Non-string inputs safely return "other" without throwing.
 */
function normalizeToolName(raw: unknown): string {
  if (typeof raw !== "string") return "other";
  if (raw.length > MAX_TOOL_NAME_LENGTH) return "other";
  const lower = raw.toLowerCase().trim();
  return KNOWN_TOOL_NAMES.has(lower) ? lower : "other";
}

export interface EvidenceItem {
  toolName: string;
  summary: string;
  isError: boolean;
}

/** Sanitized, bounded metadata retained for a tool call (no raw args). */
interface SanitizedCallMeta {
  toolName: string;
  /** For bash: bounded command. For read/edit/write: bounded path. Empty otherwise. */
  detail: string;
}

interface ToolResultInfo {
  toolName: string;
  isError: boolean;
  content: unknown;
}

/**
 * Build a bounded, deterministic evidence digest from current-run messages.
 * Pairs toolResult messages to prior toolCall parts when possible.
 * Latest items are kept when count exceeds MAX_EVIDENCE_ITEMS.
 */
export function buildEvidenceDigest(messages: readonly unknown[]): EvidenceItem[] {
  const eventMessages = messages as any[];
  const calls = new Map<string, SanitizedCallMeta>();
  const pairs: Array<{ call?: SanitizedCallMeta; result: ToolResultInfo }> = [];

  for (const msg of eventMessages) {
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "toolCall" && typeof part.id === "string") {
          const id = part.id;
          // Skip huge/malformed ids — they are only needed transiently for lookup
          if (id.length > MAX_TOOL_CALL_ID_LENGTH) continue;

          const rawName = part.name ?? part.toolName ?? "";
          const normalizedName = normalizeToolName(rawName);
          const rawArgs = part.arguments ?? part.args;

          // Store only sanitized, bounded metadata (no raw args)
          let detail = "";
          if (normalizedName === "bash") {
            detail = extractCommand(rawArgs);
          } else if (
            normalizedName === "read" ||
            normalizedName === "edit" ||
            normalizedName === "write"
          ) {
            detail = extractPath(rawArgs);
          }

          calls.set(id, { toolName: normalizedName, detail });

          // Cap pending calls: evict oldest when over limit
          if (calls.size > MAX_PENDING_CALLS) {
            const oldestKey = calls.keys().next().value;
            if (oldestKey !== undefined) calls.delete(oldestKey);
          }
        }
      }
    }

    if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
      let call: SanitizedCallMeta | undefined;
      // Only look up if id length is within bounds — skip huge/malformed ids
      if (msg.toolCallId.length <= MAX_TOOL_CALL_ID_LENGTH) {
        call = calls.get(msg.toolCallId);
        if (call) calls.delete(msg.toolCallId);
      }

      pairs.push({
        call,
        result: {
          toolName: normalizeToolName(msg.toolName),
          isError: Boolean(msg.isError),
          content: msg.content,
        },
      });
      // Rolling buffer: evict oldest when over cap
      if (pairs.length > MAX_EVIDENCE_ITEMS) {
        pairs.shift();
      }
    }
  }

  // Pairs already bounded to MAX_EVIDENCE_ITEMS by the rolling buffer.
  // Normalize content lazily only for tools that need it (bash).
  return pairs.map(({ call, result }) => ({
    toolName: normalizeToolName(call?.toolName || result.toolName),
    summary: summarize(call, result),
    isError: result.isError,
  }));
}

/**
 * Serialize evidence items into an XML section string.
 * Returns empty string when items is empty.
 */
export function serializeEvidence(items: readonly EvidenceItem[]): string {
  if (items.length === 0) return "";
  const entries = items
    .map(
      (item, idx) =>
        `<item index="${idx}" tool="${escapeXmlAttr(item.toolName)}" isError="${item.isError}">${escapeXmlSectionText(item.summary)}</item>`,
    )
    .join("\n");
  return `<visible_execution_evidence>\n${entries}\n</visible_execution_evidence>`;
}

// ─── internals ───────────────────────────────────────────────────────

const TRUNCATION_MARKER = "\n…[truncated]…\n";

/**
 * Deterministic head/tail window truncation for large text.
 * When text exceeds MAX_TOOL_RESULT_TEXT_LENGTH, keeps the first and last
 * portions with a truncation marker in between. This preserves test aggregate
 * lines that typically appear at the tail of output.
 */
function truncateToWindow(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_LENGTH) return text;
  const available = MAX_TOOL_RESULT_TEXT_LENGTH - TRUNCATION_MARKER.length;
  const headSize = Math.ceil(available / 2);
  const tailSize = available - headSize;
  return text.slice(0, headSize) + TRUNCATION_MARKER + text.slice(text.length - tailSize);
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return truncateToWindow(content);
  }

  if (Array.isArray(content)) {
    const available = MAX_TOOL_RESULT_TEXT_LENGTH - TRUNCATION_MARKER.length;
    const headSize = Math.ceil(available / 2);
    const tailSize = available - headSize;

    let totalLength = 0;
    let head = "";
    let tailBuffer = "";

    for (const p of content) {
      if (p?.type === "text" && typeof p.text === "string") {
        const text = p.text;
        totalLength += text.length;

        // Build head (capped at MAX_TOOL_RESULT_TEXT_LENGTH for small-content case)
        if (head.length < MAX_TOOL_RESULT_TEXT_LENGTH) {
          const remaining = MAX_TOOL_RESULT_TEXT_LENGTH - head.length;
          if (text.length <= remaining) {
            head += text;
          } else {
            head += text.slice(0, remaining);
          }
        }

        // Build tail buffer (sliding window of last tailSize chars)
        tailBuffer += text;
        if (tailBuffer.length > tailSize) {
          tailBuffer = tailBuffer.slice(tailBuffer.length - tailSize);
        }
      }
    }

    // Small content: return full join
    if (totalLength <= MAX_TOOL_RESULT_TEXT_LENGTH) {
      return head;
    }

    // Large content: head/tail window
    return head.slice(0, headSize) + TRUNCATION_MARKER + tailBuffer;
  }

  return "";
}

function summarize(call: SanitizedCallMeta | undefined, result: ToolResultInfo): string {
  const name = normalizeToolName(call?.toolName || result.toolName || "");
  let raw: string;
  if (name === "bash") raw = summarizeBash(call?.detail ?? "", result);
  else if (name === "read") raw = summarizeRead(call?.detail ?? "");
  else if (name === "edit" || name === "write") raw = summarizeEditWrite(name, call?.detail ?? "");
  else raw = summarizeGeneric(name, result);
  return truncate(raw, MAX_SUMMARY_LENGTH);
}

function summarizeBash(boundedCommand: string, result: ToolResultInfo): string {
  const label = classifyCommand(boundedCommand);
  const output = normalizeContent(result.content).trim();

  if (label === "test") {
    const facts = extractTestFacts(output);
    if (facts) return `bash ${label} → ${facts}`;
  }

  if (result.isError) {
    return `bash ${label} → exit non-zero`;
  }

  if (!output) return `bash ${label} → exit 0`;
  return `bash ${label} → ok`;
}

function summarizeRead(boundedPath: string): string {
  return `read → ${truncate(boundedPath, MAX_SUMMARY_LENGTH)}`;
}

function summarizeEditWrite(toolName: string, boundedPath: string): string {
  return `${toolName} → ${truncate(boundedPath, MAX_SUMMARY_LENGTH)}`;
}

function summarizeGeneric(normalizedName: string, result: ToolResultInfo): string {
  if (result.isError) return `${normalizedName} → error`;
  return `${normalizedName} → ok`;
}

// ─── field extractors ────────────────────────────────────────────────

function extractCommand(args: unknown): string {
  if (typeof args === "string") return boundCommand(args);
  if (args && typeof args === "object" && "command" in args) {
    const cmd = (args as any).command;
    if (typeof cmd === "string") return boundCommand(cmd);
  }
  return "";
}

function extractPath(args: unknown): string {
  if (args && typeof args === "object" && "path" in args) {
    const p = (args as any).path;
    if (typeof p === "string") {
      return p.length > MAX_COMMAND_SCAN_LENGTH ? p.slice(0, MAX_COMMAND_SCAN_LENGTH) : p;
    }
  }
  return "";
}

function boundCommand(command: string): string {
  if (command.length <= MAX_COMMAND_SCAN_LENGTH) return command;
  return command.slice(0, MAX_COMMAND_SCAN_LENGTH);
}

/**
 * Classify a shell command into a category.
 * Test runner detection is shell-position aware (C14): the runner must appear
 * as an actual command (not inside arguments or quoted strings).
 */
function classifyCommand(command: string): string {
  const cmd = command.trim();

  // Test runners — position-aware check (C14)
  if (hasTestRunnerInCommandPosition(cmd)) return "test";

  // Remaining classifications use the full lowercased command string.
  const lower = cmd.toLowerCase();

  // Type checking
  if (/(?:tsc\b|typecheck|type-check)/.test(lower)) return "typecheck";

  // Build/compile
  if (/(?:build|compile|webpack|vite\s+build|rollup|esbuild)/.test(lower)) return "build";

  // Lint/format
  if (/(?:lint|eslint|prettier)/.test(lower)) return "lint";

  // Git operations
  if (/git\s+status/.test(lower)) return "git-status";
  if (/git\s+diff/.test(lower)) return "git-diff";
  if (/git\s+log/.test(lower)) return "git-log";
  if (/git\b/.test(lower)) return "git";

  // Package installation
  if (/(?:npm\s+install|pnpm\s+install|yarn\s+install|npm\s+i\b|pnpm\s+i\b)/.test(lower)) return "install";

  // File inspection
  if (/(?:^|\s)(?:ls|cat|find|grep|wc|head|tail)\b/.test(lower)) return "file-inspect";

  return "other";
}

/**
 * Check whether any command segment has a test runner in command position.
 * Strips quoted strings and splits by shell operators so that runner names
 * inside arguments or quoted strings do not trigger false positives.
 */
function hasTestRunnerInCommandPosition(command: string): boolean {
  const stripped = stripQuotedStrings(command);
  const segments = stripped.split(/\s*(?:&&|\|\||;|\|)\s*/);

  for (const segment of segments) {
    const effective = getEffectiveCommand(segment);
    if (
      /^(?:vitest|jest|pytest|npm(?:\s+run)?\s+test|pnpm(?:\s+run)?\s+test|yarn(?:\s+run)?\s+test|npx\s+(?:vitest|jest)|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/i.test(
        effective,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Replace quoted substrings (double, single, backtick) with a space. */
function stripQuotedStrings(cmd: string): string {
  return cmd.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " ");
}

/**
 * Extract the effective command from a shell segment by stripping
 * leading/trailing grouping characters, environment variable assignments,
 * and common wrapper commands (sudo, env, timeout, nohup, time).
 * Iterates until stable, bounded to avoid runaway stripping on nested
 * compound prefixes such as `sudo timeout 60 pytest` or
 * `time env FOO=bar vitest`.
 */
function getEffectiveCommand(segment: string): string {
  let s = segment.trim();
  const MAX_STRIP_ITERATIONS = 10;
  for (let i = 0; i < MAX_STRIP_ITERATIONS; i++) {
    const before = s;
    // Strip leading/trailing grouping characters: ( ) { } [ ]
    s = s.replace(/^[({[]+\s*/, "").replace(/\s*[)}\]]+$/, "");
    // Strip leading environment variable assignments (VAR=value)
    s = s.replace(/^(?:\w+=\S+\s+)*/, "");
    // Strip common wrappers
    s = s.replace(/^(?:sudo|env|nohup|time)\s+/i, "");
    s = s.replace(/^timeout\s+\S+\s+/i, "");
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

/**
 * Strict Vitest/Jest aggregate line pattern.
 * Requires the whole line to be: "Test Files" or "Tests" keyword,
 * then one or more "<count> <status>" entries separated by commas,
 * optional "(<total>)" at end, no arbitrary suffix text allowed.
 */
const VITEST_AGGREGATE_STRICT_RE = /^(Test Files?|Tests)\s+(\d{1,6}\s+(?:passed|failed|skipped|pending|todo)(?:\s*,\s*\d{1,6}\s+(?:passed|failed|skipped|pending|todo))*)(?:\s*\(\d{1,6}\))?\s*$/i;

/** Regex to extract recognized count-status pairs from validated aggregate text. */
const COUNT_STATUS_RE = /(\d{1,6})\s+(passed|failed|skipped|pending|todo)/gi;

/** pytest summary line: "===== N passed, M failed in Xs =====" */
const PYTEST_SUMMARY_RE = /^=+\s*(.+?)\s*=*$/;
const PYTEST_COUNT_STATUS_RE = /(\d{1,6})\s+(passed|failed|error|skipped|warnings?)/gi;

/**
 * Strict pytest inner content pattern.
 * Requires the text between === markers to be canonical count-status pairs
 * optionally followed by "in <duration>s". Rejects arbitrary text.
 */
const PYTEST_INNER_STRICT_RE = /^\d{1,6}\s+(?:passed|failed|error|skipped|warnings?)(?:\s*,\s*\d{1,6}\s+(?:passed|failed|error|skipped|warnings?))*(?:\s+in\s+[\d.]+s)?$/i;

/**
 * Parse a Vitest/Jest aggregate line into normalized fact strings.
 * The whole line must match the canonical summary shape (strict regex);
 * lines with extra non-summary text or secrets are rejected entirely.
 */
function parseVitestAggregate(line: string): string[] {
  const strictMatch = VITEST_AGGREGATE_STRICT_RE.exec(line);
  if (!strictMatch) return [];

  const category = /^test\s+file/i.test(strictMatch[1]) ? "test file" : "test";

  // Extract count-status pairs only from the validated counts portion
  const pairs = [...strictMatch[2].matchAll(COUNT_STATUS_RE)];
  const facts: string[] = [];
  for (const pair of pairs) {
    const count = parseInt(pair[1], 10);
    const status = pair[2].toLowerCase();
    const plural = count === 1 ? category : `${category}s`;
    facts.push(`${count} ${plural} ${status}`);
  }
  return facts;
}

/**
 * Extract test summary facts from recognized aggregate lines only.
 * Broad catch-all patterns like /(\d+)\s+passed/ are intentionally absent —
 * only lines matching known test-runner summary formats are inspected.
 * Facts are normalized from parsed count/status fields, never raw lines.
 */
function extractTestFacts(output: string): string | null {
  const facts: string[] = [];
  const lines = output.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Vitest / Jest aggregate lines ("Test Files …" or "Tests …")
    // Fast-path prefix check; strict validation inside parseVitestAggregate
    if (/^(?:test\s+files?|tests)\s+\d/i.test(line)) {
      facts.push(...parseVitestAggregate(line));
      continue;
    }

    // pytest summary line ("===== 25 passed, 1 failed in 2.5s =====")
    // Requires the whole inner text between === markers to match canonical counts shape
    if (line.startsWith("=")) {
      const outerMatch = PYTEST_SUMMARY_RE.exec(line);
      if (outerMatch) {
        const inner = outerMatch[1].trim();
        if (PYTEST_INNER_STRICT_RE.test(inner)) {
          const countMatches = [...inner.matchAll(PYTEST_COUNT_STATUS_RE)];
          for (const cm of countMatches) {
            const count = parseInt(cm[1], 10);
            const status = cm[2].toLowerCase();
            facts.push(`${count} ${status}`);
          }
        }
      }
      continue;
    }
  }

  // Deduplicate while preserving order, then cap count
  const unique = [...new Set(facts)].slice(0, MAX_FACTS);
  return unique.length > 0 ? unique.join(", ") : null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}


