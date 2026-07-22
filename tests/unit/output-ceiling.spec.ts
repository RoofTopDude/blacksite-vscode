import { describe, expect, it } from "vitest";
import { resolveOutputCeiling } from "../../src/agent-session.js";

// Regression guard for the execution-log failure:
//   "Bedrock 400: The maximum tokens you requested exceeds the model limit of 64000"
// triggered by the output-escalation path requesting MAX_ESCALATED_OUTPUT_TOKENS (65536).
describe("resolveOutputCeiling", () => {
  it("caps Bedrock Claude output at 64000", () => {
    expect(resolveOutputCeiling("us.anthropic.claude-opus-4-8", "bedrock")).toBe(64_000);
    expect(resolveOutputCeiling("us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock")).toBe(64_000);
  });

  /**
   * This used to assert `null` for every non-Bedrock provider — i.e. "we don't know any other
   * model's cap, so never clamp". That left the Anthropic path unguarded: with Unlimited max
   * tokens the escalation ladder climbs toward 200000, which no Claude model accepts. The real
   * caps are now known (see model-limits.ts), so they are enforced everywhere rather than only
   * where a 400 had already been observed in production.
   */
  it("clamps the Anthropic path to the model's real output cap", () => {
    expect(resolveOutputCeiling("claude-opus-4-8", "anthropic")).toBe(128_000);
    expect(resolveOutputCeiling("claude-haiku-4-5", "anthropic")).toBe(64_000);
  });

  it("resolves providers whose catalog omits output metadata from model-family limits", () => {
    expect(resolveOutputCeiling("gpt-5", "openai")).toBe(128_000);
    expect(resolveOutputCeiling("openai/gpt-4.1-mini", "openrouter")).toBe(32_768);
  });

  it("prefers a live catalog cap while retaining Bedrock's platform guard", () => {
    expect(resolveOutputCeiling("vendor/future-model", "openrouter", 96_000)).toBe(96_000);
    expect(resolveOutputCeiling("anthropic.claude-opus-4-8", "bedrock", 128_000)).toBe(64_000);
  });

  it("does not clamp non-Claude Bedrock models", () => {
    expect(resolveOutputCeiling("amazon.titan-text", "bedrock")).toBeNull();
  });

  it("tolerates missing model/provider", () => {
    expect(resolveOutputCeiling(undefined, undefined)).toBeNull();
    expect(resolveOutputCeiling(null, null)).toBeNull();
  });
});
