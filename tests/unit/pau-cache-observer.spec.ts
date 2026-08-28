import { describe, expect, it } from "vitest";
import { PauCacheObserver } from "../../src/pau-cache-observer.js";

const seg = (content: string, tokens: number) => ({ content, tokens });
const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input, cacheRead, cacheWrite });

describe("PauCacheObserver", () => {
  it("has no prefix opinion on the first turn — there is nothing to compare against", () => {
    const observer = new PauCacheObserver();
    const observation = observer.observe([seg("system", 100), seg("a", 50)], usage(150, 0, 150));
    expect(observation.stablePrefixTokens).toBeNull();
    expect(observation.stablePrefixRatio).toBeNull();
    expect(observation.invalidatedTokens).toBe(0);
  });

  it("reports a fully stable prefix when the head is unchanged and the tail grows", () => {
    const observer = new PauCacheObserver();
    observer.observe([seg("system", 100), seg("a", 50)], usage(150, 0, 150));
    const second = observer.observe(
      [seg("system", 100), seg("a", 50), seg("b", 25)],
      usage(25, 150, 0),
    );
    expect(second.stablePrefixTokens).toBe(150);
    expect(second.invalidatedTokens).toBe(0);
    expect(second.hitRatio).toBeCloseTo(150 / 175, 5);
  });

  it("collapses to zero when the head is rewritten — what a compaction looks like from here", () => {
    const observer = new PauCacheObserver();
    observer.observe([seg("system", 100), seg("a", 50), seg("b", 50)], usage(200, 0, 200));
    const second = observer.observe([seg("summary", 40), seg("b", 50)], usage(90, 0, 90));
    expect(second.stablePrefixTokens).toBe(0);
    expect(second.invalidatedTokens).toBe(200);
    expect(second.cumulativeInvalidatedTokens).toBe(200);
  });

  it("counts only the shortfall as invalidated, not tail growth", () => {
    const observer = new PauCacheObserver();
    observer.observe([seg("system", 100), seg("a", 50)], usage(150, 0, 150));
    const second = observer.observe([seg("system", 100), seg("changed", 500)], usage(600, 100, 500));
    expect(second.stablePrefixTokens).toBe(100);
    expect(second.invalidatedTokens).toBe(50);
  });

  it("accumulates reads per write across the session, for the break-even test", () => {
    const observer = new PauCacheObserver();
    observer.observe([seg("system", 100)], usage(0, 0, 100));
    expect(observer.observe([seg("system", 100)], usage(0, 100, 0)).readsPerWrite).toBeCloseTo(1, 5);
    expect(observer.observe([seg("system", 100)], usage(0, 100, 0)).readsPerWrite).toBeCloseTo(2, 5);
  });

  it("reports no reads-per-write until something has actually been written", () => {
    const observer = new PauCacheObserver();
    expect(observer.observe([seg("system", 100)], usage(100, 0, 0)).readsPerWrite).toBeNull();
  });

  it("exposes the warm prefix so evictions can be charged against it", () => {
    const observer = new PauCacheObserver();
    observer.observe([seg("system", 100), seg("a", 50)], usage(150, 0, 150));
    expect(observer.warmPrefixTokens).toBe(150);
  });
});
