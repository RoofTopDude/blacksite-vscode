import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type SubagentProviderMessage } from "../../src/agent-session.js";
import { loadCheckpoint } from "../../src/checkpoint.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => { if (value === undefined) store.delete(key); else store.set(key, value); },
    },
  } as Parameters<typeof loadCheckpoint>[0];
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = overrides.runtime ?? { handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })) };
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: createFakeContext(),
    provider: "anthropic",
    maxIterations: 10,
    checkpointingEnabled: false,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    ...overrides,
  });
  return { session, runtime };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function toolResult(events: AgentEvent[], toolCallId: string) {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "tool_call_result" }> =>
      event.type === "tool_call_result" && event.toolCallId === toolCallId,
  );
}

function subagentSpawnTool(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "subagent_spawn", input: { task: "investigate something" } };
}

function questionCardTool(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "question_card", input: { question: "Pick one", options: [{ key: "a", label: "A" }] } };
}

async function* stubSubagentSpawn(): AsyncGenerator<SubagentProviderMessage> {
  yield {
    type: "subagent_tool_result",
    result: {
      ok: true, subRequestId: "sub-1", answer: "done", toolRounds: 1, usage: null, scratchFiles: [],
      budget: { complexity: "standard", timeoutSeconds: 60, maxToolRounds: 5 },
    },
  };
}

describe("AgentSession — disabled-tool dispatch gate and live updates", () => {
  it("rejects a disabled tool at dispatch even when the model still emits it (hallucination / stale advertisement)", async () => {
    const subagentProvider = { spawn: vi.fn(stubSubagentSpawn) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [subagentSpawnTool("spawn-0")], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      subagentProvider,
      disabledTools: ["subagent_spawn"],
    });

    const events = await collectEvents(session.send("do it"));

    const spawn = toolResult(events, "spawn-0");
    expect(spawn?.ok).toBe(false);
    expect(String(spawn?.summary)).toMatch(/disabled/i);
    // The subagent provider must never actually run — disabling means no execution, not just no advertisement.
    expect(subagentProvider.spawn).not.toHaveBeenCalled();
  });

  it("rejects a disabled subagent_spawn issued in a parallel batch (the other dispatch path)", async () => {
    const subagentProvider = { spawn: vi.fn(stubSubagentSpawn) };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
        toolCalls: [
          { ...subagentSpawnTool("spawn-a"), input: { task: "a", parallel: true } },
          { ...subagentSpawnTool("spawn-b"), input: { task: "b", parallel: true } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      subagentProvider,
      disabledTools: ["subagent_spawn"],
    });

    const events = await collectEvents(session.send("do it"));

    expect(toolResult(events, "spawn-a")?.ok).toBe(false);
    expect(toolResult(events, "spawn-b")?.ok).toBe(false);
    expect(subagentProvider.spawn).not.toHaveBeenCalled();
  });

  it("takes effect on the live session immediately via updateDisabledTools, without a new session", async () => {
    const subagentProvider = { spawn: vi.fn(stubSubagentSpawn) };
    let turn = 0;
    const scripted = new ScriptedProviderSession(() => {
      const tc = subagentSpawnTool(`spawn-${turn}`);
      turn += 1;
      return { toolCalls: [tc], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      subagentProvider,
      disabledTools: [], // enabled at construction
      maxIterations: 1,
    });

    // First turn: subagent_spawn is enabled and runs normally.
    const firstEvents = await collectEvents(session.send("first"));
    expect(toolResult(firstEvents, "spawn-0")?.ok).toBe(true);
    expect(subagentProvider.spawn).toHaveBeenCalledTimes(1);

    // Flip it off on the *same, already-running* session — this is what the webview's
    // toggle_tool handler now does via chat-provider.ts.
    session.updateDisabledTools(["subagent_spawn"]);

    // Second turn, same session instance: the call is now rejected without a new session.
    const secondEvents = await collectEvents(session.send("second"));
    expect(toolResult(secondEvents, "spawn-1")?.ok).toBe(false);
    expect(subagentProvider.spawn).toHaveBeenCalledTimes(1); // still just the one from before
  });

  it("never blocks the always-on UI tools even if disabledTools erroneously names one", async () => {
    const questionCardProvider = vi.fn(async () => "a");
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [questionCardTool("q-0")], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : { text: "ok", stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      questionCardProvider,
      disabledTools: ["question_card"], // should never be reachable via the UI, but must not brick dispatch if it is
    });

    const events = await collectEvents(session.send("ask"));

    expect(questionCardProvider).toHaveBeenCalledTimes(1);
    const q = toolResult(events, "q-0");
    expect(q?.ok).toBe(true);
  });
});
