/* Mermaid diagrams for the webviews.
 *
 * lib/markdown.ts turns a ```mermaid fence into a code block carrying its source; the
 * Markdown component then hands each one to renderMermaidBlock, which swaps in the drawn
 * diagram. The diagram viewer (apps/diagram) renders through renderMermaid directly. Mermaid
 * itself is several megabytes of parser and layout code, so it is never part of an entry
 * bundle: it loads on the first diagram a webview actually shows, and a transcript without
 * one never pays for it.
 */

import type { Mermaid, MermaidConfig } from "mermaid";
import { MERMAID_SECURITY_CONFIG, SVG_SANITIZE_CONFIG } from "../../../shared/mermaid-security";

export type MermaidResult = { svg: string } | { error: string };

/** "dark" is the panel palette; "light" is for the viewer's light canvas and for exports
 *  headed into documents with a white page. */
export type DiagramTheme = "dark" | "light";

export interface RenderOptions {
  theme?: DiagramTheme;
  /** false draws labels as SVG <text> instead of HTML in <foreignObject> — see the PNG
   *  export fallback in apps/diagram/export.ts. */
  htmlLabels?: boolean;
}

/* The panel palette is a committed dark one (see the :root block in theme.chat.css), so
   diagrams in the panels get one fixed theme rather than tracking the editor's. Mermaid
   derives its remaining colours from these with khroma, which only parses plain hex/rgb —
   hence literal values here instead of the CSS custom properties they mirror. */
const THEME_VARIABLES: Record<DiagramTheme, Record<string, string | boolean>> = {
  dark: {
    darkMode: true,
    background: "#0d0d0f",
    primaryColor: "#1c1830",
    primaryBorderColor: "#6b56b8",
    primaryTextColor: "#f4f4f5",
    secondaryColor: "#17171c",
    secondaryBorderColor: "#3f3f46",
    secondaryTextColor: "#e4e4e7",
    tertiaryColor: "#121216",
    tertiaryBorderColor: "#3f3f46",
    tertiaryTextColor: "#e4e4e7",
    lineColor: "#9a9aa3",
    textColor: "#e4e4e7",
    clusterBkg: "#121216",
    clusterBorder: "#3f3f46",
    edgeLabelBackground: "#0d0d0f",
    noteBkgColor: "#1f1c14",
    noteBorderColor: "#c4b08d",
    noteTextColor: "#f4f4f5",
    errorBkgColor: "#2a1a1d",
    errorTextColor: "#c78b94",
  },
  light: {
    darkMode: false,
    background: "#ffffff",
    primaryColor: "#f1edfd",
    primaryBorderColor: "#8b5cf6",
    primaryTextColor: "#18181b",
    secondaryColor: "#f4f4f5",
    secondaryBorderColor: "#d4d4d8",
    secondaryTextColor: "#27272a",
    tertiaryColor: "#fafafa",
    tertiaryBorderColor: "#d4d4d8",
    tertiaryTextColor: "#27272a",
    lineColor: "#71717a",
    textColor: "#27272a",
    clusterBkg: "#fafafa",
    clusterBorder: "#d4d4d8",
    edgeLabelBackground: "#ffffff",
    noteBkgColor: "#fdf8e7",
    noteBorderColor: "#c4a35a",
    noteTextColor: "#27272a",
    errorBkgColor: "#fdecee",
    errorTextColor: "#a4343f",
  },
};

function panelFontFamily(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
    if (value) return value;
  } catch { /* fall through to the default stack */ }
  return "Lexend, system-ui, sans-serif";
}

function mermaidConfig(theme: DiagramTheme, htmlLabels: boolean, fontFamily: string): MermaidConfig {
  return {
    ...MERMAID_SECURITY_CONFIG,
    theme: "base",
    themeVariables: { ...THEME_VARIABLES[theme], fontFamily, fontSize: "14px" },
    fontFamily,
    htmlLabels,
    flowchart: { htmlLabels },
  };
}

let loading: Promise<Mermaid> | null = null;
let fontFamily = "";

function loadMermaid(): Promise<Mermaid> {
  loading ??= (async () => {
    const { default: mermaid } = await import("mermaid");
    fontFamily = panelFontFamily();
    // Mermaid sizes every node from measured text. If the panel font has not loaded yet,
    // it measures the fallback face and the real one then overflows the boxes it drew.
    try { await document.fonts?.load(`14px ${fontFamily}`); } catch { /* measure with what is there */ }
    return mermaid;
  })().catch((error: unknown) => {
    // Let the next diagram retry rather than caching a failed chunk load for the session.
    loading = null;
    throw error;
  });
  return loading;
}

/* mermaid.initialize() replaces one global configuration, and render() reads it after an
   await. Two renders with different themes in flight would each draw with whichever
   initialize ran last, so every initialize-and-render pair runs to completion before the
   next one starts. */
let queue: Promise<unknown> = Promise.resolve();
let configured = "";

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function sanitizeSvg(svg: string): Promise<string> {
  const { default: DOMPurify } = await import("dompurify");
  return DOMPurify.sanitize(svg, SVG_SANITIZE_CONFIG);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = message.trim();
  if (!trimmed) return "Mermaid could not parse this diagram.";
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

/* Results are keyed by source and options. A transcript re-mounts its turns as a
   conversation is restored, and re-running layout for a diagram already drawn is the single
   most expensive thing this module does. Bounded so a long session cannot grow it without
   limit. */
const results = new Map<string, Promise<MermaidResult>>();
const RESULT_CACHE_LIMIT = 64;
let sequence = 0;

/** Render Mermaid source to sanitized SVG, or the reason it could not be drawn. */
export function renderMermaid(source: string, options: RenderOptions = {}): Promise<MermaidResult> {
  const theme = options.theme ?? "dark";
  const htmlLabels = options.htmlLabels ?? true;
  const key = `${theme}|${htmlLabels ? "html" : "text"}|${source}`;
  const cached = results.get(key);
  if (cached) return cached;

  const result = loadMermaid().then(
    (mermaid) => exclusive(async (): Promise<MermaidResult> => {
      const configKey = `${theme}|${htmlLabels}`;
      if (configured !== configKey) {
        mermaid.initialize(mermaidConfig(theme, htmlLabels, fontFamily));
        configured = configKey;
      }
      const id = `bs-mermaid-${++sequence}`;
      try {
        const { svg } = await mermaid.render(id, source);
        return { svg: await sanitizeSvg(svg) };
      } catch (error) {
        return { error: describeError(error) };
      } finally {
        // render() measures inside a scratch container on document.body. It removes that
        // on success; make sure a failure partway through layout does not leave one behind.
        document.getElementById(`d${id}`)?.remove();
      }
    }),
    (): MermaidResult => {
      results.delete(key);
      return { error: "The diagram renderer failed to load." };
    },
  );

  if (results.size >= RESULT_CACHE_LIMIT) results.clear();
  results.set(key, result);
  return result;
}

/** Below this, a wide diagram scrolls sideways instead of shrinking further. Mermaid lays
 *  text out at 14px, so 0.75 keeps labels at roughly the size of the panel's small text. */
const MIN_DIAGRAM_SCALE = 0.75;

/** Mermaid's own rendered width, from the max-width it sets when useMaxWidth is on. */
function naturalWidth(svg: SVGSVGElement): number {
  const fromStyle = Number.parseFloat(svg.style.maxWidth);
  if (Number.isFinite(fromStyle) && fromStyle > 0) return fromStyle;
  const fromViewBox = svg.viewBox?.baseVal?.width ?? 0;
  return fromViewBox > 0 ? fromViewBox : 0;
}

/** The Mermaid source a `.cb-mermaid` block was rendered from. */
export function mermaidBlockSource(block: Element): string {
  return block.querySelector(":scope > pre code")?.textContent ?? "";
}

/**
 * Draw one `.cb-mermaid` block produced by lib/markdown.ts. The block keeps its source in
 * the `pre > code` beneath the diagram, which is what Copy, Open, and the Source toggle read,
 * and what the block falls back to showing when the diagram cannot be drawn.
 */
export async function renderMermaidBlock(block: HTMLElement, isCurrent: () => boolean): Promise<void> {
  const source = mermaidBlockSource(block);
  const target = block.querySelector<HTMLElement>(":scope > .cb-diagram");
  if (!target) return;

  const result = source.trim()
    ? await renderMermaid(source)
    : { error: "This diagram block is empty." };
  if (!isCurrent() || !block.isConnected) return;

  if ("error" in result) {
    target.textContent = result.error;
    target.removeAttribute("title");
    block.classList.add("is-failed");
    block.classList.remove("is-rendered");
    return;
  }

  target.innerHTML = result.svg;
  target.title = "Open in the diagram viewer";
  const svg = target.querySelector("svg");
  const width = svg ? naturalWidth(svg) : 0;
  if (svg && width > 0) svg.style.minWidth = `${Math.round(width * MIN_DIAGRAM_SCALE)}px`;
  block.classList.add("is-rendered");
  block.classList.remove("is-failed");
}
