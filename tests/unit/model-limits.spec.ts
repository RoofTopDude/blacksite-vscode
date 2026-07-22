/**
 * Context windows and output ceilings.
 *
 * Both were previously wrong in the expensive direction. The context window fell back to a flat
 * 200K for every Claude id, so Opus 4.8 — a 1M-window model — was compacted at roughly 12% of its
 * real capacity, shedding history it had ample room for. The output ceiling was known only for
 * Bedrock, so an "Unlimited" run on the Anthropic path could request 200K and take a hard 400.
 */
import { describe, expect, it } from "vitest";
import { resolveClaudeLimits, resolveContextWindow, resolveOutputCeiling, isOpenAIReasoningModel } from "../../src/model-limits.js";
import { getContextLength } from "../../src/model-fetcher.js";

describe("context windows", () => {
  it("gives the current Claude family its real 1M window", () => {
    for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5"]) {
      expect(resolveContextWindow(id), id).toBe(1_000_000);
    }
  });

  it("keeps Haiku 4.5 and the older family at 200K", () => {
    expect(resolveContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(resolveContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(resolveContextWindow("claude-3-7-sonnet-20250219")).toBe(200_000);
  });

  it("resolves across every provider's spelling of the same model", () => {
    for (const id of [
      "anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-4-8-v1:0",
      "anthropic/claude-opus-4.8",
    ]) {
      expect(resolveContextWindow(id), id).toBe(1_000_000);
    }
  });

  it("returns undefined for non-Claude models rather than guessing", () => {
    expect(resolveContextWindow("gpt-5.2")).toBeUndefined();
    expect(resolveContextWindow("amazon.nova-pro-v1:0")).toBeUndefined();
  });

  /** getContextLength is what the compaction trigger divides by — the flat 200K fallback there was
   *  the actual source of the premature-compaction bug. */
  it("flows through getContextLength for a live-listed Bedrock id", () => {
    expect(getContextLength("bedrock", "us.anthropic.claude-opus-4-8-v1:0")).toBe(1_000_000);
    expect(getContextLength("anthropic", "claude-opus-4-8")).toBe(1_000_000);
    expect(getContextLength("anthropic", "claude-haiku-4-5")).toBe(200_000);
  });

  it("leaves non-Claude context resolution alone", () => {
    expect(getContextLength("openrouter", "google/gemini-2.5-pro")).toBe(1_048_576);
  });
});

describe("output ceilings", () => {
  it("knows the 128K output cap on the current Claude family", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5"]) {
      expect(resolveOutputCeiling(id, "anthropic"), id).toBe(128_000);
    }
  });

  it("knows Haiku 4.5's lower 64K cap", () => {
    expect(resolveOutputCeiling("claude-haiku-4-5", "anthropic")).toBe(64_000);
  });

  /** Bedrock rejects any Claude max_tokens above 64000 regardless of the model's first-party cap —
   *  an observed platform limit applied on top of the model's own. */
  it("applies Bedrock's platform cap on top of the model's limit", () => {
    expect(resolveOutputCeiling("anthropic.claude-opus-4-8", "bedrock")).toBe(64_000);
    expect(resolveOutputCeiling("us.anthropic.claude-sonnet-4-6-v1:0", "bedrock")).toBe(64_000);
  });

  /** The scenario that 400s today: "Unlimited" max tokens escalates toward 200K, which no Claude
   *  model accepts. The clamp has to bite on the Anthropic path too, not just Bedrock. */
  it("clamps an unlimited-mode request down to the model's real cap", () => {
    expect(Math.min(200_000, resolveOutputCeiling("claude-opus-4-8", "anthropic")!)).toBe(128_000);
  });

  it("resolves documented OpenAI family ceilings when /v1/models omits them", () => {
    expect(resolveOutputCeiling("gpt-5.2", "openai")).toBe(128_000);
    expect(resolveOutputCeiling("gpt-4.1", "openai")).toBe(32_768);
    expect(resolveOutputCeiling("gpt-4o", "openai")).toBe(16_384);
    expect(resolveOutputCeiling("o3", "openai")).toBe(100_000);
    expect(resolveOutputCeiling("o1-mini", "openai")).toBe(65_536);
  });

  it("keeps genuinely unknown families explicit", () => {
    expect(resolveOutputCeiling("vendor/future-model", "openrouter")).toBeNull();
  });
});

describe("resolveClaudeLimits", () => {
  it("keeps the window and the output cap consistent for one model", () => {
    expect(resolveClaudeLimits("claude-opus-4-8")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(resolveClaudeLimits("claude-haiku-4-5")).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000 });
  });

  it("assumes the current family's limits for a model newer than the table", () => {
    expect(resolveClaudeLimits("claude-opus-5")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  });
});

/** Shared by agent-session.ts's main turn path and compressor.ts's background summarizer —
 *  a single source of truth is what keeps them from silently diverging (compressor.ts used to
 *  hardcode max_tokens unconditionally, 400ing on exactly the models covered here). */
describe("isOpenAIReasoningModel", () => {
  it("recognizes o-series reasoning models", () => {
    for (const id of ["o1", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
      expect(isOpenAIReasoningModel(id), id).toBe(true);
    }
  });

  it("recognizes gpt-5 and later as reasoning-native", () => {
    for (const id of ["gpt-5", "gpt-5.2", "gpt-5.6-luna", "gpt-6"]) {
      expect(isOpenAIReasoningModel(id), id).toBe(true);
    }
  });

  it("does not flag pre-5 chat models", () => {
    for (const id of ["gpt-4o", "gpt-4-turbo", "gpt-4o-mini", "gpt-3.5-turbo"]) {
      expect(isOpenAIReasoningModel(id), id).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isOpenAIReasoningModel("GPT-5.2")).toBe(true);
  });
});
