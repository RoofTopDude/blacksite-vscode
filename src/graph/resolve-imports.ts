/* Pure specifier → workspace-file resolution against a known file set.
   Relative specifiers only (plus Python dotted modules); bare package
   specifiers return null — external deps are not map nodes in v1. */

import { normalizeGraphPath } from "./graph-model.js";

const JSISH_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts", "json", "css", "scss", "less"];
const STYLE_EXTS = ["css", "scss", "less"];

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

/** Resolve one specifier from a file to another workspace file, or null when
    external/unresolvable. `files` must contain normalized forward-slash
    workspace-relative paths. */
export function resolveSpecifier(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const from = normalizeGraphPath(fromPath);
  const lang = from.slice(from.lastIndexOf(".") + 1).toLowerCase();
  const trimmed = spec.trim();
  if (!trimmed) return null;

  if (lang === "py") return resolvePython(from, trimmed, files);
  if (STYLE_EXTS.includes(lang)) return resolveStyle(from, trimmed, files);

  /* TS/JS: only relative specifiers resolve to workspace files in v1. */
  if (!trimmed.startsWith("./") && !trimmed.startsWith("../")) return null;
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  const joined = joinPosix(dirOf(from), normalizeGraphPath(withoutQuery));
  if (joined === null) return null;
  return probeJsish(joined, files);
}
