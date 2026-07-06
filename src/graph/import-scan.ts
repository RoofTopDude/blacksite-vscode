/* Pure regex import extraction. Fast, language-limited by design: the goal is
   a good-enough dependency skeleton for the map, not a compiler-grade graph.
   An LSP enrichment pass can add edges later without touching this module.

   Coverage is biased toward references that can be resolved back to a workspace
   file: relative imports, quoted C/C++ includes, Rust `mod`, `require_relative`,
   HTML `src`/`href`, Go module imports (resolved against go.mod), Java
   FQCNs (resolved against source roots), and C# `using`/`using static`
   references — plus bare TS/JS specifiers when a
   tsconfig/jsconfig `paths`/`baseUrl` alias maps them back into the tree (see
   resolve-imports.ts + tsconfig-paths.ts). Constructs that name a package
   registry or a pure namespace with no workspace file behind them (external npm
   specifiers, stdlib namespaces, third-party registry packages) still produce
   no edge, by design. */

const MAX_SCAN_CHARS = 512_000;

const TS_JS_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const STYLE_LANGS = new Set(["css", "scss", "less"]);
const C_LANGS = new Set(["c", "h", "cpp", "hpp", "cc", "cxx", "hxx", "hh"]);
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
/* C#: namespace imports, alias imports, and `using static` for type members.
   Emitted with `csharp-*:` tags so the resolver can distinguish namespace-only
   lookups from exact-type lookups. */
const CSHARP_USING_RE = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?!static\b)([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)[ \t]*;/gm;
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
  const lang = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const body = content.length > MAX_SCAN_CHARS ? content.slice(0, MAX_SCAN_CHARS) : content;
  const specs = new Set<string>();

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
  } else if (lang === "json") {
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
  } else if (lang === "cs") {
    collect(CSHARP_USING_RE, body, specs, (name) => [`csharp-ns:${name}`]);
    collect(CSHARP_ALIAS_RE, body, specs, (name) => [`csharp-alias:${name}`]);
    collect(CSHARP_STATIC_USING_RE, body, specs, (name) => [`csharp-type:${name}`]);
  } else if (lang === "rb") {
    collect(RUBY_REQUIRE_RE, body, specs);
    collect(RUBY_REL_REQUIRE_RE, body, specs);
  } else if (lang === "php") {
    collect(PHP_REQUIRE_RE, body, specs);
  } else if (lang === "html" || lang === "htm") {
    collect(HTML_ASSET_RE, body, specs, htmlAsset);
  }

  return [...specs];
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
    tsconfig `references` paths / any explicitly-relative string value. The URL
    fragment on a `$ref` ("common.json#/defs") is dropped so only the file part
    remains. */
function collectJsonReferences(content: string, out: Set<string>): void {
  const add = (raw: string | undefined): void => {
    const value = raw?.split("#")[0]?.trim();
    if (value) out.add(value);
  };
  for (const m of content.matchAll(JSON_KEYED_REF_RE)) add(m[1]);
  for (const m of content.matchAll(JSON_PATH_REF_RE)) add(m[1]);
  for (const m of content.matchAll(JSON_RELATIVE_STRING_RE)) add(m[1]);
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
