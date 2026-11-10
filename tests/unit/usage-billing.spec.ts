import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import {
  bedrockEndpointMultiplier,
  bedrockModelsToModelInfo,
  createModelClient,
  estimateUsageCostUsd,
  fastModeNeedsBeta,
  getContextLength,
  getModelPricing,
  planThinking,
  resolveAnthropicBetaExtras,
  supportsFastMode,
  type BedrockAvailableModel,
  type ModelRequest,
  type ProviderTurnStreamEvent,
} from "@blacksite-agent/llm";
import { anthropicSseStream, eventFrame, streamFromChunks } from "@blacksite-agent/llm/testing";

/*
  What a turn is billed for, read from the response rather than guessed from settings: the TTL each
  cache write carried, the speed the request was served at, the searches the provider ran, and the
  prompt tokens a server-side search added after the opening usage snapshot.
*/

afterEach(() => { vi.unstubAllGlobals(); });

type Usage = Extract<ProviderTurnStreamEvent, { type: "usage_update" }>;

function anthropicRequest(model = "claude-opus-5-5"): ModelRequest {
  return {
    model,
    system: "You are terse.",
    systemSummary: "",
    contextTail: "",
    messages: [{ role: "user", content: "hi" }],
    tools: { wire: [], deferred: new Set() },
    thinking: planThinking({ model, provider: "anthropic", configuredMaxTokens: 1024, ceiling: null, thinkingEnabled: false, budgetTokens: 0, effort: undefined, temperature: undefined }),
    conversationId: "conv-1",
    turnIndex: 0,
  };
}

async function anthropicUsage(startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>): Promise<Usage> {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    body: anthropicSseStream([
      { type: "message_start", message: { usage: startUsage } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: deltaUsage },
    ]),
  })));
  const client = createModelClient({ provider: "anthropic", apiKey: "k", cacheTtl: "1h" });
  const events: ProviderTurnStreamEvent[] = [];
  for await (const event of client.stream(anthropicRequest())) events.push(event);
  const usage = events.find((event): event is Usage => event.type === "usage_update");
  if (!usage) throw new Error("no usage event");
  return usage;
}

describe("Anthropic usage", () => {
  it("reports how many cache writes carried the one-hour TTL", async () => {
    const usage = await anthropicUsage(
      {
        input_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1500,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 },
      },
      { output_tokens: 12 },
    );
    expect(usage).toMatchObject({ inputTokens: 40, outputTokens: 12, cacheReadTokens: 9000, cacheWriteTokens: 1500, cacheWrite1hTokens: 1000 });
  });

  it("leaves the split unknown when the response gives none, so the session setting decides", async () => {
    const usage = await anthropicUsage({ input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 300 }, { output_tokens: 3 });
    expect(usage.cacheWriteTokens).toBe(300);
    expect(usage.cacheWrite1hTokens).toBeUndefined();
  });

  it("counts the prompt tokens and searches a server-side search added after the first snapshot", async () => {
    const usage = await anthropicUsage(
      { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      // The closing usage is cumulative: search results were read as input in later rounds.
      { input_tokens: 9500, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0, output_tokens: 300, server_tool_use: { web_search_requests: 3 } },
    );
    expect(usage).toMatchObject({ inputTokens: 9500, cacheReadTokens: 1200, outputTokens: 300, webSearchRequests: 3 });
  });

  it("never lets a closing usage that omits a field erase what the opening one reported", async () => {
    const usage = await anthropicUsage({ input_tokens: 700, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 }, { output_tokens: 8 });
    expect(usage).toMatchObject({ inputTokens: 700, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 8 });
    expect(usage.webSearchRequests).toBeUndefined();
  });

  it("marks a request served in fast mode, and only that one", async () => {
    const fast = await anthropicUsage({ input_tokens: 10, speed: "fast" }, { output_tokens: 5, speed: "fast" });
    expect(fast.serviceTier).toBe("fast");
    const standard = await anthropicUsage({ input_tokens: 10, speed: "standard" }, { output_tokens: 5 });
    expect(standard.serviceTier).toBeUndefined();
  });
});

describe("cost of a turn", () => {
  const opus55 = getModelPricing("anthropic", "claude-opus-5-5");

  it("bills each cache write at the rate of the TTL it was written with", () => {
    // 1,000,000 written: 250,000 for an hour ($8/MTok) and 750,000 for five minutes ($5/MTok).
    const cost = estimateUsageCostUsd(opus55, { cacheWrite: 1_000_000, cacheWrite1h: 250_000, cacheTtl: "1h" });
    expect(cost?.costUsd).toBeCloseTo(0.25 * 8 + 0.75 * 5, 10);
    expect(cost?.partial).toBe(false);
  });

  it("trusts a reported split of zero over a one-hour setting", () => {
    // Bedrock fell back to the five-minute cache: the setting still says 1h, the bill does not.
    expect(estimateUsageCostUsd(opus55, { cacheWrite: 1_000_000, cacheWrite1h: 0, cacheTtl: "1h" })?.costUsd).toBeCloseTo(5, 10);
  });

  it("falls back to the session TTL when no split was reported", () => {
    expect(estimateUsageCostUsd(opus55, { cacheWrite: 1_000_000, cacheTtl: "1h" })?.costUsd).toBeCloseTo(8, 10);
    expect(estimateUsageCostUsd(opus55, { cacheWrite: 1_000_000 })?.costUsd).toBeCloseTo(5, 10);
  });

  it("never bills more one-hour writes than there were writes", () => {
    expect(estimateUsageCostUsd(opus55, { cacheWrite: 100_000, cacheWrite1h: 900_000 })?.costUsd).toBeCloseTo(0.8, 10);
  });

  it("doubles every token category in fast mode", () => {
    const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };
    const standard = estimateUsageCostUsd(opus55, tokens)!.costUsd;
    expect(standard).toBeCloseTo(4 + 20 + 0.2, 10);
    expect(estimateUsageCostUsd(opus55, { ...tokens, serviceTier: "fast" })!.costUsd).toBeCloseTo(standard * 2, 10);
  });

  it("adds $10 per 1,000 searches, a flat fee fast mode does not scale", () => {
    expect(estimateUsageCostUsd(opus55, { webSearchRequests: 250 })?.costUsd).toBeCloseTo(2.5, 10);
    expect(estimateUsageCostUsd(opus55, { webSearchRequests: 250, serviceTier: "fast" })?.costUsd).toBeCloseTo(2.5, 10);
  });
});

describe("Claude Fable 5.2 and Mythos 5.2", () => {
  it.each(["claude-fable-5-2", "claude-mythos-5-2"])("prices %s at $8 / $40 with 0.025x cache reads", (id) => {
    expect(getModelPricing("anthropic", id)).toMatchObject({ inputPricePerM: 8, outputPricePerM: 40, cacheReadPricePerM: 0.2, cacheWritePricePerM: 10 });
  });

  it("prices every route's spelling the same, and never at Fable 5.1's rate", () => {
    expect(getModelPricing("bedrock", "anthropic.claude-fable-5-2")?.inputPricePerM).toBe(8);
    expect(getModelPricing("bedrock", "global.anthropic.claude-fable-5-2")?.inputPricePerM).toBe(8);
    expect(getModelPricing("openrouter", "anthropic/claude-fable-5.2")?.outputPricePerM).toBe(40);
    expect(getModelPricing("anthropic", "claude-fable-5-1")?.inputPricePerM).toBe(10);
  });

  it("offers fast mode there without the research-preview header", () => {
    expect(supportsFastMode("claude-fable-5-2")).toBe(true);
    expect(supportsFastMode("claude-mythos-5-2")).toBe(true);
    expect(supportsFastMode("claude-fable-5-1")).toBe(false);
    expect(fastModeNeedsBeta("claude-fable-5-2")).toBe(false);
    const extras = resolveAnthropicBetaExtras("claude-fable-5-2", { fastMode: true }, false);
    expect(extras.bodyExtras["speed"]).toBe("fast");
    expect(extras.betas).not.toContain("fast-mode-2026-02-01");
  });

  it("keeps the header for the Opus models still in research preview, and drops it for Opus 5.5", () => {
    expect(fastModeNeedsBeta("claude-opus-4-8")).toBe(true);
    expect(fastModeNeedsBeta("claude-opus-5")).toBe(true);
    expect(fastModeNeedsBeta("claude-opus-5-5")).toBe(false);
    expect(resolveAnthropicBetaExtras("claude-opus-5", { fastMode: true }, false).betas).toContain("fast-mode-2026-02-01");
    const ga = resolveAnthropicBetaExtras("claude-opus-5-5", { fastMode: true }, false);
    expect(ga.bodyExtras["speed"]).toBe("fast");
    expect(ga.betas).not.toContain("fast-mode-2026-02-01");
  });
});

describe("Bedrock pricing", () => {
  it("adds the regional premium to an in-Region foundation-model id on Claude 4.5 and later", () => {
    // A bare versioned id is served in the caller's own Region: regional routing, like a geo profile.
    expect(bedrockEndpointMultiplier("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(1.1);
    expect(getModelPricing("bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0")?.inputPricePerM).toBeCloseTo(1.1, 10);
    // Not before 4.5, not on a global profile, and not on a Mantle id, whose routing is not in the id.
    expect(bedrockEndpointMultiplier("anthropic.claude-sonnet-4-20250514-v1:0")).toBe(1);
    expect(bedrockEndpointMultiplier("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(1);
    expect(bedrockEndpointMultiplier("anthropic.claude-opus-5-5")).toBe(1);
  });

  it("prices Amazon Nova, cache reads at a quarter of input", () => {
    expect(getModelPricing("bedrock", "us.amazon.nova-pro-v1:0")).toMatchObject({ inputPricePerM: 0.8, outputPricePerM: 3.2, cacheReadPricePerM: 0.2, cacheWritePricePerM: 0.8 });
    expect(getModelPricing("bedrock", "amazon.nova-micro-v1:0")).toMatchObject({ inputPricePerM: 0.035, outputPricePerM: 0.14 });
    expect(getModelPricing("bedrock", "amazon.nova-lite-v1:0")?.outputPricePerM).toBe(0.24);
    expect(getModelPricing("bedrock", "us.amazon.nova-premier-v1:0")?.inputPricePerM).toBe(2.5);
    // Nova 2 is the one Nova with a premium on geographic profiles.
    expect(getModelPricing("bedrock", "global.amazon.nova-2-lite-v1:0")?.inputPricePerM).toBe(0.3);
    expect(getModelPricing("bedrock", "us.amazon.nova-2-lite-v1:0")?.inputPricePerM).toBeCloseTo(0.33, 10);
  });

  it("still reports a model it has no price for as unknown", () => {
    expect(getModelPricing("bedrock", "meta.llama4-maverick-17b-instruct-v1:0")).toBeUndefined();
    expect(getModelPricing("bedrock", "amazon.nova-canvas-v1:0")).toBeUndefined();
    expect(getModelPricing("anthropic", "amazon.nova-pro-v1:0")).toBeUndefined();
  });

  it("gives the other Bedrock families their own context window instead of Claude's", () => {
    expect(getContextLength("bedrock", "us.amazon.nova-micro-v1:0")).toBe(128_000);
    expect(getContextLength("bedrock", "amazon.nova-pro-v1:0")).toBe(300_000);
    expect(getContextLength("bedrock", "us.amazon.nova-premier-v1:0")).toBe(1_000_000);
    expect(getContextLength("bedrock", "us.meta.llama4-maverick-17b-instruct-v1:0")).toBe(128_000);
    expect(getContextLength("bedrock", "openai.gpt-oss-120b-1:0")).toBe(128_000);
    // Claude and opaque ARNs are unchanged.
    expect(getContextLength("bedrock", "global.anthropic.claude-sonnet-5")).toBe(1_000_000);
    expect(getContextLength("bedrock", "arn:aws:bedrock:us-east-1:1:application-inference-profile/abcd")).toBe(200_000);
  });

  const listed = (model: Partial<BedrockAvailableModel> & { id: string }): BedrockAvailableModel => ({
    label: model.id, providerName: "Anthropic", source: "inference_profile", modalities: ["TEXT"],
    inferenceTypes: ["INFERENCE_PROFILE"], customizationsSupported: [], ...model,
  });

  it("prices the models of a live Bedrock listing, which used to carry no price at all", () => {
    const [geo, global, nova, unknown] = bedrockModelsToModelInfo([
      listed({ id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", foundationModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" }),
      listed({ id: "global.anthropic.claude-sonnet-4-5-20250929-v1:0", foundationModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" }),
      listed({ id: "us.amazon.nova-pro-v1:0", foundationModelId: "amazon.nova-pro-v1:0" }),
      listed({ id: "us.meta.llama4-maverick-17b-instruct-v1:0" }),
    ]);
    expect(geo?.inputPricePerM).toBeCloseTo(3.3, 10);
    expect(geo?.cacheWritePricePerM).toBeCloseTo(4.125, 10);
    expect(global?.inputPricePerM).toBe(3);
    expect(nova?.outputPricePerM).toBe(3.2);
    expect(unknown?.inputPricePerM).toBeUndefined();
  });

  it("prices an application inference profile as the foundation model it wraps", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    expect(getModelPricing("bedrock", arn)).toBeUndefined();
    const [profile] = bedrockModelsToModelInfo([listed({ id: arn, foundationModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" })]);
    expect(profile?.inputPricePerM).toBeCloseTo(3.3, 10);
    expect(profile?.outputPricePerM).toBeCloseTo(16.5, 10);
    expect(profile?.contextLength).toBe(200_000);
  });

  it("carries Haiku 5.5's long-prompt tier into a listed row", () => {
    const [haiku] = bedrockModelsToModelInfo([listed({ id: "global.anthropic.claude-haiku-5-5" })]);
    expect(haiku?.longContextPricing?.aboveInputTokens).toBe(100_000);
  });
});

// ── Through a real Converse turn ──────────────────────────────────────────────

function converseAnswer(usage: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: streamFromChunks([
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "done" } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("messageStop", { stopReason: "end_turn" }),
      eventFrame("metadata", { usage }),
    ]),
  };
}
const rejection = (message: string) => ({
  ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ message }),
});

function converseSession(model: string) {
  return new AgentSession({
    provider: "bedrock", model, apiKey: "", systemPrompt: "Test", workspaceRoot: "C:/workspace", cacheTtl: "1h",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" },
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) },
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} } },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    maxIterations: 2, checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  } as unknown as AgentSessionOptions);
}

async function converseUsage(session: AgentSession): Promise<Extract<AgentEvent, { type: "usage_update" }>> {
  for await (const event of session.send("hello")) {
    if (event.type === "usage_update") return event;
  }
  throw new Error("no usage event");
}

describe("Bedrock Converse usage", () => {
  const written = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 800, cacheWriteInputTokens: 400 };

  it("names the provider and model, and the one-hour writes of a request sent with that TTL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(converseAnswer(written)));
    const usage = await converseUsage(converseSession("us.anthropic.claude-sonnet-5"));
    expect(usage).toMatchObject({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 400, cacheWrite1hTokens: 400,
      provider: "bedrock", model: "us.anthropic.claude-sonnet-5",
    });
  });

  it("reports no one-hour writes for a model that only takes the five-minute cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(converseAnswer(written)));
    const usage = await converseUsage(converseSession("us.anthropic.claude-sonnet-4-20250514-v1:0"));
    expect(usage.cacheWrite1hTokens).toBe(0);
  });

  it("reports no one-hour writes after Bedrock rejected the TTL, on that turn and the next", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(rejection("The ttl field of cachePoint is not supported for this model."))
      .mockResolvedValueOnce(converseAnswer(written))
      .mockResolvedValueOnce(converseAnswer(written)));
    const session = converseSession("us.anthropic.claude-sonnet-5");
    expect((await converseUsage(session)).cacheWrite1hTokens).toBe(0);
    expect((await converseUsage(session)).cacheWrite1hTokens).toBe(0);
  });

  it("prefers Bedrock's own breakdown by TTL when the response carries one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(converseAnswer({
      ...written,
      cacheDetails: [{ ttl: "1h", inputTokens: 300 }, { ttl: "5m", inputTokens: 100 }],
    })));
    const usage = await converseUsage(converseSession("us.anthropic.claude-sonnet-5"));
    expect(usage.cacheWrite1hTokens).toBe(300);
  });
});
