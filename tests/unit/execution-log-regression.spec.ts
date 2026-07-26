import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveOutputCeiling, normalizeForProvider } from "../../src/agent-session.js";
import { findWhitespaceTolerantMatch } from "../../src/diff-edit-service.js";
import { normalizeTodoStatus } from "../../src/planning-store.js";
import { extractReporterJson } from "../../packages/local-runtime/src/test-harness.js";
import { glob, searchFiles } from "../../packages/local-runtime/src/file-ops.js";
import { isAllowedCommand, validateArgs } from "../../packages/local-runtime/src/security.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

// Each case below is distilled from a real failure in the captured execution logs
// (see scripts/analyze-execution-log.mjs). The suite asserts the harness now
// handles the input that previously produced a tool failure or session death.

describe("execution-log regressions — Tier 1 (session-killing)", () => {
  it("clamps the 65536 output-escalation that 400'd Bedrock ('exceeds the model limit of 64000')", () => {
    const ceiling = resolveOutputCeiling("us.anthropic.claude-opus-4-8", "bedrock");
    expect(ceiling).toBe(64_000);
    expect(Math.min(65_536, ceiling!)).toBe(64_000);
  });

  it("makes a post-compression assistant-first window valid (no more 'Expected toolResult blocks at messages.0')", () => {
    // The exact shape after "Compression ×2 applied" in the logs: window opens on the
    // assistant tool_use whose result was the dropped boundary.
    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "wUqk", name: "file_search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "wUqk", content: "ok" }] },
    ];
    expect(normalizeForProvider(messages)[0]!.role).toBe("user");
  });
});

describe("execution-log regressions — Tier 2 (tool friction)", () => {
  it("file_edit: tolerates the whitespace drift behind 'oldString was not found'", () => {
    const file = "function add(a, b) {\n\treturn a + b;\n}\n";
    expect(findWhitespaceTolerantMatch(file, "function add(a, b) {\n    return a + b;\n}")).not.toBeNull();
  });

  it("file_search/glob: accepts a file path instead of 'path must be a directory.'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bs-reg-"));
    const file = path.join(tmp, "main.js");
    fs.writeFileSync(file, "const x = 1;\n", "utf8");
    try {
      expect(glob(tmp, file, "*.js").ok).toBe(true);
      expect(searchFiles(tmp, file, "const").ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("shell_run: the common 'wc' utility is now allowed (was 'not in the allowed list')", () => {
    expect(isAllowedCommand("wc")).toBe(true);
    expect(isAllowedCommand("cut")).toBe(true);
  });

  it("shell_run: blocked eval flags still tell the model what to do instead", () => {
    expect(() => validateArgs("node", ["-e", "x"])).toThrowError(/Write the snippet to a file/i);
  });
});

describe("execution-log regressions — Tier 3 (data integrity & env)", () => {
  it("todo_update: maps natural-language status synonyms (was 'status must be running, done, or failed')", () => {
    expect(normalizeTodoStatus("in_progress")).toBe("running");
    expect(normalizeTodoStatus("completed")).toBe("done");
    expect(normalizeTodoStatus("blocked")).toBe("failed");
  });

  it("test_run: recovers the JSON report from mixed reporter output (was 'Could not parse test output')", () => {
    const mixed = '✓ src/foo.spec.ts (3)\n{"numPassedTests":3,"numFailedTests":0,"testResults":[]}\nTests  3 passed (3)';
    const parsed = JSON.parse(extractReporterJson(mixed)) as { numPassedTests: number };
    expect(parsed.numPassedTests).toBe(3);
  });
});
