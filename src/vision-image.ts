/*
  One place that turns "some image bytes" into something every vision provider will accept.

  Images reach the model from several directions — user attachments, reference_zoom_image,
  file_read on an image, browser and preview screenshots, retained run artifacts — and each path
  used to trust the media type it was handed (usually guessed from a file extension) and forward
  the bytes as-is. Three things go wrong with that, and each one fails the *whole provider
  request*, not just the image:

   - the declared type does not match the bytes (a `.png` that is really a JPEG, which is common
     for downloaded and renamed files) — Anthropic rejects the request outright;
   - the format is not one providers take (BMP, TIFF, HEIC, AVIF);
   - the image is too large, in bytes (a ~5 MB base64 ceiling) or in pixels (8000 px on a side,
     which a full-page screenshot passes easily).

  Decoding is portable on purpose: Jimp for the common formats, WASM libwebp and libheif for WebP
  and HEIC/HEIF, and macOS ImageIO only as a last resort. Before this, WebP and AVIF decoded on
  macOS (through `sips`) and failed on Windows, so the same attachment worked for one user and not
  another.
*/
import { transcodeImageWithMacSips } from "./macos-image.js";
import { decodeHeicImage } from "./heic-image.js";
import { decodeWebpImage } from "./webp-image.js";

/** What Anthropic, OpenAI, Bedrock and OpenRouter vision inputs all accept. */
export const VISION_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Raw-byte budget per image. Providers cap the *base64* payload around 5 MB and base64 inflates
 *  by 4/3, so the raw ceiling must stay under 5 MB × 3/4 ≈ 3.75 MB. */
export const VISION_MAX_BYTES = 3.5 * 1024 * 1024;
/** Anthropic's hard per-side limit. Larger images are rejected rather than resized. */
export const VISION_MAX_DIMENSION = 8000;
/** Ceiling on decoded pixel count before anything is decoded. A tiny file declaring enormous
 *  dimensions would otherwise allocate a multi-gigabyte bitmap and take the extension host down
 *  mid-decode; 100 MP covers any real screenshot or photo (an 8K monitor is ~33 MP). */
export const MAX_DECODE_PIXELS = 100_000_000;

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify an image from its leading bytes. Returns undefined for anything unrecognised, which
 *  callers treat as "keep whatever type you were told". */
export function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "image/tiff";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
  }
  return undefined;
}

/**
 * Read declared width/height without decoding any pixel data. Covers the formats that are passed
 * through untouched when they fit the byte budget — PNG, GIF, JPEG and WebP — because those are
 * the ones whose dimensions would otherwise never be checked. Null when the header is not
 * understood; callers then fall back to decoding, which measures the real bitmap.
 */
export function probeImageDimensions(bytes: Buffer): { width: number; height: number } | null {
  try {
    const type = sniffImageMediaType(bytes);
    if (type === "image/png") {
      if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (type === "image/gif") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (type === "image/webp") {
      const chunk = bytes.toString("ascii", 12, 16);
      if (chunk === "VP8X" && bytes.length >= 30) {
        return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      }
      if (chunk === "VP8L" && bytes.length >= 25) {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 " && bytes.length >= 30) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    if (type === "image/jpeg") {
      // Walk the marker segments to the first start-of-frame, which carries the dimensions.
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const length = bytes.readUInt16BE(offset + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        offset += 2 + length;
      }
      return null;
    }
  } catch { /* truncated header — treat as unknown */ }
  return null;
}

type JimpImage = Awaited<ReturnType<(typeof import("jimp"))["Jimp"]["read"]>>;

/** Decode through Jimp first, then WASM libwebp and libheif (both portable), then macOS ImageIO
 *  for whatever all of those decline. `sourcePath` is only needed for that last step. */
export async function decodeImage(bytes: Buffer, sourcePath?: string): Promise<JimpImage> {
  const declared = probeImageDimensions(bytes);
  if (declared && declared.width * declared.height > MAX_DECODE_PIXELS) {
    throw new Error(`declared ${declared.width}×${declared.height} pixels, refusing to decode`);
  }
  const { Jimp } = await import("jimp");
  try {
    return await Jimp.read(bytes);
  } catch (decodeError) {
    const webp = await decodeWebpImage(bytes);
    if (webp) return Jimp.fromBitmap(webp) as JimpImage;
    const heic = await decodeHeicImage(bytes);
    if (heic) return Jimp.fromBitmap(heic) as JimpImage;
    const converted = sourcePath ? await transcodeImageWithMacSips(sourcePath) : null;
    if (!converted) throw decodeError;
    return Jimp.read(converted);
  }
}

export interface VisionImage {
  mediaType: string;
  data: Buffer;
  /** True when the bytes were decoded and re-encoded rather than passed through. */
  transcoded: boolean;
}

/**
 * Encode a decoded image into the byte budget. PNG first, because it keeps screenshots and UI
 * text crisp; JPEG when PNG will not fit, because a photo or a dense full-page capture is 5–10×
 * smaller as JPEG and would otherwise have to lose most of its resolution instead.
 */
export async function encodeForVision(image: JimpImage, maxBytes = VISION_MAX_BYTES): Promise<VisionImage> {
  const longest = Math.max(image.bitmap.width, image.bitmap.height);
  if (longest > VISION_MAX_DIMENSION) {
    const scale = VISION_MAX_DIMENSION / longest;
    image.resize({ w: Math.max(1, Math.floor(image.bitmap.width * scale)), h: Math.max(1, Math.floor(image.bitmap.height * scale)) });
  }
  const png = Buffer.from(await image.getBuffer("image/png"));
  if (png.length <= maxBytes) return { mediaType: "image/png", data: png, transcoded: true };

  let jpeg = Buffer.from(await image.getBuffer("image/jpeg", { quality: 85 }));
  // Aim once — encoded size tracks pixel count, i.e. scale² — then halve only as a safety net.
  // `||` on the floor so a tall, narrow capture keeps shrinking on its long axis.
  if (jpeg.length > maxBytes) {
    const scale = Math.min(0.9, Math.sqrt((maxBytes * 0.9) / jpeg.length));
    image.resize({ w: Math.max(1, Math.round(image.bitmap.width * scale)), h: Math.max(1, Math.round(image.bitmap.height * scale)) });
    jpeg = Buffer.from(await image.getBuffer("image/jpeg", { quality: 85 }));
  }
  while (jpeg.length > maxBytes && (image.bitmap.width > 200 || image.bitmap.height > 200)) {
    image.resize({ w: Math.max(1, Math.round(image.bitmap.width / 2)), h: Math.max(1, Math.round(image.bitmap.height / 2)) });
    jpeg = Buffer.from(await image.getBuffer("image/jpeg", { quality: 85 }));
  }
  if (jpeg.length > maxBytes) throw new Error("too large to inline even after downscaling");
  return { mediaType: "image/jpeg", data: jpeg, transcoded: true };
}

/**
 * Make image bytes safe to send as a vision block: the media type comes from the bytes rather than
 * from the caller's guess, unsupported formats are converted, and anything over the byte or
 * dimension limits is downscaled. Bytes that already qualify pass through untouched. Throws with
 * a readable reason when the image cannot be prepared.
 */
export async function prepareVisionImage(
  bytes: Buffer,
  options: { declaredType?: string; sourcePath?: string; maxBytes?: number } = {},
): Promise<VisionImage> {
  const maxBytes = options.maxBytes ?? VISION_MAX_BYTES;
  const mediaType = sniffImageMediaType(bytes) ?? options.declaredType?.toLowerCase() ?? "";
  const dimensions = probeImageDimensions(bytes);
  const fitsDimensions = !!dimensions
    && dimensions.width <= VISION_MAX_DIMENSION && dimensions.height <= VISION_MAX_DIMENSION;
  if (VISION_MEDIA_TYPES.has(mediaType) && bytes.length <= maxBytes && fitsDimensions) {
    return { mediaType, data: bytes, transcoded: false };
  }
  if (mediaType === "image/svg+xml") {
    throw new Error("SVG is vector markup, not a raster image — read it as text instead");
  }
  const image = await decodeImage(bytes, options.sourcePath);
  return encodeForVision(image, maxBytes);
}
