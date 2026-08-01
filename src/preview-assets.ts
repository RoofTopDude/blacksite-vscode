import * as fs from "fs";
import * as path from "path";

/**
 * Supplies question-card previews with the design system of the project being worked on.
 *
 * A preview runs in a sandboxed blob iframe that inherits nothing from the surface that created
 * it. Bridging the editor theme (src/shared/preview-baseline.ts) gave those previews the right
 * colours, but not the product: the workspace's own stylesheet — its tokens, component classes and
 * utility layer — still stopped at the iframe boundary. An agent proposing a change to a component
 * therefore had to rebuild that component from memory in hand-written CSS before it could show the
 * one thing it was actually proposing, which is why previews came back as loose sketches rather
 * than prototypes. Handing over the real sheet turns "reconstruct the component" into "restyle the
 * component", so the effort goes into the proposal instead of the scaffolding.
 *
 * Resolution is workspace-first on purpose. The stylesheet that makes a preview true-to-form is
 * the one belonging to the project in the editor, not the one belonging to Blacksite; falling
 * straight back to the extension's own sheet would quietly dress a preview of someone else's app
 * in Blacksite's design system, which is worse than no stylesheet at all because it looks
 * deliberate. The extension sheet is the last resort, and it is the correct answer in exactly one
 * case: when the project in the editor *is* Blacksite.
 *
 * Read host-side rather than in the webview so both preview surfaces — the inline chat frame and
 * the side-by-side comparison panel — serve identical bytes from one source. The comparison panel
 * is a separate webview that loads no React bundle and so has no stylesheet of its own to borrow.
 */

/** Emitted by the webview build (see emitPreviewStylesheet in vite.webview.config.mjs). */
export const PREVIEW_STYLESHEET = "preview-tokens.css";

/**
 * Conventional workspace locations probed when no explicit path is configured, in priority order.
 * `.blacksite/` first so a project can point at a hand-picked sheet without touching its build.
 */
export const WORKSPACE_CSS_CANDIDATES: readonly string[] = [
  `.blacksite/${PREVIEW_STYLESHEET}`,
  `out/webview/${PREVIEW_STYLESHEET}`,
  `dist/${PREVIEW_STYLESHEET}`,
  `build/${PREVIEW_STYLESHEET}`,
];

/** Common uncompiled entry sheets. These are a lower-fidelity fallback than a build artefact —
 *  framework directives may not expand — but their tokens, authored classes, fonts and global
 *  composition still describe the project more truthfully than an unrelated extension theme. */
export const WORKSPACE_SOURCE_CSS_CANDIDATES: readonly string[] = [
  "src/index.css", "src/main.css", "src/app.css", "src/globals.css",
  "app/globals.css", "styles/globals.css", "styles/index.css", "styles/main.css",
  "src/styles.css", "src/styles/globals.css", "src/styles/index.css", "src/styles/main.css",
  "src/webview/react/theme.css",
];

/** Build systems generally fingerprint their CSS, so exact conventional filenames cannot find
 *  them. Search only known output asset roots — never the workspace recursively — and keep a hard
 *  byte/file ceiling because the chosen sheets are embedded into every live preview document. */
export const WORKSPACE_CSS_ASSET_DIRS: readonly string[] = [
  "dist/assets", "build/assets", "out/assets", "public/build/assets", ".next/static/css",
];
const MAX_DISCOVERED_CSS_FILES = 8;
const MAX_DISCOVERED_CSS_BYTES = 4 * 1024 * 1024;

/**
 * Lexend, bundled under out/webview/fonts and declared in shell.html against webview resource
 * URIs. Those URIs are useless to a preview: a `sandbox="allow-scripts"` blob frame is an opaque
 * origin and cannot fetch `vscode-webview://` resources, so the @font-face has to be re-declared
 * with the font embedded. Typography is most of what makes a preview read as the product, so this
 * is worth the ~100 KB of base64 rather than letting previews fall back to a system face.
 *
 * Ranges mirror shell.html — keep the two in step if the bundled subsets ever change.
 */
const FONT_FACES: readonly { file: string; unicodeRange: string }[] = [
  {
    file: "lexend-latin.woff2",
    unicodeRange:
      "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, "
      + "U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    file: "lexend-latin-ext.woff2",
    unicodeRange:
      "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, "
      + "U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, "
      + "U+2C60-2C7F, U+A720-A7FF",
  },
];

/** `@font-face` blocks with the woff2 payloads inlined as data: URIs. Missing files are skipped
 *  rather than failing the load — a preview in the wrong typeface still beats no preview. */
export function buildPreviewFontCss(fontsDir: string): string {
  const blocks: string[] = [];
  for (const face of FONT_FACES) {
    let encoded: string;
    try { encoded = fs.readFileSync(path.join(fontsDir, face.file)).toString("base64"); }
    catch { continue; }
    blocks.push(
      "@font-face{font-family:'Lexend';font-style:normal;font-weight:100 900;font-display:swap;"
      + `src:url(data:font/woff2;base64,${encoded}) format('woff2');`
      + `unicode-range:${face.unicodeRange};}`,
    );
  }
  return blocks.join("");
}

export interface PreviewCssRequest {
  /** The extension's own out/webview — last-resort fallback, and the right answer when the
   *  workspace is Blacksite itself. */
  extensionOutWebviewDir: string;
  workspaceRoot?: string;
  /** Workspace-relative stylesheet paths from `blacksite.preview.projectStylesheet`. When set,
   *  these win outright: an explicit choice should never lose to a probe. */
  configuredPaths?: readonly string[];
}

export interface PreviewCssResult {
  css: string;
  /** Which rule supplied the sheet — surfaced to the agent so it knows whose design system it is
   *  drawing with, and reported in tests. */
  origin: "configured" | "workspace" | "extension" | "none";
  /** Absolute paths actually read, for diagnostics. */
  files: string[];
}

/** Reads and concatenates whichever of `files` exist. */
function readAll(files: string[]): { css: string; read: string[] } {
  const parts: string[] = [];
  const read: string[] = [];
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(file, "utf8"));
      read.push(file);
    } catch { /* a missing candidate is not an error — the caller falls through */ }
  }
  return { css: parts.join("\n"), read };
}

/** Finds fingerprinted build CSS under a small set of conventional output roots. Names such as
 *  global, main and app come first so a route chunk cannot displace the design-system substrate;
 *  within that tier the largest sheets win because they normally hold shared tokens/utilities. */
function discoverBuiltCss(workspaceRoot: string): string[] {
  const found: { file: string; size: number; priority: number }[] = [];
  for (const relativeDir of WORKSPACE_CSS_ASSET_DIRS) {
    const assetRoot = path.resolve(workspaceRoot, relativeDir);
    if (!fs.existsSync(assetRoot)) continue;
    const stack: { dir: string; depth: number }[] = [{ dir: assetRoot, depth: 0 }];
    while (stack.length) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const file = path.join(current.dir, entry.name);
        if (entry.isDirectory() && current.depth < 3) {
          stack.push({ dir: file, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".css") continue;
        try {
          const size = fs.statSync(file).size;
          if (size <= 0 || size > MAX_DISCOVERED_CSS_BYTES) continue;
          found.push({
            file,
            size,
            priority: /(?:^|[-_.])(global|main|index|app|style)(?:[-_.]|$)/i.test(entry.name) ? 1 : 0,
          });
        } catch { /* a disappearing build output is simply not a candidate */ }
      }
    }
  }
  found.sort((a, b) => b.priority - a.priority || b.size - a.size || a.file.localeCompare(b.file));
  const selected: string[] = [];
  let bytes = 0;
  for (const candidate of found) {
    if (selected.length >= MAX_DISCOVERED_CSS_FILES || bytes + candidate.size > MAX_DISCOVERED_CSS_BYTES) continue;
    selected.push(candidate.file);
    bytes += candidate.size;
  }
  return selected;
}

/** The extension stylesheet is a truthful fallback only when no project is open or the project
 *  is the extension itself. Injecting it into an unrelated workspace would make a preview look
 *  polished but project-inaccurate — more misleading than the neutral themed baseline. */
function mayUseExtensionCss(extensionOutWebviewDir: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return true;
  if (!extensionOutWebviewDir) return false;
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(extensionOutWebviewDir));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Cache key covers every input that can change the answer. */
const cache = new Map<string, PreviewCssResult>();

/**
 * The project stylesheet a preview should be rendered against.
 *
 * `origin: "none"` with empty css means no sheet was found anywhere; callers must treat that as
 * "fall back to the theme-variable baseline alone" so previews degrade to their previous
 * behaviour rather than break.
 */
export function resolvePreviewProjectCss(request: PreviewCssRequest): PreviewCssResult {
  const key = JSON.stringify([
    request.extensionOutWebviewDir,
    request.workspaceRoot ?? "",
    [...(request.configuredPaths ?? [])],
  ]);
  const cached = cache.get(key);
  if (cached) return cached;

  const root = request.workspaceRoot;
  const fonts = buildPreviewFontCss(path.join(request.extensionOutWebviewDir, "fonts"));
  let result: PreviewCssResult = { css: "", origin: "none", files: [] };

  const configured = request.configuredPaths ?? [];
  if (root && configured.length) {
    const { css, read } = readAll(configured.map((rel) => path.resolve(root, rel)));
    if (css.trim()) result = { css: fonts + css, origin: "configured", files: read };
  }

  if (result.origin === "none" && root) {
    for (const candidate of WORKSPACE_CSS_CANDIDATES) {
      const { css, read } = readAll([path.resolve(root, candidate)]);
      if (css.trim()) { result = { css: fonts + css, origin: "workspace", files: read }; break; }
    }
  }

  if (result.origin === "none" && root) {
    const { css, read } = readAll(discoverBuiltCss(root));
    if (css.trim()) result = { css: fonts + css, origin: "workspace", files: read };
  }

  if (result.origin === "none" && root) {
    for (const candidate of WORKSPACE_SOURCE_CSS_CANDIDATES) {
      const { css, read } = readAll([path.resolve(root, candidate)]);
      if (css.trim()) { result = { css: fonts + css, origin: "workspace", files: read }; break; }
    }
  }

  if (result.origin === "none" && mayUseExtensionCss(request.extensionOutWebviewDir, root)) {
    const { css, read } = readAll([path.join(request.extensionOutWebviewDir, PREVIEW_STYLESHEET)]);
    if (css.trim()) result = { css: fonts + css, origin: "extension", files: read };
  }

  cache.set(key, result);
  return result;
}

/** Test seam — the module-level cache would otherwise outlive a fixture directory. */
export function clearPreviewAssetCache(): void {
  cache.clear();
}
