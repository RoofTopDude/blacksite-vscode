import { describe, expect, it } from "vitest";
import { getContextLength } from "../../src/model-fetcher.js";

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
