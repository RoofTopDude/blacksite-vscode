/**
 * The themed substrate every question-card preview starts from.
 *
 * The preview shell used to be a bare white page, so each preview had to invent a whole visual
 * system before it could show the thing it was proposing — which is why they came back looking
 * like unstyled test pages rather than like the product.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGED_THEME_VARS,
  PREVIEW_ALIAS_VARS,
  PREVIEW_BASE_RULES,
  buildPreviewBaselineCss,
} from "../../src/shared/preview-baseline.js";

const themed = (name: string) => (name === "--vscode-editor-background" ? " #101014 " : "");

describe("buildPreviewBaselineCss", () => {
  it("bridges a resolved theme variable through, trimmed", () => {
    expect(buildPreviewBaselineCss(themed)).toContain("--vscode-editor-background:#101014;");
  });

  /** An empty declaration would shadow the alias fallback with nothing and render a preview
   *  transparent-on-transparent, which is worse than never bridging it. */
  it("drops variables the host cannot resolve instead of emitting them empty", () => {
    const css = buildPreviewBaselineCss(themed);
    expect(css).not.toContain("--vscode-foreground:;");
    expect(css).not.toMatch(/--vscode-[a-zA-Z-]+:\s*;/);
  });

  it("always supplies the semantic aliases the tool description advertises", () => {
    const css = buildPreviewBaselineCss(() => "");
    for (const alias of ["--bs-bg", "--bs-fg", "--bs-muted", "--bs-accent", "--bs-surface", "--bs-border", "--bs-font", "--bs-mono"]) {
      expect(css, alias).toContain(`${alias}:`);
    }
  });

  it("gives every alias a literal fallback, so a preview still renders on a host with no theme", () => {
    // Each alias resolves through var(--vscode-…, <literal>); none may bottom out on a bare var().
    const aliases = PREVIEW_ALIAS_VARS.split(";").filter((d) => d.startsWith("--bs-") && d.includes("var("));
    expect(aliases.length).toBeGreaterThan(0);
    for (const decl of aliases) expect(decl, decl).toMatch(/var\([^)]+,[^)]+\)/);
  });

  it("produces a valid single :root block followed by the base rules", () => {
    const css = buildPreviewBaselineCss(themed);
    expect(css.startsWith(":root{")).toBe(true);
    expect(css.split(":root{")).toHaveLength(2);
    expect(css.endsWith(PREVIEW_BASE_RULES)).toBe(true);
    expect(css.split("{").length).toBe(css.split("}").length);
  });

  it("resets the box model and themes the body, which is the boilerplate previews kept rewriting", () => {
    const css = buildPreviewBaselineCss(themed);
    expect(css).toContain("box-sizing:border-box");
    expect(css).toContain("background:var(--bs-bg)");
    expect(css).toContain("color:var(--bs-fg)");
  });

  it("bridges the font variables, so previews inherit the editor's type rather than Times", () => {
    expect(BRIDGED_THEME_VARS).toContain("--vscode-font-family");
    expect(BRIDGED_THEME_VARS).toContain("--vscode-editor-font-family");
  });

  it("asks the host for each variable exactly once", () => {
    const seen: string[] = [];
    buildPreviewBaselineCss((n) => { seen.push(n); return ""; });
    expect(seen).toEqual([...BRIDGED_THEME_VARS]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
