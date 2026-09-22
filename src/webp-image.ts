// Cross-platform WebP decoding. Jimp 1.x ships PNG/JPEG/BMP/GIF/TIFF decoders only, so a WebP
// attachment used to decode on macOS (through the `sips` fallback in macos-image.ts) and fail on
// Windows and Linux — an oversized WebP could not be downscaled for the vision block, and
// reference_zoom_image could not crop one at all. `@jsquash/webp` is libwebp compiled to WASM with
// no native binary, so it behaves identically on every OS.
//
// The glue module is bundled into out/extension.js, but its .wasm is not: emscripten locates it
// through `import.meta.url`, which has no meaning in the CJS bundle. esbuild.mjs stages the binary
// at out/webp_dec.wasm and the module is compiled here and handed to `init`, so the glue never
// tries to fetch anything. Loaded lazily — most sessions never attach a WebP.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

/** The host tsconfig carries no DOM lib, so the WASM API is described here rather than assumed. */
type WasmModule = object;
const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WasmModule> } }).WebAssembly;

type WebpDecodeModule = {
  init(module: WasmModule): Promise<void>;
  default(buffer: ArrayBuffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
};

const nodeRequire: NodeJS.Require =
  typeof require === "function" ? require : createRequire(path.join(process.cwd(), "index.js"));

let decoder: Promise<WebpDecodeModule["default"] | null> | undefined;

/** RIFF....WEBP — the only container libwebp decodes. */
export function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function wasmPath(): string | undefined {
  // Bundled extension: staged next to out/extension.js by esbuild.mjs.
  const bundled = typeof __dirname === "string" ? path.join(__dirname, "webp_dec.wasm") : "";
  if (bundled && fs.existsSync(bundled)) return bundled;
  // Unit tests and unbundled development runs resolve the package directly.
  try {
    const packageDir = path.dirname(nodeRequire.resolve("@jsquash/webp/package.json"));
    const candidate = path.join(packageDir, "codec", "dec", "webp_dec.wasm");
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function loadDecoder(): Promise<WebpDecodeModule["default"] | null> {
  const binary = wasmPath();
  if (!binary) return null;
  // The emscripten glue returns its pixels as an ImageData, which the extension host (plain Node)
  // does not define. Only the three fields below are ever read back.
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    (globalThis as Record<string, unknown>).ImageData = class ImageData {
      readonly colorSpace = "srgb";
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    };
  }
  const mod = await import("@jsquash/webp/decode.js") as unknown as WebpDecodeModule;
  await mod.init(await wasm.compile(await fs.promises.readFile(binary)));
  return mod.default;
}

/** Decode a WebP buffer to raw RGBA pixels, or null when it is not a WebP or libwebp declines it.
 *  Never throws. The shape matches decodeHeicImage so both feed Jimp.fromBitmap the same way. */
export async function decodeWebpImage(
  bytes: Buffer,
): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  if (!isWebp(bytes)) return null;
  try {
    decoder ??= loadDecoder().catch(() => null);
    const decode = await decoder;
    if (!decode) return null;
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const image = await decode(view);
    return { width: image.width, height: image.height, data: image.data };
  } catch {
    return null;
  }
}
