import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/**
 * Crash-safe reads and writes for the JSON documents under `.blacksite/`.
 *
 * These files hold state a user cannot regenerate — tickets, plans, loops, base context,
 * map notes. Overwriting one in place with a single `writeFileSync` is a torn-write risk:
 * if the extension host dies partway through (crash, force-quit, power loss) the file is
 * left truncated, and because every reader treats unparseable JSON as "absent" and falls
 * back to an empty document, the failure is *silent* — the surface shows zero tickets, and
 * the next mutation persists that empty document over the wreckage.
 *
 * So: write to a sibling temp file, keep the previous good copy as `.bak`, then rename.
 * `rename` within a directory is atomic on both POSIX and NTFS, so a reader sees either the
 * old document or the new one, never a half-written one. {@link readJsonDocument} closes the
 * loop by falling back to `.bak` when the primary file is present but unreadable.
 */

/** Create `dirPath` (and parents) if it does not already exist. */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Parse `filePath` as JSON, returning `null` when it is missing or unusable.
 *
 * Prefer {@link readJsonDocument} for durable documents — this variant has no recovery step
 * and is meant for regenerable caches, where falling back to "absent" just means a rebuild.
 */
export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parse a durable document, falling back to the `.bak` companion when the primary file
 * exists but cannot be parsed — the signature of a torn write.
 *
 * The `.bak` is consulted *only* in that case. A primary file that is simply absent means a
 * fresh workspace, or a user who deliberately deleted the document to reset it; resurrecting
 * a stale backup there would be its own kind of data corruption.
 */
export function readJsonDocument(filePath: string): unknown {
  let primaryExists = false;
  try {
    primaryExists = fs.existsSync(filePath);
    if (primaryExists) return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    // Fall through to the backup below.
  }
  if (!primaryExists) return null;
  return readJsonFile(`${filePath}.bak`);
}

export interface AtomicWriteOptions {
  /**
   * Keep the previous contents as `${filePath}.bak`. On by default.
   *
   * This is a second line of defense, not the primary one: the rename below already makes a
   * torn write impossible. What the backup buys is recovery from a write that completed but
   * was *wrong*, or from a filesystem that does not honor rename atomicity. It costs a full
   * copy of the document on every save, so hot write paths turn it off.
   */
  backup?: boolean;
}

/** Serialize `value` as pretty-printed JSON and write it atomically, matching store convention. */
export function atomicWriteJson(filePath: string, value: unknown, options?: AtomicWriteOptions): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Write `content` to `filePath` via a temp file and an atomic rename.
 *
 * The rename is the load-bearing part: it is atomic on both POSIX and NTFS, so a reader sees
 * either the whole old document or the whole new one — never the half-written file a plain
 * `writeFileSync` leaves behind when the host dies mid-call.
 *
 * The temp name carries a UUID and opens with `wx` so two writers cannot land on the same
 * scratch file; a failed rename cleans up after itself rather than leaving debris behind.
 */
export function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options?: AtomicWriteOptions,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { flag: "wx" });
  if (options?.backup !== false && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      // The new complete temporary file is still safe to promote.
    }
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the rename failure.
    }
    throw error;
  }
}
