/* Pure extraction of the workspace files a Markdown doc references, so a README
   or design note links to the code it documents. Three sources, most reliable
   first: Markdown links `[text](path)`, inline-code spans `` `path` ``, and
   bare path-like tokens. Everything is resolved against the real file set, so a
   false-positive token that doesn't name a file simply drops out. */

import { matchBySuffix, normalizeGraphPath } from "./graph-model.js";
import { joinPosix } from "./resolve-imports.js";

/** Cap references pulled from one doc — a big index can list hundreds of files;
    a doc wired to its whole tree stops being a useful relationship. */
const MAX_LINKS_PER_DOC = 60;
const MAX_SCAN_CHARS = 512_000;

/* [text](target) — target up to the first space (before an optional "title"),
   paren, or angle-bracket wrapper. */
const MD_LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+[^)]*)?\)/g;
/* `inline code` — a path only qualifies below if it looks like one. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;
/* Bare token that looks like a relative/rooted path with a file extension. */
const BARE_PATH_RE = /(?:^|[\s("'])((?:\.{0,2}\/)?[\w./-]+\.[A-Za-z][A-Za-z0-9]{0,4})/g;

function looksLikePath(token: string): boolean {
  if (!token || /^(?:[a-z]+:|\/\/|#|mailto:)/i.test(token)) return false;
  /* Must carry a file extension and not be a bare domain / version string. */
  return /[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(token.replace(/[?#].*$/, ""));
}

/** Raw path-like references in a Markdown document (deduped, capped). */
export function extractDocLinks(content: string): string[] {
  const body = content.length > MAX_SCAN_CHARS ? content.slice(0, MAX_SCAN_CHARS) : content;
  const out = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (out.size >= MAX_LINKS_PER_DOC || !raw) return;
    const token = raw.trim();
    if (looksLikePath(token)) out.add(token);
  };

  for (let m = MD_LINK_RE.exec(body); m !== null; m = MD_LINK_RE.exec(body)) add(m[1]);
  MD_LINK_RE.lastIndex = 0;
  for (let m = INLINE_CODE_RE.exec(body); m !== null; m = INLINE_CODE_RE.exec(body)) {
    const inner = (m[1] ?? "").trim();
    /* Only treat a code span as a path when it's a single path-shaped token. */
    if (!/\s/.test(inner)) add(inner);
  }
  INLINE_CODE_RE.lastIndex = 0;
  for (let m = BARE_PATH_RE.exec(body); m !== null; m = BARE_PATH_RE.exec(body)) add(m[1]);
  BARE_PATH_RE.lastIndex = 0;

  return [...out];
}

/** Resolve a doc reference to a workspace file: strip anchors/queries, then try
    it relative to the doc's own directory, then as a workspace-root-relative
    path. Returns null when it names nothing real. */
export function resolveDocLink(fromPath: string, raw: string, files: ReadonlySet<string>): string | null {
  const clean = normalizeGraphPath(raw.replace(/[?#].*$/, "").replace(/^\.\//, ""));
  if (!clean || clean.includes("://")) return null;
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const relative = joinPosix(fromDir, clean);
  if (relative && files.has(relative)) return relative;
  if (files.has(clean)) return clean;
  return null;
}

/** Fallback for docs that reference a file by bare basename ("view-model.ts")
    or a partial path ("lib/graph/protocol.ts") — extremely common in prose and
    inline code. Only links when it's *unambiguous*: a partial path must be a
    unique path suffix, a bare basename must belong to exactly one file. That
    "exactly one" rule is what keeps a mention of `index.ts` from wiring the doc
    to a dozen unrelated files. `byBasename` keys are lowercased basenames. */
export function resolveDocByName(
  raw: string,
  byBasename: ReadonlyMap<string, string[]>,
): string | null {
  const clean = normalizeGraphPath(raw.replace(/[?#].*$/, "").replace(/^\.\//, ""));
  if (!clean || clean.includes("://")) return null;
  const base = clean.slice(clean.lastIndexOf("/") + 1).toLowerCase();
  const candidates = byBasename.get(base);
  if (!candidates || candidates.length === 0) return null;
  if (clean.includes("/")) {
    const matches = matchBySuffix(candidates, clean);
    return matches.length === 1 ? matches[0]! : null;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/** All workspace files a doc documents (deduped, self-links removed). With a
    basename index, falls back to unambiguous basename/suffix matches for the
    shorthand references docs usually use. */
export function docReferences(
  fromPath: string,
  content: string,
  files: ReadonlySet<string>,
  byBasename?: ReadonlyMap<string, string[]>,
): string[] {
  const from = normalizeGraphPath(fromPath);
  const out = new Set<string>();
  for (const raw of extractDocLinks(content)) {
    const target = resolveDocLink(from, raw, files) ?? (byBasename ? resolveDocByName(raw, byBasename) : null);
    if (target && target !== from) out.add(target);
  }
  return [...out];
}
