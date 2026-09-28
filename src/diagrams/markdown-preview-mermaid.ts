/* Mermaid in VS Code's own Markdown preview, for the editors that do not render it natively.

   VS Code has bundled a Mermaid renderer for its Markdown preview since early 2026 (the
   `vscode.mermaid-markdown-features` built-in). Older releases this extension still supports,
   and forks that ship without that built-in, show a ```mermaid fence as a grey code block —
   including in every transcript document the agent writes, which opens in that preview.

   This half runs in the extension host, inside the preview's markdown-it pipeline: it wraps
   each Mermaid fence in a marker element. The other half, preview/mermaid-preview.ts, runs in
   the preview webview and draws whatever it finds marked. When a native renderer is present
   this does nothing at all, so the two never draw the same fence twice. */

import type MarkdownIt from "markdown-it";
import * as vscode from "vscode";

/** Extensions that already draw Mermaid in the Markdown preview: VS Code's built-in, and the
 *  long-standing community extension the built-in grew out of. */
export const NATIVE_MERMAID_PREVIEW_EXTENSIONS = ["vscode.mermaid-markdown-features", "bierner.markdown-mermaid"];

/** Whether something other than Blacksite already renders Mermaid in the Markdown preview.
 *  getExtension only reports enabled extensions, so a disabled built-in counts as absent. */
export function hasNativeMermaidPreview(): boolean {
  return NATIVE_MERMAID_PREVIEW_EXTENSIONS.some((id) => vscode.extensions.getExtension(id) !== undefined);
}

/** Marker class the preview script looks for. */
export const PREVIEW_MERMAID_CLASS = "blacksite-mermaid";

/**
 * Wrap each ```mermaid fence's normal rendering in a marker div. The default fence output —
 * a <pre> with the escaped source and the preview's own line-number attributes for scroll
 * sync — stays inside it untouched, so a preview whose script never runs still shows the
 * source, and scroll sync keeps working either way.
 */
export function mermaidPreviewPlugin(md: MarkdownIt): void {
  const defaultFence = md.renderer.rules.fence
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const rendered = defaultFence(tokens, index, options, env, self);
    const language = tokens[index]!.info.trim().split(/\s+/, 1)[0]?.toLowerCase();
    return language === "mermaid" ? `<div class="${PREVIEW_MERMAID_CLASS}">${rendered}</div>` : rendered;
  };
}

/** The extendMarkdownIt hook activate() returns to VS Code's Markdown extension. */
export function extendMarkdownItWithMermaid(md: MarkdownIt): MarkdownIt {
  if (!hasNativeMermaidPreview()) md.use(mermaidPreviewPlugin);
  return md;
}
