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

  it("does not clamp non-Bedrock providers (avoids truncating models that support more)", () => {
    expect(resolveOutputCeiling("claude-opus-4-8", "anthropic")).toBeNull();
    expect(resolveOutputCeiling("gpt-5", "openai")).toBeNull();
  });

  it("does not clamp non-Claude Bedrock models", () => {
    expect(resolveOutputCeiling("amazon.titan-text", "bedrock")).toBeNull();
  });

  it("tolerates missing model/provider", () => {
    expect(resolveOutputCeiling(undefined, undefined)).toBeNull();
    expect(resolveOutputCeiling(null, null)).toBeNull();
  });
});
