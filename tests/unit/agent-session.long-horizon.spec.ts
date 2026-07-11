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

function fileWriteTool(id: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name: "file_write", input };
}

function shellRunTool(id: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name: "shell_run", input };
}

function toolResult(events: AgentEvent[], toolCallId: string) {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "tool_call_result" }> =>
      event.type === "tool_call_result" && event.toolCallId === toolCallId,
  );
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

  it("answers a malformed tool call with a per-tool error without discarding valid sibling work", async () => {
    const runtime = {
      handleMessage: vi.fn(async () => ({ result: { ok: true, path: "notes.txt", bytesWritten: 2 } })),
    };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) {
        // A malformed call (missing required path/content) alongside a valid file read:
        // the bad one must not sink the good one, and neither should the whole turn be
        // thrown away and re-prompted.
        return {
          toolCalls: [fileWriteTool("write-0", {}), fileListTool("list-0")],
          stopReason: "tool_use",
          usage: { inputTokens: 80, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      if (turnIndex === 1) {
        return {
          toolCalls: [fileWriteTool("write-1", { path: "notes.txt", content: "ok", confirmed: true })],
          stopReason: "tool_use",
          usage: { inputTokens: 81, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        text: "write complete",
        stopReason: "end_turn",
        usage: { inputTokens: 82, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      maxIterations: 6,
    });

    const events = await collectEvents(session.send("write a file"));

    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");

    // The malformed call is answered with a precise, self-correcting error result…
    const write0 = events.find(
      (event): event is Extract<typeof event, { type: "tool_call_result" }> =>
        event.type === "tool_call_result" && event.toolCallId === "write-0",
    );
    expect(write0?.ok).toBe(false);
    expect(String(write0?.summary)).toContain("Invalid arguments for file_write");

    // …the valid sibling call in the same turn still runs (not discarded)…
    const list0 = events.find(
      (event): event is Extract<typeof event, { type: "tool_call_result" }> =>
        event.type === "tool_call_result" && event.toolCallId === "list-0",
    );
    expect(list0?.ok).toBe(true);

    // …and the run is never killed / re-prompted the way the old turn-discard path did.
    expect(events.some((event) =>
      event.type === "execution_diagnostic" && event.message.includes("Malformed tool call"),
    )).toBe(false);
    expect(scripted.userTexts.some((t) => t.includes("malformed tool call arguments"))).toBe(false);

    // The malformed write never dispatched; only the valid list + the later valid write did.
    const writeCalls = vi.mocked(runtime.handleMessage).mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === "system.write_file",
    );
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.[0]).toMatchObject({
      type: "system.write_file",
      payload: { path: "notes.txt", content: "ok", confirmed: true },
    });
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

  it("returns a clean error for an unknown tool name instead of crashing the turn", async () => {
    // The runtime answers an unrecognized message type with a JSON-RPC error (no `result`) —
    // the shape that used to become `undefined` and crash _capToolResult, ending the run.
    const runtime = {
      handleMessage: vi.fn(async (msg: { type: string }) => {
        if (msg.type === "totally.made.up.tool") {
          return { error: { code: -32601, message: "Unsupported message type: totally.made.up.tool" } };
        }
        return { result: { ok: true, entries: [] } };
      }),
    };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) {
        return {
          toolCalls: [{ type: "tool_use", id: "ghost-0", name: "totally_made_up_tool", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "recovered", stopReason: "end_turn", usage: { inputTokens: 41, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      maxIterations: 4,
    });

    const events = await collectEvents(session.send("call a ghost tool"));

    // The run survives: it completes normally rather than terminating with an error.
    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    expect(events.some((event) => event.type === "error")).toBe(false);

    const ghost = toolResult(events, "ghost-0");
    expect(ghost?.ok).toBe(false);
    expect(String(ghost?.summary)).toContain("Unknown tool");
  });

  it("auto-denies a confirm-tier tool under the 'deny' autonomous policy without blocking", async () => {
    const runtime = {
      handleMessage: vi.fn(async (msg: { type: string; payload?: Record<string, unknown> }) => {
        if (msg.type === "system.shell") {
          return msg.payload?.["confirmed"]
            ? { result: { ok: true, exitCode: 0, stdout: "", stderr: "" } }
            : { result: { requiresConfirmation: true, tier: "network", description: "curl example.com" } };
        }
        return { result: { ok: true } };
      }),
    };
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) {
        return {
          toolCalls: [shellRunTool("shell-0", { command: "curl", args: ["example.com"] })],
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "handled", stopReason: "end_turn", usage: { inputTokens: 51, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      autonomousApprovalPolicy: "deny",
      maxIterations: 4,
    });

    const events = await collectEvents(session.send("run curl"));

    // No interactive gate is opened, and the run does not hang waiting on a human.
    expect(events.some((event) => event.type === "approval_pending")).toBe(false);
    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");

    const shell = toolResult(events, "shell-0");
    expect(shell?.ok).toBe(false);
    expect(String(shell?.summary)).toContain("automatically denied");

    // The confirmed re-dispatch never happened.
    const confirmed = vi.mocked(runtime.handleMessage).mock.calls.filter(
      (call) => (call[0] as { payload?: Record<string, unknown> })?.payload?.["confirmed"] === true,
    );
    expect(confirmed).toHaveLength(0);
  });

  it("keeps compaction engaged when the model's context window is unknown", async () => {
    // No contextLength is supplied (the "bring any model" case). With a compression provider
    // and reported usage above the trigger, compaction must still fire against the assumed
    // window — previously it was gated off entirely and the session grew unbounded.
    const compress = vi.fn(async () => JSON.stringify({ objective: "summarized", status: "in_progress" }));
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex < 30) {
        return {
          toolCalls: [memoryReadTool(`mem-${turnIndex}`)],
          stopReason: "tool_use",
          // ~120k reported input tokens ⇒ ~94% of the 128k assumed window ⇒ over threshold.
          usage: { inputTokens: 120_000, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 120_000, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
      maxIterations: 40,
      // contextLength deliberately omitted.
    });

    const events = await collectEvents(session.send("work"));

    expect(compress).toHaveBeenCalled();
    expect(events.some((event) =>
      event.type === "execution_diagnostic" && /compress/i.test(event.message),
    )).toBe(true);
  });

  it("compacts in the background below the critical threshold instead of blocking the turn", async () => {
    const compress = vi.fn(async () => JSON.stringify({ objective: "sum", status: "in_progress" }));
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex < 12) {
        return {
          toolCalls: [memoryReadTool(`m-${turnIndex}`)],
          stopReason: "tool_use",
          // ~70% of the assumed 128k window: over the 60% trigger, under the 82% critical line.
          usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
      maxIterations: 40,
    });

    const events = await collectEvents(session.send("work"));

    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    expect(compress).toHaveBeenCalled();
    expect(events.some((event) =>
      event.type === "execution_diagnostic" && /in the background/i.test(event.message),
    )).toBe(true);
  });

  it("preserves messages appended while a background compaction is still running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compress = vi.fn(async () => { await gate; return JSON.stringify({ objective: "sum" }); });

    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex < 10) {
        return {
          toolCalls: [memoryReadTool(`m-${turnIndex}`)],
          stopReason: "tool_use",
          usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return { text: "done", stopReason: "end_turn", usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
      maxIterations: 40,
    });

    // The run finishes with the compaction still gated (background, never awaited on the
    // soft path), so at this point history is untrimmed and equals the full transcript.
    await collectEvents(session.send("work"));
    expect(compress).toHaveBeenCalledTimes(1);
    const activeBefore = session.history.length;
    const fullBefore = session.fullHistory.length;
    expect(activeBefore).toBe(fullBefore);

    release!();
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the gated compaction land

    // It removed only the summarized prefix: the immutable transcript is intact and the
    // active window shrank without dropping anything appended after the pass started.
    expect(session.fullHistory.length).toBe(fullBefore);
    expect(session.history.length).toBeLessThan(activeBefore);
    expect(session.history.length).toBeGreaterThan(0);
  });
});
