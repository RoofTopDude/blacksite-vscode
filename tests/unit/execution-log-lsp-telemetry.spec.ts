import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent-session.js";
import { createStructuredEventEntry } from "../../src/execution-log-format.js";

describe("LSP structured execution telemetry", () => {
  it("keeps reliability metrics while excluding paths, source, messages, and command arguments", () => {
    const event = {
      type: "tool_call_result",
      toolCallId: "call-1",
      toolName: "code_rename",
      ok: true,
      summary: "Renamed C:/secret/project/source.ts",
      elapsedMs: 42,
      result: {
        ok: true,
        providerStatus: "ok",
        durationMs: 35,
        attempts: 2,
        warmedUp: true,
        locations: [{ path: "C:/secret/project/source.ts", snippet: "private source" }],
        diagnostics: {
          status: "timed_out",
          scope: "file",
          problems: [{ message: "secret diagnostic", path: "source.ts" }],
          coverage: { requestedFiles: 2, activatedFiles: 2, diagnosticUris: 1 },
        },
        mutation: {
          status: "applied",
          textEdits: 3,
          resourceOperations: [{ kind: "rename", from: "secret" }],
          commands: [{ id: "private.command", arguments: ["secret"] }],
          saved: true,
        },
      },
    } as AgentEvent;

    const entry = createStructuredEventEntry({ ts: "now", workspaceRoot: "C:/secret/project" }, event);
    expect(entry.data).toMatchObject({
      toolName: "code_rename",
      summary: "Code-intelligence operation completed.",
      lsp: {
        providerStatus: "ok",
        durationMs: 35,
        attempts: 2,
        warmedUp: true,
        resultCount: 1,
        diagnosticStatus: "timed_out",
        requestedFiles: 2,
        mutationStatus: "applied",
        textEdits: 3,
        resourceOperations: 1,
        saved: true,
      },
    });
    const serialized = JSON.stringify(entry.data);
    expect(entry.workspaceRoot).toBeUndefined();
    expect(serialized).not.toContain("C:/secret");
    expect(serialized).not.toContain("private source");
    expect(serialized).not.toContain("secret diagnostic");
    expect(serialized).not.toContain("private.command");
  });
});
