import { describe, expect, it } from "vitest";
import { buildEvidenceDigest, serializeEvidence, MAX_SUMMARY_LENGTH, MAX_FACTS, MAX_TOOL_RESULT_TEXT_LENGTH, MAX_COMMAND_SCAN_LENGTH, MAX_EVIDENCE_ITEMS, MAX_TOOL_NAME_LENGTH, MAX_TOOL_CALL_ID_LENGTH, type EvidenceItem } from "../src/evidence.js";

describe("buildEvidenceDigest", () => {
  describe("tool call extraction", () => {
    it("extracts tool calls from assistant messages", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "read",
              args: { path: "/test/file.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "file contents here",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        toolName: "read",
        isError: false,
      });
    });

    it("supports pi toolCall shape with name and arguments fields", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0]).toMatchObject({
        toolName: "bash",
        isError: false,
      });
      expect(evidence[0].summary).toContain("test");
      expect(evidence[0].summary).toContain("25 tests passed");
    });

    it("extracts multiple tool calls from a single assistant message", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "read",
              args: { path: "/file1.ts" },
            },
            {
              type: "toolCall",
              id: "call-2",
              toolName: "read",
              args: { path: "/file2.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "content 1",
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "read",
          isError: false,
          content: "content 2",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(2);
      expect(evidence[0].summary).toContain("/file1.ts");
      expect(evidence[1].summary).toContain("/file2.ts");
    });

    it("handles tool calls without matching results", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "read",
              args: { path: "/test.ts" },
            },
          ],
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(0);
    });

    it("handles tool results without matching calls", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "content",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("read");
    });
  });

  describe("bash summarization", () => {
    it("summarizes successful bash with no output", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "echo 'test'" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("bash");
      expect(evidence[0].summary).toContain("exit 0");
    });

    it("summarizes bash with vitest output", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "pnpm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)\nDuration  2.5s",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("6 test files passed");
      expect(evidence[0].summary).toContain("25 tests passed");
    });

    it("summarizes bash with test failures", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: true,
          content: "Test Files  5 passed, 1 failed (6)\nTests  24 passed, 1 failed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("1 test file failed");
      expect(evidence[0].isError).toBe(true);
    });

    it("summarizes bash with non-test error", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "ls /nonexistent" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: true,
          content: "ls: cannot access '/nonexistent': No such file or directory",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("exit non-zero");
      expect(evidence[0].isError).toBe(true);
    });

    it("summarizes bash with successful non-test output", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "ls -la" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "total 32\ndrwxr-xr-x  5 user staff 160 Jan 1 12:00 .\n",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("bash");
      expect(evidence[0].summary).toContain("ok");
    });

    it("does not leak heredoc or inline secrets in command", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { 
                command: "cat <<EOF\nAPI_KEY=sk-1234567890abcdef\nSECRET=my-super-secret-token\nEOF" 
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "API_KEY=sk-1234567890abcdef\nSECRET=my-super-secret-token",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should not contain the raw command or secrets
      expect(summary).not.toContain("API_KEY");
      expect(summary).not.toContain("sk-1234567890abcdef");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("my-super-secret-token");
      expect(summary).not.toContain("EOF");
      
      // Should contain safe classifier
      expect(summary).toContain("bash");
      expect(summary).toContain("file-inspect");
    });

    it("does not leak secrets from failing bash output", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "curl https://api.example.com" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: true,
          content: "Error: Authentication failed for token=ghp_1234567890abcdefghijklmnopqrstuvwxyz\nPlease check your credentials",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should not contain raw error output or secrets
      expect(summary).not.toContain("Authentication failed");
      expect(summary).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
      expect(summary).not.toContain("token=");
      expect(summary).not.toContain("curl");
      
      // Should contain safe summary
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).toContain("exit non-zero");
    });

    it("extracts test facts with safe command label", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { 
                command: "npm test -- --coverage --token=secret123" 
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)\nCoverage  85%",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should contain test facts (normalized)
      expect(summary).toContain("6 test files passed");
      expect(summary).toContain("25 tests passed");
      
      // Should use safe label, not raw command
      expect(summary).toContain("test");
      expect(summary).not.toContain("--coverage");
      expect(summary).not.toContain("--token");
      expect(summary).not.toContain("secret123");
      expect(summary).not.toContain("npm test");
    });

    it("does not extract facts from arbitrary verbose output (C5 adversarial)", () => {
      // Adversarial: arbitrary output with "N passed" fragments that are NOT
      // from recognized test-runner aggregate lines
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [
            "Running tests...",
            "test token 123456 passed validation",
            "test token 789012 passed checks",
            "test token 345678 failed assertion",
            "Some arbitrary line with 999 passed in it",
            "Another line: 888 failed here",
            "Verbose output: 777 passed and 666 failed",
            "Test Files  2 passed (2)",
            "Tests  10 passed (10)",
          ].join("\n"),
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract ONLY from recognized aggregate lines (normalized)
      expect(summary).toContain("2 test files passed");
      expect(summary).toContain("10 tests passed");

      // Should NOT extract arbitrary numeric fragments
      expect(summary).not.toContain("123456 passed");
      expect(summary).not.toContain("789012 passed");
      expect(summary).not.toContain("345678 failed");
      expect(summary).not.toContain("999 passed");
      expect(summary).not.toContain("888 failed");
      expect(summary).not.toContain("777 passed");
      expect(summary).not.toContain("666 failed");
      expect(summary).not.toContain("token");
      expect(summary).not.toContain("arbitrary");
      expect(summary).not.toContain("Verbose");
    });

    it("does not leak raw numeric fragments from verbose test output (C5)", () => {
      // Even when hasTestContent is triggered, arbitrary output must not leak
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "vitest run" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [
            "✓ src/auth.test.ts",
            "  ✓ login flow 123456 passed",
            "  ✓ logout flow 789012 passed",
            "✗ src/api.test.ts",
            "  ✗ request 345678 failed",
            "  ✗ response 999999 failed",
            "Some debug: 111 passed, 222 failed",
            "Test Files  1 passed, 1 failed (2)",
            "Tests  3 passed, 2 failed (5)",
          ].join("\n"),
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should contain aggregate facts only (normalized)
      expect(summary).toContain("1 test file passed");
      expect(summary).toContain("1 test file failed");
      expect(summary).toContain("3 tests passed");
      expect(summary).toContain("2 tests failed");

      // Should NOT leak individual test numeric fragments
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("789012");
      expect(summary).not.toContain("345678");
      expect(summary).not.toContain("999999");
      expect(summary).not.toContain("111 passed");
      expect(summary).not.toContain("222 failed");
    });

    it("does not include secret suffix from aggregate-looking line (C5b)", () => {
      // Adversarial: aggregate-looking lines with secret suffixes
      // With C8 strict grammar, lines with ANY extra non-summary text are rejected entirely
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  25 passed SECRET_TOKEN=ghp_abc123xyz\nTest Files  6 passed API_KEY=sk-secret123",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Lines with non-canonical suffixes are rejected entirely (C8 strict grammar)
      expect(summary).not.toContain("25 tests passed");
      expect(summary).not.toContain("6 test files passed");

      // Should NOT contain secrets from the aggregate line suffix
      expect(summary).not.toContain("SECRET_TOKEN");
      expect(summary).not.toContain("ghp_abc123xyz");
      expect(summary).not.toContain("API_KEY");
      expect(summary).not.toContain("sk-secret123");
      expect(summary).not.toContain("SECRET");
    });
  });

  describe("read summarization", () => {
    it("summarizes read with path", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "read",
              args: { path: "/test/file.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "Read 150 lines from /test/file.ts",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("read");
      expect(evidence[0].summary).toContain("/test/file.ts");
    });

    it("summarizes read with simple content", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "read",
              args: { path: "/test/file.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "file contents",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("read");
      expect(evidence[0].summary).toContain("/test/file.ts");
    });
  });

  describe("edit/write summarization", () => {
    it("summarizes edit with path", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "edit",
              args: { path: "/test/file.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit",
          isError: false,
          content: "Applied 3 edits to /test/file.ts",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("edit");
      expect(evidence[0].summary).toContain("/test/file.ts");
    });

    it("summarizes write operation", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "write",
              args: { path: "/test/new-file.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          isError: false,
          content: "Wrote to /test/new-file.ts",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("write");
      expect(evidence[0].summary).toContain("/test/new-file.ts");
    });
  });

  describe("bounding", () => {
    it("limits evidence to 12 items", () => {
      const messages = [];
      const toolCalls = [];
      const toolResults = [];

      for (let i = 1; i <= 20; i++) {
        toolCalls.push({
          type: "toolCall",
          id: `call-${i}`,
          toolName: "read",
          args: { path: `/file${i}.ts` },
        });
        toolResults.push({
          role: "toolResult",
          toolCallId: `call-${i}`,
          toolName: "read",
          isError: false,
          content: `content ${i}`,
        });
      }

      messages.push({ role: "assistant", content: toolCalls });
      messages.push(...toolResults);

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(12);
      
      // Should keep the most recent 12 items
      expect(evidence[0].summary).toContain("/file9.ts");
      expect(evidence[11].summary).toContain("/file20.ts");
    });

    it("returns all items when under the limit", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "read", args: { path: "/f1.ts" } },
            { type: "toolCall", id: "call-2", toolName: "read", args: { path: "/f2.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "c1",
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "read",
          isError: false,
          content: "c2",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(2);
    });
  });

  describe("summary length bounding (C2)", () => {
    it("caps huge test output summary to MAX_SUMMARY_LENGTH", () => {
      // Generate a massive test output with many unique pass/fail fragments
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(`  ✓ suite-${i} › test group ${i} › ${i} passed`);
      }
      lines.push(`Test Files  200 passed (200)`);
      lines.push(`Tests  200 passed (200)`);
      const output = lines.join("\n");

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("caps test facts to MAX_FACTS count", () => {
      // Generate output with more unique fact patterns than MAX_FACTS
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) {
        lines.push(`Suite ${i}: ${i} tests passed, ${i} tests failed`);
      }
      lines.push(`Test Files  20 passed (20)`);
      lines.push(`Tests  400 passed (400)`);
      const output = lines.join("\n");

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);

      // Count comma-separated facts after the arrow
      const factsPart = summary.split("→")[1]?.trim();
      if (factsPart) {
        const factsList = factsPart.split(", ").map((s) => s.trim());
        expect(factsList.length).toBeLessThanOrEqual(MAX_FACTS);
      }
    });

    it("serialized evidence does not contain unbounded repeated facts", () => {
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`${i} tests passed`);
        lines.push(`${i} tests failed`);
      }
      const output = lines.join("\n");

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      // The summary itself must be bounded
      expect(evidence[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);

      // And the serialized form should not contain the bulk of the repeated patterns
      const serialized = evidence[0].summary;
      // Count occurrences of "passed" — should be at most MAX_FACTS times, not 100
      const passedCount = (serialized.match(/passed/gi) || []).length;
      expect(passedCount).toBeLessThanOrEqual(MAX_FACTS + 1); // +1 tolerance for truncation mid-word
    });

    it("truncate respects max length including ellipsis for long paths", () => {
      const longPath = "/a".repeat(200); // 400-char path

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "read", args: { path: longPath } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "file contents",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      // The summary starts with "read → " so the path portion is truncated,
      // but the total summary must still be bounded
      expect(evidence[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("every evidence item summary is bounded to MAX_SUMMARY_LENGTH", () => {
      // Create various tool calls that could produce long summaries
      const longPath = "/" + "segment/".repeat(50) + "file.ts";
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "read", args: { path: longPath } },
            { type: "toolCall", id: "call-2", toolName: "edit", args: { path: longPath } },
            { type: "toolCall", id: "call-3", toolName: "write", args: { path: longPath } },
            { type: "toolCall", id: "call-4", toolName: "bash", args: { command: "vitest run --reporter=verbose --coverage" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "Read 500 lines from file",
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "edit",
          isError: false,
          content: "Applied 5 edits to file",
        },
        {
          role: "toolResult",
          toolCallId: "call-3",
          toolName: "write",
          isError: false,
          content: "Wrote to file",
        },
        {
          role: "toolResult",
          toolCallId: "call-4",
          toolName: "bash",
          isError: false,
          content: "Test Files  10 passed (10)\nTests  50 passed, 3 failed (53)\nDuration  5s\n" +
            "0 tests passed\n1 tests passed\n2 tests passed\n3 tests passed\n4 tests passed\n5 tests passed\n" +
            "6 tests passed\n7 tests passed\n8 tests passed\n9 tests passed\n10 tests passed\n" +
            "0 tests failed\n1 tests failed\n2 tests failed\n3 tests failed\n4 tests failed\n5 tests failed\n" +
            "6 tests failed\n7 tests failed\n8 tests failed\n9 tests failed\n10 tests failed",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      for (const item of evidence) {
        expect(item.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty messages array", () => {
      const evidence = buildEvidenceDigest([]);
      expect(evidence).toHaveLength(0);
    });

    it("handles messages without content", () => {
      const messages = [
        { role: "assistant" },
        { role: "user", content: "hello" },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(0);
    });

    it("handles malformed tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall" }, // missing id
            { type: "toolCall", id: "call-1" }, // missing toolName
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "unknown",
          isError: false,
          content: "result",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });

    it("handles tool result with array content", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              toolName: "bash",
              args: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [
            { type: "text", text: "Test Files  3 passed (3)\n" },
            { type: "text", text: "Tests  10 passed (10)" },
          ],
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("3 test files passed");
      expect(evidence[0].summary).toContain("10 tests passed");
    });
  });

  describe("bounded tool-result text window (C3)", () => {
    it("huge bash output is summarized from bounded content", () => {
      // Generate output with thousands of lines
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        lines.push(`Processing item ${i}: some verbose log output here`);
      }
      lines.push("Test Files  10 passed (10)");
      lines.push("Tests  50 passed (50)");
      const output = lines.join("\n");

      // Verify the output is much larger than the window
      expect(output.length).toBeGreaterThan(MAX_TOOL_RESULT_TEXT_LENGTH * 2);

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      
      // Summary must be bounded
      expect(evidence[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
      
      // Should contain test facts from the tail (normalized)
      expect(evidence[0].summary).toContain("10 test files passed");
      expect(evidence[0].summary).toContain("50 tests passed");
    });

    it("test aggregate facts near tail are captured", () => {
      // Create output where test facts are at the very end
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        lines.push(`[verbose log line ${i}] building module ${i} of 5000`);
      }
      // Add test aggregate at the tail
      lines.push("");
      lines.push("Test Files  42 passed (42)");
      lines.push("Tests  256 passed (256)");
      lines.push("Duration  15.3s");
      const output = lines.join("\n");

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Must capture the tail facts despite huge output (normalized)
      expect(summary).toContain("42 test files passed");
      expect(summary).toContain("256 tests passed");
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("secret/raw text in middle of huge output is not included", () => {
      // Create output with secrets in the middle (which should be truncated)
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(`Log line ${i}: normal output`);
      }
      // Add secrets in the middle
      lines.push("SECRET_API_KEY=stripe_secret_dummy_value_not_real_xx");
      lines.push("DATABASE_PASSWORD=super_secret_password_123");
      lines.push("AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");
      // Add more lines after secrets
      for (let i = 0; i < 2000; i++) {
        lines.push(`More log line ${i}: continuing normal output`);
      }
      lines.push("Test Files  5 passed (5)");
      lines.push("Tests  25 passed (25)");
      const output = lines.join("\n");

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      const serialized = JSON.stringify(evidence);
      
      // Secrets should not appear in summary or serialized evidence
      expect(summary).not.toContain("SECRET_API_KEY");
      expect(summary).not.toContain("stripe_secret_dummy_value_not_real_xx");
      expect(summary).not.toContain("DATABASE_PASSWORD");
      expect(summary).not.toContain("super_secret_password_123");
      expect(summary).not.toContain("AWS_ACCESS_KEY");
      expect(summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
      
      expect(serialized).not.toContain("SECRET_API_KEY");
      expect(serialized).not.toContain("stripe_secret_dummy_value_not_real_xx");
      expect(serialized).not.toContain("DATABASE_PASSWORD");
      expect(serialized).not.toContain("super_secret_password_123");
      expect(serialized).not.toContain("AWS_ACCESS_KEY");
      expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      
      // But test facts from tail should be captured (normalized)
      expect(summary).toContain("5 test files passed");
      expect(summary).toContain("25 tests passed");
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("small content is not truncated", () => {
      const output = "Test Files  3 passed (3)\nTests  10 passed (10)";

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: output,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence[0].summary).toContain("3 test files passed");
      expect(evidence[0].summary).toContain("10 tests passed");
    });

    it("huge array content avoids unbounded join and captures tail facts", () => {
      // Build array content where each part is large and test facts are near the tail
      const parts = [];
      for (let i = 0; i < 500; i++) {
        parts.push({ type: "text", text: `Log line ${i}: ${"x".repeat(100)}\n` });
      }
      // Add test facts near the tail
      parts.push({ type: "text", text: "Test Files  7 passed (7)\nTests  42 passed (42)" });
      
      // Verify total length exceeds the window
      const totalLen = parts.reduce((acc, p) => acc + p.text.length, 0);
      expect(totalLen).toBeGreaterThan(MAX_TOOL_RESULT_TEXT_LENGTH * 2);

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: parts,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should capture tail facts despite huge array content (normalized)
      expect(summary).toContain("7 test files passed");
      expect(summary).toContain("42 tests passed");
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("array content with many small parts builds bounded window in one pass (C6)", () => {
      // Regression test: many small text parts should not store all parts in memory
      // Build array with thousands of small parts, test facts at tail
      const parts = [];
      for (let i = 0; i < 2000; i++) {
        parts.push({ type: "text", text: `Small part ${i}\n` });
      }
      // Add test aggregate facts at the very end
      parts.push({ type: "text", text: "Test Files  15 passed (15)\nTests  128 passed (128)" });
      
      // Verify total length exceeds the window significantly
      const totalLen = parts.reduce((acc, p) => acc + p.text.length, 0);
      expect(totalLen).toBeGreaterThan(MAX_TOOL_RESULT_TEXT_LENGTH * 3);

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: parts,
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should capture tail facts despite thousands of small parts
      expect(summary).toContain("15 test files passed");
      expect(summary).toContain("128 tests passed");
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("huge command string is bounded before regex scanning", () => {
      // Build a command with a huge heredoc containing secrets
      const secretPayload = "SECRET_TOKEN=ghp_" + "x".repeat(10000);
      const command = `cat <<EOF\n${secretPayload}\nEOF`;
      
      // The command is huge
      expect(command.length).toBeGreaterThan(MAX_COMMAND_SCAN_LENGTH * 5);

      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "file contents",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      
      // Should not leak secrets
      expect(summary).not.toContain("SECRET_TOKEN");
      expect(summary).not.toContain("ghp_");
      
      // Should still classify as file-inspect (cat)
      expect(summary).toContain("bash");
      expect(summary).toContain("file-inspect");
      expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });
  });

  describe("safe serialization (C4)", () => {
    it("does not serialize raw toolCallId in evidence output", () => {
      const sensitiveId = "sk-proj-" + "x".repeat(1000) + "-secret-key";
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: sensitiveId, toolName: "read", args: { path: "/test.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: sensitiveId,
          toolName: "read",
          isError: false,
          content: "file contents",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const serialized = serializeEvidence(evidence);
      
      // Raw toolCallId must not appear in serialized output
      expect(serialized).not.toContain(sensitiveId);
      expect(serialized).not.toContain("sk-proj-");
      expect(serialized).not.toContain("secret-key");
      
      // Should use ordinal index instead
      expect(serialized).toContain('index="0"');
      expect(serialized).not.toContain("toolCallId");
    });

    it("does not serialize raw unexpected toolName in evidence output or summary", () => {
      const sensitiveToolName = "internal_secret_tool_v2_with_api_key_exposed";
      const messages = [
        {
          role: "assistant",
          content: [
            { 
              type: "toolCall", 
              id: "call-1", 
              toolName: sensitiveToolName, 
              args: { query: "test" } 
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: sensitiveToolName,
          isError: false,
          content: "result data",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const serialized = serializeEvidence(evidence);
      
      // Raw unexpected toolName must not appear anywhere
      expect(serialized).not.toContain(sensitiveToolName);
      expect(serialized).not.toContain("secret_tool");
      expect(serialized).not.toContain("api_key_exposed");
      
      // Evidence item toolName should be normalized
      expect(evidence[0].toolName).toBe("other");
      
      // Summary should use safe label, not raw name
      expect(evidence[0].summary).not.toContain(sensitiveToolName);
      expect(evidence[0].summary).not.toContain("secret_tool");
      expect(evidence[0].summary).toContain("other");
    });

    it("normal known tool names still appear usefully in serialized output", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "echo test" } },
            { type: "toolCall", id: "call-2", toolName: "read", args: { path: "/file.ts" } },
            { type: "toolCall", id: "call-3", toolName: "edit", args: { path: "/code.ts" } },
            { type: "toolCall", id: "call-4", toolName: "write", args: { path: "/new.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "",
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "read",
          isError: false,
          content: "Read 100 lines from /file.ts",
        },
        {
          role: "toolResult",
          toolCallId: "call-3",
          toolName: "edit",
          isError: false,
          content: "Applied 2 edits to /code.ts",
        },
        {
          role: "toolResult",
          toolCallId: "call-4",
          toolName: "write",
          isError: false,
          content: "Wrote to /new.ts",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const serialized = serializeEvidence(evidence);
      
      // Known tool names should appear in serialized output
      expect(serialized).toContain('tool="bash"');
      expect(serialized).toContain('tool="read"');
      expect(serialized).toContain('tool="edit"');
      expect(serialized).toContain('tool="write"');
      
      // Evidence items should have normalized known names
      expect(evidence[0].toolName).toBe("bash");
      expect(evidence[1].toolName).toBe("read");
      expect(evidence[2].toolName).toBe("edit");
      expect(evidence[3].toolName).toBe("write");
    });

    it("serialized evidence total size remains bounded with malicious ids and names", () => {
      const maliciousId = "A".repeat(10000);
      const maliciousName = "B".repeat(10000);
      
      const messages = [];
      // Create MAX_EVIDENCE_ITEMS with huge malicious ids and names
      for (let i = 0; i < MAX_EVIDENCE_ITEMS; i++) {
        messages.push({
          role: "assistant",
          content: [
            { 
              type: "toolCall", 
              id: maliciousId + i, 
              toolName: maliciousName + i, 
              args: { test: "data" } 
            },
          ],
        });
        messages.push({
          role: "toolResult",
          toolCallId: maliciousId + i,
          toolName: maliciousName + i,
          isError: false,
          content: "x".repeat(5000),
        });
      }

      const evidence = buildEvidenceDigest(messages);
      const serialized = serializeEvidence(evidence);
      
      // Malicious content must not appear
      expect(serialized).not.toContain(maliciousId);
      expect(serialized).not.toContain(maliciousName);
      
      // Total size should be bounded:
      // MAX_EVIDENCE_ITEMS * (overhead ~80 chars + MAX_SUMMARY_LENGTH) + wrapper ~100 chars
      const maxExpectedSize = MAX_EVIDENCE_ITEMS * (MAX_SUMMARY_LENGTH + 80) + 100;
      expect(serialized.length).toBeLessThanOrEqual(maxExpectedSize);
      
      // Verify we got the expected number of items
      expect(evidence).toHaveLength(MAX_EVIDENCE_ITEMS);
      
      // All items should have normalized toolName
      for (const item of evidence) {
        expect(item.toolName).toBe("other");
        expect(item.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
      }
    });

    it("generic tool error uses safe normalized label", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { 
              type: "toolCall", 
              id: "call-1", 
              toolName: "custom_internal_tool_with_secrets", 
              args: {} 
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom_internal_tool_with_secrets",
          isError: true,
          content: "error occurred",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      
      // Should use normalized "other" label, not raw name
      expect(evidence[0].toolName).toBe("other");
      expect(evidence[0].summary).toContain("other");
      expect(evidence[0].summary).toContain("error");
      expect(evidence[0].summary).not.toContain("custom_internal_tool");
      expect(evidence[0].summary).not.toContain("secrets");
    });
  });

  describe("adversarial: read/edit/write content injection (C7)", () => {
    it("read result content containing 'SECRET 123456 lines' does not leak into summary or serialized evidence", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "read", args: { path: "/test/file.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "SECRET 123456 lines of sensitive data here",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      const serialized = serializeEvidence(evidence);

      // Summary should only contain safe path-based summary
      expect(summary).toContain("read");
      expect(summary).toContain("/test/file.ts");

      // Must NOT leak numeric fragments or secrets from content
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("lines");
      expect(summary).not.toContain("sensitive");

      // Serialized evidence must not contain them either
      expect(serialized).not.toContain("123456");
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("sensitive");
    });

    it("edit result content containing 'SECRET 9 edits' does not leak into summary or serialized evidence", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "edit", args: { path: "/test/file.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit",
          isError: false,
          content: "SECRET 9 edits applied successfully",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      const serialized = serializeEvidence(evidence);

      expect(summary).toContain("edit");
      expect(summary).toContain("/test/file.ts");

      expect(summary).not.toContain("9 edits");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("edits applied");

      expect(serialized).not.toContain("9 edits");
      expect(serialized).not.toContain("SECRET");
    });

    it("write result content containing 'SECRET 9 edits' does not leak into summary or serialized evidence", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "write", args: { path: "/test/file.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          isError: false,
          content: "SECRET 9 edits written to disk",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;
      const serialized = serializeEvidence(evidence);

      expect(summary).toContain("write");
      expect(summary).toContain("/test/file.ts");

      expect(summary).not.toContain("9 edits");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("written");

      expect(serialized).not.toContain("9 edits");
      expect(serialized).not.toContain("SECRET");
    });

    it("read summary is deterministic regardless of result content", () => {
      const makeMsg = (content: string) => ([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", toolName: "read", args: { path: "/file.ts" } }],
        },
        { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content },
      ]);

      const e1 = buildEvidenceDigest(makeMsg(""));
      const e2 = buildEvidenceDigest(makeMsg("Read 999999 lines SECRET_KEY=sk_abc123"));
      const e3 = buildEvidenceDigest(makeMsg("any arbitrary content whatsoever"));

      // All three should produce the exact same summary — path-only
      expect(e1[0].summary).toBe(e2[0].summary);
      expect(e2[0].summary).toBe(e3[0].summary);
    });

    it("edit/write summary is deterministic regardless of result content", () => {
      const makeMsg = (tool: string, content: string) => ([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", toolName: tool, args: { path: "/file.ts" } }],
        },
        { role: "toolResult", toolCallId: "c1", toolName: tool, isError: false, content },
      ]);

      const e1 = buildEvidenceDigest(makeMsg("edit", ""));
      const e2 = buildEvidenceDigest(makeMsg("edit", "Applied 999999 edits SECRET"));
      expect(e1[0].summary).toBe(e2[0].summary);

      const w1 = buildEvidenceDigest(makeMsg("write", ""));
      const w2 = buildEvidenceDigest(makeMsg("write", "Wrote 999999 lines PASSWORD=hunter2"));
      expect(w1[0].summary).toBe(w2[0].summary);
    });
  });

  describe("adversarial: test fact extraction strict grammar (C8)", () => {
    it("Vitest/Jest line with secret numeric/status suffix is ignored entirely", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  25 passed SECRET 123456 failed",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Line should be rejected entirely due to non-canonical suffix
      expect(summary).not.toContain("25 tests passed");
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("failed");
    });

    it("Test Files line with secret suffix is ignored entirely", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed SECRET 789 failed",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Line should be rejected entirely
      expect(summary).not.toContain("6 test files passed");
      expect(summary).not.toContain("789");
      expect(summary).not.toContain("SECRET");
    });

    it("pytest line with arbitrary text and numeric/status is ignored", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== token 123456 passed validation =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should not extract the arbitrary numeric/status
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("passed");
      expect(summary).not.toContain("token");
      expect(summary).not.toContain("validation");
    });

    it("pytest line with multiple arbitrary counts is ignored", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== SECRET 999 failed something 888 passed =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should not extract any arbitrary counts
      expect(summary).not.toContain("999");
      expect(summary).not.toContain("888");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("something");
    });

    it("valid Vitest aggregate lines still produce normalized facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid canonical lines should still work
      expect(summary).toContain("6 test files passed");
      expect(summary).toContain("25 tests passed");
    });

    it("valid Vitest aggregate with mixed statuses still works", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  24 passed, 1 failed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid canonical line with comma-separated counts
      expect(summary).toContain("24 tests passed");
      expect(summary).toContain("1 test failed");
    });

    it("valid pytest summary lines still produce normalized facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 25 passed, 1 failed in 2.5s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid canonical pytest line should work
      expect(summary).toContain("25 passed");
      expect(summary).toContain("1 failed");
    });

    it("valid pytest summary without duration still works", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 10 passed =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid canonical pytest line without duration
      expect(summary).toContain("10 passed");
    });

    it("mixed valid and invalid lines only extracts from valid ones", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: "bash", args: { command: "npm test" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [
            "Tests  25 passed SECRET 123456 failed",  // Invalid - rejected
            "===== token 999 passed validation =====",  // Invalid - rejected
            "Test Files  6 passed (6)",  // Valid
            "Tests  24 passed, 1 failed (25)",  // Valid
            "===== 10 passed in 0.5s =====",  // Valid
          ].join("\n"),
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract only from valid canonical lines
      expect(summary).toContain("6 test files passed");
      expect(summary).toContain("24 tests passed");
      expect(summary).toContain("1 test failed");
      expect(summary).toContain("10 passed");

      // Should NOT extract from invalid lines
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("999");
      expect(summary).not.toContain("SECRET");
      expect(summary).not.toContain("token");
    });
  });

  describe("public EvidenceItem shape (C7)", () => {
    it("does not expose toolCallId on returned evidence items", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "sensitive-id-sk-proj-123", toolName: "read", args: { path: "/f.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "sensitive-id-sk-proj-123",
          toolName: "read",
          isError: false,
          content: "ok",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);

      // toolCallId must not be a property on the item
      expect("toolCallId" in evidence[0]).toBe(false);
      expect((evidence[0] as any).toolCallId).toBeUndefined();

      // Sensitive id must not appear anywhere in JSON serialization
      const json = JSON.stringify(evidence);
      expect(json).not.toContain("sensitive-id");
      expect(json).not.toContain("sk-proj-123");
    });
  });

  describe("C10: normalizeToolName accepts unknown", () => {
    it("non-string tool names (number) do not throw and normalize to other", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: 42, arguments: { command: "ls" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: 42,
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });

    it("null tool name does not throw and normalizes to other", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: null, arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: null,
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });

    it("undefined tool name does not throw and normalizes to other", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });

    it("boolean tool name does not throw and normalizes to other", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: true, arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: false,
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });

    it("object tool name does not throw and normalizes to other", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: { evil: true }, arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: { evil: true },
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
    });
  });

  describe("C10: many unmatched calls with huge args do not leak", () => {
    it("many unmatched tool calls with huge args do not leak huge command/path into evidence and latest matched calls still work", () => {
      const hugeArg = "x".repeat(50_000);
      const messages: any[] = [];
      const toolCalls: any[] = [];

      // Create many unmatched tool calls with huge args (exceeds MAX_PENDING_CALLS)
      for (let i = 0; i < MAX_EVIDENCE_ITEMS * 4; i++) {
        toolCalls.push({
          type: "toolCall",
          id: `unmatched-${i}`,
          name: "bash",
          arguments: { command: hugeArg },
        });
      }

      // Add a matched call at the end with normal args
      toolCalls.push({
        type: "toolCall",
        id: "matched-final",
        name: "bash",
        arguments: { command: "echo done" },
      });

      messages.push({ role: "assistant", content: toolCalls });

      // Only the last call gets a result
      messages.push({
        role: "toolResult",
        toolCallId: "matched-final",
        toolName: "bash",
        isError: false,
        content: "done",
      });

      const evidence = buildEvidenceDigest(messages);
      const serialized = JSON.stringify(evidence);

      // Huge arg must not appear anywhere in evidence
      expect(serialized.length).toBeLessThan(50_000);
      expect(serialized).not.toContain("xxxxx");

      // Latest matched call should work normally
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("bash");
      // "echo" is classified as "other" by classifyCommand
      expect(evidence[0].summary).toContain("bash");
      expect(evidence[0].summary).toContain("other");
    });

    it("many unmatched read calls with huge paths do not leak", () => {
      const hugePath = "/" + "a".repeat(50_000);
      const messages: any[] = [];
      const toolCalls: any[] = [];

      for (let i = 0; i < MAX_EVIDENCE_ITEMS * 4; i++) {
        toolCalls.push({
          type: "toolCall",
          id: `unmatched-read-${i}`,
          name: "read",
          arguments: { path: hugePath },
        });
      }

      toolCalls.push({
        type: "toolCall",
        id: "matched-read-final",
        name: "read",
        arguments: { path: "/real/file.ts" },
      });

      messages.push({ role: "assistant", content: toolCalls });
      messages.push({
        role: "toolResult",
        toolCallId: "matched-read-final",
        toolName: "read",
        isError: false,
        content: "file contents",
      });

      const evidence = buildEvidenceDigest(messages);
      const serialized = JSON.stringify(evidence);

      // Huge path must not appear
      expect(serialized.length).toBeLessThan(50_000);
      expect(serialized).not.toContain("aaaaa");

      // Latest matched call works
      expect(evidence).toHaveLength(1);
      expect(evidence[0].summary).toContain("/real/file.ts");
    });

    it("matched calls delete pending call metadata (calls map does not retain paired entries)", () => {
      // Create MAX_PENDING_CALLS * 2 matched calls — if deletion after pairing
      // works, all should produce evidence (bounded by MAX_EVIDENCE_ITEMS rolling buffer)
      const messages: any[] = [];
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      for (let i = 0; i < MAX_EVIDENCE_ITEMS * 3; i++) {
        toolCalls.push({
          type: "toolCall",
          id: `call-${i}`,
          name: "read",
          arguments: { path: `/file${i}.ts` },
        });
        toolResults.push({
          role: "toolResult",
          toolCallId: `call-${i}`,
          toolName: "read",
          isError: false,
          content: `content ${i}`,
        });
      }

      messages.push({ role: "assistant", content: toolCalls });
      messages.push(...toolResults);

      const evidence = buildEvidenceDigest(messages);

      // Rolling buffer keeps latest MAX_EVIDENCE_ITEMS
      expect(evidence).toHaveLength(MAX_EVIDENCE_ITEMS);

      // Should have the latest items
      const lastIdx = MAX_EVIDENCE_ITEMS * 3 - 1;
      const firstKeptIdx = lastIdx - MAX_EVIDENCE_ITEMS + 1;
      expect(evidence[evidence.length - 1].summary).toContain(`/file${lastIdx}.ts`);
      expect(evidence[0].summary).toContain(`/file${firstKeptIdx}.ts`);
    });
  });

  describe("C10: huge toolCallId does not appear in evidence", () => {
    it("huge toolCallId is skipped and does not break extraction for subsequent calls", () => {
      const hugeId = "call-" + "x".repeat(1000);
      const messages = [
        {
          role: "assistant",
          content: [
            // Huge id call — should be skipped
            { type: "toolCall", id: hugeId, name: "bash", arguments: { command: "secret-cmd" } },
            // Normal call right after
            { type: "toolCall", id: "call-ok", name: "bash", arguments: { command: "echo hi" } },
          ],
        },
        // Result for huge id (no matching call stored)
        {
          role: "toolResult",
          toolCallId: hugeId,
          toolName: "bash",
          isError: false,
          content: "should-not-match",
        },
        // Result for normal call
        {
          role: "toolResult",
          toolCallId: "call-ok",
          toolName: "bash",
          isError: false,
          content: "hi output",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const serialized = JSON.stringify(evidence);

      // Huge id must not appear anywhere
      expect(serialized).not.toContain(hugeId);
      expect(serialized).not.toContain("xxxxx");

      // Normal call should still pair and work
      // "echo" is classified as "other" by classifyCommand
      expect(evidence.some((e) => e.summary.includes("bash") && e.summary.includes("other"))).toBe(true);
    });

    it("huge toolCallId on toolResult does not throw", () => {
      const hugeId = "result-" + "z".repeat(1000);
      const messages = [
        {
          role: "toolResult",
          toolCallId: hugeId,
          toolName: "bash",
          isError: false,
          content: "orphan result",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      // No matching call, but still produces an evidence item
      // toolName comes from result.toolName which is "bash"
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("bash");
    });

    it("non-string toolCallId on toolResult is safely ignored", () => {
      const messages = [
        {
          role: "toolResult",
          toolCallId: 12345,
          toolName: "bash",
          isError: false,
          content: "orphan",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      // toolCallId is not a string, so it won't match the typeof check and is skipped
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(0);
    });

    it("non-string id on toolCall part is safely skipped", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: 99999, name: "bash", arguments: { command: "ls" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "99999",
          toolName: "bash",
          isError: false,
          content: "output",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      // The call was skipped (id is not a string), so result has no matching call
      // but still produces an evidence item from the result alone
      expect(evidence).toHaveLength(1);
    });
  });

  describe("C11: boundedness of raw tool names and result-side toolCallId", () => {
    it("huge toolName string with known name embedded does not throw/leak and normalizes to other", () => {
      const hugeName = "bash" + "x".repeat(10_000);
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: hugeName, arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: hugeName,
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");

      // Huge name must not leak into summary or serialized evidence
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(hugeName);
      expect(serialized).not.toContain("xxxxx");
      expect(evidence[0].summary).not.toContain(hugeName);
      expect(evidence[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    });

    it("huge toolName with embedded secret does not throw/leak and normalizes to other", () => {
      const secretName = "SECRET_API_KEY=sk_live_" + "a".repeat(5_000);
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", toolName: secretName, args: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: secretName,
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");

      const serialized = serializeEvidence(evidence);
      expect(serialized).not.toContain("SECRET_API_KEY");
      expect(serialized).not.toContain("sk_live_");
      expect(serialized).not.toContain("aaaaa");
    });

    it("huge result-side toolCallId does not prevent emitting safe orphan evidence and does not leak", () => {
      const hugeId = "orphan-" + "z".repeat(50_000);
      const messages = [
        {
          role: "toolResult",
          toolCallId: hugeId,
          toolName: "bash",
          isError: false,
          content: "orphan result output",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);

      // Orphan result should still produce evidence
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("bash");

      // Huge id must not appear anywhere in evidence
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(hugeId);
      expect(serialized).not.toContain("zzzzz");
      expect(serialized.length).toBeLessThan(1_000);
    });

    it("huge result-side toolCallId with huge toolName does not leak either", () => {
      const hugeId = "result-" + "y".repeat(50_000);
      const hugeName = "evil_tool_" + "x".repeat(50_000);
      const messages = [
        {
          role: "toolResult",
          toolCallId: hugeId,
          toolName: hugeName,
          isError: true,
          content: "error occurred",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);

      // Should produce orphan evidence with safe normalized name
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("other");
      expect(evidence[0].isError).toBe(true);

      // Neither huge id nor huge name should leak
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(hugeId);
      expect(serialized).not.toContain(hugeName);
      expect(serialized).not.toContain("yyyyy");
      expect(serialized).not.toContain("xxxxx");
      expect(serialized).not.toContain("evil_tool");
    });

    it("huge result-side toolCallId does not use huge id for map lookup", () => {
      // Create a scenario where a huge id on toolResult should not attempt
      // to look up in the calls map (avoiding unbounded string operations)
      const hugeId = "huge-" + "w".repeat(100_000);
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "normal-call", name: "bash", arguments: { command: "echo test" } },
          ],
        },
        // Huge id result — should not match anything and not break normal pairing
        {
          role: "toolResult",
          toolCallId: hugeId,
          toolName: "bash",
          isError: false,
          content: "huge id orphan",
        },
        // Normal result — should still pair correctly
        {
          role: "toolResult",
          toolCallId: "normal-call",
          toolName: "bash",
          isError: false,
          content: "normal output",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);

      // Should have 2 items: one orphan (huge id) and one matched (normal)
      expect(evidence).toHaveLength(2);

      // Huge id must not leak
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(hugeId);
      expect(serialized).not.toContain("wwwww");
      expect(serialized.length).toBeLessThan(2_000);
    });
  });

  describe("C12: extractCommand/extractPath reject non-string fields", () => {
    it("array command does not throw or leak", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: ["echo", "test"] } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].toolName).toBe("bash");
      // Should not leak array stringification
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("echo,test");
      expect(serialized).not.toContain("[object");
    });

    it("object command with throwing toString does not throw or leak", () => {
      const evilObj = { toString() { throw new Error("boom"); } };
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: evilObj } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
    });

    it("function command does not throw or leak", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: () => "secret" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("function");
    });

    it("number command does not throw", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: 12345 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("12345");
    });

    it("null command does not throw", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: null } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
    });

    it("array path does not throw or leak", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: ["/etc", "passwd"] } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("/etc,passwd");
      expect(serialized).not.toContain("[object");
    });

    it("object path with throwing toString does not throw or leak", () => {
      const evilObj = { toString() { throw new Error("boom"); } };
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: evilObj } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
    });

    it("function path does not throw or leak", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: () => "/secret/path" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("/secret/path");
      expect(serialized).not.toContain("function");
    });

    it("number path does not throw", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: 99999 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: "ok",
        },
      ];

      expect(() => buildEvidenceDigest(messages)).not.toThrow();
      const evidence = buildEvidenceDigest(messages);
      expect(evidence).toHaveLength(1);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("99999");
    });
  });

  describe("C12: overlong test counts are rejected", () => {
    it("overlong pytest count (7+ digits) is ignored", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 1234567 passed in 2.5s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Overlong count should be rejected
      expect(summary).not.toContain("1234567");
      expect(summary).not.toContain("passed");
    });

    it("overlong Vitest/Jest count (7+ digits) is ignored", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  9999999 passed (9999999)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Overlong count should be rejected
      expect(summary).not.toContain("9999999");
      expect(summary).not.toContain("passed");
    });

    it("valid pytest count (6 digits) still works", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 999999 passed in 2.5s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid 6-digit count should work
      expect(summary).toContain("999999 passed");
    });

    it("valid Vitest/Jest count (6 digits) still works", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "vitest run" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  999999 passed (999999)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Valid 6-digit count should work
      expect(summary).toContain("999999 tests passed");
    });

    it("pytest emits parsed count/status fields, not raw matched text", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pytest" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 25 passed, 1 failed in 2.5s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should contain parsed individual facts
      expect(summary).toContain("25 passed");
      expect(summary).toContain("1 failed");
    });
  });

  describe("C13: test fact extraction gated on command classification", () => {
    it("non-test command with canonical test output does NOT extract facts (AC3)", () => {
      // echo is not a test runner, even though output contains canonical test lines
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: 'echo "Tests  25 passed (25)"' },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Tests  25 passed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should summarize as ok, NOT extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).toContain("ok");
      expect(summary).not.toContain("25 tests passed");
      expect(summary).not.toContain("passed");
    });

    it("orphan bash result with test-looking output does NOT extract facts (AC4)", () => {
      // No paired command, so classifyCommand gets empty string → "other"
      const messages = [
        {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should summarize as ok, NOT extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).toContain("ok");
      expect(summary).not.toContain("6 test files passed");
      expect(summary).not.toContain("25 tests passed");
    });

    it("valid test runner with canonical output still extracts facts (AC5)", () => {
      // Sanity check: test runner commands still work
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "vitest run" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  3 passed (3)\nTests  15 passed (15)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("3 test files passed");
      expect(summary).toContain("15 tests passed");
    });

    it("test runner with no canonical output falls back to ok/error", () => {
      // Test runner command but output has no canonical aggregate lines
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Running tests...\nSome verbose output\nNo aggregate lines here",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // extractTestFacts returns null, so falls back to ok
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("ok");
    });

    it("ls command with test-looking output does NOT extract facts", () => {
      // ls is classified as file-inspect, not test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "ls -la" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  10 passed (10)\nTests  50 passed (50)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should summarize as ok with file-inspect label
      expect(summary).toContain("bash");
      expect(summary).toContain("file-inspect");
      expect(summary).toContain("ok");
      expect(summary).not.toContain("10 test files passed");
      expect(summary).not.toContain("50 tests passed");
    });
  });

  describe("C14: shell-position aware test command classification", () => {
    it("echo with quoted test runner name does NOT classify as test (AC3)", () => {
      // echo "npm test" should not classify as test even though output has canonical test lines
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: 'echo "npm test"' },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "npm test",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should NOT extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).not.toContain("test");
    });

    it("grep with test runner name in arguments does NOT classify as test (AC3)", () => {
      // grep pytest README.md should classify as file-inspect, not test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "grep pytest README.md" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  25 passed (25)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should classify as file-inspect and NOT extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("file-inspect");
      expect(summary).toContain("ok");
      expect(summary).not.toContain("6 test files passed");
      expect(summary).not.toContain("25 tests passed");
    });

    it("printf with quoted test runner name does NOT classify as test (AC3)", () => {
      // printf "vitest" should not classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: 'printf "vitest"' },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  3 passed (3)\nTests  15 passed (15)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should NOT extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).toContain("ok");
      expect(summary).not.toContain("3 test files passed");
      expect(summary).not.toContain("15 tests passed");
    });

    it("test runner after shell separator (&&) still classifies as test (AC2)", () => {
      // cd project && npm test should classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "cd project && npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  5 passed (5)\nTests  20 passed (20)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("5 test files passed");
      expect(summary).toContain("20 tests passed");
    });

    it("test runner after pipe (|) still classifies as test (AC2)", () => {
      // vitest run | tee output.log should classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "vitest run | tee output.log" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  2 passed (2)\nTests  10 passed (10)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("2 test files passed");
      expect(summary).toContain("10 tests passed");
    });

    it("test runner with environment variable prefix still classifies as test (AC2)", () => {
      // CI=true npm test should classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "CI=true npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  4 passed (4)\nTests  18 passed (18)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("4 test files passed");
      expect(summary).toContain("18 tests passed");
    });

    it("test runner with timeout wrapper still classifies as test (AC2)", () => {
      // timeout 60 pytest should classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "timeout 60 pytest" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 30 passed in 2.1s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("30 passed");
    });

    it("cat with test runner name in filename does NOT classify as test", () => {
      // cat pytest.ini should classify as file-inspect, not test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "cat pytest.ini" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "[pytest]\ntestpaths = tests",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should classify as file-inspect
      expect(summary).toContain("bash");
      expect(summary).toContain("file-inspect");
      expect(summary).not.toContain("test");
    });

    it("single quotes also prevent test classification (AC3)", () => {
      // echo 'npm test' should not classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "echo 'npm test'" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "npm test",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should NOT classify as test
      expect(summary).toContain("bash");
      expect(summary).toContain("other");
      expect(summary).not.toContain("test");
    });

    it("test runner in subshell still classifies as test (AC2)", () => {
      // (cd project && npm test) should classify as test
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "(cd project && npm test)" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  7 passed (7)\nTests  35 passed (35)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      // Should extract test facts
      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("7 test files passed");
      expect(summary).toContain("35 tests passed");
    });
  });

  describe("C15: real JS test invocations and compound wrapper prefixes", () => {
    it("npm run test with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "npm run test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  4 passed (4)\nTests  18 passed (18)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("4 test files passed");
      expect(summary).toContain("18 tests passed");
    });

    it("pnpm run test with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "pnpm run test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  5 passed (5)\nTests  22 passed (22)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("5 test files passed");
      expect(summary).toContain("22 tests passed");
    });

    it("yarn run test with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "yarn run test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  3 passed (3)\nTests  14 passed (14)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("3 test files passed");
      expect(summary).toContain("14 tests passed");
    });

    it("env CI=true npm test with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "env CI=true npm test" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  6 passed (6)\nTests  26 passed (26)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("6 test files passed");
      expect(summary).toContain("26 tests passed");
    });

    it("sudo timeout 60 pytest with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "sudo timeout 60 pytest" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "===== 31 passed in 2.1s =====",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("31 passed");
    });

    it("time env FOO=bar vitest with canonical output extracts test facts", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "time env FOO=bar vitest" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: "Test Files  2 passed (2)\nTests  9 passed (9)",
        },
      ];

      const evidence = buildEvidenceDigest(messages);
      const summary = evidence[0].summary;

      expect(summary).toContain("bash");
      expect(summary).toContain("test");
      expect(summary).toContain("2 test files passed");
      expect(summary).toContain("9 tests passed");
    });

    it("C14 negatives still do not fabricate test facts", () => {
      const negatives = [
        {
          command: 'echo "npm test"',
          output: "npm test",
          expectedLabel: "other",
        },
        {
          command: "grep pytest README.md",
          output: "Test Files  6 passed (6)\nTests  25 passed (25)",
          expectedLabel: "file-inspect",
        },
        {
          command: 'printf "vitest"',
          output: "Test Files  3 passed (3)\nTests  15 passed (15)",
          expectedLabel: "other",
        },
      ];

      for (const { command, output, expectedLabel } of negatives) {
        const messages = [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            isError: false,
            content: output,
          },
        ];

        const evidence = buildEvidenceDigest(messages);
        const summary = evidence[0].summary;

        expect(summary).toContain("bash");
        expect(summary).toContain(expectedLabel);
        expect(summary).not.toContain("test files passed");
        expect(summary).not.toContain("tests passed");
      }
    });
  });
});
