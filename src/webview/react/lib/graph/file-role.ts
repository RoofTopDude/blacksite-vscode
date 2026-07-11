/* Functional-role classification for map files — what a file is *for*, as far as
   its path can tell, independent of language (lang answers "what syntax", role
   answers "what job"). Pure and deterministic so the renderer's star marks, the
   node card, and territory-zone styling all agree, and it stays unit-testable. */

export type FileRole =
  | "source"   // default — product code
  | "test"     // specs, fixtures under test dirs
  | "config"   // manifests, rc files, build/tool configuration
  | "docs"     // markdown & friends
  | "styles"   // css-family
  | "types"    // declaration/type-only modules
  | "entry"    // index/main/app style entry & barrel modules
  | "data"     // datasets: sql/csv/fixtures
  | "assets";  // images, fonts, static media

export const FILE_ROLE_LABELS: Record<FileRole, string> = {
  source: "Source",
  test: "Test",
  config: "Config",
  docs: "Docs",
  styles: "Styles",
  types: "Types",
  entry: "Entry point",
  data: "Data",
  assets: "Asset",
};

/** Marker tint per role (0xRRGGBB). Deliberately quiet, sitting in the same
    family as the existing badge colors — role is chrome, not a second star. */
export const FILE_ROLE_COLORS: Record<FileRole, number> = {
  source: 0x8fa9d6,  // steel blue (unused — source draws no mark)
  test: 0x81c784,    // green — "verified by"
  config: 0x93c5fd,  // blue — mirrors the service-lens config edge color
  docs: 0xd6c08f,    // parchment
  styles: 0xc084fc,  // purple
  types: 0x5eead4,   // teal
  entry: 0xfacc15,   // gold — "the way in"
  data: 0xa78bfa,    // violet — mirrors the service-lens data edge color
  assets: 0x9e9e9e,  // neutral
};

const DOCS_EXTS = new Set(["md", "mdx", "rst", "adoc", "txt"]);
const STYLE_EXTS = new Set(["css", "scss", "sass", "less", "styl"]);
const CONFIG_EXTS = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini", "env", "properties", "webmanifest"]);
const DATA_EXTS = new Set(["sql", "csv", "tsv", "jsonl", "ndjson", "parquet"]);
/* JSON/YAML are config *by default* (the far more common case in a repo), but a
   payload-named or payload-homed one — data.json, meta.json, locales/en.json,
   fixtures — is content, not configuration, and should read as data. */
const STRUCTURED_TEXT_EXTS = new Set(["json", "jsonc", "json5", "yaml", "yml", "xml"]);
const DATA_NAME_RE = /^(data|meta|metadata)\.(json|jsonc|json5|yaml|yml|xml)$/;
const DATA_SUFFIX_RE = /\.(data|meta|fixture|fixtures|snapshot|snap|sample|seed)\.(json|jsonc|json5|yaml|yml|xml)$/;
const DATA_SEGMENTS = new Set(["data", "dataset", "datasets", "fixtures", "seeds", "samples", "locales", "i18n", "translations", "lang"]);
const ASSET_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "woff", "woff2", "ttf", "eot", "mp3", "mp4"]);
const TEST_SEGMENTS = new Set(["__tests__", "__mocks__", "test", "tests", "spec", "specs", "e2e", "fixtures"]);
const CONFIG_SEGMENTS = new Set([".vscode", ".github", ".config", "config", "configs"]);
const DOC_SEGMENTS = new Set(["docs", "doc"]);
const ENTRY_BASENAMES = new Set([
  "index", "main", "app", "extension", "server", "cli", "program",
  "__init__", "__main__", "mod", "lib",
]);

function extOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

/** Classify a workspace-relative path into its functional role. Precedence is
    most-specific-signal first: an explicit test marker beats everything (a
    `foo.config.spec.ts` is a test), declarations beat entry naming (`index.d.ts`
    is types, not an entry point), and role-by-extension comes last. */
export function fileRole(id: string): FileRole {
  const path = id.replace(/\\/g, "/").toLowerCase();
  const segments = path.split("/");
  const basename = segments[segments.length - 1] ?? "";
  const dirSegments = segments.slice(0, -1);
  const ext = extOf(basename);

  // Tests: name markers or a test-ish directory anywhere above the file.
  if (/\.(test|spec)\.[a-z0-9]+$/.test(basename) || /_test\.(go|py|rb|rs|ex|exs)$/.test(basename) || /^test_[^/]*\.py$/.test(basename)) return "test";
  if (dirSegments.some((segment) => TEST_SEGMENTS.has(segment))) {
    // Fixtures inside test dirs still read best as data — including JSON/YAML
    // payloads (tests/fixtures/users.json is content, not a test).
    return DATA_EXTS.has(ext) || STRUCTURED_TEXT_EXTS.has(ext) ? "data" : "test";
  }

  if (basename.endsWith(".d.ts")) return "types";
  if (/^(types|typings|interfaces)\.[a-z0-9]+$/.test(basename) || dirSegments.some((segment) => segment === "types" || segment === "typings" || segment === "@types")) return "types";

  // Config: rc/dotfiles, *.config.*, known manifests, config-ish dirs, config extensions.
  if (/^\.[^/]+rc(\.[a-z0-9]+)?$/.test(basename) || /\.config\.[a-z0-9]+$/.test(basename)) return "config";
  if (/^(package|tsconfig|jsconfig|composer|deno|bun)([-.][^/]*)?\.json$/.test(basename) || basename === "dockerfile" || basename === "makefile") return "config";

  // Payload JSON/YAML: named as data (meta.json, data.json, foo.fixture.json) or
  // homed in a data-ish directory (data/, locales/, seeds/, …). Checked after the
  // known config manifests above — a package.json in a data dir is still config —
  // but before the config-dir/extension fallbacks, which would otherwise claim
  // every .json as configuration.
  if (DATA_NAME_RE.test(basename) || DATA_SUFFIX_RE.test(basename)) return "data";
  if ((STRUCTURED_TEXT_EXTS.has(ext) || DATA_EXTS.has(ext)) && dirSegments.some((segment) => DATA_SEGMENTS.has(segment))) return "data";

  if (dirSegments.some((segment) => CONFIG_SEGMENTS.has(segment))) return "config";

  if (DOCS_EXTS.has(ext) || dirSegments.some((segment) => DOC_SEGMENTS.has(segment))) return "docs";
  if (STYLE_EXTS.has(ext)) return "styles";
  if (DATA_EXTS.has(ext)) return "data";
  if (ASSET_EXTS.has(ext)) return "assets";
  if (CONFIG_EXTS.has(ext)) return "config";

  const stem = basename.slice(0, basename.length - (ext ? ext.length + 1 : 0));
  if (ENTRY_BASENAMES.has(stem)) return "entry";

  return "source";
}

/** The dominant *denoted* role of a group of files — drives territory-zone
    styling. Returns null unless a non-source role holds a clear majority
    (> half), so mixed zones keep the default look instead of flickering
    between styles as membership shifts. */
export function dominantZoneRole(ids: readonly string[]): FileRole | null {
  if (ids.length === 0) return null;
  const counts = new Map<FileRole, number>();
  for (const id of ids) {
    const role = fileRole(id);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  let best: FileRole | null = null;
  let bestCount = 0;
  for (const [role, count] of counts) {
    if (role === "source") continue;
    if (count > bestCount) { best = role; bestCount = count; }
  }
  return best && bestCount * 2 > ids.length ? best : null;
}
