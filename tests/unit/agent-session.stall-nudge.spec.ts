import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";
import type { EditBatchResult, EditProvider, EditResult, JsonEditResult } from "../../src/diff-edit-service.js";
import type { GraphAnnotationProvider } from "../../src/graph-annotation-store.js";

/**
 * Coverage for the stall nudge: a long run of read/search/probe tool calls with no edit
 * attempt is a distinct failure mode from the empty-response/missing-note cases (the model
 * is still producing real tool calls, just not converging — see the execution logs that
 * motivated this). Exercised through the real AgentSession loop, mirroring
 * agent-session.note-enforcement.spec.ts's approach for the adjacent mechanism.
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
    async applyJsonEdit(input): Promise<JsonEditResult> {
      return { ok: true, path: input.path, operations: input.operations.length };
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
      if (op === "list") return { ok: true, notes: [] };
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
const readCall = (turnIndex: number): ToolUseBlock => ({ type: "tool_use", id: `read-${turnIndex}`, name: "file_read", input: { path: "index.html" } });

describe("AgentSession — stall nudge", () => {
  it("nudges only after three identical rounds return no new evidence", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex < 3) return { toolCalls: [readCall(turnIndex)], stopReason: "tool_use", usage };
      if (turnIndex === 6) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-edit", name: "file_edit", input: { path: "index.html", oldString: "a", newString: "b" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      if (turnIndex === 7) {
        const call: ToolUseBlock = { type: "tool_use", id: "call-note", name: "map_note_add", input: { from: "index.html", note: "adjusted the a/b setting" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("read index.html and figure out what to change"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);

    // The nudge fired exactly once, naming the same "no edit yet" pattern the logs showed.
    expect(scripted.userTexts.some((t) => t.includes("last 3 tool rounds repeated the same work (file_read)"))).toBe(true);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.level === "info" && e.message.includes("identical tool rounds (file_read) returned no new evidence"))).toBe(true);
  });

  it("does not nudge six distinct read-only investigation steps", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex < 6) return { toolCalls: [{ ...readCall(turnIndex), input: { path: `src/${turnIndex}.ts` } }], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted });

    const events = await collectEvents(session.send("analyze the source tree"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(scripted.userTexts.some((t) => t.includes("Internal progress check"))).toBe(false);
  });

  it("resets the detector when the tool call changes", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => {
      if (turnIndex < 2) return { toolCalls: [readCall(turnIndex)], stopReason: "tool_use", usage };
      if (turnIndex === 2) {
        // A different tool call breaks the duplicate-work sequence.
        const call: ToolUseBlock = { type: "tool_use", id: "call-bad-edit", name: "file_edit", input: { path: "index.html", oldString: "nomatch", newString: "b" } };
        return { toolCalls: [call], stopReason: "tool_use", usage };
      }
      if (turnIndex < 5) return { toolCalls: [readCall(turnIndex)], stopReason: "tool_use", usage };
      return { text: "Done.", stopReason: "end_turn", usage };
    };

    // file_edit fails for this path so the attempt at turnIndex 5 is a genuine failure.
    const failingEditProvider: EditProvider = {
      async applyEdit(): Promise<EditResult> { return { ok: false, error: "oldString not found." }; },
      async applyBatchEdits(input): Promise<EditBatchResult> { return { ok: true, files: 0, edits: 0, replacements: 0, results: [] }; },
      async applyJsonEdit(input): Promise<JsonEditResult> { return { ok: true, path: input.path, operations: input.operations.length }; },
    };

    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, editProvider: failingEditProvider });

    // Two duplicate reads, a different edit call, then two more reads: never three identical
    // completed rounds in a row, so a legitimate change of tactic is not interrupted.
    await collectEvents(session.send("try to edit index.html"));

    expect(scripted.userTexts.some((t) => t.includes("Internal progress check"))).toBe(false);
  });

  it("caps nudges at 3 per turn and still terminates instead of stalling forever", async () => {
    const turnFactory: ScriptedTurnFactory = ({ turnIndex }) => ({ toolCalls: [readCall(turnIndex)], stopReason: "tool_use", usage });
    const scripted = new ScriptedProviderSession(turnFactory);
    const { session } = createSession({ providerTurnSessionFactory: () => scripted, maxIterations: 19 });

    const events = await collectEvents(session.send("keep reading index.html forever"));

    expect(events.filter((e) => e.type === "turn_complete")).toHaveLength(1);
    expect(events.find((e) => e.type === "turn_complete" && e.stopReason === "max_iterations")).toBeTruthy();

    const nudges = events.filter((e) => e.type === "execution_diagnostic" && e.level === "info" && e.message.includes("identical tool rounds"));
    expect(nudges).toHaveLength(3); // capped after rounds 3, 6, and 9
  });
});
