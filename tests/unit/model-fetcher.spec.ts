import { describe, expect, it } from "vitest";
import {
  estimateUsageCostUsd, getContextLength, getMaxOutputTokens, getModelPricing,
  mapAnthropicModelEntry, mapOpenRouterModelEntry, normalizeModelIdForFallbackLookup,
  SONNET_5_INTRO_PRICING_ENDS, sonnet5Pricing,
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
    expect(getContextLength("openai", "gpt-5")).toBe(400000);
  });

  it("gives the gpt-5.6 family its 1.05M window rather than the 400K figure from the 5.x line", () => {
    // Inheriting the earlier 5.x window would trip auto-compaction at ~38% of real capacity.
    expect(getContextLength("openai", "gpt-5.6")).toBe(1050000);       // meta table
    expect(getContextLength("openai", "gpt-5.6-sol")).toBe(1050000);
    expect(getContextLength("openai", "gpt-5.6-terra")).toBe(1050000);
    expect(getContextLength("openai", "gpt-5.6-luna")).toBe(1050000);
    expect(getContextLength("openai", "gpt-5.7-unreleased")).toBe(1050000); // heuristic
  });
});

describe("output-cap detection", () => {
  it("uses OpenRouter's live top-provider completion cap for unknown and known model families", () => {
    expect(mapOpenRouterModelEntry({
      id: "vendor/future-model",
      top_provider: { max_completion_tokens: 91_234 },
    }).maxOutputTokens).toBe(91_234);
    expect(mapOpenRouterModelEntry({
      id: "openai/gpt-5",
      top_provider: { max_completion_tokens: 120_000 },
    }).maxOutputTokens).toBe(120_000);
  });

  it("falls back to family metadata when a provider catalog omits the cap", () => {
    expect(mapOpenRouterModelEntry({ id: "openai/gpt-5" }).maxOutputTokens).toBe(128_000);
    expect(getMaxOutputTokens("openai", "gpt-4o-2024-11-20")).toBe(16_384);
    expect(getMaxOutputTokens("openrouter", "vendor/unknown")).toBeUndefined();
  });
});

describe("getModelPricing", () => {
  it("resolves known OpenRouter model pricing from the fallback table", () => {
    const pricing = getModelPricing("openrouter", "anthropic/claude-opus-4.8");
    expect(pricing?.inputPricePerM).toBe(5);
    expect(pricing?.outputPricePerM).toBe(25);
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
    // the exact-match lookup misses, but the normalized core ("claude-opus-4-8") still resolves.
    const pricing = getModelPricing("openrouter", "anthropic/claude-opus-4.8:20260601");
    expect(pricing?.inputPricePerM).toBe(5);
    expect(pricing?.outputPricePerM).toBe(25);
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

  it("scales every billed category by the processing tier that served the request", () => {
    // Pricing tables quote standard-tier rates. OpenAI bills flex at the Batch rate (half) and
    // Fast mode at double, so a flex turn costed at the sticker price is a 2x over-report —
    // which is exactly what happened before the tier was taken into account at all.
    const pricing = { inputPricePerM: 5, outputPricePerM: 30, cacheReadPricePerM: 0.5, cacheWritePricePerM: 6.25 };
    const tokens = { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 };
    const standard = estimateUsageCostUsd(pricing, tokens)!.costUsd;

    expect(estimateUsageCostUsd(pricing, { ...tokens, serviceTier: "flex" })!.costUsd).toBeCloseTo(standard * 0.5, 10);
    expect(estimateUsageCostUsd(pricing, { ...tokens, serviceTier: "fast" })!.costUsd).toBeCloseTo(standard * 2, 10);
    // "priority" is OpenAI's former name for Fast mode and still routes there — same multiplier.
    expect(estimateUsageCostUsd(pricing, { ...tokens, serviceTier: "priority" })!.costUsd).toBeCloseTo(standard * 2, 10);
    // Tiers that bill at the quoted rate, plus an unknown tier failing open to standard.
    for (const tier of ["default", "auto", "scale", "something-new", undefined]) {
      expect(estimateUsageCostUsd(pricing, { ...tokens, serviceTier: tier })!.costUsd).toBeCloseTo(standard, 10);
    }
  });
});

describe("Claude cache pricing", () => {
  it("prices cache reads and writes for every Claude model instead of dropping them", () => {
    // These columns were absent entirely, and estimateUsageCostUsd excludes any category it
    // cannot price. The Anthropic path places cache breakpoints deliberately, so most of its
    // prompt is served from cache — meaning the reported figure was a fraction of the invoice.
    for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-fable-5", "claude-haiku-4-5"]) {
      const p = getModelPricing("anthropic", id)!;
      expect(p.cacheReadPricePerM, id).toBeCloseTo(p.inputPricePerM! * 0.1, 10);
      expect(p.cacheWritePricePerM, id).toBeCloseTo(p.inputPricePerM! * 1.25, 10);
    }
  });

  it("derives the same rates for Bedrock Mantle ids, which bill at first-party rates", () => {
    const p = getModelPricing("bedrock", "anthropic.claude-opus-5")!;
    expect(p).toMatchObject({ inputPricePerM: 5, outputPricePerM: 25 });
    expect(p.cacheReadPricePerM).toBeCloseTo(0.5, 10);
    expect(p.cacheWritePricePerM).toBeCloseTo(6.25, 10);
  });

  it("charges the 1-hour breakpoint TTL at 2x input rather than the quoted 1.25x", () => {
    const pricing = getModelPricing("anthropic", "claude-opus-5");
    const tokens = { cacheWrite: 1_000_000 };
    // Catalog rates are the 5m figure; the 1h breakpoint buys a longer-lived entry at a higher
    // write premium, and billing the quoted rate under-reports it by 37.5%.
    expect(estimateUsageCostUsd(pricing, { ...tokens, cacheTtl: "5m" })!.costUsd).toBeCloseTo(6.25, 8);
    expect(estimateUsageCostUsd(pricing, { ...tokens, cacheTtl: "1h" })!.costUsd).toBeCloseTo(10, 8);
    expect(estimateUsageCostUsd(pricing, tokens)!.costUsd).toBeCloseTo(6.25, 8); // omitted → 5m
  });
});

describe("Claude Sonnet 5 introductory pricing", () => {
  it("quotes the introductory rate up to the cutover and the standard rate after", () => {
    // Pinned to both sides of the boundary rather than "whatever today is": a single hardcoded
    // figure is wrong half the time — 50% over-reported before the cutover, under-reported after.
    const before = sonnet5Pricing(SONNET_5_INTRO_PRICING_ENDS - 1);
    expect(before).toMatchObject({ inputPricePerM: 2, outputPricePerM: 10 });
    expect(before.cacheReadPricePerM).toBeCloseTo(0.2, 10);

    const after = sonnet5Pricing(SONNET_5_INTRO_PRICING_ENDS + 1);
    expect(after).toMatchObject({ inputPricePerM: 3, outputPricePerM: 15 });
    expect(after.cacheReadPricePerM).toBeCloseTo(0.3, 10);
  });

  it("re-resolves on every getModelPricing call rather than freezing at module load", () => {
    // The catalog is built once at import; a host process still running when the window closes
    // would otherwise quote the introductory rate for the rest of its life.
    for (const [provider, id] of [["anthropic", "claude-sonnet-5"], ["openrouter", "anthropic/claude-sonnet-5"]] as const) {
      expect(getModelPricing(provider, id), id).toEqual(sonnet5Pricing());
    }
  });
});

describe("OpenAI cache pricing", () => {
  it("prices cache reads and writes for the GPT-5.6 family instead of dropping them", () => {
    // Cache pricing used to be absent from the OpenAI table entirely, so every cache token fell
    // into estimateUsageCostUsd's unpriced branch: silently excluded from the cost and the whole
    // estimate flagged partial. On a long agent run the cache carries most of the prompt, so the
    // reported spend was a small fraction of the real invoice.
    const sol = getModelPricing("openai", "gpt-5.6-sol");
    expect(sol).toMatchObject({
      inputPricePerM: 5, outputPricePerM: 30, cacheReadPricePerM: 0.5, cacheWritePricePerM: 6.25,
    });
    expect(getModelPricing("openai", "gpt-5.6-terra")).toMatchObject({
      inputPricePerM: 2, outputPricePerM: 12, cacheReadPricePerM: 0.2, cacheWritePricePerM: 2.5,
    });
    expect(getModelPricing("openai", "gpt-5.6-luna")).toMatchObject({
      inputPricePerM: 0.2, outputPricePerM: 1.2, cacheReadPricePerM: 0.02, cacheWritePricePerM: 0.25,
    });
    // The bare alias routes to Sol.
    expect(getModelPricing("openai", "gpt-5.6")).toMatchObject({ inputPricePerM: 5, outputPricePerM: 30 });
  });

  it("charges 1.25x input for GPT-5.6 cache writes and nothing for earlier families", () => {
    // The 5.6 generation is the first to bill cache writes at all; before it they were free.
    // Encoding that as 0 rather than undefined keeps those estimates exact instead of partial.
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const p = getModelPricing("openai", id)!;
      expect(p.cacheWritePricePerM).toBeCloseTo(p.inputPricePerM! * 1.25, 10);
    }
    for (const id of ["gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o3"]) {
      expect(getModelPricing("openai", id)?.cacheWritePricePerM).toBe(0);
    }
  });

  it("produces an exact (non-partial) estimate for a cache-heavy OpenAI turn", () => {
    const cost = estimateUsageCostUsd(getModelPricing("openai", "gpt-5.6-sol"), {
      input: 2_000, output: 1_000, cacheRead: 100_000, cacheWrite: 8_000,
    });
    // 2k @ $5/M + 1k @ $30/M + 100k @ $0.50/M + 8k @ $6.25/M
    expect(cost?.costUsd).toBeCloseTo(0.01 + 0.03 + 0.05 + 0.05, 8);
    expect(cost?.partial).toBe(false);
  });
});
