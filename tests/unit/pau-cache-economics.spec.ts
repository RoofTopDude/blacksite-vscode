import { describe, expect, it } from "vitest";
import {
  blastRadiusTokens,
  breakEvenReads,
  cacheAdjustedNetValue,
  cacheEconomicsFor,
} from "../../src/pau-cache-economics.js";

describe("cacheEconomicsFor", () => {
  it("uses Anthropic's 5m ratios by default", () => {
    const econ = cacheEconomicsFor("anthropic", "5m");
    expect(econ.known).toBe(true);
    expect(econ.readMultiplier).toBeCloseTo(0.1, 5);
    expect(econ.writeMultiplier).toBeCloseTo(1.25, 5);
    expect(econ.ttlSeconds).toBe(300);
  });

  it("charges the higher write premium for the 1h TTL", () => {
    expect(cacheEconomicsFor("anthropic", "1h").writeMultiplier).toBeCloseTo(2, 5);
    expect(cacheEconomicsFor("anthropic", "1h").ttlSeconds).toBe(3600);
  });

  it("treats Bedrock as Anthropic — Mantle is the Messages API over SigV4", () => {
    expect(cacheEconomicsFor("bedrock", "5m").writeMultiplier).toBeCloseTo(1.25, 5);
  });

  it("derives multipliers from catalog rates when the row quotes them", () => {
    const econ = cacheEconomicsFor("openrouter", "5m", {
      inputPricePerM: 4,
      outputPricePerM: 20,
      cacheReadPricePerM: 0.8,
      cacheWritePricePerM: 6,
    });
    expect(econ.known).toBe(true);
    expect(econ.readMultiplier).toBeCloseTo(0.2, 5);
    expect(econ.writeMultiplier).toBeCloseTo(1.5, 5);
    expect(econ.basis).toBe("catalog rates");
  });

  it("reports unpriced rather than guessing for an unknown provider with no rates", () => {
    const econ = cacheEconomicsFor("openrouter", "5m");
    expect(econ.known).toBe(false);
    expect(econ.basis).toBe("unpriced");
  });

  it("keeps a storage-rent field even where it is always zero, so Gemini-style caches are expressible", () => {
    expect(cacheEconomicsFor("anthropic", "5m").storagePerTokenHour).toBe(0);
  });
});

describe("breakEvenReads", () => {
  it("needs ~1.4 reads to repay a 5m write premium", () => {
    expect(breakEvenReads(cacheEconomicsFor("anthropic", "5m"))!).toBeCloseTo(1.25 / 0.9, 4);
  });

  it("needs ~2.2 reads at the 1h TTL — the empirical case for or against the default", () => {
    expect(breakEvenReads(cacheEconomicsFor("anthropic", "1h"))!).toBeCloseTo(2 / 0.9, 4);
  });

  it("is null when the session is unpriced", () => {
    expect(breakEvenReads(cacheEconomicsFor("openrouter", "5m"))).toBeNull();
  });
});

describe("blastRadiusTokens", () => {
  const segments = [100, 200, 300, 400];

  it("charges an early eviction for the whole warm tail behind it", () => {
    expect(blastRadiusTokens(segments, 0, 1000)).toBe(900);
  });

  it("charges a later eviction for far less, at identical segment size", () => {
    expect(blastRadiusTokens(segments, 1, 500)).toBe(200);
  });

  it("charges nothing once the segment sits beyond the warm prefix", () => {
    expect(blastRadiusTokens(segments, 2, 500)).toBe(0);
  });

  it("charges nothing when no prefix is warm at all", () => {
    expect(blastRadiusTokens(segments, 0, 0)).toBe(0);
  });
});

describe("cacheAdjustedNetValue", () => {
  const econ = cacheEconomicsFor("anthropic", "5m");

  it("finds a large segment in a warm prefix to be net-negative — ballast, not a hog", () => {
    // 20k tokens, but removing it rewrites 300k of warm prefix.
    const value = cacheAdjustedNetValue(20_000, 300_000, 5, econ);
    expect(value.netITE).toBeLessThan(0);
    expect(value.priced).toBe(true);
  });

  it("finds the same segment worth removing when nothing is cached behind it", () => {
    expect(cacheAdjustedNetValue(20_000, 0, 5, econ).netITE).toBeGreaterThan(0);
  });

  it("converts to USD only when a base rate is known", () => {
    expect(cacheAdjustedNetValue(1000, 0, 4, econ).netUsd).toBeUndefined();
    expect(cacheAdjustedNetValue(1000, 0, 4, econ, 5).netUsd).toBeCloseTo((1000 * 0.1 * 4 / 1_000_000) * 5, 9);
  });

  it("marks unpriced results so callers cannot mistake them for a verdict", () => {
    expect(cacheAdjustedNetValue(1000, 0, 4, cacheEconomicsFor("openrouter", "5m")).priced).toBe(false);
  });
});
