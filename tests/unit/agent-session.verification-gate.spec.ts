import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import type { EditProvider, EditResult } from "../../src/diff-edit-service.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function context() {
  const values = new Map<string, unknown>();
  return { workspaceState: { get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback, update: async (key: string, value: unknown) => { values.set(key, value); } } };
}

async function eventsFor(
  factory: ScriptedTurnFactory,
  testResult = { ok: true, passed: 3, failed: 0, skipped: 0 },
  lspResult?: Record<string, unknown>,
): Promise<{ events: AgentEvent[]; scripted: ScriptedProviderSession; session: AgentSession }> {
  const scripted = new ScriptedProviderSession(factory);
  const editProvider = { applyEdit: async (input: { path: string }): Promise<EditResult> => ({ ok: true, path: input.path, replacements: 1 }) } as EditProvider;
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string }) => ({ result: message.type === "test.run" ? testResult : { ok: true } })),
  };
  const session = new AgentSession({
    apiKey: "key", model: "claude-sonnet-4-6", systemPrompt: "test", workspaceRoot: "C:/workspace",
    runtime: runtime as any, context: context() as any, provider: "anthropic", maxIterations: 12,
    checkpointingEnabled: false, editProvider, graphProvider: undefined,
    lspProvider: lspResult ? { dispatch: vi.fn(async () => lspResult) } as any : undefined,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  const events: AgentEvent[] = [];
  for await (const event of session.send("make the edit")) events.push(event);
  return { events, scripted, session };
}

const edit: ToolUseBlock = { type: "tool_use", id: "edit", name: "file_edit", input: { path: "src/a.ts", oldString: "a", newString: "b" } };
const test: ToolUseBlock = { type: "tool_use", id: "test", name: "test_run", input: { filter: "a" } };
const diagnostics: ToolUseBlock = { type: "tool_use", id: "diagnostics", name: "code_diagnostics", input: { path: "src/a.ts" } };
const rename: ToolUseBlock = { type: "tool_use", id: "rename", name: "code_rename", input: { target: { path: "src/renamed.ts", line: 1 }, newName: "renamed" } };

describe("post-edit verification gate", () => {
  it("forces a continuation after the final edit and clears on a passing targeted test", async () => {
    const { events, scripted, session } = await eventsFor(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [edit], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { text: "done", stopReason: "end_turn", usage };
      if (turnIndex === 2) return { toolCalls: [test], stopReason: "tool_use", usage };
      return { text: "verified", stopReason: "end_turn", usage };
    });

    expect(scripted.userTexts.some((text) => text.includes("not verified yet") && text.includes("src/a.ts"))).toBe(true);
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    expect(session.runtimeState.verification).toMatchObject({ status: "passed", method: "tests", files: ["src/a.ts"] });
  });

  it("persists a failed check and fails open after the bounded reminder cap", async () => {
    const { events, session } = await eventsFor(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [edit], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [test], stopReason: "tool_use", usage };
      return { text: "cannot fix", stopReason: "end_turn", usage };
    }, { ok: false, passed: 0, failed: 1, skipped: 0 });

    expect(events.some((event) => event.type === "execution_diagnostic" && event.message.includes("unverified edits"))).toBe(true);
    expect(session.runtimeState.verification.status).toBe("skipped");
    expect(session.exportState().verification?.files).toEqual(["src/a.ts"]);
  });

  it("does not accept partial diagnostics as a clean verification result", async () => {
    const { scripted, session } = await eventsFor(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [edit], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [diagnostics], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    }, undefined, { ok: true, status: "partial", counts: { error: 0 } });

    expect(scripted.userTexts.some((text) => text.includes("Diagnostics returned 'partial'"))).toBe(true);
    expect(session.runtimeState.verification.status).toBe("skipped");
  });

  it("tracks the target path of an LSP rename even when its result only reports a file count", async () => {
    const { session } = await eventsFor(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [rename], stopReason: "tool_use", usage };
      return { text: "done", stopReason: "end_turn", usage };
    }, undefined, { ok: true, files: 2 });

    expect(session.runtimeState.verification).toMatchObject({ status: "skipped", files: ["src/renamed.ts"] });
  });
});
