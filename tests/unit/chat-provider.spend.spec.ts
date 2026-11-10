import { afterEach, describe, expect, it, vi } from "vitest";
import * as llm from "@blacksite-agent/llm";
import { ChatProvider, type ExtendedSettings, type ProviderSettings } from "../../src/chat-provider.js";
import type { CompressionProvider } from "../../src/agent-session.js";

// Spend accounting through the real ChatProvider methods, without webviews, stores or runners.
type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens?: number; webSearchRequests?: number; serviceTier?: string; provider?: llm.ProviderName; model?: string };
interface Host {
  _readSettings(): ExtendedSettings;
  _modelCache: Map<string, llm.ModelInfo[]>;
  _secrets: { getApiKey: (provider: string) => Promise<string | undefined>; getBedrockConfig: () => Promise<undefined> };
  _liveTurnId?: string;
  _recordSessionSpend: (turnId: string, cost: unknown) => void;
  estimateSubagentUsageCostUsd(usage: Usage): number | undefined;
  _recordAuxiliaryUsage(provider: llm.ProviderName, model: string, usage: Omit<Usage, "provider" | "model">): void;
  _subagentModel(settings: ExtendedSettings, provider: llm.ProviderName): string;
  _buildCompressionProvider(key: string, settings: ExtendedSettings, main: ProviderSettings): CompressionProvider;
  _session?: { sessionId: string };
  _sessionTokens: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  _recordSessionTokens(usage: Omit<Usage, "provider" | "model">): void;
}

function host(settings: ExtendedSettings): Host & { spend: Array<{ turnId: string; cost: unknown }> } {
  const instance = Object.create(ChatProvider.prototype) as Host & { spend: Array<{ turnId: string; cost: unknown }> };
  instance.spend = [];
  instance._readSettings = () => settings;
  instance._modelCache = new Map();
  instance._sessionTokens = new Map();
  instance._secrets = { getApiKey: async () => "key", getBedrockConfig: async () => undefined };
  instance._recordSessionSpend = (turnId, cost) => { instance.spend.push({ turnId, cost }); };
  return instance;
}

function settings(overrides: Partial<ExtendedSettings> = {}): ExtendedSettings {
  return {
    provider: "anthropic", maxIterations: 10, disabledTools: [],
    providerSettings: {
      anthropic: { model: "claude-opus-5-5" },
      bedrock: { model: "anthropic.claude-sonnet-5-5" },
    },
    ...overrides,
  };
}

const million = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

afterEach(() => vi.restoreAllMocks());

describe("pricing a lane's usage", () => {
  it("prices the model the lane actually ran, not the configured subagent model", () => {
    const chat = host(settings({ subagent: { provider: "anthropic", model: "claude-opus-5-5", profiles: [] } }));
    // The event names Haiku 5.5: 100K input tokens at $0.10 per million, not Opus 5.5's $4.
    const hundredK = { ...million, inputTokens: 100_000 };
    expect(chat.estimateSubagentUsageCostUsd({ ...hundredK, provider: "anthropic", model: "claude-haiku-5-5" })).toBeCloseTo(0.01, 10);
    // Past 100K the whole request moves to Haiku 5.5's long-prompt rate of $0.50.
    expect(chat.estimateSubagentUsageCostUsd({ ...million, provider: "anthropic", model: "claude-haiku-5-5" })).toBeCloseTo(0.5, 10);
  });

  it("falls back to the subagent provider's own model when none is set", () => {
    // An unset subagent model used to resolve to "" for pricing, so lanes billed nothing.
    const chat = host(settings({ subagent: { provider: "bedrock", profiles: [] } }));
    expect(chat._subagentModel(chat._readSettings(), "bedrock")).toBe("anthropic.claude-sonnet-5-5");
    expect(chat.estimateSubagentUsageCostUsd(million)).toBeCloseTo(2, 10);
  });

  it("uses the parent's model for a subagent on the same provider with no model set", () => {
    const chat = host(settings({ subagent: { profiles: [] } }));
    expect(chat._subagentModel(chat._readSettings(), "anthropic")).toBe("claude-opus-5-5");
    expect(chat.estimateSubagentUsageCostUsd(million)).toBeCloseTo(4, 10);
  });
});

describe("calls outside a turn's stream", () => {
  it("records a helper call's spend on the session", () => {
    const chat = host(settings());
    chat._liveTurnId = "turn-1";
    chat._recordAuxiliaryUsage("anthropic", "claude-opus-5-5", { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(chat.spend).toHaveLength(1);
    expect(chat.spend[0]!.turnId).toBe("turn-1");
    expect((chat.spend[0]!.cost as { costUsd: number }).costUsd).toBeCloseTo(0.5 * 4 + 0.1 * 20, 10);
  });

  it("does not bill a ChatGPT subscription call per token", () => {
    const chat = host(settings({ provider: "openai", providerSettings: { openai: { model: "gpt-5.6-sol", authMode: "chatgpt" } } }));
    chat._recordAuxiliaryUsage("openai", "gpt-5.6-sol", { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(chat.spend).toEqual([]);
  });

  it("bills history compaction, which reads the whole transcript", async () => {
    const config = settings({ compression: { enabled: true } });
    const chat = host(config);
    vi.spyOn(llm, "compressHistory").mockImplementation(async (options) => {
      options.onUsage?.({ inputTokens: 200_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return "summary";
    });
    await chat._buildCompressionProvider("key", config, config.providerSettings.anthropic!).compress([]);
    expect(chat.spend).toHaveLength(1);
    expect((chat.spend[0]!.cost as { costUsd: number }).costUsd).toBeCloseTo(0.2 * 4 + 0.004 * 20, 10);
  });
});

describe("what the response says a turn cost", () => {
  const cached = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };

  it("bills cache writes by the TTL the response reports, not the one-hour setting", () => {
    // Bedrock Converse on Sonnet 5.5 through a US profile: $2.50 x 1.1 for five minutes, $4 x 1.1 for an hour.
    const config = settings({ provider: "bedrock", providerSettings: { bedrock: { model: "us.anthropic.claude-sonnet-5-5", cacheTtl: "1h" } } });
    const chat = host(config);
    const lane = { ...cached, provider: "bedrock" as const, model: "us.anthropic.claude-sonnet-5-5" };
    expect(chat.estimateSubagentUsageCostUsd({ ...lane, cacheWrite1hTokens: 0 })).toBeCloseTo(2.75, 10);
    expect(chat.estimateSubagentUsageCostUsd({ ...lane, cacheWrite1hTokens: 1_000_000 })).toBeCloseTo(4.4, 10);
    // No split reported: the setting is all there is to go on.
    expect(chat.estimateSubagentUsageCostUsd(lane)).toBeCloseTo(4.4, 10);
  });

  it("bills fast mode and provider-run searches", () => {
    const chat = host(settings());
    const turn = { ...million, provider: "anthropic" as const, model: "claude-opus-5-5" };
    expect(chat.estimateSubagentUsageCostUsd({ ...turn, serviceTier: "fast" })).toBeCloseTo(8, 10);
    expect(chat.estimateSubagentUsageCostUsd({ ...turn, webSearchRequests: 100 })).toBeCloseTo(5, 10);
  });

  it("prices a model from the live Bedrock listing under the id that was called", () => {
    const chat = host(settings({ provider: "bedrock", providerSettings: { bedrock: { model: "x" } } }));
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    chat._modelCache.set("bedrock", llm.bedrockModelsToModelInfo([{
      id: arn, label: "team profile", providerName: "Anthropic", source: "inference_profile", modalities: ["TEXT"],
      inferenceTypes: ["INFERENCE_PROFILE"], customizationsSupported: [], foundationModelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    }]));
    // An opaque ARN had no price at all; it is now priced as the model it wraps, in-Region.
    expect(chat.estimateSubagentUsageCostUsd({ ...million, provider: "bedrock", model: arn })).toBeCloseTo(3.3, 10);
  });
});

describe("a conversation's token totals", () => {
  it("adds up every call, ignoring a count that is not a number", () => {
    const chat = host(settings());
    chat._session = { sessionId: "s1" };
    chat._recordSessionTokens({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 300 });
    chat._recordSessionTokens({ inputTokens: 50, outputTokens: Number.NaN, cacheReadTokens: 5300, cacheWriteTokens: 0 });
    expect(chat._sessionTokens.get("s1")).toEqual({ input: 150, output: 20, cacheRead: 10_300, cacheWrite: 300 });
  });

  it("keeps each conversation's count apart", () => {
    const chat = host(settings());
    chat._session = { sessionId: "s1" };
    chat._recordSessionTokens({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    chat._session = { sessionId: "s2" };
    chat._recordSessionTokens({ inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(chat._sessionTokens.get("s1")?.input).toBe(1);
    expect(chat._sessionTokens.get("s2")?.input).toBe(7);
  });
});
