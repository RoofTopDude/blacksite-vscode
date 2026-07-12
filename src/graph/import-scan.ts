/* Pure regex import extraction. Fast, language-limited by design: the goal is
   a good-enough dependency skeleton for the map, not a compiler-grade graph.
   An LSP enrichment pass can add edges later without touching this module.

   Coverage is biased toward references that can be resolved back to a workspace
   file: relative imports, quoted C/C++ includes, Rust `mod`, `require_relative`,
   HTML `src`/`href`, Go module imports (resolved against go.mod), Java
   FQCNs (resolved against source roots), C# `using`/`using static`
   references plus the file's own namespace declarations (same-namespace usage
   needs no using), and JSON/JSONC/webmanifest path-looking values (manifest
   scripts, package entry points, config refs) — plus bare TS/JS specifiers when a
   tsconfig/jsconfig `paths`/`baseUrl` alias maps them back into the tree (see
   resolve-imports.ts + tsconfig-paths.ts). Constructs that name a package
   registry or a pure namespace with no workspace file behind them (external npm
   specifiers, stdlib namespaces, third-party registry packages) still produce
   no edge, by design. */

const MAX_SCAN_CHARS = 512_000;
/* Overlap between successive windows on a large file. Comfortably larger than
   any single import construct (an `import (...)` block, a JSON $ref, a Java
   FQCN), so no match is ever split across a window boundary. */
const WINDOW_OVERLAP = 16_000;

const TS_JS_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const STYLE_LANGS = new Set(["css", "scss", "less"]);
const C_LANGS = new Set(["c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh"]);
const SHELL_LANGS = new Set(["sh", "bash", "zsh", "ksh", "fish"]);
/* Single-file component / template langs whose <script> blocks are ES modules. */
const COMPONENT_LANGS = new Set(["vue", "svelte"]);

/* Matches the specifier in: import x from "s"; import "s"; export * from "s";
   export { a } from "s". The from-clause group must be reluctant (??) so a
   bare side-effect import isn't swallowed while hunting for the next "from",
   and it may not cross quotes/semicolons (statement boundaries). */
const ES_IMPORT_RE = /(?:^|[\s>;])(?:import|export)\s+(?:[^"';]*?\sfrom\s+)??["']([^"'\n]+)["']/g;
/* require("s") and dynamic import("s") */
const CALL_IMPORT_RE = /(?:\brequire|\bimport)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
/* require.resolve("s") — resolves a module's path without importing it. */
const REQUIRE_RESOLVE_RE = /\brequire\.resolve\s*\(\s*["']([^"'\n]+)["']/g;
/* new URL("./worker.js", import.meta.url) — the modern bundler idiom for a
   worker/asset sibling; only the import.meta.url form names a local file. */
const WORKER_URL_RE = /\bnew\s+URL\s*\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g;
/* jest / vitest module mocks reference a real module by path. */
const MODULE_MOCK_RE = /\b(?:jest|vi)\s*\.\s*(?:mock|unmock|doMock|requireActual|requireMock|importActual|importMock)\s*\(\s*["']([^"'\n]+)["']/g;
/* importScripts("a.js", "b.js") — classic web-worker script loader (multi-arg). */
const IMPORT_SCRIPTS_RE = /\bimportScripts\s*\(([^)]*)\)/g;
/* JSON config cross-references: $ref (JSON Schema / OpenAPI), extends
   (tsconfig/jsconfig/babel/eslint), tsconfig `references` path entries, and any
   explicitly-relative "./x" string value. Resolution filters to real files, so
   liberal extraction here is safe — a non-file string just yields no edge. */
const JSON_KEYED_REF_RE = /"(?:\$ref|extends|configFile|tsconfig|tsConfig)"\s*:\s*"([^"\n]+)"/g;
const JSON_PATH_REF_RE = /"path"\s*:\s*"([^"\n]+)"/g;
const JSON_RELATIVE_STRING_RE = /"(\.\.?\/[^"\n]+)"/g;
/* Bare path-looking string values: "background.js", "src/popup.html",
   "dist/index.js" — the form manifest.json scripts, package.json entry points,
   and tool configs actually use (rarely "./"-prefixed). Requires a short
   letter-led extension so version strings ("1.2.3") don't qualify; the
   candidate is then vetted by jsonPathCandidate and, as always, only becomes
   an edge if it resolves to a real workspace file. */
const JSON_BARE_PATH_RE = /"([^"\n]{1,200}\.[A-Za-z][A-Za-z0-9]{0,7})"/g;
/* Ceiling on specs contributed by one JSON file, so a huge data/i18n blob
   full of extensionful strings can't flood the resolver. Config files that
   genuinely reference code sit far below it. */
const JSON_MAX_SPECS = 400;
/* Python: "import a.b as c, d.e". Relative dots in "from" are kept. */
const PY_IMPORT_RE = /^[ \t]*import[ \t]+([\w. \t,]+)/gm;
/* "from a.b import c, d as e" / "from . import x" / "from .pkg import (a, b)".
   Captures the module (group 1) and the imported-names clause (group 2) so we
   can also resolve each imported name as a *submodule* (a/b/c.py) — the common
   package layout — not just the package itself. */
const PY_FROM_IMPORT_RE = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n#]+)/gm;
/* CSS: @import "s"; @import url(s); @use "s" (scss) */
const CSS_IMPORT_RE = /@(?:import|use)\s+(?:url\(\s*)?["']?([^"')\n;]+)["']?\s*\)?/g;
/* C/C++: #include "local.h" — quotes only. <angle.h> is a system/library path,
   almost never a workspace file, so it's intentionally ignored. */
const C_INCLUDE_RE = /#\s*include\s+"([^"\n]+)"/g;
/* Rust: `mod foo;` / `pub mod foo;` → sibling foo.rs or foo/mod.rs. */
const RUST_MOD_RE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;
/* Rust: `use crate::a::b::C;` / `pub use self::x::{A, B};` / `use super::y;`.
   The path (up to `;`, possibly spanning lines inside a `{...}` group) is
   captured and reduced to a resolvable module prefix in rustUseSpec. Only
   crate-internal paths (crate/self/super) resolve to a workspace file; external
   crate `use serde::…` intentionally yields no edge. */
const RUST_USE_RE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm;
/* Ruby: require_relative "x"; require "./x" (relative only — bare gems skip). */
const RUBY_REQUIRE_RE = /\brequire_relative\s+["']([^"'\n]+)["']/g;
const RUBY_REL_REQUIRE_RE = /\brequire\s+["'](\.{1,2}\/[^"'\n]+)["']/g;
/* PHP: require/include (+_once) "path" — resolved dir-relative. */
const PHP_REQUIRE_RE = /\b(?:require|require_once|include|include_once)\b\s*\(?\s*["']([^"'\n]+)["']/g;
/* HTML: src="./x.js" / href="./x.css" — relative asset references. */
const HTML_ASSET_RE = /\b(?:src|href)\s*=\s*["']([^"'\n]+)["']/g;
/* Razor (.cshtml / .razor): views reference other views by name or path.
   Layout, partials, view-components and <partial> tag helpers all name a view;
   Blazor component tags (<PascalCase />) name a .razor file. Emitted with the
   `view:` scheme so the resolver can basename-match against .cshtml/.razor. */
const RAZOR_LAYOUT_RE = /\bLayout\s*=\s*["']([^"'\n]+)["']/g;
const RAZOR_PARTIAL_RE = /\b(?:Html\.(?:Partial|RenderPartial)(?:Async)?|PartialAsync|RenderPartialAsync)\s*\(\s*["']([^"'\n]+)["']/g;
const RAZOR_TAG_PARTIAL_RE = /<partial\b[^>]*\bname\s*=\s*["']([^"'\n]+)["']/g;
const RAZOR_COMPONENT_RE = /\b(?:Component\.InvokeAsync|Html\.RenderComponentAsync|await\s+Component\.InvokeAsync)\s*(?:<[^>(]+>)?\s*\(\s*["']([^"'\n]+)["']/g;
/* Blazor component usage: <NavMenu ... /> — PascalCase custom elements only.
   Framework components (<EditForm>, <InputText>) simply won't basename-match a
   workspace file, so they produce no false edge. */
const RAZOR_BLAZOR_TAG_RE = /<([A-Z][A-Za-z0-9]+)(?=[\s/>])/g;
/* Go: a single `import "path"` (with an optional alias, blank, or dot prefix). */
const GO_IMPORT_SINGLE_RE = /^[ \t]*import[ \t]+(?:[A-Za-z0-9_.]+[ \t]+|_[ \t]+|\.[ \t]+)?"([^"\n]+)"/gm;
/* Go: a grouped `import ( ... )` block; the strings inside are pulled per line. */
const GO_IMPORT_BLOCK_RE = /\bimport[ \t]*\(([\s\S]*?)\)/g;
const GO_BLOCK_LINE_RE = /(?:^|\n)[ \t]*(?:[A-Za-z0-9_.]+[ \t]+|_[ \t]+|\.[ \t]+)?"([^"\n]+)"/g;
/* Java: `import [static] a.b.C;` / `import a.b.*;`. The FQCN (or package-star)
   is resolved to a file later; stdlib/third-party names simply won't match.
   "static" is captured (group 1) rather than discarded — resolve-imports.ts's
   Java resolver only retries with the last segment dropped (to recover a class
   from a static member/nested-class reference) when the import was static, so
   the tag must survive into the emitted spec. */
const JAVA_IMPORT_RE = /^[ \t]*import[ \t]+(static)?[ \t]*([A-Za-z_][\w.]*(?:\.\*)?)[ \t]*;/gm;
/* Kotlin imports are JVM FQCNs with an optional local alias. Workspace
   resolution mirrors Java but also probes Kotlin/Scala source extensions. */
const KOTLIN_IMPORT_RE = /^[ \t]*import[ \t]+([A-Za-z_]\w*(?:\.[A-Za-z_*]\w*)*)(?:[ \t]+as[ \t]+[A-Za-z_]\w*)?[ \t]*;?/gm;
/* Scala imports support selectors (`a.b.{C, D => Alias}`), comma-separated
   clauses, and both Scala 2 `_` and Scala 3 `*` wildcard suffixes. */
const SCALA_IMPORT_RE = /^[ \t]*import[ \t]+([^\n;]+)/gm;
/* Dart URI dependencies: import/export and part files. `dart:` SDK URIs are
   deliberately retained here and discarded by the workspace resolver. */
const DART_IMPORT_RE = /^[ \t]*(?:import|export|part)[ \t]+["']([^"'\n]+)["']/gm;
/* Lua module and literal file loaders. Tagged so resolution can apply Lua's
   dotted-module and init.lua conventions without confusing direct paths. */
const LUA_REQUIRE_RE = /\brequire\s*(?:\(\s*)?["']([^"'\n]+)["']\s*\)?/g;
const LUA_FILE_RE = /\b(?:dofile|loadfile)\s*\(\s*["']([^"'\n]+)["']/g;
/* Elixir compile-time module dependencies plus literal Code.require_file. */
const ELIXIR_MODULE_RE = /^[ \t]*(?:alias|import|require|use)[ \t]+([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*(?:\.\{[^}\n]+\})?)/gm;
const ELIXIR_FILE_RE = /\bCode\.require_file\s*\(\s*["']([^"'\n]+)["']/g;
/* POSIX-family literal source operations. Dynamic paths containing variables
   are filtered by collectShellSources because they cannot be resolved safely. */
const SHELL_SOURCE_RE = /^[ \t]*(?:source|\.)[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#;]+))/gm;
const SHELLCHECK_SOURCE_RE = /^[ \t]*#[ \t]*shellcheck[ \t]+source=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#;]+))/gm;
/* C#: namespace imports, alias imports, and `using static` for type members.
   Emitted with `csharp-*:` tags so the resolver can distinguish namespace-only
   lookups from exact-type lookups. */
const CSHARP_USING_RE = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)[ \t]*;/gm;
/* The file's own namespace declaration(s) — file-scoped (`namespace X;`) or
   block (`namespace X {`). Emitted as a csharp-ns: spec like a `using`: types
   from a file's *own* namespace need no using directive at all, so without
   this the most common C# relationship (same-namespace usage) produced zero
   edges. The resolver's type-precision + the per-file cap keep it from
   fanning a big namespace into a clique. */
const CSHARP_NAMESPACE_DECL_RE = /^[ \t]*namespace[ \t]+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/gm;
const CSHARP_ALIAS_RE = /^[ \t]*(?:global[ \t]+)?using[ \t]+[A-Za-z_]\w*[ \t]*=[ \t]*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*(?:<[^;\n]+>)?)[ \t]*;/gm;
const CSHARP_STATIC_USING_RE = /^[ \t]*(?:global[ \t]+)?using[ \t]+static[ \t]+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*(?:<[^;\n]+>)?)[ \t]*;/gm;

function collect(re: RegExp, content: string, out: Set<string>, map?: (raw: string) => string[]): void {
  re.lastIndex = 0;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    for (const spec of map ? map(raw) : [raw]) {
      const cleaned = spec.trim();
      if (cleaned) out.add(cleaned);
    }
  }
}

/** Extract raw import specifiers from file content. Returns specifiers as
    written (e.g. "./util.js", "react", "..models.user", "mod:parser") —
    resolution against the workspace file set happens in resolve-imports.ts.
    Language-specific specifiers are tagged with a `scheme:` prefix so the
    resolver can dispatch without re-deriving the source language. */
export function extractImports(relPath: string, content: string): string[] {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const lang = dot > 0 ? name.slice(dot + 1) : "";
  const specs = new Set<string>();
  /* A normal file is one window (identical to a single pass over the whole
     content); a large/generated one is scanned in overlapping windows so it
     still contributes every import instead of losing everything past the old
     512 KB truncation point. Results union into `specs`, so re-scanning the
     overlap is harmless. */
  for (const window of scanWindows(content)) collectSpecs(lang, name, window, specs);
  return [...specs];
}

/** Yield the slices of `content` to scan: the whole thing when it fits the
    single-pass budget, otherwise newline-aligned windows that overlap by
    `overlap` chars so a construct near a boundary is caught whole in the next
    window. Pure and deterministic. */
export function* scanWindows(content: string, size = MAX_SCAN_CHARS, overlap = WINDOW_OVERLAP): Generator<string> {
  if (content.length <= size) {
    yield content;
    return;
  }
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + size);
    if (end < content.length) {
      const nl = content.lastIndexOf("\n", end);
      if (nl > start) end = nl + 1; // end on a line boundary where possible
    }
    yield content.slice(start, end);
    if (end >= content.length) return;
    /* Step back by the overlap, then advance to the next line boundary so the
       window's `^`-anchored patterns still match; fall back to `end` (no
       overlap) on a giant single line so we always make progress. */
    const nlNext = content.indexOf("\n", Math.max(start + 1, end - overlap));
    start = nlNext !== -1 && nlNext < end ? nlNext + 1 : end;
  }
}

function collectSpecs(lang: string, name: string, body: string, specs: Set<string>): void {
  if (TS_JS_LANGS.has(lang) || COMPONENT_LANGS.has(lang)) {
    /* Single-file components (.vue/.svelte) embed ES modules in <script>; the
       same regexes cover the whole file cheaply. Beyond static import/require,
       cover the runtime module references JS commonly uses: require.resolve,
       worker/asset `new URL(..., import.meta.url)`, jest/vitest mocks, and
       classic web-worker importScripts. */
    collect(ES_IMPORT_RE, body, specs);
    collect(CALL_IMPORT_RE, body, specs);
    collect(REQUIRE_RESOLVE_RE, body, specs);
    collect(WORKER_URL_RE, body, specs);
    collect(MODULE_MOCK_RE, body, specs);
    collectImportScripts(body, specs);
    if (COMPONENT_LANGS.has(lang)) collect(HTML_ASSET_RE, body, specs, htmlAsset);
  } else if (lang === "json" || lang === "jsonc" || lang === "webmanifest") {
    collectJsonReferences(body, specs);
  } else if (lang === "py") {
    collect(PY_IMPORT_RE, body, specs, (raw) =>
      raw.split(",").map((part) => part.trim().split(/[ \t]+as[ \t]+/)[0] ?? ""));
    collectPyFromImports(body, specs);
  } else if (lang === "cshtml" || lang === "razor") {
    collect(RAZOR_LAYOUT_RE, body, specs, viewScheme);
    collect(RAZOR_PARTIAL_RE, body, specs, viewScheme);
    collect(RAZOR_TAG_PARTIAL_RE, body, specs, viewScheme);
    collect(RAZOR_COMPONENT_RE, body, specs, viewScheme);
    collect(HTML_ASSET_RE, body, specs, htmlAsset);
    if (lang === "razor") collect(RAZOR_BLAZOR_TAG_RE, body, specs, viewScheme);
  } else if (STYLE_LANGS.has(lang)) {
    collect(CSS_IMPORT_RE, body, specs);
  } else if (C_LANGS.has(lang)) {
    collect(C_INCLUDE_RE, body, specs);
  } else if (lang === "rs") {
    collect(RUST_MOD_RE, body, specs, (name) => [`mod:${name}`]);
    collect(RUST_USE_RE, body, specs, rustUseSpec);
  } else if (lang === "go") {
    collect(GO_IMPORT_SINGLE_RE, body, specs);
    GO_IMPORT_BLOCK_RE.lastIndex = 0;
    for (let m = GO_IMPORT_BLOCK_RE.exec(body); m !== null; m = GO_IMPORT_BLOCK_RE.exec(body)) {
      collect(GO_BLOCK_LINE_RE, m[1] ?? "", specs);
    }
  } else if (lang === "java") {
    JAVA_IMPORT_RE.lastIndex = 0;
    for (let m = JAVA_IMPORT_RE.exec(body); m !== null; m = JAVA_IMPORT_RE.exec(body)) {
      const fqcn = m[2]?.trim();
      if (!fqcn) continue;
      specs.add(m[1] ? `static:${fqcn}` : fqcn);
    }
  } else if (lang === "kt" || lang === "kts") {
    collect(KOTLIN_IMPORT_RE, body, specs);
  } else if (lang === "scala" || lang === "sc") {
    collectScalaImports(body, specs);
  } else if (lang === "dart") {
    collect(DART_IMPORT_RE, body, specs);
  } else if (lang === "lua") {
    collect(LUA_REQUIRE_RE, body, specs, (name) => [`lua:${name}`]);
    collect(LUA_FILE_RE, body, specs, (name) => [`lua-file:${name}`]);
  } else if (lang === "ex" || lang === "exs") {
    collectElixirImports(body, specs);
  } else if (SHELL_LANGS.has(lang)) {
    collectShellSources(body, specs);
  } else if (lang === "cs") {
    collect(CSHARP_USING_RE, body, specs, (name) => [`csharp-ns:${name}`]);
    collect(CSHARP_ALIAS_RE, body, specs, (name) => [`csharp-alias:${name}`]);
    collect(CSHARP_STATIC_USING_RE, body, specs, (name) => [`csharp-type:${name}`]);
    collect(CSHARP_NAMESPACE_DECL_RE, body, specs, (name) => [`csharp-ns:${name}`]);
  } else if (lang === "rb") {
    collect(RUBY_REQUIRE_RE, body, specs);
    collect(RUBY_REL_REQUIRE_RE, body, specs);
  } else if (lang === "php") {
    collect(PHP_REQUIRE_RE, body, specs);
  } else if (lang === "html" || lang === "htm") {
    collect(HTML_ASSET_RE, body, specs, htmlAsset);
  } else if (lang === "toml") {
    collectTomlManifest(body, specs);
  } else if (lang === "yml" || lang === "yaml") {
    collectComposeReferences(body, specs);
  } else if (lang === "mk" || name === "makefile" || name === "gnumakefile") {
    collectMakefileIncludes(body, specs);
  } else if (/^requirements[\w.-]*\.(?:txt|in)$/.test(name)) {
    collectRequirements(body, specs);
  }
}

/** Cargo.toml / pyproject.toml intra-workspace dependencies: `path`-based deps
    (`foo = { path = "../foo" }`, `[tool.poetry.dependencies] bar = { path =
    "../bar" }`) and `[workspace] members = [...]`. Each names a package
    directory, emitted as `manifest-dir:` so the resolver lands on that
    directory's manifest. Glob members (`crates/*`) can't name one file and are
    dropped by the resolver. */
function collectTomlManifest(content: string, specs: Set<string>): void {
  for (const m of content.matchAll(/\bpath\s*=\s*["']([^"'\n]+)["']/g)) {
    const value = m[1]?.trim();
    if (value) specs.add(`manifest-dir:${value}`);
  }
  for (const block of content.matchAll(/\bmembers\s*=\s*\[([^\]]*)\]/g)) {
    for (const s of (block[1] ?? "").matchAll(/["']([^"'\n]+)["']/g)) {
      const value = s[1]?.trim();
      if (value) specs.add(`manifest-dir:${value}`);
    }
  }
}

/** requirements.txt intra-repo edges: `-e ./pkg` editable installs (a local
    package directory) and `-r base.txt` includes (another requirements file).
    Registry pins and VCS/URL installs name no workspace file and are skipped. */
function collectRequirements(content: string, specs: Set<string>): void {
  for (const m of content.matchAll(/^[ \t]*-e[ \t]+([^\n#]+)/gm)) {
    let value = (m[1] ?? "").trim().replace(/^file:\/\//, "").split(/\s+/)[0] ?? "";
    value = value.replace(/#egg=.*$/, "").replace(/\[[^\]]*\]$/, "");
    if (!value || /:\/\//.test(value) || value.startsWith("git+")) continue;
    specs.add(`manifest-dir:${value}`);
  }
  for (const m of content.matchAll(/^[ \t]*-r[ \t]+([^\n#]+)/gm)) {
    const value = (m[1] ?? "").trim().split(/\s+/)[0];
    if (value) specs.add(`path:${value}`);
  }
}

/** Makefile `include` / `-include` / `sinclude` directives (each line may name
    several files). Variable-bearing paths ($(VAR), wildcards) are dropped. */
function collectMakefileIncludes(content: string, specs: Set<string>): void {
  for (const m of content.matchAll(/^[ \t]*(?:-include|sinclude|include)[ \t]+([^\n#]+)/gm)) {
    for (const part of (m[1] ?? "").trim().split(/\s+/)) {
      if (part && !/[$%*?]/.test(part)) specs.add(`path:${part}`);
    }
  }
}

/** docker-compose (and compose-shaped) references: a service `build:`/`context:`
    build context (a directory holding a Dockerfile or manifest → `manifest-dir:`)
    and `dockerfile:`/`env_file:` file references (`path:`). Runs on all YAML;
    non-compose files simply won't resolve their matches to a workspace file.
    `depends_on` names services, not files, so it's intentionally not followed. */
function collectComposeReferences(content: string, specs: Set<string>): void {
  for (const m of content.matchAll(/^[ \t]*(?:context|build)[ \t]*:[ \t]*["']?([^\s"'#{][^\n"'#]*)/gm)) {
    const value = (m[1] ?? "").trim();
    if (value && !/[$*?]/.test(value)) specs.add(`manifest-dir:${value}`);
  }
  for (const key of ["dockerfile", "env_file"]) {
    for (const m of content.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*["']?([^\\s"'#]+)`, "gm"))) {
      const value = (m[1] ?? "").trim();
      if (value && !/[$*?]/.test(value)) specs.add(`path:${value}`);
    }
  }
}

/** Split a comma-separated list while preserving commas inside `{...}`. */
function splitTopLevelCommas(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out;
}

function stripScalaAlias(raw: string): string {
  return raw.split(/\s*=>\s*|\s+as\s+/)[0]?.trim() ?? "";
}

/** Expand Scala selectors to ordinary dotted names so the resolver can use one
    conservative FQCN path. Package wildcards contribute their prefix; it only
    becomes an edge if that prefix maps to a real source file (for example an
    imported object's members). */
function collectScalaImports(content: string, out: Set<string>): void {
  SCALA_IMPORT_RE.lastIndex = 0;
  for (let m = SCALA_IMPORT_RE.exec(content); m !== null; m = SCALA_IMPORT_RE.exec(content)) {
    const line = (m[1] ?? "").replace(/\/\/.*$/, "").trim();
    for (const clause of splitTopLevelCommas(line)) {
      const value = clause.trim().replace(/^_root_\./, "");
      if (!value) continue;
      const open = value.indexOf("{");
      const close = value.lastIndexOf("}");
      if (open >= 0 && close > open) {
        const prefix = value.slice(0, open).replace(/\.$/, "");
        for (const selector of value.slice(open + 1, close).split(",")) {
          const name = stripScalaAlias(selector);
          if (!name) continue;
          if (name === "_" || name === "*") {
            if (prefix) out.add(prefix);
          } else {
            out.add(prefix ? `${prefix}.${name}` : name);
          }
        }
        continue;
      }
      let normalized = stripScalaAlias(value);
      if (normalized.endsWith("._") || normalized.endsWith(".*")) normalized = normalized.slice(0, -2);
      if (normalized) out.add(normalized);
    }
  }
}

function collectElixirImports(content: string, out: Set<string>): void {
  ELIXIR_MODULE_RE.lastIndex = 0;
  for (let m = ELIXIR_MODULE_RE.exec(content); m !== null; m = ELIXIR_MODULE_RE.exec(content)) {
    const value = (m[1] ?? "").trim();
    const open = value.indexOf("{");
    const close = value.lastIndexOf("}");
    if (open >= 0 && close > open) {
      const prefix = value.slice(0, open).replace(/\.$/, "");
      for (const member of value.slice(open + 1, close).split(",")) {
        const name = member.trim();
        if (prefix && /^[A-Z][A-Za-z0-9_]*$/.test(name)) out.add(`elixir:${prefix}.${name}`);
      }
    } else if (value) {
      out.add(`elixir:${value}`);
    }
  }
  collect(ELIXIR_FILE_RE, content, out, (name) => [`elixir-file:${name}`]);
}

function shellLiteral(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || /[$`*?{}]/.test(value)) return null;
  return value;
}

function collectShellSources(content: string, out: Set<string>): void {
  for (const re of [SHELL_SOURCE_RE, SHELLCHECK_SOURCE_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(content); m !== null; m = re.exec(content)) {
      const value = shellLiteral(m[1] ?? m[2] ?? m[3]);
      if (value) out.add(value);
    }
  }
}

/** importScripts("a.js", "b.js") loads several worker scripts in one call;
    pull every quoted path out of the argument list. */
function collectImportScripts(content: string, out: Set<string>): void {
  IMPORT_SCRIPTS_RE.lastIndex = 0;
  for (let m = IMPORT_SCRIPTS_RE.exec(content); m !== null; m = IMPORT_SCRIPTS_RE.exec(content)) {
    for (const s of (m[1] ?? "").matchAll(/["']([^"'\n]+)["']/g)) {
      const value = s[1]?.trim();
      if (value) out.add(value);
    }
  }
}

/** Extract file cross-references from a JSON (or JSONC) config: $ref / extends /
    tsconfig `references` paths, any explicitly-relative string value, and any
    bare string that plausibly names a workspace file (manifest.json scripts,
    package.json entry points, settings-style tool paths). The URL fragment on
    a `$ref` ("common.json#/defs") is dropped so only the file part remains. */
function collectJsonReferences(content: string, out: Set<string>): void {
  const add = (raw: string | undefined): void => {
    if (out.size >= JSON_MAX_SPECS) return;
    const value = raw?.split("#")[0]?.trim();
    if (value) out.add(value);
  };
  for (const m of content.matchAll(JSON_KEYED_REF_RE)) add(m[1]);
  for (const m of content.matchAll(JSON_PATH_REF_RE)) add(m[1]);
  for (const m of content.matchAll(JSON_RELATIVE_STRING_RE)) add(m[1]);
  for (const m of content.matchAll(JSON_BARE_PATH_RE)) {
    if (out.size >= JSON_MAX_SPECS) return;
    const candidate = jsonPathCandidate(m[1]);
    if (candidate) add(candidate);
  }
}

/** Vet a bare JSON string as a plausible file path: no URL scheme or
    protocol-relative form, no globs/templates/whitespace. Returns the value
    (query/fragment intact — the resolver strips those) or null. */
function jsonPathCandidate(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // http:, data:, vscode:, …
  if (value.startsWith("//")) return null;
  if (/[\s*?<>|"{}]/.test(value)) return null; // globs, brace templates, junk
  return value;
}

/** Keep only local-looking HTML asset references (drop absolute URLs, protocol-
    relative, data URIs, and template placeholders that can't resolve to files). */
function htmlAsset(raw: string): string[] {
  if (/^(?:[a-z]+:|\/\/|#|data:|\{\{|\$\{)/i.test(raw)) return [];
  return [raw];
}

/** Tag a Razor view/component reference with the `view:` scheme. */
function viewScheme(raw: string): string[] {
  const name = raw.trim();
  return name ? [`view:${name}`] : [];
}

/** Reduce a Rust `use` path to the module prefix the resolver can map to a
    file, tagged `use:`. A brace group (`a::{B, C}`) collapses to its shared
    prefix (`a`); an `as` alias and a trailing wildcard/`::` are dropped. The
    remaining `crate::…`/`self::…`/`super::…` path is resolved intra-crate;
    anything else (an external crate) simply won't join to a workspace file. */
function rustUseSpec(raw: string): string[] {
  let path = raw.trim();
  const brace = path.indexOf("{");
  if (brace >= 0) path = path.slice(0, brace);
  path = path.replace(/\s+as\s+[\s\S]*$/, "").replace(/::\s*\*?\s*$/, "").trim();
  return path ? [`use:${path}`] : [];
}

/** "from MODULE import a, b as c, (d)" → the package MODULE plus each imported
    name resolved as a submodule (MODULE.name). Star imports add only MODULE. */
function collectPyFromImports(content: string, out: Set<string>): void {
  PY_FROM_IMPORT_RE.lastIndex = 0;
  for (let m = PY_FROM_IMPORT_RE.exec(content); m !== null; m = PY_FROM_IMPORT_RE.exec(content)) {
    const mod = (m[1] ?? "").trim();
    if (!mod) continue;
    out.add(mod);
    const clause = (m[2] ?? "").replace(/[()]/g, "");
    if (clause.includes("*")) continue;
    for (const part of clause.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) {
        out.add(mod.endsWith(".") ? `${mod}${name}` : `${mod}.${name}`);
      }
    }
  }
}
