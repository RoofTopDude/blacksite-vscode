/**
 * End-to-end check of the preview substrate against the *real* build artifact.
 *
 * The unit specs around this one all run on synthetic stylesheets, which proves the logic but not
 * the plumbing: the emitted sheet could be empty, could lose the design tokens to the CSS
 * injector, or could classify every real class as a utility, and every synthetic test would still
 * pass while previews rendered unstyled. This asserts the chain end to end on what actually ships.
 *
 * Skips cleanly when out/webview/preview-tokens.css is absent, so a fresh checkout that has not
 * run `npm run build` does not fail on a missing artifact.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildDesignDigest } from "../../src/preview-design-digest.js";
import { buildPreviewBaselineCss, buildPreviewDocument } from "../../src/shared/preview-baseline.js";

const sheetPath = path.resolve(__dirname, "..", "..", "out", "webview", "preview-tokens.css");
const built = fs.existsSync(sheetPath);
const sheet = built ? fs.readFileSync(sheetPath, "utf8") : "";

describe.skipIf(!built)("the emitted preview stylesheet", () => {
  it("is substantial rather than an empty file the CSS injector already drained", () => {
    expect(sheet.length).toBeGreaterThan(50_000);
  });

  /** These are the tokens theme.css maps onto the editor theme; without them a preview cannot
   *  resolve a single project colour. */
  it("carries the shadcn token bridge", () => {
    for (const token of ["--background", "--foreground", "--muted-foreground", "--border", "--radius"]) {
      expect(sheet, token).toContain(token);
    }
  });

  it("carries real component classes, not just utilities", () => {
    for (const cls of [".chat-surface", ".board-card", ".map-root"]) {
      expect(sheet, cls).toContain(cls);
    }
  });

  it("carries Tailwind utilities, so a preview can compose with them", () => {
    expect(sheet).toMatch(/\.flex\b/);
  });

  /** Previews resolve project tokens through --vscode-*, which the baseline bridges in. If the
   *  sheet stopped referencing them the bridge would be dead weight and previews would ignore the
   *  user's theme. */
  it("still resolves its palette through the bridged editor variables", () => {
    expect(sheet).toContain("--vscode-");
  });
});

describe.skipIf(!built)("the digest built from the real stylesheet", () => {
  const digest = () => buildDesignDigest(sheet, "extension");

  it("finds the project's own component families", () => {
    const prefixes = digest().components.map((group) => group.prefix);
    expect(prefixes).toEqual(expect.arrayContaining(["board", "chat", "map"]));
  });

  it("does not misclassify the design system as utilities", () => {
    const { totals } = digest();
    expect(totals.components).toBeGreaterThan(100);
  });

  it("surfaces the product's font stack, so previews inherit Lexend", () => {
    expect(digest().fontStacks.join(" ")).toContain("Lexend");
  });

  it("reports the real tokens", () => {
    const names = digest().tokens.flatMap((group) => group.tokens).map((token) => token.name);
    expect(names).toContain("background");
    expect(names).toContain("radius");
  });

  /** The whole point of the digest is that the sheet is too large to read; if it were not
   *  truncating, it would be cheaper to hand over the CSS. */
  it("truncates rather than returning the entire class list", () => {
    expect(digest().truncated).toBe(true);
  });
});

describe.skipIf(!built)("a preview document assembled from the real stylesheet", () => {
  const doc = () => buildPreviewDocument({
    code: "document.body.innerHTML = '<div class=\"chat-surface\">hello</div>';",
    projectCss: sheet,
    baselineCss: buildPreviewBaselineCss((name) => (name === "--vscode-editor-background" ? "#101014" : ""), true),
  });

  it("contains both the project sheet and the bridged theme", () => {
    const html = doc();
    expect(html).toContain(".chat-surface");
    expect(html).toContain("--vscode-editor-background:#101014;");
  });

  it("puts the project sheet before the baseline so the reset cannot precede its own tokens", () => {
    const html = doc();
    expect(html.indexOf(".chat-surface")).toBeLessThan(html.indexOf("--bs-bg:"));
  });

  it("leaves body typography to the project sheet", () => {
    expect(doc()).not.toContain("font-family:var(--bs-font)");
  });

  it("stays a single well-formed document", () => {
    const html = doc();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.match(/<\/head>/gi)).toHaveLength(1);
  });
});
