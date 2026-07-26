import fs from "fs";
import path from "path";
import { StringDecoder } from "string_decoder";
import type { DirectoryEntry, SearchMatch } from "./types.js";
import { resolveWorkspacePath } from "./path-policy.js";

/** Bytes buffered per chunk while scanning a file line-wise (see readLineWindow). Memory stays
    O(chunk + window), never O(file), so an arbitrarily large file is readable a window at a time. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Lines returned when the caller doesn't pass an explicit `limit`. Matches the ballpark other
    coding harnesses use — big enough that ordinary source files come back whole in one call. */
const DEFAULT_READ_LINE_LIMIT = 2000;
/** Hard cap on lines per call, so one read can't blow the tool-result budget on a minified bundle. */
const MAX_READ_LINE_LIMIT = 5000;
/** Per-line character cap (long minified lines would otherwise eat the whole result budget).
    Overridable per call via `maxLineChars` up to MAX_LINE_CHARS_CEILING, so a one-line minified
    bundle is still readable in character windows instead of being a permanent dead end. */
const DEFAULT_MAX_READ_LINE_CHARS = 2000;
const MAX_LINE_CHARS_CEILING = 20_000;
/** Image extensions surfaced to the model as a real vision block instead of mojibake `utf8` text. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
/** Refuse to inline an image larger than this as a data URL — base64 of a huge image is a
    context-budget disaster and providers reject oversized image blocks anyway. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "out", ".next", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache"]);

/** Directory-exclusion knobs shared by file_glob and file_search. `includeExcluded` opens up
    the default skip list (debugging inside node_modules is a legitimate ask); `extraExcludes`
    prunes additional generated trees (e.g. "target", "build") that the defaults don't cover. */
export interface ExclusionOptions {
  includeExcluded?: boolean;
  extraExcludes?: string[];
}

function isExcludedDir(name: string, options: ExclusionOptions): boolean {
  if (options.extraExcludes?.includes(name)) return true;
  if (options.includeExcluded) return false;
  return EXCLUDED_DIRS.has(name);
}

/** True when any skip counter is non-zero — field-agnostic so a new skip category can never
    be forgotten in a hand-maintained OR-chain (which would silently hide the `skipped` field
    and break the "no matches means proven-absent" contract). */
function hasAnySkips(skipped: { [key: string]: number } | GlobResultSkips | SearchResultSkips): boolean {
  return Object.values(skipped).some((n) => n > 0);
}

/** Workspace-relative forward-slash form of an absolute path — the same id space the
    Codebase Map, code_* tools, and git results use, so a file-op result can be passed
    straight into those tools without the model translating path dialects. Falls back
    to the forward-slashed absolute path for files outside the workspace root. */
function toRelativePath(workspaceRoot: string, resolved: string): string {
  const rel = path.relative(workspaceRoot, resolved).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : resolved.replace(/\\/g, "/");
}

export function listDirectory(workspaceRoot: string, target: string, limit = 500): { ok: true; path: string; entries: DirectoryEntry[]; truncated: boolean } | { ok: false; error: string } {
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const raw = fs.readdirSync(resolved, { withFileTypes: true });
    const entries: DirectoryEntry[] = raw.slice(0, limit).map((entry) => {
      let sizeBytes: number | null = null;
      let modifiedAt: string | null = null;
      try {
        const stat = fs.statSync(path.join(resolved, entry.name));
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch { /* skip */ }
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        sizeBytes, modifiedAt,
      };
    });
    return { ok: true, path: resolved, entries, truncated: raw.length > limit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Text encodings recognised by BOM sniffing. Anything else is decoded as UTF-8. */
type DetectedEncoding = "utf8" | "utf16le" | "utf16be";

/** Sniff a BOM off the first bytes of a file. UTF-16 files are extremely common on Windows
    (PowerShell 5.1 redirects produce them) and previously read as "binary file (contains NUL
    bytes)"; a UTF-8 BOM previously leaked an invisible ﻿ into the first line, which made
    any file_edit oldString touching that line silently unmatchable. */
function detectEncoding(first: Buffer): { encoding: DetectedEncoding; bomBytes: number } {
  if (first.length >= 3 && first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) return { encoding: "utf8", bomBytes: 3 };
  if (first.length >= 2 && first[0] === 0xff && first[1] === 0xfe) return { encoding: "utf16le", bomBytes: 2 };
  if (first.length >= 2 && first[0] === 0xfe && first[1] === 0xff) return { encoding: "utf16be", bomBytes: 2 };
  return { encoding: "utf8", bomBytes: 0 };
}

/**
 * Read a 1-based, inclusive line window out of a file without ever holding more than a chunk
 * plus the window in memory. This is what lets file_read serve an arbitrarily large file a
 * window at a time instead of the old behaviour — a hard "File too large" failure above
 * 256 KB, which left big files (a bundled index.html, a long log) simply unreadable and pushed
 * the agent into re-reading + tool_output_page paging loops.
 *
 * Returns the requested lines plus the file's true total line count (always scanned to EOF, so
 * the model knows whether more remains and can page with `offset`), the detected encoding, and
 * how many returned lines were clipped at maxLineChars.
 *
 * Decoding goes through StringDecoder so a multi-byte character split across chunk boundaries
 * can never decode as replacement-char garbage.
 */
function readLineWindow(
  filePath: string,
  startLine: number,
  maxLines: number,
  maxLineChars: number,
): { lines: string[]; totalLines: number; binary: boolean; encoding: DetectedEncoding; bom: boolean; longLinesTruncated: number } {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const collected: string[] = [];
    let pending = "";
    let lineNo = 0;
    let binary = false;
    let sawAnyByte = false;
    let longLinesTruncated = 0;
    let firstChunk = true;
    let encoding: DetectedEncoding = "utf8";
    let bom = false;
    let decoder = new StringDecoder("utf8");
    /** utf16be only: a chunk ending mid code-unit leaves one byte to carry into the next chunk
        so the byte-swap below always operates on whole 2-byte units. */
    let carryByte: number | null = null;

    const takeLine = (line: string): void => {
      lineNo++;
      if (lineNo >= startLine && collected.length < maxLines) {
        if (line.length > maxLineChars) {
          longLinesTruncated++;
          collected.push(`${line.slice(0, maxLineChars)}… (line truncated)`);
        } else {
          collected.push(line);
        }
      }
    };

    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      sawAnyByte = true;
      let chunk: Buffer = buffer.subarray(0, bytesRead);

      if (firstChunk) {
        firstChunk = false;
        const detected = detectEncoding(chunk);
        encoding = detected.encoding;
        bom = detected.bomBytes > 0;
        chunk = chunk.subarray(detected.bomBytes);
        // Node's StringDecoder has no big-endian UTF-16 mode; utf16be bytes are pair-swapped
        // below and then decoded as utf16le.
        decoder = new StringDecoder(encoding === "utf8" ? "utf8" : "utf16le");
      }

      // A NUL byte is the standard "this is not text" tell — but only for UTF-8 content.
      // UTF-16 text is *full* of NUL bytes (every ASCII char has one); with a UTF-16 BOM the
      // file is decoded instead of rejected. The UTF-16 paths get the equivalent guard below:
      // a *decoded* U+0000 (a 0x0000 code unit) never appears in real text, so a binary blob
      // whose first bytes merely coincide with a BOM still reports itself as binary rather
      // than returning mojibake the model might edit against.
      if (encoding === "utf8" && !binary && chunk.includes(0)) binary = true;

      let decoded: string;
      if (encoding === "utf16be") {
        let bytes: Buffer = carryByte !== null ? Buffer.concat([Buffer.from([carryByte]), chunk]) : Buffer.from(chunk);
        carryByte = null;
        if (bytes.length % 2 === 1) {
          carryByte = bytes[bytes.length - 1]!;
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        bytes.swap16();
        decoded = decoder.write(bytes);
      } else {
        decoded = decoder.write(chunk);
      }
      if (encoding !== "utf8" && !binary && decoded.includes("\u0000")) binary = true;
      pending += decoded;

      let newlineIdx: number;
      while ((newlineIdx = pending.indexOf("\n")) !== -1) {
        takeLine(pending.slice(0, newlineIdx).replace(/\r$/, ""));
        pending = pending.slice(newlineIdx + 1);
      }
    }
    pending += decoder.end();
    // A utf16be file with an odd byte count leaves half a code unit in carryByte at EOF.
    // Surface it as U+FFFD rather than silently dropping the file's final byte.
    if (carryByte !== null) pending += "�";
    // Trailing content with no final newline is still a line; a file ending in "\n" is not
    // followed by a phantom empty one.
    if (pending.length > 0) takeLine(pending.replace(/\r$/, ""));

    return { lines: collected, totalLines: sawAnyByte ? lineNo : 0, binary, encoding, bom, longLinesTruncated };
  } finally {
    fs.closeSync(fd);
  }
}

export interface ReadFileOptions {
  /** 1-based first line to return (default 1). */
  offset?: number;
  /** Max lines to return (default DEFAULT_READ_LINE_LIMIT, hard-capped at MAX_READ_LINE_LIMIT). */
  limit?: number;
  /** Prefix each line with its 1-based number ("  42\ttext"). Off by default — see file_read's
      schema for why (a numbered line copied verbatim into file_edit's oldString never matches). */
  lineNumbers?: boolean;
  /** Per-line character cap before clipping (default DEFAULT_MAX_READ_LINE_CHARS, ceiling
      MAX_LINE_CHARS_CEILING). Raise it — with a small `limit` — to read through minified
      one-liner files that the default cap would clip forever. */
  maxLineChars?: number;
}

export type ReadFileResult =
  | {
    ok: true;
    path: string;
    relativePath: string;
    content: string;
    sizeBytes: number;
    /** Total lines in the file, not just in the returned window. */
    lines: number;
    /** 1-based inclusive bounds of the returned window. */
    startLine: number;
    endLine: number;
    /** True when the file has more lines past `endLine` — read them with `offset: endLine + 1`. */
    hasMore: boolean;
    /** Present when the file is not plain UTF-8 ("utf16le"/"utf16be", or "utf8" with a BOM).
        The content is decoded text either way; this is a heads-up for tools that write. */
    encoding?: string;
    /** True when the file starts with a byte-order mark (stripped from `content`). */
    bom?: boolean;
    notice?: string;
  }
  | {
    ok: true;
    path: string;
    relativePath: string;
    /** Base64 data URL; AgentSession turns this into a real vision block for the model. */
    mediaDataUrl: string;
    mediaType: string;
    sizeBytes: number;
  }
  | { ok: false; error: string };

export function readFile(workspaceRoot: string, target: string, options: ReadFileOptions = {}): ReadFileResult {
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return { ok: false, error: `${target} is a directory — use file_list to see its contents.` };

    const relativePath = toRelativePath(workspaceRoot, resolved);

    // Images come back as a data URL so the model actually sees the picture (a real vision
    // block), rather than the utf8 garbage a binary read would produce.
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()];
    if (mediaType) {
      if (stat.size > IMAGE_MAX_BYTES) {
        return { ok: false, error: `Image too large to inline (${stat.size} bytes, max ${IMAGE_MAX_BYTES}).` };
      }
      const base64 = fs.readFileSync(resolved).toString("base64");
      return { ok: true, path: resolved, relativePath, mediaDataUrl: `data:${mediaType};base64,${base64}`, mediaType, sizeBytes: stat.size };
    }

    const requestedOffset = Math.max(1, Math.floor(options.offset ?? 1));
    const requestedLimit = Math.min(
      Math.max(1, Math.floor(options.limit ?? DEFAULT_READ_LINE_LIMIT)),
      MAX_READ_LINE_LIMIT,
    );
    const maxLineChars = Math.min(
      Math.max(100, Math.floor(options.maxLineChars ?? DEFAULT_MAX_READ_LINE_CHARS)),
      MAX_LINE_CHARS_CEILING,
    );

    const { lines, totalLines, binary, encoding, bom, longLinesTruncated } = readLineWindow(resolved, requestedOffset, requestedLimit, maxLineChars);
    if (binary) {
      return { ok: false, error: `${relativePath} appears to be a binary file (contains NUL bytes) — it has no readable text content.` };
    }

    const startLine = totalLines === 0 ? 0 : requestedOffset;
    const endLine = totalLines === 0 ? 0 : requestedOffset + lines.length - 1;
    const hasMore = endLine < totalLines;

    const content = options.lineNumbers
      ? lines.map((line, i) => `${String(requestedOffset + i).padStart(6)}\t${line}`).join("\n")
      : lines.join("\n");

    // The model must be told, in the result itself, that it is holding a window rather than the
    // whole file — and exactly how to get the rest. Otherwise a partial read silently reads as
    // complete and it reasons off a truncated view of the file.
    const notices: string[] = [];
    if (requestedOffset > totalLines && totalLines > 0) {
      notices.push(`offset ${requestedOffset} is past the end of the file (${totalLines} lines).`);
    } else if (hasMore) {
      notices.push(`Showing lines ${startLine}-${endLine} of ${totalLines}. Continue with offset: ${endLine + 1}.`);
    }
    if (longLinesTruncated > 0) {
      notices.push(
        `${longLinesTruncated} line(s) exceeded ${maxLineChars} chars and were clipped (marked "… (line truncated)"). ` +
        `Do NOT use a clipped line in file_edit's oldString — the marker is not in the file. ` +
        `Re-read with a larger maxLineChars (up to ${MAX_LINE_CHARS_CEILING}) and a small limit to see the full line.`,
      );
    }
    const nonPlainUtf8 = encoding !== "utf8" || bom;

    return {
      ok: true,
      path: resolved,
      relativePath,
      content,
      sizeBytes: stat.size,
      lines: totalLines,
      startLine,
      endLine,
      hasMore,
      ...(nonPlainUtf8 ? { encoding, bom } : {}),
      ...(notices.length ? { notice: notices.join(" ") } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface WriteFileOptions {
  /** "overwrite" (default) replaces the whole file; "append" adds `content` to the end of an
      existing file (or creates it), which is the safe way to land a large generated file in
      chunks instead of risking a single write that truncates at the output-token budget. */
  mode?: "overwrite" | "append";
}

export type WriteFileResult =
  | {
    ok: true;
    path: string;
    relativePath: string;
    bytesWritten: number;
    mode: "overwrite" | "append";
    /** True when this call created the file rather than changing an existing one. */
    created: boolean;
    /** Size of the file this write replaced (overwrite of an existing file only) — a nudge to
        verify nothing was lost when overwriting a file that was never read this session. */
    replacedSizeBytes?: number;
    /** Total file size after an append, so chunked writers can sanity-check progress. */
    sizeBytes?: number;
    notice?: string;
  }
  | { ok: false; error: string; requiresConfirmation?: true; tier?: string; description?: string };

export function writeFile(workspaceRoot: string, target: string, content: string, confirmed: boolean, options: WriteFileOptions = {}): WriteFileResult {
  if (typeof content !== "string") return { ok: false, error: "content must be a string." };
  const mode = options.mode === "append" ? "append" : "overwrite";
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!confirmed) {
    return {
      ok: false, requiresConfirmation: true, tier: "write",
      description: `${mode === "append" ? "Append to" : "Write"} file: ${resolved}`,
      error: "Confirmation required.",
    };
  }
  try {
    let previousSize: number | null = null;
    try { const s = fs.statSync(resolved); if (s.isFile()) previousSize = s.size; } catch { /* new file */ }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (mode === "append") fs.appendFileSync(resolved, content, "utf8");
    else fs.writeFileSync(resolved, content, "utf8");
    const created = previousSize === null;
    const bytesWritten = Buffer.byteLength(content, "utf8");
    const overwroteExisting = mode === "overwrite" && !created;
    return {
      ok: true,
      path: resolved,
      relativePath: toRelativePath(workspaceRoot, resolved),
      bytesWritten,
      mode,
      created,
      ...(overwroteExisting ? { replacedSizeBytes: previousSize! } : {}),
      ...(mode === "append" ? { sizeBytes: (previousSize ?? 0) + bytesWritten } : {}),
      ...(overwroteExisting
        ? { notice: `Replaced an existing file (${previousSize} bytes). If you have not read it this session, verify nothing important was dropped.` }
        : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Copy a file or directory inside the workspace. Refuses to clobber an existing destination
 * unless `overwrite` is set, so a template copy can never silently destroy work.
 *
 * Gated on `confirmed` exactly like writeFile/deletePath — a copy creates files, and with
 * overwrite it can destroy one, so it must flow through the same approval pipeline as every
 * other mutating file op (the runtime's first call returns requiresConfirmation, the host
 * gets approval, then re-dispatches with confirmed:true).
 */
export function copyPath(workspaceRoot: string, source: string, destination: string, overwrite: boolean, confirmed: boolean): { ok: true; source: string; destination: string; relativeDestination: string; kind: "file" | "directory" } | { ok: false; error: string; requiresConfirmation?: true; tier?: string; description?: string } {
  let resolvedSource: string;
  let resolvedDestination: string;
  try {
    resolvedSource = resolveWorkspacePath(workspaceRoot, source, { label: "source" });
    resolvedDestination = resolveWorkspacePath(workspaceRoot, destination, { label: "destination" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const stat = fs.statSync(resolvedSource);
    const destinationExists = fs.existsSync(resolvedDestination);
    if (destinationExists && !overwrite) {
      return { ok: false, error: `Destination already exists: ${toRelativePath(workspaceRoot, resolvedDestination)}. Pass overwrite:true to replace it.` };
    }
    if (!confirmed) {
      // Overwriting an existing destination is destructive-tier; a plain copy is write-tier.
      return {
        ok: false, requiresConfirmation: true,
        tier: destinationExists ? "destructive" : "write",
        description: `Copy ${toRelativePath(workspaceRoot, resolvedSource)} → ${toRelativePath(workspaceRoot, resolvedDestination)}${destinationExists ? " (replaces existing destination)" : ""}`,
        error: "Confirmation required.",
      };
    }
    fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true });
    fs.cpSync(resolvedSource, resolvedDestination, { recursive: stat.isDirectory(), force: overwrite, errorOnExist: !overwrite });
    return {
      ok: true,
      source: resolvedSource,
      destination: resolvedDestination,
      relativeDestination: toRelativePath(workspaceRoot, resolvedDestination),
      kind: stat.isDirectory() ? "directory" : "file",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deletePath(workspaceRoot: string, target: string, confirmed: boolean): { ok: true; path: string } | { ok: false; error: string; requiresConfirmation?: true; tier?: string; description?: string } {
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!confirmed) return { ok: false, requiresConfirmation: true, tier: "destructive", description: `Delete path: ${resolved}`, error: "Confirmation required." };
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createDirectory(workspaceRoot: string, target: string): { ok: true; path: string } | { ok: false; error: string } {
  let projectPath: string;
  try {
    projectPath = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    fs.mkdirSync(projectPath, { recursive: true });
    return { ok: true, path: projectPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface GlobResultSkips {
  /** Directories not descended into because the depth cap was hit — a non-zero value means
      deeper subtrees exist that this scan never saw. */
  depthLimited: number;
  /** Directories pruned by the default/extra exclusion list. */
  excludedDirs: number;
}

export function glob(workspaceRoot: string, searchPath: string, pattern: string, maxResults = 200, exclusions: ExclusionOptions = {}): { ok: true; path: string; pattern: string; results: string[]; truncated: boolean; skipped?: GlobResultSkips } | { ok: false; error: string } {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, searchPath, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const limit = Math.min(maxResults, 1000);

  let regex: RegExp;
  try { regex = globToRegex(pattern); }
  catch (err) { return { ok: false, error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` }; }

  const hits: Array<{ relPath: string; mtimeMs: number }> = [];
  const skipped: GlobResultSkips = { depthLimited: 0, excludedDirs: 0 };
  function walk(dir: string, depth: number) {
    if (hits.length >= limit) return;
    if (depth > 12) { skipped.depthLimited++; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      const childPath = path.join(dir, entry.name);
      const relPath = path.relative(resolved, childPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name, exclusions)) { skipped.excludedDirs++; continue; }
        if (regex.test(relPath)) hits.push({ relPath: relPath + "/", mtimeMs: mtimeOf(childPath) });
        walk(childPath, depth + 1);
      } else if (entry.isFile() && regex.test(relPath)) {
        hits.push({ relPath, mtimeMs: mtimeOf(childPath) });
      }
    }
  }

  try {
    // A file path is a common, reasonable input (the model often passes the file it
    // just read). Rather than reject it and burn a turn — observed repeatedly in the
    // execution logs as "path must be a directory." — search that file's directory.
    let stat: fs.Stats;
    try { stat = fs.statSync(resolved); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    if (!stat.isDirectory()) resolved = path.dirname(resolved);
    walk(resolved, 0);
    // Most-recently-modified first: in a real repo the files a task is about are almost always
    // the ones touched recently, so the head of a truncated result set is the useful part.
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, path: resolved, pattern, results: hits.map((h) => h.relPath), truncated: hits.length >= limit, ...(hasAnySkips(skipped) ? { skipped } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function mtimeOf(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

/** Translate a glob (`**`, `*`, `?`, `[a-z]`) into an anchored RegExp. Shared by file_glob's
    path matching and file_search's `include` filter, so the two speak the same glob dialect. */
function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*" && normalized[i + 1] === "*") {
      re += ".*"; i++;
      if (normalized[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = normalized.indexOf("]", i);
      if (end > i) { re += normalized.slice(i, end + 1); i = end; }
      else re += "\\[";
    } else if ("^$+.(){}|\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$", process.platform === "win32" ? "i" : "");
}

/** True when `include` looks like a glob rather than a plain substring. Lets file_search accept
    both `*.ts` (the form every other harness uses — and which could never match as a substring,
    since no filename contains a literal `*`) and a bare substring like `service`, without a mode flag. */
function looksLikeGlob(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function matchesInclude(include: string, fileName: string, relPath: string): boolean {
  if (!looksLikeGlob(include)) return fileName.includes(include) || relPath.includes(include);
  const regex = globToRegex(include);
  // A bare `*.ts` should match at any depth, so test the basename too, not just the full path.
  return regex.test(relPath) || regex.test(fileName);
}

const SEARCH_MAX_FILE_BYTES = 512 * 1024;
/** Ceiling for the per-call `maxFileBytes` override — big enough for bundles/logs, small enough
    that one pathological file can't stall the scan for seconds. */
const SEARCH_MAX_FILE_BYTES_CEILING = 8 * 1024 * 1024;

export type SearchOutputMode = "content" | "files_with_matches" | "count";

export interface SearchFilesOptions extends ExclusionOptions {
  caseSensitive?: boolean;
  /** Glob (`*.ts`, `**​/*.spec.ts`) or plain substring — see matchesInclude. */
  include?: string;
  maxResults?: number;
  /** Lines of surrounding context to attach to each match (0-10). content mode only. */
  contextLines?: number;
  /** content (default): matching lines. files_with_matches: just the paths. count: per-file tallies. */
  outputMode?: SearchOutputMode;
  /** Let `.` match newlines and the pattern span lines (whole-file match instead of line-by-line). */
  multiline?: boolean;
  /** Per-file size cap in bytes (default SEARCH_MAX_FILE_BYTES, ceiling
      SEARCH_MAX_FILE_BYTES_CEILING). Raise it to search generated/bundled files the default
      cap would skip — skipped files are always counted in the result's `skipped` field. */
  maxFileBytes?: number;
}

export interface SearchResultSkips {
  /** Files skipped because they exceed the per-file size cap. Non-zero means "no matches"
      is not proof of absence — re-run with a larger maxFileBytes to cover them. */
  largeFiles: number;
  /** Directories not descended into because the depth cap was hit. */
  depthLimited: number;
  /** Directories pruned by the default/extra exclusion list. */
  excludedDirs: number;
}

export type SearchFilesResult =
  | {
    ok: true;
    path: string;
    pattern: string;
    outputMode: SearchOutputMode;
    results: SearchMatch[];
    /** files_with_matches mode. */
    files?: string[];
    /** count mode. */
    counts?: Array<{ file: string; count: number }>;
    totalMatches: number;
    truncated: boolean;
    /** Present when anything was skipped — the scan was NOT exhaustive. */
    skipped?: SearchResultSkips;
  }
  | { ok: false; error: string };

export function searchFiles(workspaceRoot: string, searchPath: string, pattern: string, options: SearchFilesOptions = {}): SearchFilesResult {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, searchPath, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const limit = Math.min(options.maxResults ?? 100, 500);
  const outputMode: SearchOutputMode = options.outputMode ?? "content";
  const contextLines = Math.min(Math.max(options.contextLines ?? 0, 0), 10);
  const maxFileBytes = Math.min(Math.max(options.maxFileBytes ?? SEARCH_MAX_FILE_BYTES, 1024), SEARCH_MAX_FILE_BYTES_CEILING);
  const skipped: SearchResultSkips = { largeFiles: 0, depthLimited: 0, excludedDirs: 0 };

  let regex: RegExp;
  try {
    const flags = `${options.caseSensitive ? "" : "i"}${options.multiline ? "s" : ""}g`;
    regex = new RegExp(pattern, flags);
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
  // `g` makes .test/.exec stateful via lastIndex; reset per use rather than per file so a match
  // in one file can never cause a false negative in the next.
  const matches = (text: string): boolean => { regex.lastIndex = 0; return regex.test(text); };

  const results: SearchMatch[] = [];
  const files: string[] = [];
  const counts: Array<{ file: string; count: number }> = [];
  let totalMatches = 0;
  /** In content mode the budget is matched lines; in the aggregate modes it's files. */
  const budgetSpent = (): number => (outputMode === "content" ? results.length : outputMode === "count" ? counts.length : files.length);

  const scanFile = (filePath: string, relBase: string) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size > maxFileBytes) { skipped.largeFiles++; return; }
    let text: string;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { return; }
    const rel = path.relative(relBase, filePath).replace(/\\/g, "/");

    // Multiline scans the whole file at once (the pattern may span lines), then reports the
    // starting line of each match; the default path stays a cheap line-by-line scan.
    if (options.multiline) {
      regex.lastIndex = 0;
      let hit: RegExpExecArray | null;
      let fileCount = 0;
      while ((hit = regex.exec(text)) !== null) {
        fileCount++;
        totalMatches++;
        if (outputMode === "content" && results.length < limit) {
          const line = text.slice(0, hit.index).split("\n").length;
          results.push({ file: rel, line, text: hit[0].slice(0, 300) });
        }
        if (hit[0] === "") regex.lastIndex++; // a zero-width match would loop forever
      }
      if (fileCount > 0) {
        if (outputMode === "files_with_matches" && files.length < limit) files.push(rel);
        if (outputMode === "count" && counts.length < limit) counts.push({ file: rel, count: fileCount });
      }
      return;
    }

    const lines = text.split("\n");
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!matches(lines[i]!)) continue;
      fileCount++;
      totalMatches++;
      if (outputMode === "content" && results.length < limit) {
        const match: SearchMatch = { file: rel, line: i + 1, text: lines[i]!.slice(0, 300) };
        if (contextLines > 0) {
          match.before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 300));
          match.after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)).map((l) => l.slice(0, 300));
        }
        results.push(match);
      }
      // files_with_matches only needs to know the file matched at all — stop scanning it.
      if (outputMode === "files_with_matches") break;
    }
    if (fileCount > 0) {
      if (outputMode === "files_with_matches" && files.length < limit) files.push(rel);
      if (outputMode === "count" && counts.length < limit) counts.push({ file: rel, count: fileCount });
    }
  };

  function walk(dir: string, depth: number) {
    if (budgetSpent() >= limit) return;
    if (depth > 8) { skipped.depthLimited++; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budgetSpent() >= limit) return;
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name, options)) { skipped.excludedDirs++; continue; }
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const filePath = path.join(dir, entry.name);
        const rel = path.relative(resolved, filePath).replace(/\\/g, "/");
        if (options.include && !matchesInclude(options.include, entry.name, rel)) continue;
        scanFile(filePath, resolved);
      }
    }
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }

  // Searching "within this one file" is a common, reasonable request. Rather than rejecting a
  // file path and forcing the model to re-issue the call against a directory (a wasted turn we
  // observed repeatedly in execution logs), scan just that file when a file path is given.
  const searchRoot = stat.isFile() ? path.dirname(resolved) : resolved;
  if (stat.isFile()) scanFile(resolved, searchRoot);
  else walk(resolved, 0);

  const base = {
    ok: true as const,
    path: stat.isFile() ? resolved : searchRoot,
    pattern,
    outputMode,
    results,
    totalMatches,
    truncated: budgetSpent() >= limit,
    ...(hasAnySkips(skipped) ? { skipped } : {}),
  };
  if (outputMode === "files_with_matches") return { ...base, files };
  if (outputMode === "count") return { ...base, counts };
  return base;
}
