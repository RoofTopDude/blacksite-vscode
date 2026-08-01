import { describe, expect, it } from "vitest";
import { buildAssistantTextRequestBody, classifyAttachment, probePngDimensions } from "../../src/chat-provider.js";

// Regression coverage for a decompression-bomb guard: a tiny PNG can declare enormous pixel
// dimensions, and decoding it with Jimp allocates a bitmap sized to those dimensions — large
// enough to OOM-kill the whole extension host, which happens *during* decode, before any
// post-decode JS check could run. probePngDimensions reads width/height straight out of the
// IHDR chunk (a fixed offset right after the PNG signature) so the attachment pipeline can
// reject an oversized claim before ever calling Jimp.read().

function pngWithDimensions(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13);
  const ihdrType = Buffer.from("IHDR", "ascii");
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  // Remaining IHDR fields (bit depth, color type, compression, filter, interlace) + CRC are
  // irrelevant to this probe — it only reads the fixed-offset width/height fields.
  const rest = Buffer.alloc(5 + 4);
  return Buffer.concat([signature, ihdrLength, ihdrType, dims, rest]);
}

describe("probePngDimensions", () => {
  it("reads width/height out of a real PNG's IHDR chunk", () => {
    const png = pngWithDimensions(1920, 1080);
    expect(probePngDimensions(png)).toEqual({ width: 1920, height: 1080 });
  });

  it("reads a decompression-bomb-scale declared size without decoding anything", () => {
    const bomb = pngWithDimensions(50_000, 50_000);
    expect(probePngDimensions(bomb)).toEqual({ width: 50_000, height: 50_000 });
  });

  it("returns null for a non-PNG buffer (falls through to the post-decode checks)", () => {
    expect(probePngDimensions(Buffer.from("not a png at all, just text"))).toBeNull();
    expect(probePngDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // JPEG magic
  });

  it("returns null for a truncated buffer instead of throwing", () => {
    expect(probePngDimensions(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(probePngDimensions(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when the signature matches but IHDR isn't the first chunk (malformed)", () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const wrongChunk = Buffer.concat([signature, Buffer.alloc(16, 0)]); // no "IHDR" at offset 12
    expect(probePngDimensions(wrongChunk)).toBeNull();
  });
});

describe("classifyAttachment", () => {
  it("recognizes media and keeps uncommon image/audio formats on the multimodal path", () => {
    expect(classifyAttachment("design.heic")).toBe("image");
    expect(classifyAttachment("voice-note.m4a")).toBe("audio");
    expect(classifyAttachment("meeting.webm", "audio/webm")).toBe("audio");
  });

  it("presents code, data, archives, and unknown files without rejecting any of them", () => {
    expect(classifyAttachment("routes.ts")).toBe("code");
    expect(classifyAttachment("events.jsonl")).toBe("data");
    expect(classifyAttachment("release.tar.gz")).toBe("archive");
    expect(classifyAttachment("custom.firmware")).toBe("other");
  });
});

describe("buildAssistantTextRequestBody", () => {
  it("uses OpenAI's completion-token dialect for continuation reviewers on reasoning models", () => {
    const body = buildAssistantTextRequestBody({
      provider: "openai",
      model: "gpt-5.2",
      maxTokens: 4096,
      systemPrompt: "Review one approval.",
      userPrompt: "Allow this scoped edit?",
      reasoningEffort: "low",
    });

    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe("low");
  });

  it("keeps max_tokens for non-reasoning and OpenRouter requests", () => {
    expect(buildAssistantTextRequestBody({
      provider: "openai", model: "gpt-4o", maxTokens: 4096, systemPrompt: "s", userPrompt: "u",
    })).toMatchObject({ max_tokens: 4096 });
    expect(buildAssistantTextRequestBody({
      provider: "openrouter", model: "openai/gpt-5.2", maxTokens: 4096, systemPrompt: "s", userPrompt: "u",
    })).toMatchObject({ max_tokens: 4096 });
  });
});
