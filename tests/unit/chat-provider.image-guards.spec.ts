import { describe, expect, it } from "vitest";
import { probePngDimensions } from "../../src/chat-provider.js";

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
