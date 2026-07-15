import { describe, expect, it } from "vitest";
import { estimateUsageCostUsd, getContextLength, getModelPricing } from "../../src/model-fetcher.js";

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

  it("returns undefined for a provider/model with no known pricing (e.g. Bedrock)", () => {
    expect(getModelPricing("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBeUndefined();
  });

  it("returns undefined for an unrecognized model id", () => {
    expect(getModelPricing("openrouter", "some/unknown-model")).toBeUndefined();
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
