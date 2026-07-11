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

const JSON_CONFIG_EXTS = ["json", "jsonc", "yaml", "yml"];

/** JSON config reference ($ref / extends / references path / relative or bare
    string): resolved relative to the referencing file's directory first. Probes
    the path as-is, then common config extensions, then a `tsconfig.json` inside
    a referenced directory (tsconfig project references point at a folder).

    A *bare* path ("src/popup.html", "scripts/gen.js") is additionally retried
    against each ancestor directory: configs routinely write paths relative to
    the project or workspace root rather than their own folder
    (.vscode/settings.json, nested manifests). A web-root-absolute path
    ("/icons/icon.png") retries workspace-root-relative. A bare package
    specifier (e.g. an `extends` naming an npm config) simply won't join to a
    workspace file, so it yields no edge. */
function resolveJson(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const clean = spec.replace(/[?#].*$/, "").trim();
  if (!clean) return null;
  const probe = (base: string | null): string | null => {
    if (!base) return null;
    if (files.has(base)) return base;
    for (const ext of JSON_CONFIG_EXTS) {
      if (files.has(`${base}.${ext}`)) return `${base}.${ext}`;
    }
    if (files.has(`${base}/tsconfig.json`)) return `${base}/tsconfig.json`;
    return null;
  };
  if (clean.startsWith("/")) {
    return probe(normalizeGraphPath(clean.slice(1)));
  }
  const normalized = normalizeGraphPath(clean);
  const direct = probe(joinPosix(dirOf(fromPath), normalized));
  if (direct) return direct;
  if (clean.startsWith(".")) return null; // explicitly dir-relative — no fallback
  let dir = dirOf(fromPath);
  while (dir) {
    dir = dirOf(dir);
    const hit = probe(dir ? `${dir}/${normalized}` : normalized);
    if (hit) return hit;
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

const JVM_WORKSPACE_EXTS = ["kt", "kts", "scala", "java"];

/** Kotlin and Scala imports use JVM-style dotted names. Probe source-root
    suffixes rather than assuming `src/main/<lang>` so Gradle/Maven, generated
    trees, and mixed Java/Kotlin/Scala projects all share the same resolver. */
function resolveJvmWorkspaceImport(
  fromPath: string,
  spec: string,
  files: ReadonlySet<string>,
  ctx?: ResolveContext,
): string | null {
  let dotted = spec.trim().replace(/^_root_\./, "");
  if (!dotted || dotted.endsWith(".*") || dotted.endsWith("._")) return null;
  const tryDotted = (value: string): string | null => {
    const parts = value.split(".").filter(Boolean);
    if (parts.length === 0) return null;
    const stem = parts.join("/");
    for (const ext of JVM_WORKSPACE_EXTS) {
      const rel = `${stem}.${ext}`;
      if (files.has(rel)) return rel;
      const bucket = ctx?.byBasename?.get(`${parts[parts.length - 1]!.toLowerCase()}.${ext}`);
      if (!bucket) continue;
      const matches = matchBySuffix(bucket, rel);
      if (matches.length > 0) return pickNearest(matches, fromPath);
    }
    return null;
  };
  const direct = tryDotted(dotted);
  if (direct) return direct;
  /* Kotlin/Scala can import a nested type or object member. One conservative
     retry at the containing type recovers `pkg.Type.member` / `pkg.Outer.Inner`
     without walking arbitrary package prefixes. */
  const parts = dotted.split(".");
  const tail = parts[parts.length - 1] ?? "";
  const parent = parts[parts.length - 2] ?? "";
  const canBeMemberOrNestedType = /^[a-z_]/.test(tail) || (/^[A-Z]/.test(tail) && /^[A-Z]/.test(parent));
  if (!canBeMemberOrNestedType) return null;
  dotted = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
  return dotted ? tryDotted(dotted) : null;
}

function probeFile(base: string | null, extensions: readonly string[], files: ReadonlySet<string>): string | null {
  if (!base) return null;
  if (files.has(base)) return base;
  for (const ext of extensions) if (files.has(`${base}.${ext}`)) return `${base}.${ext}`;
  return null;
}

function resolveDart(fromPath: string, spec: string, files: ReadonlySet<string>, ctx?: ResolveContext): string | null {
  const clean = spec.replace(/[?#].*$/, "").trim();
  if (!clean || clean.startsWith("dart:")) return null;
  if (!clean.startsWith("package:")) {
    return probeFile(joinPosix(dirOf(fromPath), normalizeGraphPath(clean)), ["dart"], files);
  }
  const uri = clean.slice("package:".length);
  const slash = uri.indexOf("/");
  if (slash <= 0 || slash === uri.length - 1) return null;
  const packageName = uri.slice(0, slash);
  const packageRel = normalizeGraphPath(uri.slice(slash + 1));
  const suffix = `lib/${packageRel}`;
  for (const direct of [`${packageName}/${suffix}`, suffix]) {
    const hit = probeFile(direct, ["dart"], files);
    /* Root-level lib/ is the current package only when the importer also lives
       under that root. A nested package URI must match its directory name. */
    if (hit && (direct !== suffix || fromPath.startsWith("lib/"))) return hit;
  }
  const targetName = packageRel.slice(packageRel.lastIndexOf("/") + 1).toLowerCase();
  const bucket = ctx?.byBasename?.get(targetName) ?? [];
  const suffixLower = `/${suffix.toLowerCase()}`;
  const matches = bucket.filter((candidate) => {
    const lower = candidate.toLowerCase();
    if (!(lower === suffix.toLowerCase() || lower.endsWith(suffixLower))) return false;
    const beforeLib = lower.slice(0, lower.length - suffixLower.length);
    return beforeLib === packageName.toLowerCase() || beforeLib.endsWith(`/${packageName.toLowerCase()}`);
  });
  return matches.length > 0 ? pickNearest(matches, fromPath) : null;
}

function ancestorDirs(fromPath: string): string[] {
  const out: string[] = [];
  let current = dirOf(fromPath);
  for (;;) {
    out.push(current);
    if (!current) break;
    current = dirOf(current);
  }
  return out;
}

function resolveLua(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const directFile = spec.startsWith("lua-file:");
  const module = spec.startsWith("lua:");
  const raw = spec.slice(directFile ? "lua-file:".length : module ? "lua:".length : 0).trim();
  if (!raw || /^[a-z]+:/i.test(raw)) return null;
  const modulePath = directFile || raw.startsWith(".") ? normalizeGraphPath(raw) : raw.replace(/\./g, "/");
  const bases = raw.startsWith(".")
    ? [joinPosix(dirOf(fromPath), modulePath)]
    : ancestorDirs(fromPath).map((dir) => dir ? `${dir}/${modulePath}` : modulePath);
  for (const base of bases) {
    const hit = probeFile(base, ["lua"], files);
    if (hit) return hit;
    if (base && files.has(`${base}/init.lua`)) return `${base}/init.lua`;
  }
  return null;
}

function snakeCaseModuleSegment(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function resolveElixir(fromPath: string, spec: string, files: ReadonlySet<string>, ctx?: ResolveContext): string | null {
  if (spec.startsWith("elixir-file:")) {
    const raw = spec.slice("elixir-file:".length).trim();
    return probeFile(joinPosix(dirOf(fromPath), normalizeGraphPath(raw)), ["ex", "exs"], files);
  }
  const raw = spec.slice(spec.startsWith("elixir:") ? "elixir:".length : 0).trim();
  if (!raw) return null;
  const parts = raw.split(".").filter(Boolean).map(snakeCaseModuleSegment);
  const tryParts = (segments: readonly string[]): string | null => {
    if (segments.length === 0) return null;
    const stem = segments.join("/");
    for (const ext of ["ex", "exs"]) {
      const rel = `${stem}.${ext}`;
      if (files.has(rel)) return rel;
      const bucket = ctx?.byBasename?.get(`${segments[segments.length - 1]}.${ext}`) ?? [];
      const matches = matchBySuffix(bucket, rel);
      if (matches.length > 0) return pickNearest(matches, fromPath);
    }
    return null;
  };
  const exact = tryParts(parts);
  if (exact) return exact;
  /* Nested modules are commonly declared in their parent's file. */
  return parts.length > 1 ? tryParts(parts.slice(0, -1)) : null;
}

function resolveShell(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const clean = normalizeGraphPath(spec.trim());
  if (!clean || spec.startsWith("/") || /[$`*?{}]/.test(spec)) return null;
  const extensions = ["sh", "bash", "zsh", "ksh", "fish"];
  const local = probeFile(joinPosix(dirOf(fromPath), clean), extensions, files);
  if (local) return local;
  /* `source lib/common.sh` is often workspace-root-relative because scripts are
     launched from the repository root; only accept it when that file exists. */
  return clean.startsWith("../") ? null : probeFile(clean.replace(/^\.\//, ""), extensions, files);
}

function normalizeCSharpRef(value: string): string {
  return value.trim().replace(/^global::/, "").replace(/<[^>]+>/g, "");
}

/** Namespaces at or below this many declaring files fan out to every file (the
    old behavior) — small namespaces are cheap and type-matching would miss
    legitimate edges (extension methods, generic-inferred usage). Larger
    namespaces require a referenced-type match so a `using` doesn't link to
    hundreds of unrelated files. */
const CSHARP_SMALL_NAMESPACE = 6;

function resolveCSharpTargets(_fromPath: string, spec: string, ctx?: ResolveContext, referenced?: ReadonlySet<string>): string[] {
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
    const namespaceName = normalizeCSharpRef(spec.slice("csharp-ns:".length));
    const nsFiles = index.byNamespace.get(namespaceName);
    if (!nsFiles) return [];
    /* Precise resolution only when we know what the consuming file references
       AND the namespace is big enough that fanning out would be noise. */
    if (referenced && nsFiles.length > CSHARP_SMALL_NAMESPACE) {
      const declaredTypes = index.typesByNamespace.get(namespaceName);
      if (declaredTypes) {
        const hits = new Set<string>();
        for (const [shortName, typeFiles] of declaredTypes) {
          if (!referenced.has(shortName)) continue;
          for (const file of typeFiles) hits.add(file);
        }
        /* No referenced type matched: the `using` is unused, or is for extension
           methods / global usings. Linking every file would be the hairball
           we're avoiding, so contribute no edge for this namespace. */
        return [...hits];
      }
    }
    return take(nsFiles);
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
  if (lang === "json" || lang === "jsonc" || lang === "webmanifest") return resolveJson(from, trimmed, files);
  if (STYLE_EXTS.includes(lang)) return resolveStyle(from, trimmed, files);
  if (C_LANGS.has(lang)) return resolveInclude(from, trimmed, files);
  if (lang === "rs") return trimmed.startsWith("mod:") ? resolveRustMod(from, trimmed.slice(4), files) : null;
  if (lang === "rb") return resolveRuby(from, trimmed, files);
  if (lang === "php") return resolvePhp(from, trimmed, files);
  if (lang === "java") return resolveJava(from, trimmed, files, ctx);
  if (lang === "kt" || lang === "kts" || lang === "scala" || lang === "sc") {
    return resolveJvmWorkspaceImport(from, trimmed, files, ctx);
  }
  if (lang === "dart") return resolveDart(from, trimmed, files, ctx);
  if (lang === "lua") return resolveLua(from, trimmed, files);
  if (lang === "ex" || lang === "exs") return resolveElixir(from, trimmed, files, ctx);
  if (lang === "sh" || lang === "bash" || lang === "zsh" || lang === "ksh" || lang === "fish") {
    return resolveShell(from, trimmed, files);
  }
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
  /** For `.cs` files: the PascalCase identifiers referenced in the consuming
      file (from referencedTypeNames). When present, a `using` on a large
      namespace resolves only to files declaring a referenced type. */
  csharpReferencedNames?: ReadonlySet<string>,
): string[] {
  const from = normalizeGraphPath(fromPath);
  const lang = from.slice(from.lastIndexOf(".") + 1).toLowerCase();
  if (lang === "go") return resolveGoImport(from, spec.trim(), files, ctx?.goModules ?? [], ctx?.goDirIndex);
  if (lang === "cs") return resolveCSharpTargets(from, spec.trim(), ctx, csharpReferencedNames).filter((target) => files.has(target));
  const one = resolveSpecifier(from, spec, files, ctx);
  return one ? [one] : [];
}
