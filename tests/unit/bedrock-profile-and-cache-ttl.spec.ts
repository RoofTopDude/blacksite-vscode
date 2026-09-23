import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  normalizeBedrockStopReason,
  withBedrockRollingCacheBreakpoint,
  withBedrockToolsCacheBreakpoint,
  type AgentEvent,
  type AgentSessionOptions,
} from "../../src/agent-session.js";
import { buildRequestBody } from "../../src/bedrock-client.js";
import {
  BEDROCK_CONVERSE_DEFAULT_MODEL,
  BEDROCK_CONVERSE_LEGACY_DEFAULT_MODEL,
  BEDROCK_MANTLE_DEFAULT_MODEL,
  defaultBedrockModel,
} from "../../src/bedrock-config.js";
import { bedrockSupportsCacheTtl1h, resolveClaudeLimits } from "../../src/model-limits.js";
import { normalizeModelIdForFallbackLookup } from "../../src/model-fetcher.js";
import { parseClaudeVersion, resolveThinkingMode } from "../../src/thinking-modes.js";
import { eventFrame, streamFromChunks } from "./helpers/bedrock-frames.js";

/* Fix 1. Only us./eu./apac./us-gov. were stripped, so the global profile AWS's own samples use —
   and the jp./au. geos — were not recognised as Claude: thinking, effort, context limits and
   cache anchoring all switched off without an error. */
describe("Bedrock inference-profile prefixes", () => {
  it.each([
    "global.anthropic.claude-sonnet-5",
    "us.anthropic.claude-sonnet-5",
    "eu.anthropic.claude-sonnet-5",
    "au.anthropic.claude-sonnet-5",
    "jp.anthropic.claude-sonnet-4-6-v1:0",
    "apac.anthropic.claude-sonnet-4-6-v1:0",
    "us-gov.anthropic.claude-sonnet-4-6-v1:0",
  ])("recognises %s as Claude", (id) => {
    expect(parseClaudeVersion(id)).not.toBeNull();
    expect(resolveThinkingMode(id)).toBe("adaptive");
    expect(resolveClaudeLimits(id)?.contextWindow).toBe(1_000_000);
  });

  it("normalises a global profile for pricing and context lookups", () => {
    expect(normalizeModelIdForFallbackLookup("global.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

/* Fix 2. Converse sent bare cache points, so a "1h" session ran on 5-minute entries. */
describe("Bedrock Converse cache TTL", () => {
  it("knows which models take the one-hour TTL", () => {
    for (const id of ["global.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-4-5-20251101-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic.claude-fable-5"]) {
      expect(bedrockSupportsCacheTtl1h(id), id).toBe(true);
    }
    for (const id of ["us.anthropic.claude-sonnet-4-20250514-v1:0", "us.anthropic.claude-3-7-sonnet-20250219-v1:0", "amazon.nova-pro-v1:0"]) {
      expect(bedrockSupportsCacheTtl1h(id), id).toBe(false);
    }
  });

  it("puts the TTL on every cache point when asked, and on none otherwise", () => {
    const messages = [
      { role: "user" as const, content: [{ text: "a" }] },
      { role: "assistant" as const, content: [{ text: "b" }] },
      { role: "user" as const, content: [{ text: "c" }] },
    ];
    const rolled = withBedrockRollingCacheBreakpoint(messages, { anchorPreviousTurn: true, ttl: "1h" });
    expect(rolled[0]!.content.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    expect(rolled[2]!.content.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    expect(withBedrockRollingCacheBreakpoint(messages)[2]!.content.at(-1)).toEqual({ cachePoint: { type: "default" } });

    const tool = { toolSpec: { name: "t", description: "d", inputSchema: { json: {} } } };
    expect(withBedrockToolsCacheBreakpoint([tool], "1h").at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });

    const body = buildRequestBody({
      credentials: { region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" },
      modelId: "us.anthropic.claude-sonnet-5", messages, systemPrompt: "sys", cacheTtl: "1h",
    });
    expect(body.system?.[1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
  });
});

/* Fix 3, with its opt-out. */
describe("Bedrock Converse stop reasons", () => {
  it("treats a context-window overflow as one, so recovery compacts instead of growing the output budget", () => {
    expect(normalizeBedrockStopReason("model_context_window_exceeded")).toBe("context_window_exceeded");
  });

  it("restores the earlier mapping when blacksite.bedrock.extendedStopReasons is off", () => {
    expect(normalizeBedrockStopReason("model_context_window_exceeded", { extendedStopReasons: false })).toBe("protocol_violation");
  });

  it("keeps malformed output on the revert-and-retry path", () => {
    expect(normalizeBedrockStopReason("malformed_tool_use")).toBe("protocol_violation");
    expect(normalizeBedrockStopReason("malformed_model_output")).toBe("protocol_violation");
  });
});

/* Fix 4, with its opt-out. */
describe("Bedrock default model", () => {
  it("defaults Converse to Sonnet 5 in the same US geography as before", () => {
    expect(defaultBedrockModel("converse")).toBe("us.anthropic.claude-sonnet-5");
    expect(BEDROCK_CONVERSE_DEFAULT_MODEL).toBe("us.anthropic.claude-sonnet-5");
  });

  it("keeps the previous default when blacksite.bedrock.latestDefaultModel is off", () => {
    expect(defaultBedrockModel("converse", { latest: false })).toBe(BEDROCK_CONVERSE_LEGACY_DEFAULT_MODEL);
    expect(BEDROCK_CONVERSE_LEGACY_DEFAULT_MODEL).toBe("us.anthropic.claude-sonnet-4-20250514-v1:0");
  });

  it("leaves the Mantle default alone either way", () => {
    expect(defaultBedrockModel("mantle", { latest: false })).toBe(BEDROCK_MANTLE_DEFAULT_MODEL);
  });
});

// ── Through a real Converse turn ──────────────────────────────────────────────

function converseAnswer(stopReason = "end_turn") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: streamFromChunks([
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "done" } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("messageStop", { stopReason }),
      eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } }),
    ]),
  };
}
const rejection = (message: string) => ({
  ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ message }),
});

function converseSession(model: string, extra: Partial<AgentSessionOptions> = {}) {
  return new AgentSession({
    provider: "bedrock", model, apiKey: "", systemPrompt: "Test", workspaceRoot: "C:/workspace", cacheTtl: "1h",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" },
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) },
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    maxIterations: 2, checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    ...extra,
  } as unknown as AgentSessionOptions);
}

async function run(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send("hello")) events.push(event);
  return events;
}

const sentBody = (fetchMock: ReturnType<typeof vi.fn>, i: number) =>
  JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as { system?: Array<Record<string, unknown>> };

describe("Converse cache TTL on the wire", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends the one-hour TTL for a model that takes it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(converseAnswer());
    vi.stubGlobal("fetch", fetchMock);
    await run(converseSession("us.anthropic.claude-sonnet-5"));
    expect(sentBody(fetchMock, 0).system?.[1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
  });

  it("sends a plain cache point for a model that does not", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(converseAnswer());
    vi.stubGlobal("fetch", fetchMock);
    await run(converseSession("us.anthropic.claude-sonnet-4-20250514-v1:0"));
    expect(sentBody(fetchMock, 0).system?.[1]).toEqual({ cachePoint: { type: "default" } });
  });

  it("drops only the TTL when Bedrock rejects it, keeping the cache points", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejection("The ttl field of cachePoint is not supported for this model."))
      .mockResolvedValueOnce(converseAnswer());
    vi.stubGlobal("fetch", fetchMock);
    const events = await run(converseSession("us.anthropic.claude-sonnet-5"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).system?.[1]).toEqual({ cachePoint: { type: "default" } });
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });
});

describe("Converse stop-reason setting on the wire", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads the setting per turn, so switching it off applies without a restart", async () => {
    let extended = true;
    const getter = vi.fn(() => extended);
    const fetchMock = vi.fn().mockImplementation(async () => converseAnswer());
    vi.stubGlobal("fetch", fetchMock);
    const session = converseSession("us.anthropic.claude-sonnet-5", { bedrockExtendedStopReasons: getter });
    await run(session);
    extended = false;
    await run(session);
    expect(getter).toHaveBeenCalledTimes(2);
  });
});
