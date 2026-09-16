// Cross-platform HEIC/HEIF decoding. `heic-decode` wraps `libheif-js`, a pure-WASM build of
// libheif with no native binary, so — unlike macos-image.ts's `sips` bridge — this works
// identically on Windows, macOS, and Linux. It is the fix for a real gap: the attach-file
// picker has always advertised heic/heif on every platform (see chat-provider.ts's filter),
// but only macOS could actually decode one; Windows/Linux got a hard failure.
//
// Lazy-required rather than imported at module load: libheif's WASM payload is a few MB and
// most sessions never attach a HEIC/HEIF file. `heic-decode` is plain CommonJS
// (`module.exports = decode`), so `require` — not a dynamic `import()` whose ESM/CJS interop
// for a reassigned `module.exports` function is not guaranteed to preserve it — is what its
// own docs use, and what sql-driver.ts already established as this codebase's pattern for a
// require that resolves correctly in both the esbuild CJS bundle and the vitest ESM runner.

import { createRequire } from "node:module";
import * as path from "node:path";

const nodeRequire: (id: string) => unknown =
  typeof require === "function"
    ? (require as unknown as (id: string) => unknown)
    : (createRequire(path.join(process.cwd(), "index.js")) as unknown as (id: string) => unknown);

type HeicDecode = (opts: { buffer: Buffer }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

/** Decode a HEIC/HEIF buffer to raw RGBA pixel data, or null if it isn't a HEIC/HEIF image
 * (wrong magic bytes) or libheif otherwise declines it. Never throws. */
export async function decodeHeicImage(
  bytes: Buffer,
): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  try {
    const decode = nodeRequire("heic-decode") as HeicDecode;
    return await decode({ buffer: bytes });
  } catch {
    return null;
  }
}
