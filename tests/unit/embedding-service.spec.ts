import { describe, expect, it } from "vitest";
import { EmbeddingService } from "../../src/embedding-service.js";

// No API key is ever returned, so every embed() call falls through to the local
// sparse fallback — deterministic and network-free, which is all this cache-key
// regression needs.
function offlineService(): EmbeddingService {
  return new EmbeddingService("anthropic", async () => undefined);
}

describe("EmbeddingService cache key", () => {
  it("does not collide two different texts that share the same first 256 characters", async () => {
    const service = offlineService();
    const prefix = "x".repeat(256);
    const a = await service.embed(`${prefix} alpha unique suffix one`);
    const b = await service.embed(`${prefix} bravo unique suffix two`);
    expect(a).not.toEqual(b);
  });

  it("still serves the cached vector for a text embedded twice", async () => {
    const service = offlineService();
    const text = "some workspace text to embed";
    const first = await service.embed(text);
    const second = await service.embed(text);
    expect(second).toBe(first);
  });
});
