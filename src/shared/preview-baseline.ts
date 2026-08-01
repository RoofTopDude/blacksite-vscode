/**
 * The stylesheet every question-card preview starts from.
 *
 * A preview runs in a sandboxed blob: iframe, which inherits nothing from the surface that
 * created it. The shell was therefore a bare white page — no theme, no fonts, no colours, no
 * metrics — and every preview had to invent an entire visual system from scratch before it could
 * show the one thing it was actually proposing. That is a tax paid on every option of every
 * question, and it is why previews came back looking like unstyled test pages rather than like
 * the product they were suggesting a change to.
 *
 * Bridging the live theme in means an option can be *drawn* rather than rebuilt, and follows
 * whatever theme the viewer is running without the preview knowing anything about it.
 *
 * Shared rather than duplicated because two surfaces render these previews — the inline frame in
 * chat (SandboxPreview) and the side-by-side comparison panel — and a preview that looked
 * different depending on which one you opened would defeat the point of comparing them. Neither
 * caller can be handed a finished string: the values live in CSS custom properties that only
 * exist inside a webview, so each reads them itself and calls {@link buildPreviewBaselineCss}.
 */

/** Theme variables copied into the iframe. Curated rather than exhaustive: enough to build a
 *  convincing surface, few enough to stay readable in the generated `:root` block. */
export const BRIDGED_THEME_VARS: readonly string[] = [
  "--vscode-editor-background", "--vscode-editor-foreground", "--vscode-foreground",
  "--vscode-descriptionForeground", "--vscode-focusBorder", "--vscode-panel-border",
  "--vscode-widget-border", "--vscode-button-background", "--vscode-button-foreground",
  "--vscode-button-hoverBackground", "--vscode-button-secondaryBackground",
  "--vscode-button-secondaryForeground", "--vscode-input-background", "--vscode-input-foreground",
  "--vscode-input-placeholderForeground", "--vscode-textLink-foreground", "--vscode-badge-background",
  "--vscode-badge-foreground", "--vscode-list-hoverBackground", "--vscode-list-activeSelectionBackground",
  "--vscode-editorError-foreground", "--vscode-editorWarning-foreground", "--vscode-charts-green",
  "--vscode-charts-blue", "--vscode-charts-orange", "--vscode-charts-purple", "--vscode-charts-red",
  "--vscode-editorWidget-background", "--vscode-scrollbarSlider-background",
  "--vscode-font-family", "--vscode-editor-font-family", "--vscode-font-size",
];

/**
 * Short semantic aliases layered over the bridged variables.
 *
 * These are the names the tool description advertises to the agent, and they exist so a preview
 * can say `var(--bs-accent)` without first having to know which of VS Code's several hundred
 * theme variables is the right one — the lookup problem was itself part of why previews ignored
 * the theme and hardcoded colours instead. Every alias carries a literal fallback so a preview
 * still renders sanely if a host ever fails to supply the variable behind it.
 */
export const PREVIEW_ALIAS_VARS: string =
  "--bs-bg:var(--vscode-editor-background,#1e1e1e);"
  + "--bs-fg:var(--vscode-editor-foreground,#dddddd);"
  + "--bs-muted:var(--vscode-descriptionForeground,#8b8b8b);"
  + "--bs-accent:var(--vscode-textLink-foreground,#4daafc);"
  + "--bs-border:var(--vscode-panel-border,rgba(128,128,128,.35));"
  + "--bs-surface:var(--vscode-editorWidget-background,rgba(128,128,128,.08));"
  + "--bs-danger:var(--vscode-editorError-foreground,#f14c4c);"
  + "--bs-warning:var(--vscode-editorWarning-foreground,#cca700);"
  + "--bs-success:var(--vscode-charts-green,#89d185);"
  + "--bs-radius:6px;--bs-gap:8px;"
  + "--bs-font:var(--vscode-font-family,system-ui,-apple-system,'Segoe UI',sans-serif);"
  + "--bs-mono:var(--vscode-editor-font-family,ui-monospace,'Cascadia Code',Menlo,monospace);"
  + "color-scheme:light dark;";

/** Structural rules that are safe whether or not the project stylesheet is present: a box-sizing
 *  reset, a full-bleed root, and scrollbars that match the editor's. */
const PREVIEW_STRUCTURAL_RULES: string =
  "*,*::before,*::after{box-sizing:border-box;}"
  + "html,body{margin:0;padding:0;width:100%;min-height:100%;}"
  + "::-webkit-scrollbar{width:10px;height:10px;}"
  + "::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(128,128,128,.4));border-radius:5px;}";

/** Reset and defaults, so a preview opens on a themed surface instead of a blank page. Kept
 *  deliberately thin — it should remove boilerplate, not impose a design of its own. Used when no
 *  project stylesheet is available; otherwise {@link PREVIEW_BASE_RULES_WITH_PROJECT} applies. */
export const PREVIEW_BASE_RULES: string =
  PREVIEW_STRUCTURAL_RULES
  + "body{background:var(--bs-bg);color:var(--bs-fg);font-family:var(--bs-font);"
  + "font-size:var(--vscode-font-size,13px);line-height:1.45;-webkit-font-smoothing:antialiased;}"
  + "code,pre,kbd{font-family:var(--bs-mono);}";

/**
 * The same reset, minus every declaration the project stylesheet already owns.
 *
 * theme.css styles `body` from inside `@layer base`, and layered rules lose to unlayered ones —
 * so the standalone body rule above would quietly outrank the product's own typography and
 * background and make a preview render in the wrong font on the wrong surface. That is exactly
 * the fidelity the project sheet was bridged in to provide, so when it is present these
 * declarations stand down and let it win.
 */
export const PREVIEW_BASE_RULES_WITH_PROJECT: string = PREVIEW_STRUCTURAL_RULES;

/**
 * Assemble the baseline. `read` resolves one CSS custom property against the host surface —
 * normally `getComputedStyle(document.documentElement).getPropertyValue`. Variables that resolve
 * to nothing are dropped rather than emitted empty, so the alias fallbacks above take over.
 *
 * `hasProjectCss` says whether the caller is also injecting the compiled project stylesheet
 * (src/preview-assets.ts) ahead of this baseline. The bridged `--vscode-*` block is emitted either
 * way: theme.css resolves its own tokens through those variables, so without them the project
 * sheet would render against its hardcoded fallbacks instead of the user's live theme.
 */
export function buildPreviewBaselineCss(
  read: (name: string) => string,
  hasProjectCss = false,
): string {
  const bridged = BRIDGED_THEME_VARS
    .map((name) => [name, (read(name) || "").trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const rules = hasProjectCss ? PREVIEW_BASE_RULES_WITH_PROJECT : PREVIEW_BASE_RULES;
  return `:root{${bridged}${PREVIEW_ALIAS_VARS}}${rules}`;
}

/** Reports uncaught errors to the parent frame so a surface can show a fallback rather than a
 *  silently blank iframe, and records them on `window.__previewErrors` so a headless render
 *  (src/preview-render.ts) can read back what went wrong without a parent to post to. */
export function buildPreviewErrorReporter(): string {
  return [
    "window.__previewErrors = [];",
    "function __bsReport(message) {",
    "  window.__previewErrors.push(String(message || 'Script error'));",
    "  try { parent.postMessage({ __qcardPreview: true, status: 'error', message: String(message || 'Script error') }, '*'); }",
    "  catch (e) { /* no parent to notify in a headless render */ }",
    "}",
    "window.addEventListener('error', function (e) { __bsReport(e && e.message); });",
    "window.addEventListener('unhandledrejection', function (e) {",
    "  var r = e && e.reason; __bsReport(r && r.message ? r.message : r);",
    "});",
  ].join("\n");
}

export interface PreviewDocumentParts {
  /** Optional custom document shell; a themed default is used when absent. */
  html?: string;
  /** The preview's own module code. */
  code?: string;
  /** The project's compiled stylesheet (src/preview-assets.ts), injected first so the preview's
   *  own rules still win on order. */
  projectCss?: string;
  /** Bridged theme variables and reset, from {@link buildPreviewBaselineCss}. */
  baselineCss: string;
  /** CSS extracted from a mount build's component-level imports. */
  extraCss?: string;
  /** Webview CSP nonce. Omitted for a headless file:// render, which has no CSP to satisfy. */
  nonce?: string;
}

const EMPTY_SHELL = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body></body></html>";

/**
 * Assemble the full preview document.
 *
 * Shared because three surfaces render these previews — the inline chat frame, the comparison
 * panel, and the headless renderer that lets the agent check its own work — and a preview that
 * differed between them would undermine all three at once: the comparison would not be comparing
 * like with like, and the agent would be reviewing something other than what the user sees.
 */
export function buildPreviewDocument(parts: PreviewDocumentParts): string {
  const nonceAttr = parts.nonce ? ` nonce="${parts.nonce}"` : "";
  // Split so this file can be bundled into a document without terminating its own script tag.
  const OPEN = "<" + `script type="module"${nonceAttr}>`;
  const CLOSE = "</" + "script>";
  const BOOT_OPEN = "<" + `script${nonceAttr}>`;
  const base = parts.html && parts.html.trim() ? parts.html : EMPTY_SHELL;
  const styles = (parts.projectCss ? `<style>${parts.projectCss}</style>` : "")
    + `<style>${parts.baselineCss}</style>`
    + (parts.extraCss ? `<style>${parts.extraCss}</style>` : "");
  const injected = styles
    + BOOT_OPEN + "\n" + buildPreviewErrorReporter() + "\n" + CLOSE
    + "\n" + OPEN + "\n" + (parts.code || "") + "\n" + CLOSE;
  const closeHead = base.search(/<\/head\s*>/i);
  return closeHead >= 0 ? base.slice(0, closeHead) + injected + base.slice(closeHead) : base + injected;
}
