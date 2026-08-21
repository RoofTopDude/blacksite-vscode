// macOS ships `sips`, a system image converter that understands the HEIC, HEIF, and TIFF files
// users commonly attach from Photos. Jimp deliberately does not depend on native codecs, so use
// this only as a Darwin-only fallback after its normal decoder declines an image.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Convert a locally attached image to PNG with macOS's built-in ImageIO bridge.
 *
 * Uses an absolute executable path and argument-array invocation: attachment names never pass
 * through a shell. The converted file lives in a unique temp directory and is removed before the
 * promise settles, leaving the original attachment untouched.
 */
export async function transcodeImageWithMacSips(sourcePath: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blacksite-image-"));
  const outputPath = path.join(tempDir, "converted.png");
  try {
    await execFileAsync(
      "/usr/bin/sips",
      ["--setProperty", "format", "png", sourcePath, "--out", outputPath],
      { maxBuffer: 1024 * 1024 },
    );
    return await fs.promises.readFile(outputPath);
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
