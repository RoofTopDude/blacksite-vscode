import { describe, expect, it } from "vitest";
import { PROFILE_CAPS, resolveGraphCapacity } from "../../src/graph/config.js";

describe("resolveGraphCapacity", () => {
  it("uses the selected profile when advanced caps are unset", () => {
    expect(resolveGraphCapacity({ performanceProfile: "balanced" })).toEqual({
      performanceProfile: "balanced",
      ...PROFILE_CAPS.balanced,
    });
    expect(resolveGraphCapacity({ performanceProfile: "large" })).toEqual({
      performanceProfile: "large",
      ...PROFILE_CAPS.large,
    });
  });

  it("falls back to balanced for custom without explicit caps", () => {
    expect(resolveGraphCapacity({ performanceProfile: "custom" })).toEqual({
      performanceProfile: "custom",
      ...PROFILE_CAPS.balanced,
    });
  });

  it("honors explicit advanced caps over the profile", () => {
    expect(resolveGraphCapacity({
      performanceProfile: "safe",
      maxIndexedFiles: 60_000,
      maxRenderedStars: 12_000,
      maxRelationshipEdges: 18_000,
    })).toEqual({
      performanceProfile: "safe",
      maxIndexedFiles: 60_000,
      maxRenderedStars: 12_000,
      maxRelationshipEdges: 18_000,
    });
  });

  it("uses legacy maxNodes as a rendered cap and indexes at least that many files", () => {
    expect(resolveGraphCapacity({
      maxNodes: 9_000,
      maxRenderedStars: 0,
      maxIndexedFiles: 0,
      maxRelationshipEdges: 0,
    })).toMatchObject({
      maxIndexedFiles: 12_000,
      maxRenderedStars: 9_000,
      maxRelationshipEdges: 5_000,
    });
  });
});
