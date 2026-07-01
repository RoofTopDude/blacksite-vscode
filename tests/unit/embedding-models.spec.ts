import { describe, expect, it } from "vitest";
import {
  buildBedrockEmbeddingBody, defaultEmbeddingForProvider, embeddingModelsForProvider,
  parseBedrockEmbeddingResponse,
} from "../../src/embedding-models.js";

describe("embeddingModelsForProvider", () => {
  it("returns Bedrock Titan/Cohere models for bedrock", () => {
    const models = embeddingModelsForProvider("bedrock");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "bedrock")).toBe(true);
    expect(models.some((m) => m.model.startsWith("amazon.titan-embed"))).toBe(true);
    expect(models.some((m) => m.model.startsWith("cohere.embed"))).toBe(true);
  });

  it("returns OpenAI models for openai/openrouter and unknown providers", () => {
    for (const p of ["openai", "openrouter", "anthropic", "???"]) {
      const models = embeddingModelsForProvider(p);
      expect(models.some((m) => m.model.startsWith("text-embedding-3"))).toBe(true);
    }
    expect(embeddingModelsForProvider("openrouter")[0]!.provider).toBe("openrouter");
  });
});

describe("defaultEmbeddingForProvider", () => {
  it("seeds Titan for bedrock and OpenAI otherwise", () => {
    expect(defaultEmbeddingForProvider("bedrock").model).toBe("amazon.titan-embed-text-v2:0");
    expect(defaultEmbeddingForProvider("openai").model).toBe("text-embedding-3-small");
    expect(defaultEmbeddingForProvider("openrouter").model).toBe("text-embedding-3-small");
  });
  it("returns a fresh object each call (no shared mutation)", () => {
    const a = defaultEmbeddingForProvider("bedrock");
    const b = defaultEmbeddingForProvider("bedrock");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("buildBedrockEmbeddingBody", () => {
  it("sends dimensions + normalize for Titan v2, clamping to allowed sizes", () => {
    expect(buildBedrockEmbeddingBody("amazon.titan-embed-text-v2:0", "hi", 512)).toEqual({
      inputText: "hi", dimensions: 512, normalize: true,
    });
    // Unsupported dim falls back to 1024.
    expect(buildBedrockEmbeddingBody("amazon.titan-embed-text-v2:0", "hi", 999)).toEqual({
      inputText: "hi", dimensions: 1024, normalize: true,
    });
  });

  it("omits dimensions for Titan v1 (fixed size)", () => {
    expect(buildBedrockEmbeddingBody("amazon.titan-embed-text-v1", "hi", 512)).toEqual({ inputText: "hi" });
  });

  it("uses the Cohere texts/input_type shape", () => {
    expect(buildBedrockEmbeddingBody("cohere.embed-english-v3", "hi")).toEqual({
      texts: ["hi"], input_type: "search_document", truncate: "END",
    });
  });

  it("truncates very long inputs", () => {
    const body = buildBedrockEmbeddingBody("amazon.titan-embed-text-v2:0", "x".repeat(20_000)) as { inputText: string };
    expect(body.inputText.length).toBe(8_000);
  });
});

describe("parseBedrockEmbeddingResponse", () => {
  it("reads the Titan { embedding } shape", () => {
    expect(parseBedrockEmbeddingResponse("amazon.titan-embed-text-v2:0", { embedding: [1, 2, 3] })).toEqual([1, 2, 3]);
  });
  it("reads the Cohere { embeddings: number[][] } shape", () => {
    expect(parseBedrockEmbeddingResponse("cohere.embed-english-v3", { embeddings: [[4, 5, 6]] })).toEqual([4, 5, 6]);
  });
  it("reads the Cohere embeddings-by-type { embeddings: { float } } shape", () => {
    expect(parseBedrockEmbeddingResponse("cohere.embed-english-v3", { embeddings: { float: [[7, 8]] } })).toEqual([7, 8]);
  });
  it("returns an empty array for unrecognized shapes", () => {
    expect(parseBedrockEmbeddingResponse("x", null)).toEqual([]);
    expect(parseBedrockEmbeddingResponse("x", { nope: true })).toEqual([]);
  });
});
