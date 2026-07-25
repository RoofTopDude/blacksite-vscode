import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";
import type { EditBatchResult, EditProvider, EditResult } from "../../src/diff-edit-service.js";

/**
 * The behaviour driven through the real AgentSession loop: when the agent edits
 * a file and later comes back to it in the SAME execution, the result it gets
 * back tells it its earlier copy is out of date.
 *
 * Exercised end-to-end rather than against the ledger alone, because the value
 * is entirely in the wiring — the warning has to survive onto the tool_result
 * the model actually reads, and it has to be computed from the state as it was
 * *before* the current call was folded in.
 */

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

function createFakeEditProvider(): EditProvider {
  return {
    async applyEdit(input): Promise<EditResult> {
      return { ok: true, path: input.path, replacements: 1 };
    },
    async applyBatchEdits(input): Promise<EditBatchResult> {
      return {
        ok: true,
        files: input.edits.length,
        edits: input.edits.length,
        replacements: input.edits.length,
        results: input.edits.map((edit) => ({ path: edit.path, replacements: 1 })),
      };
    },
    async applyJsonEdit(): Promise<never> { throw new Error("not used"); },
  } as unknown as EditProvider;
}

/** Stands in for the local runtime's file ops: file_read succeeds, file_write
 *  succeeds and reports the absolute-plus-relative shape the real tool does. */
function createFakeRuntime() {
  return {
    handleMessage: vi.fn(async (message: { type: string; payload?: Record<string, unknown> }) => {
      const payload = message.payload ?? {};
      if (message.type === "file_read") {
        return { result: { ok: true, path: `C:/workspace/${String(payload.path)}`, relativePath: String(payload.path), content: "current contents", totalLines: 1 } };
      }
      if (message.type === "file_write") {
        return { result: { ok: true, path: `C:/workspace/${String(payload.path)}`, relativePath: String(payload.path), bytesWritten: 10, mode: "overwrite", created: false } };
      }
      return { result: { ok: true } };
    }),
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = overrides.runtime ?? createFakeRuntime();
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: createFakeContext() as unknown as ConstructorParameters<typeof AgentSession>[0]["context"],
    provider: "anthropic",
    maxIterations: 20,
    checkpointingEnabled: false,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    editProvider: createFakeEditProvider(),
    ...overrides,
  });
  return { session, runtime };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function resultFor(events: AgentEvent[], toolCallId: string): Record<string, unknown> | undefined {
  const event = events.find((e) => e.type === "tool_call_result" && e.toolCallId === toolCallId);
  if (!event || event.type !== "tool_call_result") return undefined;
  return event.result as Record<string, unknown>;
}

const editCall = (id: string, path: string): ToolUseBlock =>
  ({ type: "tool_use", id, name: "file_edit", input: { path, oldString: "a", newString: "b" } });
const writeCall = (id: string, path: string): ToolUseBlock =>
  ({ type: "tool_use", id, name: "file_write", input: { path, content: "whole new file" } });
const readCall = (id: string, path: string): ToolUseBlock =>
  ({ type: "tool_use", id, name: "file_read", input: { path } });

describe("AgentSession — awareness of its own earlier edits", () => {
  it("warns when a whole-file write would overwrite an edit it made and never re-read", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [editCall("call-edit", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [writeCall("call-write", "src/foo.ts")], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const { session } = createSession({ providerTurnSessionFactory: () => new ScriptedProviderSession(turnFactory) });
    const events = await collectEvents(session.send("edit then rewrite src/foo.ts"));

    // The edit itself says nothing — it is the normal way to change a file.
    expect(resultFor(events, "call-edit")?.staleFileWarning).toBeUndefined();

    const warning = resultFor(events, "call-write")?.staleFileWarning;
    expect(warning).toBeTypeOf("string");
    expect(String(warning)).toContain("src/foo.ts");
    expect(String(warning)).toContain("file_edit");
  });

  it("stays quiet when the agent re-reads the file before rewriting it", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [editCall("call-edit", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [readCall("call-read", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 2) return { toolCalls: [writeCall("call-write", "src/foo.ts")], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const { session } = createSession({ providerTurnSessionFactory: () => new ScriptedProviderSession(turnFactory) });
    const events = await collectEvents(session.send("edit, re-read, then rewrite src/foo.ts"));

    expect(resultFor(events, "call-write")?.staleFileWarning).toBeUndefined();
  });

  it("does not warn about a different file", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [editCall("call-edit", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [writeCall("call-write", "src/other.ts")], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const { session } = createSession({ providerTurnSessionFactory: () => new ScriptedProviderSession(turnFactory) });
    const events = await collectEvents(session.send("edit one file, write another"));

    expect(resultFor(events, "call-write")?.staleFileWarning).toBeUndefined();
  });

  it("explains an anchor miss on a file it already changed", async () => {
    /* The edit provider accepts the first edit and then rejects the second the
       way the real one does once its oldString no longer exists. */
    let applied = 0;
    const editProvider = {
      async applyEdit(input: { path: string }): Promise<EditResult> {
        applied += 1;
        if (applied === 1) return { ok: true, path: input.path, replacements: 1 };
        return { ok: false, error: `oldString was not found in ${input.path} (also tried EOL-converted, whitespace-tolerant, and line-number-stripped matches).` };
      },
      async applyBatchEdits(): Promise<never> { throw new Error("not used"); },
      async applyJsonEdit(): Promise<never> { throw new Error("not used"); },
    } as unknown as EditProvider;

    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [editCall("call-one", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [editCall("call-two", "src/foo.ts")], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const { session } = createSession({
      editProvider,
      providerTurnSessionFactory: () => new ScriptedProviderSession(turnFactory),
    });
    const events = await collectEvents(session.send("edit src/foo.ts twice"));

    const failed = resultFor(events, "call-two");
    expect(failed?.ok).toBe(false);
    expect(String(failed?.staleFileWarning)).toMatch(/already changed/);
    expect(String(failed?.staleFileWarning)).toMatch(/file_read/);
  });

  it("puts the warning in front of the model, not just on the UI event", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [editCall("call-edit", "src/foo.ts")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [writeCall("call-write", "src/foo.ts")], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });
    await collectEvents(session.send("edit then rewrite src/foo.ts"));

    /* The model-facing copy is the serialized tool_result, so the warning is
       only doing its job if it survives into that payload. */
    const serialized = JSON.stringify(scripted.toolResults ?? []);
    expect(serialized).toContain("staleFileWarning");
  });
});
