/**
 * End-to-end coverage for server-side compaction (beta compact-2026-01-12), driven over a
 * mocked Anthropic wire — the same style as agent-session.mid-stream-retry.spec.ts, and for the
 * same reason: this is exactly the kind of thing pure-function tests can't catch. The real risk
 * was never "does the request body have the right field" (resolveAnthropicBetaExtras covers
 * that) — it's whether the compaction block that comes back actually survives being recorded
 * into history and replayed correctly on the *next* request. Get that wrong and every
 * long-running conversation that triggers compaction silently loses its summarized history and
 * re-sends the full uncompacted transcript, defeating the entire feature without ever erroring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ContentBlock } from "../../src/agent-loop-contract.js";
import { anthropicCompactionTurn, anthropicTextTurn } from "./helpers/anthropic-sse.js";

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

function createAnthropicSession(opts?: { compactionTriggerTokens?: number }) {
  return new AgentSession({
    apiKey: "test-key",
    model: "claude-opus-4-8",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: createFakeContext() as never,
    provider: "anthropic",
    maxIterations: 5,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    compactionTriggerTokens: opts?.compactionTriggerTokens,
  } as never);
}

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function lastAssistantContent(session: AgentSession): ContentBlock[] {
  const assistant = [...session.history].reverse().find((m) => m.role === "assistant");
  if (!assistant) throw new Error("no assistant message recorded");
  if (typeof assistant.content === "string") throw new Error("expected structured content");
  return assistant.content as ContentBlock[];
}

describe("server-side compaction — round trip", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("requests compaction with the right beta header and context_management body field", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, body: anthropicTextTurn("hi") });
    vi.stubGlobal("fetch", fetchMock);

    await collect(createAnthropicSession({ compactionTriggerTokens: 80_000 }), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain("compact-2026-01-12");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["context_management"]).toEqual({
      edits: [{
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: 80_000 },
        pause_after_compaction: false,
        instructions: null,
      }],
    });
  });

  it("records the compaction block first, ahead of the text reply, in the persisted assistant turn", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: anthropicCompactionTurn({ compactionText: "Summary: user asked about X, we did Y.", replyText: "Continuing from where we left off." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = createAnthropicSession({ compactionTriggerTokens: 80_000 });
    await collect(session, "hello");

    const content = lastAssistantContent(session);
    expect(content[0]).toEqual({ type: "compaction", content: "Summary: user asked about X, we did Y." });
    expect(content[1]).toMatchObject({ type: "text", text: "Continuing from where we left off." });
  });

  it("replays the compaction block verbatim on the NEXT request — the actual round-trip", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        body: anthropicCompactionTurn({ compactionText: "Summary of everything so far.", replyText: "OK, noted." }),
      })
      .mockResolvedValueOnce({ ok: true, body: anthropicTextTurn("second reply") });
    vi.stubGlobal("fetch", fetchMock);

    const session = createAnthropicSession({ compactionTriggerTokens: 80_000 });
    await collect(session, "first message");
    await collect(session, "second message");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body)) as { messages: Array<{ role: string; content: unknown }> };
    // Find the assistant turn that should carry the compaction block forward.
    const assistantTurn = secondBody.messages.find((m) => m.role === "assistant");
    expect(assistantTurn).toBeDefined();
    const assistantContent = assistantTurn!.content as Array<Record<string, unknown>>;
    expect(assistantContent[0]).toEqual({ type: "compaction", content: "Summary of everything so far." });
  });

  it("sums usage.iterations for accurate cost when compaction fires, instead of undercounting", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: anthropicCompactionTurn({
        compactionText: "summary",
        replyText: "reply",
        iterations: [
          { type: "compaction", input_tokens: 180_000, output_tokens: 3_500 },
          { type: "message", input_tokens: 23_000, output_tokens: 1_000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createAnthropicSession({ compactionTriggerTokens: 80_000 }), "hello");
    const runtimeEvents = events.filter((e): e is Extract<AgentEvent, { type: "runtime_state" }> => e.type === "runtime_state");
    // lastInputTokens on the final runtime snapshot should reflect the SUMMED total
    // (180000+23000), not just the top-level message-iteration figure the plain fields
    // would have reported.
    expect(runtimeEvents.at(-1)?.state.lastInputTokens).toBe(203_000);
  });

  it("does not send context_management at all when compaction is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, body: anthropicTextTurn("hi") });
    vi.stubGlobal("fetch", fetchMock);

    await collect(createAnthropicSession(), "hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["context_management"]).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});
