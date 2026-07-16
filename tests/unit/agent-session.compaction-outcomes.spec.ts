import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { loadCheckpoint } from "../../src/checkpoint.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

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
    maxIterations: 40,
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

function lastTurnComplete(events: AgentEvent[]) {
  return events.filter((e): e is Extract<AgentEvent, { type: "turn_complete" }> => e.type === "turn_complete").at(-1);
}

function memoryReadTool(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "memory_read", input: {} };
}

/** An artificial, unsafe-to-cut message array: every entry (after the leading user prompt)
 *  is a user message carrying a tool_result, with no assistant messages between them at all.
 *  Real conversation flow can never produce this shape (assistant tool_use and its user
 *  tool_result always alternate 1:1), but a resumed/restored session's history is not
 *  re-validated for alternation — this simulates that edge case deterministically via
 *  restoreState, so safeRecentStart is forced to walk all the way back to index 0 and
 *  _compressHistory takes its "unsafe boundary" skip path on demand. */
function buildUnsafeToolResultChain(count: number) {
  const messages = [{ role: "user" as const, content: "start" }];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "user" as const,
      // Not a real tool_result-carrying shape from the assistant side, but `restoreState`
      // doesn't validate assistant/user alternation — only messageCarriesToolResult's
      // `role === "user"` + a tool_result block matters for the boundary walk.
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] as unknown as string,
    });
  }
  return messages;
}

describe("AgentSession — compaction outcome semantics (compressed vs skipped vs failed)", () => {
  it("manualCompact reports a distinct 'skipped' message, and does not resurface a stale failure, when the boundary is unsafe to cut", async () => {
    const compress = vi.fn(async () => JSON.stringify({ objective: "should never be called" }));
    const { session } = createSession({ compressionKeepRecent: 4 });

    // Seed a stale failure from an earlier (unrelated) compression attempt, alongside a
    // history shape that forces the current attempt to skip rather than compress.
    session.restoreState({
      sessionId: "s1",
      messages: buildUnsafeToolResultChain(20),
      lastCompressionError: "stale failure from three turns ago",
    });

    const result = await session.manualCompact({ compress });

    expect(compress).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/stale failure from three turns ago/);
    expect(result.message).toMatch(/nothing safe to compact/i);

    // The prior error is a persisted UI indicator ("last compaction attempt failed") — a
    // no-op skip must not silently erase real history of a genuine earlier failure either.
    expect(session.runtimeState.lastCompressionError).toBe("stale failure from three turns ago");
  });

  it("a background pass that skips (unsafe boundary) never emits a 'Background compression failed' diagnostic, even with a stale error present", async () => {
    const compress = vi.fn(async () => JSON.stringify({ objective: "should never be called" }));
    // The skip path (recentStart <= 0) resolves synchronously inside _compressHistory, before
    // any await — no real async gap for the background pass to still be settling, so a single
    // send() is enough to observe its notice (or, here, confirm the absence of one).
    const scripted = new ScriptedProviderSession(() => ({
      text: "done", stopReason: "end_turn", usage: { inputTokens: 90_000, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
    });

    session.restoreState({
      sessionId: "s1",
      messages: buildUnsafeToolResultChain(20),
      lastCompressionError: "stale failure from three turns ago",
      lastInputTokens: 90_000, // ~70% of the assumed 128k window — above the 60% trigger
    });

    const events = await collectEvents(session.send("continue"));

    expect(compress).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "execution_diagnostic" && /background compression failed/i.test(e.message))).toBe(false);
    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
  });

  it("a background pass that genuinely fails still reports the failure (skip-handling didn't also suppress real failures)", async () => {
    const compress = vi.fn(async () => { throw new Error("summariser 500"); });
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex < 12
      ? { toolCalls: [memoryReadTool(`m-${turnIndex}`)], stopReason: "tool_use", usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : { text: "done", stopReason: "end_turn", usage: { inputTokens: 90_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
    });

    // The background pass's failure (after its internal retry backoff) doesn't necessarily
    // settle before this first turn's natural end — that's the whole point of running it in
    // the background. Wait past the retry backoff, then send a follow-up turn so the
    // iteration-top notice drain picks up what the first turn's background pass produced.
    await collectEvents(session.send("work"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const followUp = await collectEvents(session.send("continue"));

    expect(compress).toHaveBeenCalled();
    expect(followUp.some((e) => e.type === "execution_diagnostic" && /background compression failed/i.test(e.message))).toBe(true);
    expect(session.runtimeState.lastCompressionError).toMatch(/summariser 500/);
  });
});

describe("AgentSession — cancellation during a bounded critical-path compaction wait", () => {
  it("honors Stop promptly instead of waiting out the full blocking-compaction deadline", async () => {
    const controller = new AbortController();
    const hang = new Promise<never>(() => { /* never resolves for the duration of this test */ });
    const compress = vi.fn(async () => { await hang; return "unreachable"; });

    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex < 30
      ? {
        toolCalls: [memoryReadTool(`m-${turnIndex}`)],
        stopReason: "tool_use",
        // ~86% of the assumed 128k window — over COMPACTION_CRITICAL_PCT (82%), so once
        // enough compressible history has accumulated, the post-tool trigger blocks on
        // _awaitCompactionBounded (the same method the pre-turn trigger uses).
        usage: { inputTokens: 110_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      : { text: "done", stopReason: "end_turn", usage: { inputTokens: 110_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
      maxIterations: 40,
      signal: controller.signal,
    });

    const events: AgentEvent[] = [];
    const startedAt = Date.now();
    for await (const event of session.send("work")) {
      events.push(event);
      // Matches either the pre-turn or post-tool phrasing of the *blocking* critical-path
      // trigger (as opposed to the background-path "…in the background…" phrasing) — both
      // route through the same _awaitCompactionBounded this test is exercising.
      if (event.type === "execution_diagnostic" && /before (continuing|sending)/i.test(event.message)) {
        controller.abort();
      }
    }
    const elapsedMs = Date.now() - startedAt;

    // BLOCKING_COMPACTION_DEADLINE_MS is 75s — this proves cancellation short-circuited the
    // wait rather than the loop just happening to hit the deadline naturally.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(lastTurnComplete(events)?.stopReason).toBe("cancelled");
  }, 10_000);
});

/** A safely-cuttable message history (plain alternating user/assistant text, no interleaved
 *  tool_use/tool_result blocks) — unlike buildUnsafeToolResultChain above, this always finds a
 *  safe compaction boundary, so a rejecting compress() genuinely reaches "failed" rather than
 *  short-circuiting to "skipped" before ever calling it. */
function buildPlainMessages(pairs: number) {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "user", content: `message ${i}` });
    messages.push({ role: "assistant", content: `reply ${i}` });
  }
  return messages;
}

describe("AgentSession — compaction circuit breaker", () => {
  it("opens after 3 consecutive failures and stops attempting automatic compaction", async () => {
    const compress = vi.fn(async () => { throw new Error("summariser 500"); });
    const scripted = new ScriptedProviderSession(() => ({
      text: "done", stopReason: "end_turn",
      usage: { inputTokens: 110_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
    });
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20) });

    // Three consecutive, deterministically-awaited failures — manualCompact is never gated by
    // the breaker (an explicit user retry should always attempt for real), so this reliably
    // trips it without depending on background-pass timing.
    for (let i = 0; i < 3; i++) {
      const result = await session.manualCompact({ compress });
      expect(result.ok).toBe(false);
    }
    const callsAfterTripping = compress.mock.calls.length;

    // Restore high usage and cross the CRITICAL threshold (82%) via a real turn. If the
    // breaker weren't open, the pre-turn critical-path trigger would call compress again
    // (via _awaitCompactionBounded); instead it should shed old tool output directly (or
    // report nothing left to shed) and never touch compress.
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20), lastInputTokens: 110_000 });
    const events = await collectEvents(session.send("continue"));

    expect(compress.mock.calls.length).toBe(callsAfterTripping);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.level === "warn"
      && /automatic compaction is disabled after repeated failures/i.test(e.message))).toBe(true);
    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
  }, 10_000);

  it("escalates to an error-level diagnostic exactly once, at the trip point", async () => {
    const compress = vi.fn(async () => { throw new Error("summariser 500"); });
    const { session } = createSession({ compressionKeepRecent: 4 });
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20) });

    for (let i = 0; i < 3; i++) await session.manualCompact({ compress });

    // A 4th manual attempt still runs for real (manualCompact is never gated) and fails again,
    // but the breaker was already open — this must not fire a second "disabled" escalation.
    await session.manualCompact({ compress });

    // manualCompact reports failure via its own return value, not execution_diagnostic
    // events — the escalation notice is only ever queued by the background/automatic path
    // (_beginBackgroundCompaction's .then()), so drive it through there once to observe it.
    const scripted = new ScriptedProviderSession(() => ({
      text: "done", stopReason: "end_turn",
      usage: { inputTokens: 50_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const { session: session2 } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionKeepRecent: 4,
    });
    // Trip this session's own breaker via the background path so its pending-notice queue
    // actually receives the escalation (manualCompact above proved the counter/threshold
    // mechanics; this proves the message only fires once).
    for (let i = 0; i < 3; i++) await session2.manualCompact({ compress });
    session2.restoreState({ sessionId: "s2", messages: buildPlainMessages(20) });

    const events = await collectEvents(session2.send("continue"));
    const escalations = events.filter((e) => e.type === "execution_diagnostic" && e.level === "error"
      && /disabled for the rest of this session/i.test(e.message));
    expect(escalations.length).toBeLessThanOrEqual(1);
  }, 15_000);

  it("a single success resets the failure count, so intermittent failures never trip it", async () => {
    let calls = 0;
    const compress = vi.fn(async () => {
      calls++;
      if (calls <= 4) throw new Error("transient"); // exhausts 2 full manualCompact attempts (2 retries each)
      return JSON.stringify({ objective: "ok", compressionMeta: { messageCount: 1, version: 1 } });
    });
    const scripted = new ScriptedProviderSession(() => ({
      text: "done", stopReason: "end_turn",
      usage: { inputTokens: 110_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionTriggerPct: 60,
      compressionKeepRecent: 4,
    });
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20) });

    expect((await session.manualCompact({ compress })).ok).toBe(false);
    expect((await session.manualCompact({ compress })).ok).toBe(false);
    expect((await session.manualCompact({ compress })).ok).toBe(true);
    const callsAfterRecovery = compress.mock.calls.length;

    // Breaker never opened — a subsequent automatic critical-path trigger must still call
    // compress rather than silently skipping to the shed fallback.
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20), lastInputTokens: 110_000 });
    await collectEvents(session.send("continue"));

    expect(compress.mock.calls.length).toBeGreaterThan(callsAfterRecovery);
  }, 10_000);
});

describe("AgentSession — self-heals from a thrown context-overflow rejection instead of ending the turn", () => {
  it("compacts and retries once on a provider's outright 'prompt too long' rejection, and corrects the assumed context length", async () => {
    const compress = vi.fn(async () => JSON.stringify({ objective: "summary", compressionMeta: { messageCount: 1, version: 1 } }));
    // Mirrors the real-world case this recovers: the request is rejected before any response
    // streams (a synchronous 400/402, not a normalized turnResult.stopReason), exactly what a
    // catalog-vs-real-limit mismatch (OpenRouter reporting a larger context window than it
    // actually enforces for this request) produces.
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { throwError: "OpenRouter 400: Prompt tokens limit exceeded: 256772 > 229126" }
      : { text: "done", stopReason: "end_turn", usage: { inputTokens: 1_000, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionKeepRecent: 4,
      contextLength: 1_000_000, // deliberately inflated, mirroring a catalog that overpromises
    });
    session.restoreState({ sessionId: "s1", messages: buildPlainMessages(20) });

    const events = await collectEvents(session.send("continue"));

    expect(compress).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(lastTurnComplete(events)?.stopReason).toBe("end_turn");
    // The observed real limit replaces the inflated one for the rest of the session, so the
    // proactive compaction trigger can actually fire before this happens again.
    expect(session.runtimeState.contextLength).toBe(229_126);
  });

  it("does not self-heal a plain cancellation (never misclassifies an abort as a context overflow)", async () => {
    const controller = new AbortController();
    const compress = vi.fn(async () => "unreachable");
    // Abort partway through the (would-be) provider call, not before send() starts — aborting
    // beforehand would exit via the loop's own top-of-iteration cancellation check without ever
    // reaching runTurn() at all, which wouldn't actually exercise the guard this test targets:
    // the new catch branch's own `!this._signal?.aborted` check, which must still see the abort
    // that happened *during* this call and decline to self-heal it as a context overflow.
    const scripted = new ScriptedProviderSession(() => {
      controller.abort();
      return { throwError: "OpenRouter 400: Prompt tokens limit exceeded: 5 > 3" };
    });

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      signal: controller.signal,
    });

    const events = await collectEvents(session.send("continue"));

    expect(compress).not.toHaveBeenCalled();
    expect(lastTurnComplete(events)?.stopReason).toBe("cancelled");
  });

  it("reports a real terminal failure, not an infinite retry, when nothing can be freed", async () => {
    const compress = vi.fn(async () => { throw new Error("compression also broken"); });
    const scripted = new ScriptedProviderSession(() => ({ throwError: "OpenRouter 400: Prompt tokens limit exceeded: 256772 > 229126" }));

    const { session } = createSession({
      providerTurnSessionFactory: () => scripted,
      compressionProvider: { compress },
      compressionKeepRecent: 4,
    });
    // No restoreState — a fresh session has too little history to compress (_compressHistory's
    // own "skipped" guard), and compress() fails too, so _recoverContextOverflow can free
    // nothing and must report a real terminal failure on the first attempt rather than looping.

    const events = await collectEvents(session.send("continue"));

    expect(lastTurnComplete(events)?.stopReason).toBe("context_window_exceeded");
    expect(events.some((e) => e.type === "error" && /cannot be reduced further/i.test(e.message))).toBe(true);
  });
});
