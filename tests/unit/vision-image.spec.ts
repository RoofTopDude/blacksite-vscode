/**
 * Every image the model sees goes through prepareVisionImage. A vision block a provider rejects
 * fails the whole request, so these pin the three ways that used to happen — a mislabelled media
 * type, an unsupported format, an oversized image — plus the portable WebP decoder that made the
 * Windows path match macOS.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  VISION_MAX_DIMENSION,
  decodeImage,
  encodeForVision,
  prepareVisionImage,
  probeImageDimensions,
  sniffImageMediaType,
} from "../../src/vision-image.js";

/** 64×32 solid red, lossy WebP (VP8). */
const WEBP_64X32_RED = "UklGRlAAAABXRUJQVlA4IEQAAABwAwCdASpAACAAPpFIn0ulpCKhpAgAsBIJZwDQRoAAII0kYaAA/u6mP/9x2BuvFv/+5wP+5wP+5wP42wiXYTbpQAAAAA==";

/* jimp is slow to import cold; resolve it once with a budget sized for that (see reference-tools.spec). */
let Jimp: typeof import("jimp").Jimp;
beforeAll(async () => {
  ({ Jimp } = await import("jimp"));
}, 60_000);

async function encoded(width: number, height: number, mime: "image/png" | "image/jpeg" | "image/bmp" | "image/gif"): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x2266aaff });
  return Buffer.from(await image.getBuffer(mime));
}

describe("sniffImageMediaType", () => {
  it("identifies formats from their leading bytes", async () => {
    expect(sniffImageMediaType(await encoded(4, 4, "image/png"))).toBe("image/png");
    expect(sniffImageMediaType(await encoded(4, 4, "image/jpeg"))).toBe("image/jpeg");
    expect(sniffImageMediaType(await encoded(4, 4, "image/gif"))).toBe("image/gif");
    expect(sniffImageMediaType(await encoded(4, 4, "image/bmp"))).toBe("image/bmp");
    expect(sniffImageMediaType(Buffer.from(WEBP_64X32_RED, "base64"))).toBe("image/webp");
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(8)]);
    expect(sniffImageMediaType(ftyp("heic"))).toBe("image/heic");
    expect(sniffImageMediaType(ftyp("avif"))).toBe("image/avif");
    expect(sniffImageMediaType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
  });
});

describe("probeImageDimensions", () => {
  it("reads dimensions without decoding for PNG, JPEG, GIF and WebP", async () => {
    expect(probeImageDimensions(await encoded(37, 21, "image/png"))).toEqual({ width: 37, height: 21 });
    expect(probeImageDimensions(await encoded(37, 21, "image/jpeg"))).toEqual({ width: 37, height: 21 });
    expect(probeImageDimensions(await encoded(37, 21, "image/gif"))).toEqual({ width: 37, height: 21 });
    expect(probeImageDimensions(Buffer.from(WEBP_64X32_RED, "base64"))).toEqual({ width: 64, height: 32 });
  });
});

describe("prepareVisionImage", () => {
  /** A `.png` that is really a JPEG made Anthropic reject the whole request. */
  it("passes qualifying bytes through with the media type the bytes actually have", async () => {
    const jpeg = await encoded(20, 10, "image/jpeg");
    const prepared = await prepareVisionImage(jpeg, { declaredType: "image/png" });
    expect(prepared).toMatchObject({ mediaType: "image/jpeg", transcoded: false });
    expect(prepared.data).toBe(jpeg);
  });

  it("converts formats providers reject", async () => {
    const prepared = await prepareVisionImage(await encoded(20, 10, "image/bmp"), { declaredType: "image/bmp" });
    expect(prepared).toMatchObject({ mediaType: "image/png", transcoded: true });
    expect(probeImageDimensions(prepared.data)).toEqual({ width: 20, height: 10 });
  });

  /** A full-page screenshot is easily taller than the 8000px per-side limit while still small in bytes. */
  it("downscales an image past the per-side pixel limit even when its bytes fit", async () => {
    const tall = await encoded(8, VISION_MAX_DIMENSION + 400, "image/png");
    const prepared = await prepareVisionImage(tall);
    const size = probeImageDimensions(prepared.data)!;
    expect(prepared.transcoded).toBe(true);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(VISION_MAX_DIMENSION);
  }, 20_000);

  it("falls back to JPEG when PNG cannot fit the byte budget", async () => {
    const noise = new Jimp({ width: 200, height: 200, color: 0x000000ff });
    for (let i = 0; i < noise.bitmap.data.length; i++) noise.bitmap.data[i] = (i * 2654435761) >>> 24;
    const png = Buffer.from(await noise.getBuffer("image/png"));
    const result = await encodeForVision(noise, Math.floor(png.length / 2));
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(Math.floor(png.length / 2));
  });

  it("explains that SVG is markup rather than failing inside the decoder", async () => {
    await expect(prepareVisionImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { declaredType: "image/svg+xml" }))
      .rejects.toThrow(/SVG/);
  });
});

describe("decodeImage", () => {
  /** Jimp has no WebP decoder; this used to work only on macOS, through `sips`. */
  it("decodes WebP portably", async () => {
    const image = await decodeImage(Buffer.from(WEBP_64X32_RED, "base64"));
    expect(image.bitmap.width).toBe(64);
    expect(image.bitmap.height).toBe(32);
    expect(image.bitmap.data[0]).toBeGreaterThan(200);
  });

  it("refuses a decompression bomb before allocating it", async () => {
    const header = await encoded(1, 1, "image/png");
    header.writeUInt32BE(50_000, 16);
    header.writeUInt32BE(50_000, 20);
    await expect(decodeImage(header)).rejects.toThrow(/refusing to decode/);
  });
});
