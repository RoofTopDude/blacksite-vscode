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
  PREVIEW_BASE_RULES_WITH_PROJECT,
  buildPreviewBaselineCss,
  buildPreviewDocument,
  buildPreviewErrorReporter,
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

  /**
   * theme.css styles `body` from inside `@layer base`, and layered rules lose to unlayered ones —
   * so the standalone body rule would silently outrank the product's own typography and background
   * and render the preview in the wrong font. That is the exact fidelity the project sheet is
   * bridged in to supply, so it has to win.
   */
  it("stands down from styling body once the project stylesheet supplies it", () => {
    const withProject = buildPreviewBaselineCss(themed, true);
    expect(withProject).not.toContain("background:var(--bs-bg)");
    expect(withProject).not.toContain("font-family:var(--bs-font)");
    expect(withProject.endsWith(PREVIEW_BASE_RULES_WITH_PROJECT)).toBe(true);
  });

  /** theme.css resolves its own tokens through --vscode-*, so dropping the bridge alongside a
   *  project sheet would render it against hardcoded fallbacks rather than the user's theme. */
  it("still bridges the theme variables when a project stylesheet is present", () => {
    expect(buildPreviewBaselineCss(themed, true)).toContain("--vscode-editor-background:#101014;");
  });

  it("keeps the structural reset in both modes — the box model is nobody else's job", () => {
    expect(buildPreviewBaselineCss(themed, true)).toContain("box-sizing:border-box");
    expect(buildPreviewBaselineCss(themed, false)).toContain("box-sizing:border-box");
  });
});

describe("buildPreviewDocument", () => {
  const baselineCss = ":root{--bs-bg:#000;}";

  it("injects the project stylesheet ahead of the baseline, so the preview's own rules still win", () => {
    const doc = buildPreviewDocument({ code: "x", projectCss: ".card{color:red}", baselineCss });
    expect(doc.indexOf(".card{color:red}")).toBeLessThan(doc.indexOf(baselineCss));
  });

  it("omits the project style tag entirely when there is no sheet, rather than emitting an empty one", () => {
    expect(buildPreviewDocument({ code: "x", baselineCss })).toContain(`<style>${baselineCss}</style>`);
    expect(buildPreviewDocument({ code: "x", baselineCss }).match(/<style>/g)).toHaveLength(1);
  });

  it("places mount CSS after the baseline so component styles are not reset by it", () => {
    const doc = buildPreviewDocument({ code: "x", baselineCss, extraCss: ".mounted{gap:2px}" });
    expect(doc.indexOf(baselineCss)).toBeLessThan(doc.indexOf(".mounted{gap:2px}"));
  });

  /** blob: documents inherit the creating context's CSP, so an un-nonced script is silently
   *  blocked and the iframe renders blank with no error anywhere. */
  it("nonces both injected scripts when a nonce is supplied", () => {
    const doc = buildPreviewDocument({ code: "run()", baselineCss, nonce: "abc123" });
    expect(doc.match(/nonce="abc123"/g)).toHaveLength(2);
  });

  it("omits the nonce attribute for a headless render, which has no CSP to satisfy", () => {
    expect(buildPreviewDocument({ code: "run()", baselineCss })).not.toContain("nonce=");
  });

  it("injects into a custom shell's head rather than appending past it", () => {
    const doc = buildPreviewDocument({
      html: "<!doctype html><html><head><title>t</title></head><body><main></main></body></html>",
      code: "run()",
      baselineCss,
    });
    expect(doc.indexOf(baselineCss)).toBeLessThan(doc.indexOf("</head>"));
    expect(doc).toContain("<main></main>");
  });

  it("falls back to a themed default shell when the preview supplies none", () => {
    expect(buildPreviewDocument({ code: "run()", baselineCss })).toContain("<!DOCTYPE html>");
  });

  /** The generated document must not terminate the script tag that carries it. */
  it("never emits a literal closing script tag from its own source", () => {
    const doc = buildPreviewDocument({ code: "const a = 1;", baselineCss });
    expect(doc).toContain("</" + "script>");
    expect(doc.split("<" + "script").length - 1).toBe(2);
  });

  it("runs the error reporter before the preview module, so a throw on line one is still caught", () => {
    const doc = buildPreviewDocument({ code: "throw new Error('boom')", baselineCss });
    expect(doc.indexOf("__previewErrors")).toBeLessThan(doc.indexOf("throw new Error('boom')"));
  });
});

describe("buildPreviewErrorReporter", () => {
  /** The headless renderer has no parent frame to postMessage to, so errors must also be readable
   *  off the page itself or the agent's rehearsal silently reports success on a broken preview. */
  it("records errors on the window as well as posting them to the parent", () => {
    const reporter = buildPreviewErrorReporter();
    expect(reporter).toContain("window.__previewErrors");
    expect(reporter).toContain("parent.postMessage");
  });

  it("survives having no parent to post to", () => {
    expect(buildPreviewErrorReporter()).toMatch(/try\s*\{[\s\S]*parent\.postMessage[\s\S]*\}\s*catch/);
  });

  it("covers unhandled rejections, not just synchronous throws", () => {
    expect(buildPreviewErrorReporter()).toContain("unhandledrejection");
  });
});
