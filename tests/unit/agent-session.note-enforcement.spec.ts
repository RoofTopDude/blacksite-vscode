import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";
import type { EditBatchResult, EditProvider, EditResult } from "../../src/diff-edit-service.js";
import type { GraphAnnotationProvider } from "../../src/graph-annotation-store.js";
import type { LspProvider } from "../../src/lsp-service.js";

/**
 * End-to-end coverage for the Codebase Map "working memory" enforcement: an
 * end_turn right after an unnoted edit gets forced to continue (mirroring the
 * existing empty-response recovery), up to a small cap, then fails open —
 * exercised through the real AgentSession loop so the interaction with the
 * adjacent auto-continue/retry branches is actually verified, not assumed.
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
  };
}

function createFakeLspProvider(): LspProvider {
  return {
    async dispatch(op, payload) {
      if (op === "insert") {
        const target = payload.target as { path?: unknown } | undefined;
        return { ok: true, path: String(target?.path ?? ""), line: 1, column: 1 };
      }
      return { ok: false, error: `Unknown op: ${op}` };
    },
  };
}

function createFakeGraphProvider(): GraphAnnotationProvider {
  let counter = 0;
  return {
    async dispatch(op, payload) {
      if (op === "add" || op === "link") {
        counter += 1;
        return {
          ok: true,
          note: { id: `note-${counter}`, from: String(payload.from ?? ""), to: payload.to ? String(payload.to) : undefined, note: String(payload.note ?? "") },
        };
      }
      if (op === "update") {
        return { ok: true, note: { id: String(payload.id ?? ""), from: String(payload.from ?? "src/foo.ts"), note: String(payload.note ?? "") } };
      }
      if (op === "list") return { ok: true, notes: [] };
      if (op === "remove") return { ok: true, removed: String(payload.id ?? "") };
      return { ok: false, error: `Unknown map operation: ${op}` };
    },
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = overrides.runtime ?? { handleMessage: vi.fn(async () => ({ result: { ok: true } })) };
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
    graphProvider: createFakeGraphProvider(),
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

describe("AgentSession — Codebase Map note enforcement", () => {
  it("does not complete on the first end_turn after an unnoted edit, and completes once a note is added", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-edit", name: "file_edit", input: { path: "src/foo.ts", oldString: "a", newString: "b" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      if (turnIndex === 1) {
        // Tries to finish right after the edit, without a note.
        return { text: "Done editing.", stopReason: "end_turn", usage };
      }
      if (turnIndex === 2) {
        // Forced to continue — now it complies.
        const call: ToolUseBlock = { type: "tool_use", id: "call-note", name: "map_note_add", input: { from: "src/foo.ts", note: "adjusted the foo helper" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("edit src/foo.ts"));

    // Exactly one turn_complete — the first end_turn (turn 1) did not end the session.
    const completions = events.filter((e) => e.type === "turn_complete");
    expect(completions).toHaveLength(1);

    // A reminder naming the file and the tool to use was injected as a synthetic user turn.
    expect(scripted.userTexts.some((t) => t.includes("src/foo.ts") && t.includes("map_note_add"))).toBe(true);

    // The forced continuation was surfaced as a diagnostic, not silently swallowed.
    expect(events.some((e) => e.type === "execution_diagnostic" && e.level === "info" && e.message.includes("src/foo.ts"))).toBe(true);
    // No fail-open warning fired — the requirement was actually satisfied.
    expect(events.some((e) => e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("src/foo.ts"))).toBe(false);
  });

  it("fails open after the reminder cap instead of stalling the session", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-edit", name: "file_edit", input: { path: "src/bar.ts", oldString: "a", newString: "b" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      // Every subsequent turn tries to end without ever adding a note.
      return { text: "Done editing.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("edit src/bar.ts and never add a note"));

    // The session still terminates — the cap prevents an infinite reminder loop.
    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);

    const infoReminders = events.filter((e) => e.type === "execution_diagnostic" && e.level === "info" && e.message.includes("src/bar.ts"));
    expect(infoReminders).toHaveLength(2); // capped at MAX_NOTE_ENFORCEMENT_CONTINUATIONS

    const failOpenWarning = events.find((e) => e.type === "execution_diagnostic" && e.level === "warn" && e.message.includes("src/bar.ts"));
    expect(failOpenWarning).toBeTruthy();
  });

  it("does not clear dirty files or claim spent reminders when the turn errors before any note is added", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-edit", name: "file_edit", input: { path: "src/baz.ts", oldString: "a", newString: "b" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      return { stopReason: "error", usage };
    };
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("edit src/baz.ts then error out"));

    // Note-enforcement is gated on stopReason === "end_turn" — an abnormal
    // termination must neither claim reminders it never issued nor emit the
    // fail-open warning.
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("src/baz.ts"))).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);

    // The dirty-file record must survive the error so a resumed session
    // still owes a note for this edit — it must not be silently forgotten.
    const exported = session.exportState();
    expect(exported.dirtyMapFiles).toEqual(["src/baz.ts"]);
  });

  it("also enforces the note requirement for code_insert, not just file_edit/file_edit_batch", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-insert", name: "code_insert", input: { target: { path: "src/qux.ts", line: 1 }, position: "after", text: "// hi" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      if (turnIndex === 1) {
        // Tries to finish right after the edit, without a note.
        return { text: "Done editing.", stopReason: "end_turn", usage };
      }
      if (turnIndex === 2) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-note", name: "map_note_add", input: { from: "src/qux.ts", note: "added a header comment" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, lspProvider: createFakeLspProvider() });

    const events = await collectEvents(session.send("insert a header comment into src/qux.ts"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(scripted.userTexts.some((t) => t.includes("src/qux.ts") && t.includes("map_note_add"))).toBe(true);
  });

  it("never prompts for a note during a pure exploration session with no edits", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex === 0) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-read", name: "file_read", input: { path: "src/foo.ts" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      return { text: "Here's what I found.", stopReason: "end_turn", usage };
    };
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("just look at src/foo.ts"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.toLowerCase().includes("map note"))).toBe(false);
  });

  /* The reminder is only worth issuing when the agent can actually comply. In both
     cases below the note tools are absent from the advertised catalog, so nagging
     would spend the whole continuation budget demanding an impossible call and then
     emit a fail-open warning about it. */
  const editThenEndTurn = (path: string): ScriptedTurnFactory => ({ turnIndex }) => {
    if (turnIndex === 0) {
      const call: ToolUseBlock = { type: "tool_use", id: "call-edit", name: "file_edit", input: { path, oldString: "a", newString: "b" } };
      return { toolCalls: [call], stopReason: "tool_use", usage };
    }
    return { text: "Done editing.", stopReason: "end_turn", usage };
  };

  it("skips the reminder entirely when no graph provider is wired", async () => {
    const scripted = new ScriptedProviderSession(editThenEndTurn("src/nomap.ts"));
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, graphProvider: undefined });

    const events = await collectEvents(session.send("edit src/nomap.ts"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(scripted.userTexts.some((t) => t.includes("map_note_add"))).toBe(false);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("src/nomap.ts"))).toBe(false);
  });

  it("skips the reminder when the user has disabled the note tool", async () => {
    const scripted = new ScriptedProviderSession(editThenEndTurn("src/off.ts"));
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, disabledTools: ["map_note_add"] });

    const events = await collectEvents(session.send("edit src/off.ts"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(scripted.userTexts.some((t) => t.includes("map_note_add"))).toBe(false);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("src/off.ts"))).toBe(false);
  });
});
