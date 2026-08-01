/**
 * Resolving the design system a question-card preview renders against.
 *
 * The stylesheet that makes a preview true-to-form is the one belonging to the project in the
 * editor. Falling straight back to Blacksite's own sheet would dress a preview of someone else's
 * app in Blacksite's design system — worse than no stylesheet, because it looks deliberate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  WORKSPACE_CSS_CANDIDATES,
  WORKSPACE_CSS_ASSET_DIRS,
  WORKSPACE_SOURCE_CSS_CANDIDATES,
  buildPreviewFontCss,
  clearPreviewAssetCache,
  resolvePreviewProjectCss,
} from "../../src/preview-assets.js";

let root: string;
let extensionOut: string;
let workspace: string;

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-preview-assets-"));
  extensionOut = path.join(root, "extension", "out", "webview");
  workspace = path.join(root, "workspace");
  fs.mkdirSync(extensionOut, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  clearPreviewAssetCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearPreviewAssetCache();
});

describe("resolvePreviewProjectCss", () => {
  it("prefers the workspace's own stylesheet over the extension's", () => {
    write(path.join(extensionOut, "preview-tokens.css"), ".blacksite-own{color:red}");
    write(path.join(workspace, "out/webview/preview-tokens.css"), ".project-own{color:blue}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(result.origin).toBe("workspace");
    expect(result.css).toContain(".project-own");
    expect(result.css).not.toContain(".blacksite-own");
  });

  /** An explicit setting is a decision; a probe is a guess. The decision has to win. */
  it("lets a configured path beat a discoverable one", () => {
    write(path.join(workspace, "out/webview/preview-tokens.css"), ".discovered{}");
    write(path.join(workspace, "styles/custom.css"), ".configured{}");
    const result = resolvePreviewProjectCss({
      extensionOutWebviewDir: extensionOut,
      workspaceRoot: workspace,
      configuredPaths: ["styles/custom.css"],
    });
    expect(result.origin).toBe("configured");
    expect(result.css).toContain(".configured");
  });

  it("concatenates several configured sheets so a project can compose its own", () => {
    write(path.join(workspace, "a.css"), ".a{}");
    write(path.join(workspace, "b.css"), ".b{}");
    const result = resolvePreviewProjectCss({
      extensionOutWebviewDir: extensionOut,
      workspaceRoot: workspace,
      configuredPaths: ["a.css", "b.css"],
    });
    expect(result.css).toContain(".a{}");
    expect(result.css).toContain(".b{}");
    expect(result.files).toHaveLength(2);
  });

  /** A configured path that no longer exists must not strand previews with no styling at all. */
  it("falls through to discovery when every configured path is missing", () => {
    write(path.join(workspace, "out/webview/preview-tokens.css"), ".discovered{}");
    const result = resolvePreviewProjectCss({
      extensionOutWebviewDir: extensionOut,
      workspaceRoot: workspace,
      configuredPaths: ["styles/does-not-exist.css"],
    });
    expect(result.origin).toBe("workspace");
  });

  it("does not dress an unrelated project in the extension's own design system", () => {
    write(path.join(extensionOut, "preview-tokens.css"), ".blacksite-own{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(result).toMatchObject({ origin: "none", css: "", files: [] });
  });

  it("uses the extension sheet when the open workspace owns that build output", () => {
    const localExtensionOut = path.join(workspace, "extension", "out", "webview");
    write(path.join(localExtensionOut, "preview-tokens.css"), ".blacksite-own{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: localExtensionOut, workspaceRoot: workspace });
    expect(result.origin).toBe("extension");
    expect(result.css).toContain(".blacksite-own");
  });

  /** Callers branch on this to keep the standalone body rules, so it must be reported honestly
   *  rather than papered over with an empty string that still claims an origin. */
  it("reports 'none' when there is no stylesheet anywhere", () => {
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(result).toMatchObject({ origin: "none", css: "", files: [] });
  });

  it("probes the documented candidate locations in order", () => {
    expect(WORKSPACE_CSS_CANDIDATES[0]).toBe(".blacksite/preview-tokens.css");
    write(path.join(workspace, ".blacksite/preview-tokens.css"), ".first{}");
    write(path.join(workspace, "dist/preview-tokens.css"), ".second{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(result.css).toContain(".first{}");
    expect(result.css).not.toContain(".second{}");
  });

  it("finds fingerprinted CSS in common build asset directories", () => {
    write(path.join(workspace, "dist/assets/app-a1b2c3.css"), ":root{--brand:orchid}.product-shell{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(WORKSPACE_CSS_ASSET_DIRS).toContain("dist/assets");
    expect(result.origin).toBe("workspace");
    expect(result.css).toContain("--brand:orchid");
  });

  it("prefers a compiled asset bundle over a conventional source entry", () => {
    write(path.join(workspace, "dist/assets/main-123.css"), ".compiled-project{}");
    write(path.join(workspace, "src/index.css"), ".source-project{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(result.css).toContain(".compiled-project{}");
    expect(result.css).not.toContain(".source-project{}");
  });

  it("falls back to a conventional source stylesheet when no build exists", () => {
    write(path.join(workspace, "src/globals.css"), ":root{--product-accent:tomato}.source-shell{}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(WORKSPACE_SOURCE_CSS_CANDIDATES).toContain("src/globals.css");
    expect(result.origin).toBe("workspace");
    expect(result.css).toContain("--product-accent:tomato");
  });

  it("ignores a whitespace-only sheet rather than treating it as a design system", () => {
    write(path.join(workspace, "out/webview/preview-tokens.css"), "   \n\t ");
    write(path.join(extensionOut, "preview-tokens.css"), ".blacksite-own{}");
    expect(resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace }).origin)
      .toBe("none");
  });

  it("works with no workspace open at all", () => {
    write(path.join(extensionOut, "preview-tokens.css"), ".blacksite-own{}");
    expect(resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut }).origin).toBe("extension");
  });

  /** Re-reading 240 KB and re-encoding two fonts for every option of every question is pure waste. */
  it("caches per input set", () => {
    const file = path.join(workspace, "out/webview/preview-tokens.css");
    write(file, ".first{}");
    const first = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    write(file, ".changed{}");
    const second = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace });
    expect(second.css).toBe(first.css);
    clearPreviewAssetCache();
    expect(resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace }).css)
      .toContain(".changed{}");
  });

  it("keys the cache on the workspace, so two projects never share a design system", () => {
    const other = path.join(root, "other-workspace");
    fs.mkdirSync(other, { recursive: true });
    write(path.join(workspace, "out/webview/preview-tokens.css"), ".project-a{}");
    write(path.join(other, "out/webview/preview-tokens.css"), ".project-b{}");
    expect(resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: workspace }).css)
      .toContain(".project-a{}");
    expect(resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut, workspaceRoot: other }).css)
      .toContain(".project-b{}");
  });
});

describe("buildPreviewFontCss", () => {
  /** A sandboxed blob frame is an opaque origin and cannot fetch vscode-webview:// resources, so
   *  the font has to travel inside the document or previews silently lose the product's type. */
  it("inlines the woff2 as a data URI", () => {
    const fonts = path.join(extensionOut, "fonts");
    fs.mkdirSync(fonts, { recursive: true });
    fs.writeFileSync(path.join(fonts, "lexend-latin.woff2"), Buffer.from([1, 2, 3, 4]));
    const css = buildPreviewFontCss(fonts);
    expect(css).toContain("@font-face");
    expect(css).toContain("font-family:'Lexend'");
    expect(css).toContain(`url(data:font/woff2;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")})`);
    expect(css).toContain("unicode-range:");
  });

  it("skips a missing subset instead of failing the whole load", () => {
    const fonts = path.join(extensionOut, "fonts");
    fs.mkdirSync(fonts, { recursive: true });
    fs.writeFileSync(path.join(fonts, "lexend-latin.woff2"), Buffer.from([9]));
    expect(buildPreviewFontCss(fonts).match(/@font-face/g)).toHaveLength(1);
  });

  it("returns nothing at all when no fonts are bundled", () => {
    expect(buildPreviewFontCss(path.join(root, "nowhere"))).toBe("");
  });

  it("puts the font faces ahead of the sheet that references them", () => {
    const fonts = path.join(extensionOut, "fonts");
    fs.mkdirSync(fonts, { recursive: true });
    fs.writeFileSync(path.join(fonts, "lexend-latin.woff2"), Buffer.from([1]));
    write(path.join(extensionOut, "preview-tokens.css"), "body{font-family:'Lexend'}");
    const result = resolvePreviewProjectCss({ extensionOutWebviewDir: extensionOut });
    expect(result.css.indexOf("@font-face")).toBeLessThan(result.css.indexOf("body{font-family"));
  });
});
