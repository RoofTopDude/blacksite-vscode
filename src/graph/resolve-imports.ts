/* Pure specifier → workspace-file resolution against a known file set.
   Relative specifiers (plus Python dotted modules, Go module imports, and Java
   FQCNs) resolve to workspace files; bare npm/registry specifiers return null
   unless a tsconfig/jsconfig alias maps them back into the tree. */

import { dirOf, joinPosix, matchBySuffix, normalizeGraphPath } from "./graph-model.js";
import { aliasCandidates, type TsAliasTable } from "./tsconfig-paths.js";
import { resolveGoImport, type GoModule } from "./go-modules.js";
import type { CSharpIndex } from "./csharp-index.js";

export { joinPosix };

const JSISH_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts", "json", "css", "scss", "less", "vue", "svelte"];
const STYLE_EXTS = ["css", "scss", "less"];
const C_LANGS = new Set(["c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh"]);
const JSISH_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"]);

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

/** Pick among equally-valid candidates: a sibling in the importer's directory
    first (most likely the intended one), else the shortest path. */
function pickNearest(candidates: readonly string[], fromPath: string): string {
  const dir = dirOf(fromPath);
  return (
    candidates.find((p) => dirOf(p) === dir)
    ?? [...candidates].sort((a, b) => a.length - b.length)[0]
    ?? candidates[0]!
  );
}

/** Razor-specific tie-break on top of pickNearest: a Shared/ view beats an
    arbitrary shortest-path guess when there's no same-directory sibling. */
function pickView(candidates: readonly string[], fromPath: string): string {
  const dir = dirOf(fromPath);
  return (
    candidates.find((p) => dirOf(p) === dir)
    ?? candidates.find((p) => /(?:^|\/)shared\//i.test(p))
    ?? [...candidates].sort((a, b) => a.length - b.length)[0]
    ?? candidates[0]!
  );
}

/** Java: a fully-qualified `import a.b.C;` maps to a file whose path ends in
    `a/b/C.java`, under whatever source root the project uses (src/main/java,
    src/, or none). Resolution is a suffix match against the basename index so
    source roots need no special-casing. `import a.b.*;` (a whole package) is
    skipped — it names a directory, not a file.

    A static import `import static a.b.C.member;` (tagged `static:a.b.C.member`
    by import-scan.ts) has an extra trailing segment; when the full name
    doesn't resolve, dropping the last segment recovers the class. That retry
    is gated on the static tag — without it, a plain `import a.b.C;` that fails
    to resolve is a genuine miss (an external/third-party class), not a
    static-member import, and retrying one segment up would silently wire the
    file to an unrelated class that merely shares a package prefix. */
function resolveJava(fromPath: string, spec: string, files: ReadonlySet<string>, ctx?: ResolveContext): string | null {
  const isStatic = spec.startsWith("static:");
  const dotted = (isStatic ? spec.slice(7) : spec).trim();
  if (!dotted || dotted.endsWith(".*")) return null;

  const tryFqcn = (fqcn: string): string | null => {
    const parts = fqcn.split(".").filter(Boolean);
    if (parts.length === 0) return null;
    const rel = `${parts.join("/")}.java`;
    if (files.has(rel)) return rel;
    const index = ctx?.byBasename;
    if (!index) return null;
    const candidates = index.get(`${parts[parts.length - 1]!.toLowerCase()}.java`);
    if (!candidates || candidates.length === 0) return null;
    const matches = matchBySuffix(candidates, rel);
    return matches.length > 0 ? pickNearest(matches, fromPath) : null;
  };

  const direct = tryFqcn(dotted);
  if (direct) return direct;
  if (!isStatic) return null;
  const parts = dotted.split(".");
  return parts.length >= 2 ? tryFqcn(parts.slice(0, -1).join(".")) : null;
}

function normalizeCSharpRef(value: string): string {
  return value.trim().replace(/^global::/, "").replace(/<[^>]+>/g, "");
}

function resolveCSharpTargets(fromPath: string, spec: string, ctx?: ResolveContext): string[] {
  const index = ctx?.csharp;
  if (!index) return [];
  const take = (hits: readonly string[] | undefined): string[] => hits ? [...new Set(hits)] : [];
  if (spec.startsWith("csharp-type:")) {
    return take(index.byType.get(normalizeCSharpRef(spec.slice("csharp-type:".length))));
  }
  if (spec.startsWith("csharp-alias:")) {
    const target = normalizeCSharpRef(spec.slice("csharp-alias:".length));
    const typeHits = take(index.byType.get(target));
    if (typeHits.length > 0) return typeHits;
    return take(index.byNamespace.get(target));
  }
  if (spec.startsWith("csharp-ns:")) {
    return take(index.byNamespace.get(normalizeCSharpRef(spec.slice("csharp-ns:".length))));
  }
  return [];
}

/** Optional resolution context for references that can't be resolved from the
    specifier and file set alone — name-based lookups (Razor partials, Java
    FQCNs), tsconfig path aliases, and Go module prefixes. Built once per
    rebuild from the file set + project config. */
export interface ResolveContext {
  /** Lowercased basename-with-extension → workspace paths carrying it. */
  byBasename?: ReadonlyMap<string, string[]>;
  /** tsconfig/jsconfig `paths` + `baseUrl` aliases, nearest-config-first. */
  aliases?: TsAliasTable;
  /** `go.mod` module prefixes for resolving Go package imports to local files. */
  goModules?: readonly GoModule[];
  /** Directory → its .go files, precomputed once per rebuild so resolving a Go
      package import doesn't rescan the whole workspace file set every time. */
  goDirIndex?: ReadonlyMap<string, string[]>;
  /** Namespace/type index for resolving C# `using` references back to files. */
  csharp?: CSharpIndex;
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
  if (lang === "java") return resolveJava(from, trimmed, files, ctx);
  if (lang === "cs") {
    const hits = resolveCSharpTargets(from, trimmed, ctx);
    return hits.length > 0 ? pickNearest(hits, from) : null;
  }
  if (lang === "html" || lang === "htm") return resolveHtmlAsset(from, trimmed, files);
  if (lang === "cshtml" || lang === "razor") {
    return trimmed.startsWith("view:")
      ? resolveView(from, trimmed.slice(5), files, ctx)
      : resolveHtmlAsset(from, trimmed, files);
  }

  /* TS/JS + single-file components (.vue/.svelte, whose <script> is an ES
     module). Relative specifiers resolve directly (Vue/Svelte targets included
     because JSISH_EXTS covers those extensions); a non-relative specifier gets
     one more chance through the tsconfig/jsconfig alias table before giving up,
     so `@app/*` / `~/lib/*` / baseUrl imports become real edges. */
  if (!trimmed.startsWith("./") && !trimmed.startsWith("../")) {
    if (ctx?.aliases && JSISH_LANGS.has(lang)) {
      /* Strip query/hash before matching, not just before probing — an exact
         (non-wildcard) alias like "@ui" must still match "@ui?raw" verbatim. */
      const aliasSpec = trimmed.replace(/[?#].*$/, "");
      for (const base of aliasCandidates(from, aliasSpec, ctx.aliases)) {
        const hit = probeJsish(base, files);
        if (hit) return hit;
      }
    }
    return null;
  }
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  const joined = joinPosix(dirOf(from), normalizeGraphPath(withoutQuery));
  if (joined === null) return null;
  return probeJsish(joined, files);
}

/** Resolve a specifier to every workspace file it points at. Most languages
    name a single file (thin wrapper over resolveSpecifier); Go imports name a
    package directory and fan out to all of its source files. This is the entry
    point the indexer uses so a Go import contributes every real edge. */
export function resolveSpecifierTargets(
  fromPath: string,
  spec: string,
  files: ReadonlySet<string>,
  ctx?: ResolveContext,
): string[] {
  const from = normalizeGraphPath(fromPath);
  const lang = from.slice(from.lastIndexOf(".") + 1).toLowerCase();
  if (lang === "go") return resolveGoImport(from, spec.trim(), files, ctx?.goModules ?? [], ctx?.goDirIndex);
  if (lang === "cs") return resolveCSharpTargets(from, spec.trim(), ctx).filter((target) => files.has(target));
  const one = resolveSpecifier(from, spec, files, ctx);
  return one ? [one] : [];
}
