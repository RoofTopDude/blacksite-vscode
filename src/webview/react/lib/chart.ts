/* Charts for the webviews: draws a ```chart block.
 *
 * lib/markdown.ts turns a `chart` fence into a block carrying its JSON source, the same shape
 * as a Mermaid block; the Markdown component hands each one here after mount. Unlike Mermaid
 * there is nothing to load or wait for — parsing and drawing are a few milliseconds of plain
 * string work — so this runs synchronously, and redraws when the panel is resized, because a
 * chart is laid out for its width and keeps its text at one size rather than scaling it.
 */

import DOMPurify from "dompurify";
import { renderChartSvg } from "../../../shared/chart-render";
import { parseChartSpec } from "../../../shared/chart-spec";

/** Redraw only when the width has really changed; the redraw itself changes the height. */
const MIN_REDRAW_DELTA = 12;
/** .cb-diagram's horizontal padding. */
const PADDING = 24;

/** The JSON source a `.cb-chart` block was rendered from. */
export function chartBlockSource(block: Element): string {
  return block.querySelector(":scope > pre code")?.textContent ?? "";
}

function fail(block: HTMLElement, target: HTMLElement, message: string): void {
  target.textContent = message;
  block.classList.add("is-failed");
  block.classList.remove("is-rendered");
}

/**
 * Draw one `.cb-chart` block. Returns a function that stops watching its size; call it when the
 * block leaves the document. A spec that does not parse leaves the source on show with the
 * reason, which is also what the agent's diagram_check reports.
 */
export function renderChartBlock(block: HTMLElement): () => void {
  const target = block.querySelector<HTMLElement>(":scope > .cb-diagram");
  if (!target) return () => {};

  const source = chartBlockSource(block);
  const parsed = source.trim() ? parseChartSpec(source) : ({ ok: false, error: "This chart block is empty." } as const);
  if (!parsed.ok) {
    fail(block, target, parsed.error);
    return () => {};
  }

  let drawnWidth = 0;
  const draw = (): void => {
    const available = Math.floor(target.clientWidth - PADDING);
    const width = Math.max(260, Math.min(900, available > 0 ? available : 560));
    if (drawnWidth && Math.abs(width - drawnWidth) < MIN_REDRAW_DELTA) return;
    drawnWidth = width;
    try {
      const svg = renderChartSvg(parsed.spec, { theme: "dark", width });
      target.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      block.classList.add("is-rendered");
      block.classList.remove("is-failed");
    } catch (error) {
      fail(block, target, error instanceof Error ? error.message : "The chart could not be drawn.");
    }
  };

  draw();
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(draw);
  observer.observe(target);
  return () => observer.disconnect();
}
