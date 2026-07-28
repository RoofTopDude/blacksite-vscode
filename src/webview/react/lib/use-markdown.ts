/* Lazy access to the Markdown renderer.
 *
 * lib/markdown.ts pulls in DOMPurify, markdown-it, seven markdown-it plugins, and eleven
 * highlight.js grammars. The chat transcript is worth that on mount; the Plans panel is
 * not, since most plans are read without ever expanding a doc or a block. Loading it
 * through a dynamic import lets Vite emit it as a shared chunk that the chat pulls eagerly
 * (see prefetchMarkdown in main.tsx) and the utility panels pull only on first use.
 *
 * The module resolves once per webview and is cached here, so a panel that expands twenty
 * blocks parses the bundle once.
 */

import { useEffect, useState } from "react";

export type MarkdownModule = typeof import("./markdown");

let cached: MarkdownModule | null = null;
let pending: Promise<MarkdownModule> | null = null;

/** Start loading the renderer without waiting for a component to want it. */
export function prefetchMarkdown(): Promise<MarkdownModule> {
  if (cached) return Promise.resolve(cached);
  pending ??= import("./markdown").then((mod) => {
    cached = mod;
    pending = null;
    return mod;
  });
  return pending;
}

/**
 * The renderer once it is available, or `null` while it loads. Callers render plain text
 * until it resolves — the same output they fall back to when parsing fails — so a panel
 * never shows an empty box waiting on a chunk.
 *
 * Pass `enabled: false` to hold the import back entirely (e.g. a collapsed doc row).
 */
export function useMarkdown(enabled = true): MarkdownModule | null {
  const [mod, setMod] = useState<MarkdownModule | null>(() => cached);

  useEffect(() => {
    if (!enabled || mod) return;
    let alive = true;
    void prefetchMarkdown()
      .then((loaded) => { if (alive) setMod(loaded); })
      .catch(() => { /* stay on the plain-text fallback */ });
    return () => { alive = false; };
  }, [enabled, mod]);

  return mod;
}
