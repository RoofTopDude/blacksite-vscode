import { describe, expect, it } from "vitest";
import {
  estimateUsageCostUsd, getContextLength, getModelPricing,
  mapAnthropicModelEntry, normalizeModelIdForFallbackLookup,
} from "../../src/model-fetcher.js";

describe("getContextLength", () => {
  it("resolves a known Bedrock cross-region inference-profile model id from the fallback table", () => {
    expect(getContextLength("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(200000);
  });

  it("defaults custom Bedrock inference-profile ARNs to 200k instead of undefined", () => {
    // Application inference-profile ARNs carry an opaque id, not a model name, so the
    // "claude" substring heuristic can't match them — this was silently disabling the
    // auto-compression trigger, which gates on contextLength being truthy.
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    expect(getContextLength("bedrock", arn)).toBe(200000);
  });

  it("still returns undefined for an unrecognized non-Bedrock model id", () => {
    expect(getContextLength("openai", "some-unknown-model")).toBeUndefined();
  });

  it("resolves the gpt-4.1 family to its 1M window instead of the legacy gpt-4 8K default", () => {
    // The bare "gpt-4" substring rule matched gpt-4.1 first, reporting 8K for a 1M-window
    // model — compaction would have fired at ~0.5% of real capacity.
    expect(getContextLength("openai", "gpt-4.1")).toBe(1047576);
    expect(getContextLength("openrouter", "openai/gpt-4.1-mini")).toBe(1047576);
    expect(getContextLength("openai", "gpt-4")).toBe(8192);
  });

  it("resolves gpt-5.x context from the meta table / heuristic", () => {
    expect(getContextLength("openai", "gpt-5.1")).toBe(400000);
    expect(getContextLength("openai", "gpt-5.6")).toBe(400000); // heuristic — no meta entry yet
  });
});

describe("getModelPricing", () => {
  it("resolves known OpenRouter model pricing from the fallback table", () => {
    const pricing = getModelPricing("openrouter", "anthropic/claude-sonnet-5");
    expect(pricing?.inputPricePerM).toBe(3);
    expect(pricing?.outputPricePerM).toBe(15);
  });

  it("resolves OpenAI pricing from the hardcoded meta table", () => {
    const pricing = getModelPricing("openai", "gpt-4o-mini");
    expect(pricing?.inputPricePerM).toBe(0.15);
    expect(pricing?.outputPricePerM).toBe(0.60);
  });

  it("prices the gpt-5.x generation and carries o3's June-2025 reprice", () => {
    expect(getModelPricing("openai", "gpt-5.1")?.inputPricePerM).toBe(1.25);
    expect(getModelPricing("openai", "gpt-5.1")?.outputPricePerM).toBe(10);
    expect(getModelPricing("openai", "o3")?.inputPricePerM).toBe(2);
    expect(getModelPricing("openai", "o3")?.outputPricePerM).toBe(8);
  });

  it("prices known Bedrock cross-region inference-profile models from the fallback table", () => {
    // Bedrock pricing mirrors Anthropic's own published rates — no separate Bedrock markup.
    const pricing = getModelPricing("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(pricing?.inputPricePerM).toBe(3);
    expect(pricing?.outputPricePerM).toBe(15);
  });

  it("prices Bedrock Mantle model ids (anthropic.claude-*, no dated snapshot)", () => {
    const pricing = getModelPricing("bedrock", "anthropic.claude-opus-4-8");
    expect(pricing?.inputPricePerM).toBe(5);
    expect(pricing?.outputPricePerM).toBe(25);
  });

  it("returns undefined for a genuinely unpriceable Bedrock id (opaque inference-profile ARN)", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    expect(getModelPricing("bedrock", arn)).toBeUndefined();
  });

  it("returns undefined for an unrecognized model id", () => {
    expect(getModelPricing("openrouter", "some/unknown-model")).toBeUndefined();
  });

  it("fuzzy-matches a dated-snapshot or provider-prefixed id the fallback table doesn't have verbatim", () => {
    // Same Claude model, id decorated the way OpenRouter/a future Bedrock date stamp would send it —
    // the exact-match lookup misses, but the normalized core ("claude-sonnet-5") still resolves.
    const pricing = getModelPricing("openrouter", "anthropic/claude-sonnet-5:20260601");
    expect(pricing?.inputPricePerM).toBe(3);
    expect(pricing?.outputPricePerM).toBe(15);
  });

  it("prefers the more specific fallback sibling over a shorter unrelated model that's merely a string-prefix", () => {
    // "gpt-4o" sorts before "gpt-4o-mini" in the fallback table; a naive first-match fuzzy
    // lookup on "gpt-4o-mini-2024-07-18" (an exact-meta miss) picked "gpt-4o" and overpriced
    // gpt-4o-mini by ~16x. The dash-dated suffix must also normalize away so this exact-matches
    // "gpt-4o-mini" rather than merely resolving via prefix specificity.
    const mini = getModelPricing("openai", "gpt-4o-mini-2024-07-18");
    expect(mini?.inputPricePerM).toBe(0.15);
    expect(mini?.outputPricePerM).toBe(0.60);

    // Same collision shape for o3 vs o3-mini.
    const o3mini = getModelPricing("openai", "o3-mini-2025-01-31");
    expect(o3mini?.inputPricePerM).toBe(1.1);
    expect(o3mini?.outputPricePerM).toBe(4.4);
  });
});

describe("normalizeModelIdForFallbackLookup", () => {
  it("strips the Bedrock Mantle provider-namespace prefix", () => {
    expect(normalizeModelIdForFallbackLookup("anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("strips the OpenRouter provider path and a dated-snapshot/version suffix", () => {
    expect(normalizeModelIdForFallbackLookup("anthropic/claude-sonnet-5:20260601")).toBe("claude-sonnet-5");
    expect(normalizeModelIdForFallbackLookup("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
  });

  it("preserves a decimal version dot instead of truncating at it — the regression this fix targets", () => {
    // A naive "strip everything before the last dot" rule (mistakenly modeled on the Bedrock
    // Mantle "anthropic.claude-x" prefix) would mangle these into "5-pro" and "1" respectively.
    expect(normalizeModelIdForFallbackLookup("google/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeModelIdForFallbackLookup("gpt-4.1")).toBe("gpt-4.1");
  });

  it("strips an OpenAI-style dash-dated snapshot suffix (YYYY-MM-DD), not just the compact 8-digit form", () => {
    expect(normalizeModelIdForFallbackLookup("gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
    expect(normalizeModelIdForFallbackLookup("o3-mini-2025-01-31")).toBe("o3-mini");
  });
});

describe("mapAnthropicModelEntry (Models API capability consumption)", () => {
  it("reads context window, output cap, and vision/thinking capabilities from a live response", () => {
    const info = mapAnthropicModelEntry({
      id: "claude-opus-4-8",
      display_name: "Claude Opus 4.8",
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: { image_input: { supported: true }, thinking: { supported: true } },
    });
    expect(info.contextLength).toBe(1_000_000);
    expect(info.maxOutputTokens).toBe(128_000);
    expect(info.supportsVision).toBe(true);
    expect(info.supportsThinking).toBe(true);
  });

  it("falls back to the id-based heuristics when capabilities is absent (older API response)", () => {
    const info = mapAnthropicModelEntry({ id: "claude-opus-4-8" });
    expect(info.supportsVision).toBe(true); // default-true fallback
    expect(info.supportsThinking).toBe(true); // id-based heuristic still recognizes this model
    expect(info.contextLength).toBe(1_000_000); // resolveContextWindow fallback
    expect(info.maxOutputTokens).toBeUndefined();
  });

  it("a live vision:false does not get overridden back to true", () => {
    const info = mapAnthropicModelEntry({
      id: "claude-haiku-4-5",
      capabilities: { image_input: { supported: false } },
    });
    expect(info.supportsVision).toBe(false);
  });

  it("a live thinking:true is honored even for a model the id heuristic doesn't recognize", () => {
    // OR, not AND: the live capability must be able to ADD support the id table doesn't know
    // about (some future model family), without a false id match ever being able to remove it.
    const info = mapAnthropicModelEntry({
      id: "some-future-model-id",
      capabilities: { thinking: { supported: true } },
    });
    expect(info.supportsThinking).toBe(true);
  });
});

describe("estimateUsageCostUsd", () => {
  it("returns undefined when the model has no known pricing at all", () => {
    expect(estimateUsageCostUsd(undefined, { input: 1000, output: 500 })).toBeUndefined();
    expect(estimateUsageCostUsd({}, { input: 1000, output: 500 })).toBeUndefined();
  });

  it("computes input + output cost precisely from per-million pricing", () => {
    const pricing = { inputPricePerM: 3, outputPricePerM: 15 };
    // 1000 input tokens @ $3/M + 500 output tokens @ $15/M = $0.003 + $0.0075
    const cost = estimateUsageCostUsd(pricing, { input: 1000, output: 500 });
    expect(cost?.costUsd).toBeCloseTo(0.0105, 6);
    expect(cost?.partial).toBe(false);
  });

  it("includes cache read/write cost when priced, without inflating the estimate when unpriced", () => {
    const pricing = { inputPricePerM: 3, outputPricePerM: 15, cacheReadPricePerM: 0.3, cacheWritePricePerM: 3.75 };
    const cost = estimateUsageCostUsd(pricing, { input: 100, output: 0, cacheRead: 10_000, cacheWrite: 1000 });
    // 100 input @ $3/M + 10,000 cache-read @ $0.30/M + 1,000 cache-write @ $3.75/M
    expect(cost?.costUsd).toBeCloseTo(0.0003 + 0.003 + 0.00375, 8);
    expect(cost?.partial).toBe(false);
  });

  it("marks the estimate partial (a lower bound) when a billed category has no known price", () => {
    // Input/output are priced but cache pricing is unknown — cache tokens must not be priced
    // using the input rate (that would inflate the estimate), just flagged as uncounted.
    const pricing = { inputPricePerM: 3, outputPricePerM: 15 };
    const cost = estimateUsageCostUsd(pricing, { input: 100, output: 0, cacheRead: 50_000 });
    expect(cost?.costUsd).toBeCloseTo(0.0003, 8);
    expect(cost?.partial).toBe(true);
  });

  it("does not mark partial when an unpriced category simply had zero tokens", () => {
    const pricing = { inputPricePerM: 3, outputPricePerM: 15 };
    const cost = estimateUsageCostUsd(pricing, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(cost?.partial).toBe(false);
  });
});
