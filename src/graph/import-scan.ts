/* Pure regex import extraction. Fast, language-limited by design: the goal is
   a good-enough dependency skeleton for the map, not a compiler-grade graph.
   An LSP enrichment pass can add edges later without touching this module. */

const MAX_SCAN_CHARS = 512_000;

const TS_JS_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const STYLE_LANGS = new Set(["css", "scss", "less"]);

/* Matches the specifier in: import x from "s"; import "s"; export * from "s";
   export { a } from "s". The from-clause group must be reluctant (??) so a
   bare side-effect import isn't swallowed while hunting for the next "from",
   and it may not cross quotes/semicolons (statement boundaries). */
const ES_IMPORT_RE = /(?:^|\s)(?:import|export)\s+(?:[^"';]*?\sfrom\s+)??["']([^"'\n]+)["']/g;
/* require("s") and dynamic import("s") */
const CALL_IMPORT_RE = /(?:\brequire|\bimport)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
/* Python: "import a.b as c, d.e" and "from a.b import c" (relative dots kept) */
const PY_IMPORT_RE = /^[ \t]*import[ \t]+([\w. \t,]+)/gm;
const PY_FROM_RE = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm;
/* CSS: @import "s"; @import url(s); @use "s" (scss) */
const CSS_IMPORT_RE = /@(?:import|use)\s+(?:url\(\s*)?["']?([^"')\n;]+)["']?\s*\)?/g;

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
    written (e.g. "./util.js", "react", "..models.user") — resolution against
    the workspace file set happens in resolve-imports.ts. */
export function extractImports(relPath: string, content: string): string[] {
  const lang = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const body = content.length > MAX_SCAN_CHARS ? content.slice(0, MAX_SCAN_CHARS) : content;
  const specs = new Set<string>();

  if (TS_JS_LANGS.has(lang)) {
    collect(ES_IMPORT_RE, body, specs);
    collect(CALL_IMPORT_RE, body, specs);
  } else if (lang === "py") {
    collect(PY_IMPORT_RE, body, specs, (raw) =>
      raw.split(",").map((part) => part.trim().split(/[ \t]+as[ \t]+/)[0] ?? ""));
    collect(PY_FROM_RE, body, specs);
  } else if (STYLE_LANGS.has(lang)) {
    collect(CSS_IMPORT_RE, body, specs);
  }

  return [...specs];
}
