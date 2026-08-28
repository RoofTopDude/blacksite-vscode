import { describe, expect, it } from "vitest";
import { capturePauReceipt, pauTraceFormatFor } from "../../src/pau-metrics.js";
import { PauCacheObserver } from "../../src/pau-cache-observer.js";

const ANTHROPIC_TRACE = {
  system: "You are a careful coding agent operating inside a VS Code extension.",
  messages: [
    { role: "user", content: "Please fix the off-by-one bug in src/parser.ts." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look at the file first." },
        { type: "tool_use", id: "t1", name: "file_read", input: { path: "src/parser.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "1: function parse(x) {\n2:   return x[0..len]\n3: }" }],
    },
  ],
};

const TOOL_SCHEMAS = [
  {
    name: "file_read",
    description: "Read a file from the workspace, optionally a line range.".repeat(12),
    input_schema: { type: "object", properties: { path: { type: "string" }, start: { type: "number" } } },
  },
  {
    name: "file_edit",
    description: "Apply an exact string replacement to a file in the workspace.".repeat(12),
    input_schema: { type: "object", properties: { path: { type: "string" }, old: { type: "string" } } },
  },
];

describe("pauTraceFormatFor", () => {
  it("maps anthropic-direct to the anthropic format", () => {
    expect(pauTraceFormatFor("anthropic")).toBe("anthropic");
  });

  it("maps openai and openrouter to the openai format", () => {
    expect(pauTraceFormatFor("openai")).toBe("openai");
    expect(pauTraceFormatFor("openrouter")).toBe("openai");
  });

  it("maps bedrock mantle to anthropic, since it's the Messages API over SigV4", () => {
    expect(pauTraceFormatFor("bedrock", undefined, "mantle")).toBe("anthropic");
  });

  it("has no supported format for bedrock converse — no matching adapter for its ContentBlock shape", () => {
    expect(pauTraceFormatFor("bedrock", undefined, "converse")).toBeNull();
    expect(pauTraceFormatFor("bedrock")).toBeNull();
  });

  it("returns null for an unrecognized provider rather than guessing a shape", () => {
    expect(pauTraceFormatFor("some-future-provider")).toBeNull();
  });
});

describe("capturePauReceipt", () => {
  it("analyzes an Anthropic-shaped trace and reports sane, populated totals", () => {
    const traceInput = {
      system: "You are a careful coding agent operating inside a VS Code extension.",
      messages: [
        { role: "user", content: "Please fix the off-by-one bug in src/parser.ts." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look at the file first." },
            { type: "tool_use", id: "t1", name: "file_read", input: { path: "src/parser.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "1: function parse(x) {\n2:   return x[0..len]\n3: }" },
          ],
        },
        { role: "assistant", content: "Found it — the slice bound is off by one. Fixing now." },
      ],
    };

    const receipt = capturePauReceipt({
      traceInput,
      format: "anthropic",
      runId: "s_test",
      model: "claude-test",
      provider: "anthropic",
      contextWindow: 200_000,
      usage: { input: 150, cacheRead: 100, cacheWrite: 0 },
    });

    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.totalTokens).toBeGreaterThan(0);
    expect(receipt.totalPAU).toBeGreaterThan(0);
    expect(["A", "B", "C", "D"]).toContain(receipt.tokenAccountingGrade);
    expect(receipt.contextHealthScore).toBeGreaterThanOrEqual(0);
    expect(receipt.contextHealthScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(receipt.categories)).toBe(true);
    expect(Array.isArray(receipt.topHogs)).toBe(true);
    // Bounded — a long session's full per-segment array must not ride into the receipt verbatim.
    expect(receipt.topHogs.length).toBeLessThanOrEqual(10);
  });

  it("analyzes an OpenAI-shaped trace (system folded in as the first message)", () => {
    const traceInput = [
      { role: "system", content: "You are a careful coding agent." },
      { role: "user", content: "Summarize this repository's build setup." },
      { role: "assistant", content: "It uses esbuild for the extension host and Vite for the webviews." },
    ];

    const receipt = capturePauReceipt({
      traceInput,
      format: "openai",
      runId: "s_test_openai",
      model: "gpt-test",
      provider: "openai",
      contextWindow: 128_000,
      usage: { input: 60, cacheRead: 0, cacheWrite: 0 },
    });

    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.totalTokens).toBeGreaterThan(0);
  });

  it("counts the wire tool catalog, which no messages trace contains", () => {
    const without = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "claude-test", provider: "anthropic", contextWindow: 200_000,
    });
    const with_ = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "claude-test", provider: "anthropic", contextWindow: 200_000,
      toolSchemas: TOOL_SCHEMAS,
    });
    expect(without.skipped).toBe(false);
    expect(with_.skipped).toBe(false);
    if (without.skipped || with_.skipped) return;
    expect(without.toolSchemaTokens).toBeUndefined();
    expect(with_.toolSchemaTokens).toBeGreaterThan(0);
    expect(with_.totalTokens).toBeGreaterThan(without.totalTokens);
  });

  it("skips the tool segment entirely for an empty catalog rather than adding a hollow one", () => {
    const receipt = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "claude-test", provider: "anthropic", toolSchemas: [],
    });
    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.toolSchemaTokens).toBeUndefined();
  });

  it("prices cache economics for a known provider and reports break-even", () => {
    const receipt = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "claude-test", provider: "anthropic", cacheTtl: "1h",
      usage: { input: 100, cacheRead: 400, cacheWrite: 0 },
      observer: new PauCacheObserver(),
    });
    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.economics?.known).toBe(true);
    expect(receipt.economics?.breakEvenReads).toBeCloseTo(2 / 0.9, 4);
    expect(receipt.cache?.hitRatio).toBeCloseTo(0.8, 5);
  });

  it("reports an unpriced provider as unpriced instead of inventing multipliers", () => {
    const receipt = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "mystery", provider: "openrouter",
      usage: { input: 100, cacheRead: 0, cacheWrite: 0 },
    });
    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.economics?.known).toBe(false);
    expect(receipt.economics?.breakEvenReads).toBeNull();
    expect(receipt.plan?.priced).toBe(false);
  });

  it("attaches an advisory plan whose actions carry cache-adjusted value", () => {
    const receipt = capturePauReceipt({
      traceInput: ANTHROPIC_TRACE, format: "anthropic", runId: "s1",
      model: "claude-test", provider: "anthropic", contextWindow: 200_000,
      usage: { input: 250, cacheRead: 0, cacheWrite: 0 },
      iteration: 4,
    });
    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.plan).toBeDefined();
    expect(receipt.plan!.expectedRemainingTurns).toBe(4);
    for (const action of receipt.plan!.actions) {
      expect(action.cache.priced).toBe(true);
      expect(Number.isFinite(action.cache.netITE)).toBe(true);
    }
  });

  it("degrades to a skipped receipt instead of throwing on malformed input", () => {
    const receipt = capturePauReceipt({
      traceInput: { not: "a valid trace shape at all" },
      format: "anthropic",
      runId: "s_bad",
      model: "claude-test",
      provider: "anthropic",
    });
    expect(receipt.skipped).toBe(true);
    if (!receipt.skipped) return;
    expect(receipt.reason).toContain("analysis-failed");
  });
});
