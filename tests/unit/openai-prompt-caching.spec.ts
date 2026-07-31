/**
 * Coverage for OpenAI's GPT-5.6-era prompt caching, which this harness previously did not speak
 * at all — it sent only `prompt_cache_key` and relied on implicit caching everywhere.
 *
 * That default is actively wrong here. Implicit mode places its breakpoint on the *newest*
 * message, and the newest message on every request is the volatile workspace-context tail, so
 * each turn re-wrote that block into the cache at the 1.25x write premium 5.6 introduced and
 * none of it could ever come back as a read. These tests pin the two halves of the fix: stable
 * breakpoints on the reusable prefix, and the request-level parameters that make them the only
 * ones that write (or, on older models, that stop a ZDR org silently getting a 5-minute cache).
 */
import { describe, expect, it, vi } from "vitest";
import {
  appendOpenAIWorkspaceContextTail,
  applyOpenAICacheParams,
  hasOpenAICacheBreakpoint,
  looksLikePromptCacheRejection,
  openAISupportsExplicitPromptCache,
  stripOpenAICacheParams,
  toOpenAIMessages,
  withOpenAICacheBreakpoints,
  AgentSession,
  type AgentEvent,
} from "../../src/agent-session.js";
import type { AgentMessage } from "../../src/agent-loop-contract.js";

type Part = { type: string; text?: string; prompt_cache_breakpoint?: { mode: string } };
const partsOf = (content: unknown): Part[] => content as Part[];
const breakpointRoles = (msgs: Array<{ role: string; content: unknown }>): string[] =>
  msgs.filter((m) => Array.isArray(m.content) && partsOf(m.content).some((p) => p.prompt_cache_breakpoint))
    .map((m) => m.role);

describe("openAISupportsExplicitPromptCache", () => {
  it("recognises GPT-5.6 and later, including unreleased versions", () => {
    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.7", "gpt-6", "gpt-10.2"]) {
      expect(openAISupportsExplicitPromptCache(id), id).toBe(true);
    }
  });

  it("leaves earlier families and the o-series on the legacy dialect", () => {
    // Sending prompt_cache_options to these would be rejected outright.
    for (const id of ["gpt-5.5", "gpt-5.1", "gpt-5.1-codex", "gpt-5", "gpt-4.1", "gpt-4o", "o3", "o4-mini"]) {
      expect(openAISupportsExplicitPromptCache(id), id).toBe(false);
    }
  });
});

describe("withOpenAICacheBreakpoints", () => {
  const history: AgentMessage[] = [
    { role: "user", content: "first task" },
    { role: "assistant", content: "on it" },
    { role: "user", content: "second task" },
  ];

  it("anchors the static system prefix and the rolling end of the conversation", () => {
    const out = withOpenAICacheBreakpoints(toOpenAIMessages(history, "system prompt"));
    expect(breakpointRoles(out)).toEqual(["system", "user"]);
    // Two breakpoints, well inside OpenAI's limit of four new cache writes per request.
    expect(breakpointRoles(out)).toHaveLength(2);
    expect(partsOf(out[0]!.content)[0]).toMatchObject({
      type: "text", text: "system prompt", prompt_cache_breakpoint: { mode: "explicit" },
    });
    // The rolling one lands on the last message, not somewhere mid-history.
    expect(partsOf(out[out.length - 1]!.content)[0]).toMatchObject({ text: "second task" });
  });

  it("keeps the breakpoint off the volatile workspace tail", () => {
    // This is the whole point: a breakpoint on per-turn content re-writes the prompt every
    // request and never gets a read hit, which is precisely what implicit mode was doing.
    const marked = withOpenAICacheBreakpoints(toOpenAIMessages(history, "system prompt"));
    const out = appendOpenAIWorkspaceContextTail(marked, "WORKSPACE STATE");
    const last = out[out.length - 1]!;
    expect(last).toEqual({ role: "user", content: "WORKSPACE STATE" });
    expect(hasOpenAICacheBreakpoint([last])).toBe(false);
    expect(hasOpenAICacheBreakpoint(out)).toBe(true);
  });

  it("anchors on a trailing tool result rather than skipping back to the last user message", () => {
    // An agent turn usually ends on a tool result; anchoring further back would leave the whole
    // tool round-trip re-billed as fresh input on every iteration of the loop.
    const withToolCall: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "file_read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }] },
    ];
    const out = withOpenAICacheBreakpoints(toOpenAIMessages(withToolCall, "sys"));
    const last = out[out.length - 1]!;
    expect(last.role).toBe("tool");
    expect(partsOf(last.content)[0]).toMatchObject({ prompt_cache_breakpoint: { mode: "explicit" } });
  });

  it("skips assistant tool-call messages, which have no text block to anchor", () => {
    const trailingToolCall: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "file_read", input: {} }] },
    ];
    const out = withOpenAICacheBreakpoints(toOpenAIMessages(trailingToolCall, "sys"));
    // Falls back to the user message before it rather than dropping the rolling breakpoint.
    expect(breakpointRoles(out)).toEqual(["system", "user"]);
  });

  it("never mutates the input array or its messages", () => {
    const input = toOpenAIMessages(history, "sys");
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    withOpenAICacheBreakpoints(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("places one breakpoint when there is nothing but a system message", () => {
    const out = withOpenAICacheBreakpoints(toOpenAIMessages([], "system only"));
    expect(breakpointRoles(out)).toEqual(["system"]);
  });
});

describe("applyOpenAICacheParams", () => {
  it("switches GPT-5.6+ to explicit mode once breakpoints are actually anchored", () => {
    const body: Record<string, unknown> = {};
    applyOpenAICacheParams(body, "gpt-5.6-sol", true);
    expect(body["prompt_cache_options"]).toEqual({ mode: "explicit" });
    // The deprecated retention field must not go out alongside it — 5.6 rejects it.
    expect(body["prompt_cache_retention"]).toBeUndefined();
  });

  it("stays on implicit mode when nothing could be anchored", () => {
    // Explicit mode with no breakpoints in the payload disables caching outright, which is
    // strictly worse than implicit mode's merely-wasteful writes.
    const body: Record<string, unknown> = {};
    applyOpenAICacheParams(body, "gpt-5.6-sol", false);
    expect(body["prompt_cache_options"]).toBeUndefined();
    expect(body["prompt_cache_retention"]).toBeUndefined();
  });

  it("asks for extended retention on pre-5.6 models", () => {
    // Without this a ZDR-enabled org silently gets the in_memory policy — 5-10 minutes of idle
    // tolerance — so an agent run that pauses for a review comes back to a cold cache.
    const body: Record<string, unknown> = {};
    applyOpenAICacheParams(body, "gpt-5.1", true);
    expect(body["prompt_cache_retention"]).toBe("24h");
    expect(body["prompt_cache_options"]).toBeUndefined();
  });
});

describe("prompt-cache rejection recovery", () => {
  it("recognises a 400 that names a prompt-cache parameter, and nothing else", () => {
    const cacheError = JSON.stringify({ error: { message: "Unknown parameter: 'prompt_cache_options'.", param: "prompt_cache_options" } });
    expect(looksLikePromptCacheRejection(400, cacheError)).toBe(true);
    expect(looksLikePromptCacheRejection(400, "invalid prompt_cache_breakpoint")).toBe(true);
    expect(looksLikePromptCacheRejection(400, "prompt_cache_retention is not supported")).toBe(true);
    // An unrelated 400 must still surface as a real error rather than being silently retried.
    expect(looksLikePromptCacheRejection(400, "Invalid value for 'tool_choice'.")).toBe(false);
    // Only 400s — a 429 is a capacity problem, not a malformed request.
    expect(looksLikePromptCacheRejection(429, "prompt_cache_options")).toBe(false);
  });

  it("strips every cache field so the retry is a request the endpoint can accept", () => {
    const body: Record<string, unknown> = {
      prompt_cache_options: { mode: "explicit" },
      prompt_cache_key: "s_abc",
      messages: withOpenAICacheBreakpoints(toOpenAIMessages([{ role: "user", content: "hi" }], "sys")),
    };
    expect(stripOpenAICacheParams(body)).toBe(true);
    expect(body["prompt_cache_options"]).toBeUndefined();
    expect(hasOpenAICacheBreakpoint(body["messages"] as never)).toBe(false);
    // prompt_cache_key is plain routing metadata accepted by every model — it stays.
    expect(body["prompt_cache_key"]).toBe("s_abc");
    // Content survives the strip; only the marker is removed.
    expect(partsOf((body["messages"] as Array<{ content: unknown }>)[0]!.content)[0]).toEqual({ type: "text", text: "sys" });
  });

  it("reports no change when there was nothing to strip, so the caller does not retry blindly", () => {
    expect(stripOpenAICacheParams({ messages: toOpenAIMessages([{ role: "user", content: "hi" }], "sys") })).toBe(false);
    expect(stripOpenAICacheParams({})).toBe(false);
  });
});

// ── Wire-level coverage over a mocked OpenAI endpoint ─────────────────────────

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

function createSession(model: string, serviceTier?: "flex" | "fast") {
  return new AgentSession({
    apiKey: "test-key",
    model,
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: createFakeContext() as never,
    provider: "openai",
    serviceTier,
    maxIterations: 5,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

/** A chat-completions SSE stream carrying a usage chunk and an echoed service tier. */
function sseStream(opts: { servedTier?: string; cached?: number; cacheWrite?: number } = {}): ReadableStream<Uint8Array> {
  const usage: Record<string, unknown> = {
    prompt_tokens: 10_000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: opts.cached ?? 0, cache_write_tokens: opts.cacheWrite ?? 0 },
  };
  const chunk: Record<string, unknown> = { choices: [{ delta: { content: "done" }, finish_reason: null }] };
  if (opts.servedTier) chunk["service_tier"] = opts.servedTier;
  const lines = [
    JSON.stringify(chunk),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage, ...(opts.servedTier ? { service_tier: opts.servedTier } : {}) }),
  ];
  const bytes = new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n");
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

const okResponse = (opts?: Parameters<typeof sseStream>[0]) =>
  ({ ok: true, status: 200, headers: { get: () => null }, body: sseStream(opts) });
const badResponse = (status: number, text = "") =>
  ({ ok: false, status, headers: { get: () => null }, body: { cancel: () => Promise.resolve() }, text: async () => text });

const bodyOf = (mock: ReturnType<typeof vi.fn>, i: number): Record<string, unknown> =>
  JSON.parse(String((mock.mock.calls[i]?.[1] as RequestInit | undefined)?.body ?? "{}"));

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

const usageEvent = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "usage_update" }> => e.type === "usage_update").at(-1);

describe("OpenAI prompt caching on the wire", () => {
  it("sends explicit cache options, breakpoints and a stable key for a GPT-5.6 model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      await collect(createSession("gpt-5.6-terra"), "hello");
      const body = bodyOf(fetchMock, 0);
      expect(body["prompt_cache_options"]).toEqual({ mode: "explicit" });
      expect(body["prompt_cache_retention"]).toBeUndefined();
      // OpenAI documents the key as required (not merely advisory) for reliable 5.6 matching.
      expect(typeof body["prompt_cache_key"]).toBe("string");
      expect(hasOpenAICacheBreakpoint(body["messages"] as never)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("sends extended retention and no breakpoints for a pre-5.6 model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      await collect(createSession("gpt-5.1"), "hello");
      const body = bodyOf(fetchMock, 0);
      expect(body["prompt_cache_retention"]).toBe("24h");
      expect(body["prompt_cache_options"]).toBeUndefined();
      expect(hasOpenAICacheBreakpoint(body["messages"] as never)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("retries once without cache parameters when the endpoint rejects them", async () => {
    // The dialect is chosen from the model id, which is a threshold guess for anything newer
    // than this build. A wrong guess must cost a round trip, not the run.
    const rejection = JSON.stringify({ error: { message: "Unrecognized request argument supplied: prompt_cache_options", param: "prompt_cache_options" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(badResponse(400, rejection))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const events = await collect(createSession("gpt-5.6-sol"), "hello");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retry = bodyOf(fetchMock, 1);
      expect(retry["prompt_cache_options"]).toBeUndefined();
      expect(hasOpenAICacheBreakpoint(retry["messages"] as never)).toBe(false);
      expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "end_turn" });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("OpenAI usage accounting", () => {
  it("splits cache writes out of prompt_tokens instead of reporting them as zero", async () => {
    // cacheWriteTokens was hardcoded to 0, so on 5.6 — the first family to report and bill them
    // at 1.25x input — those tokens were both invisible and costed as ordinary input.
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ cached: 6_000, cacheWrite: 1_500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const usage = usageEvent(await collect(createSession("gpt-5.6-sol"), "hello"));
      expect(usage).toMatchObject({ cacheReadTokens: 6_000, cacheWriteTokens: 1_500, outputTokens: 500 });
      // The three input categories must still sum to the reported prompt_tokens.
      expect(usage!.inputTokens + usage!.cacheReadTokens + usage!.cacheWriteTokens).toBe(10_000);
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports the tier that served the turn, not the one that was asked for", async () => {
    // OpenAI is explicit that the echoed tier can differ from the requested one, and billing
    // follows what served it — costing a downgraded flex turn at half rates would under-report.
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ servedTier: "default" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const usage = usageEvent(await collect(createSession("gpt-5.6-sol", "flex"), "hello"));
      expect(bodyOf(fetchMock, 0)["service_tier"]).toBe("flex");
      expect(usage?.serviceTier).toBe("default");
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports flex when flex actually served the turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ servedTier: "flex" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(usageEvent(await collect(createSession("gpt-5.6-sol", "flex"), "hello"))?.serviceTier).toBe("flex");
    } finally { vi.unstubAllGlobals(); }
  });

  it("falls back to the requested tier when the backend echoes nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(usageEvent(await collect(createSession("gpt-5.6-sol", "flex"), "hello"))?.serviceTier).toBe("flex");
    } finally { vi.unstubAllGlobals(); }
  });

  it("costs a tier-downgraded turn at standard rates after the 429 fallback", async () => {
    // The fallback drops service_tier from the retry, so the seeded tier must drop with it —
    // otherwise a turn charged in full would be reported at half price.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(badResponse(429))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const usage = usageEvent(await collect(createSession("gpt-5.6-sol", "flex"), "hello"));
      expect(bodyOf(fetchMock, 1)["service_tier"]).toBeUndefined();
      expect(usage?.serviceTier).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
});
