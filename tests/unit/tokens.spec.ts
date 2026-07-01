import { describe, expect, it } from "vitest";
import {
  estimateTokens, emptyUsage, usagePromptTotal, usageTotal,
} from "../../src/webview/react/lib/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is roughly in the right ballpark for short English", () => {
    // cl100k tokenizes "hello world" as 2 tokens.
    const t = estimateTokens("hello world");
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(4);
  });

  it("scales monotonically with length", () => {
    const short = estimateTokens("one two three");
    const long = estimateTokens("one two three ".repeat(50));
    expect(long).toBeGreaterThan(short);
  });

  it("counts code punctuation as atoms", () => {
    expect(estimateTokens("const x = foo(bar);")).toBeGreaterThan(4);
  });
});

describe("usage totals", () => {
  it("sums every channel for the grand total", () => {
    const u = { input: 100, output: 40, cacheRead: 10, cacheWrite: 5 };
    expect(usageTotal(u)).toBe(155);
  });

  it("prompt total excludes generated output", () => {
    const u = { input: 100, output: 40, cacheRead: 10, cacheWrite: 5 };
    expect(usagePromptTotal(u)).toBe(115);
  });

  it("emptyUsage is all zeroes", () => {
    expect(usageTotal(emptyUsage())).toBe(0);
  });
});
