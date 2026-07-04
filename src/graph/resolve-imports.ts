/* Pure specifier → workspace-file resolution against a known file set.
   Relative specifiers only (plus Python dotted modules); bare package
   specifiers return null — external deps are not map nodes in v1. */

import { normalizeGraphPath } from "./graph-model.js";

const JSISH_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts", "json", "css", "scss", "less", "vue", "svelte"];
const STYLE_EXTS = ["css", "scss", "less"];
const C_LANGS = new Set(["c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh"]);

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

/** Collapse "a/b/../c" and "./" segments without touching the filesystem. */
export function joinPosix(base: string, rel: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null; // escapes the workspace
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

function probeJsish(candidate: string, files: ReadonlySet<string>): string | null {
  if (files.has(candidate)) return candidate;
  /* TS sources import "./x.js" — probe the sibling .ts/.tsx before extensions. */
  const jsToTs = candidate.replace(/\.(m|c)?js$/, ".$1ts");
  if (jsToTs !== candidate) {
    if (files.has(jsToTs)) return jsToTs;
    const tsx = candidate.replace(/\.js$/, ".tsx");
    if (files.has(tsx)) return tsx;
  }
  for (const ext of JSISH_EXTS) {
    if (files.has(`${candidate}.${ext}`)) return `${candidate}.${ext}`;
  }
  for (const ext of JSISH_EXTS) {
    if (files.has(`${candidate}/index.${ext}`)) return `${candidate}/index.${ext}`;
  }
  return null;
}

function resolvePython(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  let base: string;
  let rest = spec;
  if (spec.startsWith(".")) {
    /* ".mod" = sibling, "..mod" = parent, etc. */
    let dots = 0;
    while (dots < rest.length && rest[dots] === ".") dots += 1;
    rest = rest.slice(dots);
    base = dirOf(fromPath);
    for (let i = 1; i < dots; i += 1) {
      if (!base) return null;
      base = dirOf(base);
    }
  } else {
    base = ""; // absolute module path from workspace root
  }
  const relModule = rest.split(".").filter(Boolean).join("/");
  const joined = relModule ? (base ? `${base}/${relModule}` : relModule) : base;
  if (!joined) return null;
  if (files.has(`${joined}.py`)) return `${joined}.py`;
  if (files.has(`${joined}/__init__.py`)) return `${joined}/__init__.py`;
  return null;
}

function resolveStyle(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const joined = joinPosix(dirOf(fromPath), normalizeGraphPath(spec));
  if (joined === null) return null;
  if (files.has(joined)) return joined;
  for (const ext of STYLE_EXTS) {
    if (files.has(`${joined}.${ext}`)) return `${joined}.${ext}`;
  }
  /* scss partial: "dir/name" → "dir/_name.scss" */
  const idx = joined.lastIndexOf("/");
  const partial = idx === -1 ? `_${joined}` : `${joined.slice(0, idx)}/_${joined.slice(idx + 1)}`;
  for (const ext of STYLE_EXTS) {
    if (files.has(`${partial}.${ext}`)) return `${partial}.${ext}`;
  }
  return null;
}

/** C/C++ #include "x": relative to the including file's directory. Includes
    already carry an extension; probe the joined path as-is. */
function resolveInclude(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const joined = joinPosix(dirOf(fromPath), normalizeGraphPath(spec));
  if (joined === null) return null;
  return files.has(joined) ? joined : null;
}

/** Rust `mod foo;` (tagged "mod:foo") → sibling foo.rs or foo/mod.rs. */
function resolveRustMod(fromPath: string, name: string, files: ReadonlySet<string>): string | null {
  const dir = dirOf(fromPath);
  const base = dir ? `${dir}/${name}` : name;
  if (files.has(`${base}.rs`)) return `${base}.rs`;
  if (files.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
  return null;
}

/** Ruby require_relative / relative require: dir-relative, `.rb` optional. */
function resolveRuby(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const joined = joinPosix(dirOf(fromPath), normalizeGraphPath(spec));
  if (joined === null) return null;
  if (files.has(joined)) return joined;
  if (files.has(`${joined}.rb`)) return `${joined}.rb`;
  return null;
}

/** PHP require/include: dir-relative for ./ and ../, else try workspace-root
    relative (many projects require a repo-root-relative path). `.php` optional. */
function resolvePhp(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const clean = normalizeGraphPath(spec).replace(/^\.\//, "");
  const candidates = [
    joinPosix(dirOf(fromPath), clean),
    clean.startsWith("../") ? null : clean, // root-relative fallback
  ];
  for (const base of candidates) {
    if (base === null) continue;
    if (files.has(base)) return base;
    if (files.has(`${base}.php`)) return `${base}.php`;
  }
  return null;
}

/** HTML src/href: relative asset reference; the extension is written out, so
    probe the joined path as-is. */
function resolveHtmlAsset(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const withoutQuery = spec.replace(/[?#].*$/, "");
  const joined = joinPosix(dirOf(fromPath), normalizeGraphPath(withoutQuery));
  if (joined === null) return null;
  return files.has(joined) ? joined : null;
}

/** Razor view/component reference (tagged "view:..."): a Layout / partial /
    component named by path or by bare name. Paths resolve root- or dir-
    relative; bare names resolve against a basename index of .cshtml/.razor
    files (built once by the indexer), preferring a sibling, then a Shared view,
    then the shortest path. */
function resolveView(
  fromPath: string,
  raw: string,
  files: ReadonlySet<string>,
  ctx?: ResolveContext,
): string | null {
  const name = raw.replace(/^~\//, "").replace(/[?#].*$/, "").trim();
  if (!name) return null;
  if (name.includes("/")) {
    const bases = [normalizeGraphPath(name)];
    const rel = joinPosix(dirOf(fromPath), normalizeGraphPath(name));
    if (rel) bases.push(rel);
    for (const base of bases) {
      if (files.has(base)) return base;
      for (const ext of ["cshtml", "razor"]) if (files.has(`${base}.${ext}`)) return `${base}.${ext}`;
    }
    return null;
  }
  const index = ctx?.byBasename;
  if (!index) return null;
  const stripped = name.replace(/\.(cshtml|razor)$/i, "").toLowerCase();
  for (const ext of ["cshtml", "razor"]) {
    const candidates = index.get(`${stripped}.${ext}`);
    if (candidates && candidates.length > 0) return pickView(candidates, fromPath);
  }
  return null;
}

function pickView(candidates: readonly string[], fromPath: string): string {
  const dir = dirOf(fromPath);
  return (
    candidates.find((p) => dirOf(p) === dir)
    ?? candidates.find((p) => /(?:^|\/)shared\//i.test(p))
    ?? [...candidates].sort((a, b) => a.length - b.length)[0]
    ?? candidates[0]!
  );
}

/** Optional resolution context for name-based (not path-based) references —
    e.g. Razor bare partial/component names. Built once from the file set. */
export interface ResolveContext {
  /** Lowercased basename-with-extension → workspace paths carrying it. */
  byBasename?: ReadonlyMap<string, string[]>;
}

/** Build the basename index a ResolveContext needs. */
export function buildBasenameIndex(files: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
    const list = index.get(base);
    if (list) list.push(file);
    else index.set(base, [file]);
  }
  return index;
}

/** Resolve one specifier from a file to another workspace file, or null when
    external/unresolvable. `files` must contain normalized forward-slash
    workspace-relative paths. */
export function resolveSpecifier(
  fromPath: string,
  spec: string,
  files: ReadonlySet<string>,
  ctx?: ResolveContext,
): string | null {
  const from = normalizeGraphPath(fromPath);
  const lang = from.slice(from.lastIndexOf(".") + 1).toLowerCase();
  const trimmed = spec.trim();
  if (!trimmed) return null;

  if (lang === "py") return resolvePython(from, trimmed, files);
  if (STYLE_EXTS.includes(lang)) return resolveStyle(from, trimmed, files);
  if (C_LANGS.has(lang)) return resolveInclude(from, trimmed, files);
  if (lang === "rs") return trimmed.startsWith("mod:") ? resolveRustMod(from, trimmed.slice(4), files) : null;
  if (lang === "rb") return resolveRuby(from, trimmed, files);
  if (lang === "php") return resolvePhp(from, trimmed, files);
  if (lang === "html" || lang === "htm") return resolveHtmlAsset(from, trimmed, files);
  if (lang === "cshtml" || lang === "razor") {
    return trimmed.startsWith("view:")
      ? resolveView(from, trimmed.slice(5), files, ctx)
      : resolveHtmlAsset(from, trimmed, files);
  }

  /* TS/JS + single-file components (.vue/.svelte, whose <script> is an ES
     module): only relative specifiers resolve to workspace files. Vue/Svelte
     targets resolve because JSISH_EXTS includes those extensions. */
  if (!trimmed.startsWith("./") && !trimmed.startsWith("../")) return null;
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  const joined = joinPosix(dirOf(from), normalizeGraphPath(withoutQuery));
  if (joined === null) return null;
  return probeJsish(joined, files);
}
