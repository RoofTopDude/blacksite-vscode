import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { loadCheckpoint } from "../../src/checkpoint.js";
import type { ApprovalDecision } from "../../src/approval-gate.js";
import type { ContentBlock, ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  let updateCount = 0;
  const context = {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return store.has(key) ? (store.get(key) as T) : defaultValue;
      },
      update: async (key: string, value: unknown): Promise<void> => {
        updateCount += 1;
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
  return {
    context: context as Parameters<typeof loadCheckpoint>[0],
    store,
    get updateCount(): number {
      return updateCount;
    },
  };
}

function createSession(overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const fakeContext = createFakeContext();
  const runtime = overrides.runtime ?? {
    handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })),
  };
  const session = new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    context: fakeContext.context as ConstructorParameters<typeof AgentSession>[0]["context"],
    provider: "anthropic",
    maxIterations: 40,
    checkpointingEnabled: true,
    memoryProvider: {
      append: () => undefined,
      readMemory: () => "",
      readContext: () => "",
    },
    ...overrides,
  });

  return { session, fakeContext, runtime };
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function lastTurnComplete(events: AgentEvent[]) {
  const matches = events.filter((event): event is Extract<AgentEvent, { type: "turn_complete" }> => event.type === "turn_complete");
  return matches.at(-1);
}

function lastAssistantText(session: AgentSession): string {
  const assistant = [...session.history].reverse().find((message) => message.role === "assistant");
  if (!assistant || typeof assistant.content === "string") return typeof assistant?.content === "string" ? assistant.content : "";
  return (assistant.content as ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function memoryReadTool(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "memory_read", input: {} };
}

function fileListTool(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "file_list", input: { path: "." } };
}

describe("AgentSession long-horizon hardening", () => {
  it("does not leak the max-iteration budget across separate user turns", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => ({
      text: turnIndex === 0 ? "first-finished" : "second-finished",
      stopReason: "end_turn",
      usage: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const { session } = createSession({
      maxIterations: 1,
      providerTurnSessionFactory: () => scripted,
    });

    const firstEvents = await collectEvents(session.send("first"));
    const secondEvents = await collectEvents(session.send("second"));

    expect(lastTurnComplete(firstEvents)?.stopReason).toBe("end_turn");
    expect(lastTurnComplete(secondEvents)?.stopReason).toBe("end_turn");
    expect(secondEvents.some((event) => event.type === "iteration_start")).toBe(true);
  });

  it("auto-continues an empty post-tool end_turn inside the session loop", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) {
        return {
          toolCalls: [memoryReadTool("tool-0")],
          stopReason: "tool_use",
          usage: { inputTokens: 75, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      if (turnIndex === 1) {
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 76, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        text: "completed after continuation",
        stopReason: "end_turn",
        usage: { inputTokens: 77, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      maxIterations: 6,
    });

    const events = await collectEvents(session.send("start"));

    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    expect(events.some((event) => event.type === "execution_diagnostic" && event.message.includes("internal continuation"))).toBe(true);
    expect(scripted.userTexts.at(-1)?.includes("[Internal continuation]")).toBe(true);
    expect(session.runtimeState.autoContinueCount).toBe(1);
  });

  it("persists pending approval state into checkpoints before waiting", async () => {
    let resolveApproval: ((decision: ApprovalDecision) => void) | undefined;
    const approvalPromise = new Promise<ApprovalDecision>((resolve) => {
      resolveApproval = resolve;
    });

    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) {
        return {
          toolCalls: [fileListTool("approve-0")],
          stopReason: "tool_use",
          usage: { inputTokens: 55, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        text: "approved",
        stopReason: "end_turn",
        usage: { inputTokens: 56, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const { session, fakeContext, runtime } = createSession({
      providerTurnSessionFactory: () => scripted,
      approvalProvider: () => approvalPromise,
      runtime: {
        handleMessage: vi.fn(async ({ payload }) => {
          if ((payload as { confirmed?: boolean }).confirmed) return { result: { ok: true } };
          return { result: { requiresConfirmation: true, tier: "network", description: "Needs approval" } };
        }),
      } as ConstructorParameters<typeof AgentSession>[0]["runtime"],
    });

    const iterator = session.send("start")[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "approval_pending") break;
    }

    expect(events.some((event) => event.type === "approval_pending")).toBe(true);
    expect(session.runtimeState.pendingGate?.kind).toBe("approval");
    expect(loadCheckpoint(fakeContext.context)?.state?.pendingGate?.kind).toBe("approval");

    resolveApproval?.("allow");
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    expect(session.runtimeState.pendingGate).toBeUndefined();
    expect(vi.mocked(runtime.handleMessage).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("survives a 400-iteration offline run with compression and checkpoint churn", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex >= 399) {
        return {
          text: "400-turn-complete",
          stopReason: "end_turn",
          usage: { inputTokens: 92, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        toolCalls: [memoryReadTool(`memory-${turnIndex}`)],
        stopReason: "tool_use",
        usage: { inputTokens: 92, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    let compressionCalls = 0;
    const { session, fakeContext } = createSession({
      providerTurnSessionFactory: () => scripted,
      maxIterations: 450,
      contextLength: 100,
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
      compressionProvider: {
        compress: async () => {
          compressionCalls += 1;
          return `summary-${compressionCalls}`;
        },
      },
    });

    const events = await collectEvents(session.send("start"));

    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    expect(session.iteration).toBe(400);
    expect(session.runtimeState.compressionCount).toBeGreaterThan(0);
    expect(session.fullHistory.length).toBeGreaterThan(session.history.length);
    expect(loadCheckpoint(fakeContext.context)).toBeUndefined();
    expect(fakeContext.updateCount).toBeGreaterThan(300);
    expect(compressionCalls).toBeGreaterThan(0);
  });

  it("restores provider progress from checkpoint state and finishes consistently", async () => {
    const makeSession = (maxIterations: number) => {
      const scripted = new ScriptedProviderSession(({ turnIndex }) => {
        if (turnIndex >= 5) {
          return {
            text: "resume-finished",
            stopReason: "end_turn",
            usage: { inputTokens: 61, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        }
        return {
          toolCalls: [memoryReadTool(`resume-${turnIndex}`)],
          stopReason: "tool_use",
          usage: { inputTokens: 61, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      });
      return createSession({
        providerTurnSessionFactory: () => scripted,
        maxIterations,
      });
    };

    const partial = makeSession(3);
    const control = makeSession(10);

    const partialEvents = await collectEvents(partial.session.send("start"));
    expect(lastTurnComplete(partialEvents)?.stopReason).toBe("max_iterations");

    const checkpoint = loadCheckpoint(partial.fakeContext.context);
    expect(checkpoint?.state?.providerState).toBeDefined();

    const resumed = makeSession(10);
    resumed.session.restoreState({
      sessionId: checkpoint?.sessionId,
      messages: checkpoint?.messages ?? [],
      ...(checkpoint?.state ?? {}),
    });
    const resumedEvents = await collectEvents(resumed.session.send("resume"));
    const controlEvents = await collectEvents(control.session.send("start"));

    expect(lastTurnComplete(resumedEvents)?.stopReason).toBe("end_turn");
    expect(lastTurnComplete(controlEvents)?.stopReason).toBe("end_turn");
    expect(lastAssistantText(resumed.session)).toBe(lastAssistantText(control.session));
    expect(resumed.session.exportState(true).providerState?.["turnIndex"]).toBe(control.session.exportState(true).providerState?.["turnIndex"]);
  });
});
