/* Draws a parsed `chart` spec (chart-spec.ts) as SVG markup.
 *
 * A string in, a string out: no DOM, no libraries, nothing that needs a build step beyond this
 * file, so the same code draws in the chat, in tests, and anywhere else that wants a picture of
 * a spec. Everything that reaches the markup from the data is escaped.
 *
 * The drawing rules come from the dataviz skill the palette was validated with: thin marks,
 * a 2px surface gap between neighbouring fills, quiet gridlines, one axis (never two), a legend
 * whenever there are two or more series and direct labels for up to four, and hover text on
 * every mark (native <title> elements, which need no script and survive the webview's CSP).
 */

import { CATEGORICAL, INK, categorical, mix, readableInk, type DiagramTheme } from "./diagram-theme.js";
import {
  chartCategories, chartSeriesNames, describeChart, distinct, toNumber,
  type ChartRow, type ChartSpec,
} from "./chart-spec.js";

export interface ChartRenderOptions {
  theme?: DiagramTheme;
  /** Drawn width in px. The chart is laid out for this width, so text stays a fixed size. */
  width?: number;
}

const MIN_WIDTH = 260;
const MAX_WIDTH = 900;
const TEXT = 11;
const CHAR = 0.6;

const esc = (value: unknown): string =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const textWidth = (value: string, size = TEXT): number => value.length * size * CHAR;
const round = (value: number): number => Math.round(value * 100) / 100;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

// ── numbers ────────────────────────────────────────────────────────────────────────────────

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trimZeros((value / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${trimZeros((value / 1e6).toFixed(2))}M`;
  if (abs >= 1e4) return `${trimZeros((value / 1e3).toFixed(1))}k`;
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  if (abs >= 100) return trimZeros(value.toFixed(1));
  if (abs >= 1) return trimZeros(value.toFixed(2));
  if (abs === 0) return "0";
  return trimZeros(value.toPrecision(2));
}

export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  if (/^[$€£]/.test(unit)) return `${unit}${text}`;
  return /^[%°]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/** The step nearest `raw` among 1, 2, 5 and 10 times a power of ten, for choosing bin widths. */
function roundStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10) * power;
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

interface Scale { min: number; max: number; step: number; ticks: number[] }

function niceScale(min: number, max: number, target = 5): Scale {
  let lo = min;
  let hi = max;
  if (!(hi > lo)) { hi = lo + (Math.abs(lo) || 1); }
  const step = niceStep((hi - lo) / target);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = lo; tick <= hi + step / 2; tick += step) ticks.push(Math.round(tick / step) * step);
  return { min: lo, max: hi, step, ticks };
}

const linear = (domain: [number, number], range: [number, number]) => (value: number): number =>
  domain[1] === domain[0] ? range[0] : range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);

// ── frame ──────────────────────────────────────────────────────────────────────────────────

interface Frame {
  theme: DiagramTheme;
  ink: typeof INK.dark;
  width: number;
  parts: string[];
  /** Where plot content may start, below the title and legend. */
  top: number;
  height: number;
}

let gradientCounter = 0;

function seriesLabel(spec: ChartSpec, name: string): string {
  return spec.names[name] ?? name;
}

function legendItems(spec: ChartSpec, names: string[], theme: DiagramTheme): Array<{ label: string; colour: string }> {
  return names.map((name, index) => ({ label: seriesLabel(spec, name), colour: categorical(theme, index) }));
}

/** Title, subtitle and legend; returns the y where the plot may begin. */
function drawHeader(frame: Frame, spec: ChartSpec, legend: Array<{ label: string; colour: string }>): number {
  const { ink, width, parts } = frame;
  let y = 6;
  if (spec.title) {
    y += 14;
    parts.push(`<text x="0" y="${y}" font-size="14" font-weight="600" fill="${ink.text}">${esc(truncate(spec.title, Math.floor(width / 7.5)))}</text>`);
  }
  if (spec.subtitle) {
    y += 17;
    parts.push(`<text x="0" y="${y}" font-size="12" fill="${ink.muted}">${esc(truncate(spec.subtitle, Math.floor(width / 6.6)))}</text>`);
  }
  if (legend.length >= 2) {
    y += spec.title || spec.subtitle ? 21 : 14;
    let x = 0;
    for (const item of legend) {
      const label = truncate(item.label, 26);
      const itemWidth = 16 + textWidth(label, 12) + 14;
      if (x > 0 && x + itemWidth > width) { x = 0; y += 18; }
      parts.push(`<rect x="${round(x)}" y="${y - 9}" width="10" height="10" rx="2" fill="${item.colour}"/>`);
      parts.push(`<text x="${round(x + 15)}" y="${y}" font-size="12" fill="${ink.secondary}">${esc(label)}</text>`);
      x += itemWidth;
    }
    y += 6;
  }
  return y + 10;
}

function wrap(frame: Frame, label: string): string {
  const { width, height, parts } = frame;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}" role="img" aria-label="${esc(label)}" font-family="inherit" font-size="${TEXT}">${parts.join("")}</svg>`;
}

/** A transparent hit area carrying hover text. */
const hit = (x: number, y: number, w: number, h: number, tip: string): string =>
  `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, w))}" height="${round(Math.max(0, h))}" fill="transparent"><title>${esc(tip)}</title></rect>`;

// ── axes ───────────────────────────────────────────────────────────────────────────────────

interface Plot { left: number; top: number; width: number; height: number }

function drawValueAxisY(frame: Frame, plot: Plot, scale: Scale, y: (value: number) => number, unit: string | undefined, label: string | undefined, grid = true): void {
  const { ink, parts } = frame;
  if (label) parts.push(`<text x="${round(plot.left - 4)}" y="${round(plot.top - 8)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="start">${esc(label)}</text>`);
  for (const tick of scale.ticks) {
    const py = round(y(tick));
    if (grid) parts.push(`<line x1="${plot.left}" x2="${round(plot.left + plot.width)}" y1="${py}" y2="${py}" stroke="${tick === 0 ? ink.axis : ink.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${round(plot.left - 6)}" y="${py + 3.5}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="end">${esc(withUnit(formatNumber(tick), unit && /^[$€£%]/.test(unit) ? unit : undefined))}</text>`);
  }
}

function axisLabelWidth(scale: Scale, unit: string | undefined): number {
  return Math.max(...scale.ticks.map((tick) => textWidth(withUnit(formatNumber(tick), unit && /^[$€£%]/.test(unit) ? unit : undefined)))) + 12;
}

function categoryTicks(frame: Frame, plot: Plot, names: string[], centre: (index: number) => number, baseline: number, label?: string): void {
  const { ink, parts } = frame;
  const slot = plot.width / Math.max(1, names.length);
  const longest = Math.max(...names.map((name) => Math.min(name.length, 16))) * TEXT * CHAR + 6;
  const every = Math.max(1, Math.ceil(longest / slot));
  const max = Math.max(3, Math.floor((slot * every) / (TEXT * CHAR)) - 1);
  for (const [index, name] of names.entries()) {
    if (index % every !== 0) continue;
    parts.push(`<text x="${round(centre(index))}" y="${round(baseline + 15)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">${esc(truncate(name, Math.min(16, max)))}<title>${esc(name)}</title></text>`);
  }
  if (label) parts.push(`<text x="${round(plot.left + plot.width / 2)}" y="${round(baseline + 31)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="middle">${esc(label)}</text>`);
}

// ── series data ────────────────────────────────────────────────────────────────────────────

interface SeriesData { name: string; label: string; colour: string; values: Map<string, number> }

/** Per-series values by x category, summing rows that share one. */
function seriesData(spec: ChartSpec, theme: DiagramTheme): SeriesData[] {
  const names = chartSeriesNames(spec);
  const x = spec.x!;
  return names.map((name, index) => {
    const values = new Map<string, number>();
    const add = (key: string, value: number | undefined): void => {
      if (value !== undefined) values.set(key, (values.get(key) ?? 0) + value);
    };
    for (const row of spec.rows) {
      const key = row[x] === undefined || row[x] === null ? "" : String(row[x]);
      if (spec.series) {
        if (String(row[spec.series]) === name) add(key, toNumber(row[spec.y[0]!]));
      } else {
        add(key, toNumber(row[name]));
      }
    }
    return { name, label: seriesLabel(spec, name), colour: categorical(theme, index), values };
  });
}

// ── bar ────────────────────────────────────────────────────────────────────────────────────

function drawBar(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const categories = chartCategories(spec);
  const series = seriesData(spec, theme);
  const stacked = spec.stack !== false && series.length > 1;
  const percent = spec.stack === "percent" && stacked;
  const unit = percent ? "%" : spec.unit;

  const totals = categories.map((category) => series.reduce((sum, s) => sum + (s.values.get(category) ?? 0), 0));
  const value = (s: SeriesData, category: string, index: number): number => {
    const raw = s.values.get(category) ?? 0;
    return percent ? (totals[index]! === 0 ? 0 : (raw / totals[index]!) * 100) : raw;
  };
  let lo = 0;
  let hi = 0;
  for (const [index, category] of categories.entries()) {
    if (stacked) {
      let up = 0;
      let down = 0;
      for (const s of series) { const v = value(s, category, index); if (v >= 0) up += v; else down += v; }
      hi = Math.max(hi, up); lo = Math.min(lo, down);
    } else {
      for (const s of series) { const v = value(s, category, index); hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
  }
  if (percent) { hi = 100; lo = 0; }
  const scale = niceScale(lo, hi);

  if (spec.horizontal) { drawBarHorizontal(frame, spec, categories, series, stacked, percent, scale, value); return; }

  const header = drawHeader(frame, spec, series.length >= 2 ? legendItems(spec, series.map((s) => s.name), theme) : []);
  const plot: Plot = { left: axisLabelWidth(scale, unit) + (spec.yLabel ? 0 : 0), top: header + (spec.yLabel ? 14 : 4), width: 0, height: 0 };
  plot.width = width - plot.left - 8;
  plot.height = 230;
  const bottom = plot.top + plot.height;
  const y = linear([scale.min, scale.max], [bottom, plot.top]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);

  drawValueAxisY(frame, plot, scale, y, unit, spec.yLabel);
  const slot = plot.width / categories.length;
  const inner = Math.min(slot * 0.74, stacked ? 72 : 36 * series.length + 4 * (series.length - 1));
  const barWidth = stacked ? inner : (inner - 3 * (series.length - 1)) / series.length;
  const centre = (index: number): number => plot.left + slot * (index + 0.5);
  const labelled = spec.labels && !stacked && categories.length * series.length <= 18;

  for (const [index, category] of categories.entries()) {
    let up = 0;
    let down = 0;
    for (const [seriesIndex, s] of series.entries()) {
      const v = value(s, category, index);
      if (!s.values.has(category)) continue;
      const tip = `${category} · ${s.label}: ${withUnit(formatNumber(s.values.get(category)!), spec.unit)}${percent ? ` (${formatNumber(v)}%)` : ""}`;
      let x0: number;
      let y0: number;
      let y1: number;
      if (stacked) {
        x0 = centre(index) - inner / 2;
        if (v >= 0) { y0 = y(up + v); y1 = y(up); up += v; } else { y0 = y(down); y1 = y(down + v); down += v; }
      } else {
        x0 = centre(index) - inner / 2 + seriesIndex * (barWidth + 3);
        y0 = v >= 0 ? y(v) : y(0);
        y1 = v >= 0 ? y(0) : y(v);
      }
      const h = Math.max(1, y1 - y0);
      // Fills are separated by a surface-coloured stroke, which also rounds nothing off the
      // baseline: only the free end of a bar is rounded.
      parts.push(`<rect x="${round(x0)}" y="${round(y0)}" width="${round(barWidth)}" height="${round(h)}" rx="${stacked ? 0 : 2}" fill="${s.colour}" stroke="${ink.surface}" stroke-width="${stacked ? 1.5 : 0}"><title>${esc(tip)}</title></rect>`);
      if (labelled) {
        parts.push(`<text x="${round(x0 + barWidth / 2)}" y="${round(v >= 0 ? y0 - 4 : y1 + 12)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="middle">${esc(formatNumber(v))}</text>`);
      }
    }
  }
  categoryTicks(frame, plot, categories, centre, bottom, spec.xLabel);
}

function drawBarHorizontal(
  frame: Frame, spec: ChartSpec, categories: string[], series: SeriesData[], stacked: boolean, percent: boolean,
  scale: Scale, value: (s: SeriesData, category: string, index: number) => number,
): void {
  const { ink, parts, width, theme } = frame;
  const unit = percent ? "%" : spec.unit;
  const header = drawHeader(frame, spec, series.length >= 2 ? legendItems(spec, series.map((s) => s.name), theme) : []);
  const labelWidth = Math.min(150, Math.max(...categories.map((c) => textWidth(truncate(c, 22)))) + 12);
  const plot: Plot = { left: labelWidth, top: header + (spec.yLabel ? 14 : 4), width: width - labelWidth - 44, height: 0 };
  const per = stacked ? 1 : series.length;
  const band = Math.max(24, per * 14 + 10);
  plot.height = categories.length * band;
  const bottom = plot.top + plot.height;
  const xs = linear([scale.min, scale.max], [plot.left, plot.left + plot.width]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);

  if (spec.yLabel) parts.push(`<text x="0" y="${round(plot.top - 8)}" font-size="${TEXT}" fill="${ink.secondary}">${esc(spec.yLabel)}</text>`);
  for (const tick of scale.ticks) {
    const px = round(xs(tick));
    parts.push(`<line x1="${px}" x2="${px}" y1="${plot.top}" y2="${round(bottom)}" stroke="${tick === 0 ? ink.axis : ink.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${px}" y="${round(bottom + 15)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">${esc(withUnit(formatNumber(tick), unit && /^[$€£%]/.test(unit) ? unit : undefined))}</text>`);
  }
  if (spec.xLabel) parts.push(`<text x="${round(plot.left + plot.width / 2)}" y="${round(bottom + 31)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="middle">${esc(spec.xLabel)}</text>`);

  const thickness = Math.min(22, stacked ? band - 10 : (band - 10) / per);
  const labelled = spec.labels && !stacked;
  for (const [index, category] of categories.entries()) {
    const centreY = plot.top + band * (index + 0.5);
    parts.push(`<text x="${round(plot.left - 8)}" y="${round(centreY + 3.5)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="end">${esc(truncate(category, 22))}<title>${esc(category)}</title></text>`);
    let acc = 0;
    for (const [seriesIndex, s] of series.entries()) {
      if (!s.values.has(category)) continue;
      const v = value(s, category, index);
      const from = stacked ? acc : 0;
      const x0 = xs(Math.min(from, from + v));
      const x1 = xs(Math.max(from, from + v));
      acc += v;
      const yTop = stacked ? centreY - thickness / 2 : centreY - (per * thickness + (per - 1) * 3) / 2 + seriesIndex * (thickness + 3);
      const tip = `${category} · ${s.label}: ${withUnit(formatNumber(s.values.get(category)!), spec.unit)}`;
      parts.push(`<rect x="${round(x0)}" y="${round(yTop)}" width="${round(Math.max(1, x1 - x0))}" height="${round(thickness)}" rx="${stacked ? 0 : 2}" fill="${s.colour}" stroke="${ink.surface}" stroke-width="${stacked ? 1.5 : 0}"><title>${esc(tip)}</title></rect>`);
      if (labelled) parts.push(`<text x="${round(x1 + 5)}" y="${round(yTop + thickness / 2 + 3.5)}" font-size="${TEXT}" fill="${ink.secondary}">${esc(formatNumber(v))}</text>`);
    }
  }
}

// ── line and area ──────────────────────────────────────────────────────────────────────────

function drawLine(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const isArea = spec.type === "area";
  let categories = chartCategories(spec);
  const xNumeric = categories.length > 0 && categories.every((c) => toNumber(c) !== undefined);
  if (xNumeric) categories = [...categories].sort((a, b) => toNumber(a)! - toNumber(b)!);
  const series = seriesData(spec, theme);
  const stacked = isArea && spec.stack !== false && series.length > 1;
  const percent = stacked && spec.stack === "percent";
  const unit = percent ? "%" : spec.unit;

  const totals = categories.map((category) => series.reduce((sum, s) => sum + (s.values.get(category) ?? 0), 0));
  const at = (s: SeriesData, category: string, index: number): number | undefined => {
    const raw = s.values.get(category);
    if (raw === undefined) return undefined;
    return percent ? (totals[index]! === 0 ? 0 : (raw / totals[index]!) * 100) : raw;
  };

  let lo = isArea ? 0 : Infinity;
  let hi = isArea ? 0 : -Infinity;
  for (const [index, category] of categories.entries()) {
    let sum = 0;
    for (const s of series) {
      const v = at(s, category, index);
      if (v === undefined) continue;
      if (stacked) { sum += v; hi = Math.max(hi, sum); lo = Math.min(lo, 0); }
      else { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (percent) { lo = 0; hi = 100; }
  const scale = niceScale(lo, hi);

  const direct = series.length >= 2 && series.length <= 4 && !stacked;
  const directWidth = direct ? Math.min(96, Math.max(...series.map((s) => textWidth(truncate(s.label, 14))))) + 14 : 8;
  const header = drawHeader(frame, spec, series.length >= 2 ? legendItems(spec, series.map((s) => s.name), theme) : []);
  const plot: Plot = { left: axisLabelWidth(scale, unit), top: header + (spec.yLabel ? 14 : 4), width: 0, height: 230 };
  plot.width = width - plot.left - directWidth;
  const bottom = plot.top + plot.height;
  const y = linear([scale.min, scale.max], [bottom, plot.top]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);
  drawValueAxisY(frame, plot, scale, y, unit, spec.yLabel);

  const n = categories.length;
  let px: (index: number) => number;
  if (xNumeric && n > 1) {
    const xmin = toNumber(categories[0]!)!;
    const xmax = toNumber(categories[n - 1]!)!;
    const pad = 6;
    const map = linear([xmin, xmax], [plot.left + pad, plot.left + plot.width - pad]);
    px = (index) => map(toNumber(categories[index]!)!);
  } else {
    px = (index) => plot.left + (plot.width * (index + 0.5)) / n;
  }

  const base = y(0 < scale.min ? scale.min : 0);
  const below = new Array<number>(n).fill(0);
  for (const s of series) {
    // Segments break at a missing value rather than drawing a line through it.
    const segments: Array<Array<{ x: number; top: number; bottom: number; index: number; v: number }>> = [[]];
    for (const [index, category] of categories.entries()) {
      const v = at(s, category, index);
      if (v === undefined) { if (segments[segments.length - 1]!.length) segments.push([]); continue; }
      const lowerValue = stacked ? below[index]! : 0;
      const upperValue = lowerValue + v;
      segments[segments.length - 1]!.push({ x: px(index), top: y(stacked ? upperValue : v), bottom: stacked ? y(lowerValue) : base, index, v });
      if (stacked) below[index] = upperValue;
    }
    for (const segment of segments) {
      if (segment.length === 0) continue;
      const line = segment.map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)} ${round(p.top)}`).join(" ");
      if (isArea) {
        const back = [...segment].reverse().map((p) => `L${round(p.x)} ${round(p.bottom)}`).join(" ");
        parts.push(`<path d="${line} ${back} Z" fill="${s.colour}" fill-opacity="${stacked ? 0.78 : 0.2}" stroke="${stacked ? ink.surface : "none"}" stroke-width="1"/>`);
      }
      if (!stacked) parts.push(`<path d="${line}" fill="none" stroke="${s.colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (!stacked && n <= 30) {
        for (const p of segment) parts.push(`<circle cx="${round(p.x)}" cy="${round(p.top)}" r="3" fill="${s.colour}" stroke="${ink.surface}" stroke-width="2"/>`);
      }
    }
  }

  if (direct) {
    const ends = series.map((s) => {
      for (let index = n - 1; index >= 0; index -= 1) {
        const v = at(s, categories[index]!, index);
        if (v !== undefined) return { s, x: px(index), y: y(v) };
      }
      return undefined;
    }).filter((end): end is { s: SeriesData; x: number; y: number } => end !== undefined).sort((a, b) => a.y - b.y);
    let last = -Infinity;
    for (const end of ends) {
      const ty = Math.max(end.y, last + 13);
      last = ty;
      parts.push(`<text x="${round(end.x + 8)}" y="${round(ty + 3.5)}" font-size="${TEXT}" fill="${ink.secondary}">${esc(truncate(end.s.label, 14))}</text>`);
    }
  }

  // One hover column per x position, listing every series at that point.
  const slot = plot.width / Math.max(1, n);
  for (const [index, category] of categories.entries()) {
    const lines = series.map((s) => {
      const v = at(s, category, index);
      return v === undefined ? undefined : `${s.label}: ${withUnit(formatNumber(s.values.get(category)!), spec.unit)}`;
    }).filter(Boolean);
    parts.push(hit(px(index) - slot / 2, plot.top, slot, plot.height, `${category}\n${lines.join("\n")}`));
  }
  categoryTicks(frame, plot, categories, px, bottom, spec.xLabel);
}

// ── scatter ────────────────────────────────────────────────────────────────────────────────

function drawScatter(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const xField = spec.x!;
  const yField = spec.y[0]!;
  const names = chartSeriesNames(spec);
  const points = spec.rows.map((row) => ({
    row, x: toNumber(row[xField]), y: toNumber(row[yField]),
    size: spec.size ? toNumber(row[spec.size]) : undefined,
    series: spec.series ? String(row[spec.series] ?? "") : "",
  })).filter((p): p is typeof p & { x: number; y: number } => p.x !== undefined && p.y !== undefined);

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xScale = niceScale(Math.min(...xs), Math.max(...xs));
  const yScale = niceScale(Math.min(...ys), Math.max(...ys));
  const header = drawHeader(frame, spec, names.length >= 2 ? legendItems(spec, names, theme) : []);
  const plot: Plot = { left: axisLabelWidth(yScale, undefined), top: header + (spec.yLabel ? 14 : 4), width: 0, height: 280 };
  plot.width = width - plot.left - 12;
  const bottom = plot.top + plot.height;
  const px = linear([xScale.min, xScale.max], [plot.left, plot.left + plot.width]);
  const py = linear([yScale.min, yScale.max], [bottom, plot.top]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);

  drawValueAxisY(frame, plot, yScale, py, undefined, spec.yLabel);
  for (const tick of xScale.ticks) {
    const x = round(px(tick));
    parts.push(`<line x1="${x}" x2="${x}" y1="${plot.top}" y2="${round(bottom)}" stroke="${ink.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x}" y="${round(bottom + 15)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">${esc(formatNumber(tick))}</text>`);
  }
  if (spec.xLabel) parts.push(`<text x="${round(plot.left + plot.width / 2)}" y="${round(bottom + 31)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="middle">${esc(spec.xLabel)}</text>`);

  const sizes = points.map((p) => p.size).filter((s): s is number => s !== undefined);
  const sizeMax = sizes.length ? Math.max(...sizes) : 0;
  const radius = (size: number | undefined): number => (size === undefined || sizeMax <= 0 ? 4.5 : 3 + Math.sqrt(Math.max(0, size) / sizeMax) * 13);
  // Big points first, so a small one is never buried under a large one.
  for (const p of [...points].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))) {
    const index = Math.max(0, names.indexOf(p.series));
    const colour = categorical(theme, spec.series ? index : 0);
    const tip = [
      spec.series ? `${p.series}` : "",
      `${spec.xLabel ?? xField}: ${formatNumber(p.x)}`,
      `${spec.yLabel ?? yField}: ${formatNumber(p.y)}`,
      spec.size && p.size !== undefined ? `${spec.size}: ${formatNumber(p.size)}` : "",
    ].filter(Boolean).join("\n");
    parts.push(`<circle cx="${round(px(p.x))}" cy="${round(py(p.y))}" r="${round(radius(p.size))}" fill="${colour}" fill-opacity="${spec.size ? 0.72 : 0.9}" stroke="${ink.surface}" stroke-width="1.5"><title>${esc(tip)}</title></circle>`);
  }
}

// ── histogram ──────────────────────────────────────────────────────────────────────────────

function drawHistogram(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const values = spec.rows.map((row) => toNumber(row[spec.value!])).filter((v): v is number => v !== undefined);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const wanted = spec.bins ?? Math.min(30, Math.max(6, Math.ceil(Math.log2(values.length)) + 1));
  const step = roundStep((max - min || 1) / wanted);
  const start = Math.floor(min / step + 1e-9) * step;
  const count = Math.max(1, Math.ceil((max - start) / step + 1e-9));
  const bins = new Array<number>(count).fill(0);
  for (const v of values) bins[Math.min(count - 1, Math.floor((v - start) / step + 1e-9))]! += 1;

  const yScale = niceScale(0, Math.max(...bins));
  const header = drawHeader(frame, spec, []);
  const plot: Plot = { left: axisLabelWidth(yScale, undefined), top: header + 14, width: 0, height: 230 };
  plot.width = width - plot.left - 12;
  const bottom = plot.top + plot.height;
  const py = linear([yScale.min, yScale.max], [bottom, plot.top]);
  const px = linear([start, start + step * count], [plot.left, plot.left + plot.width]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);

  drawValueAxisY(frame, plot, yScale, py, undefined, spec.yLabel ?? "Count");
  for (const [index, n] of bins.entries()) {
    const x0 = px(start + index * step);
    const x1 = px(start + (index + 1) * step);
    const lo = formatNumber(start + index * step);
    const hi = formatNumber(start + (index + 1) * step);
    parts.push(`<rect x="${round(x0 + 0.5)}" y="${round(py(n))}" width="${round(Math.max(1, x1 - x0 - 1))}" height="${round(bottom - py(n))}" rx="1.5" fill="${categorical(theme, 0)}"><title>${esc(`${withUnit(lo, spec.unit)} – ${withUnit(hi, spec.unit)}: ${n}`)}</title></rect>`);
  }
  const every = Math.max(1, Math.ceil((textWidth(formatNumber(start + step * count)) + 10) / (plot.width / count)));
  for (let index = 0; index <= count; index += every) {
    parts.push(`<text x="${round(px(start + index * step))}" y="${round(bottom + 15)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">${esc(formatNumber(start + index * step))}</text>`);
  }
  parts.push(`<text x="${round(plot.left + plot.width / 2)}" y="${round(bottom + 31)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="middle">${esc(spec.xLabel ?? withUnit(spec.value!, spec.unit && !/^[$€£%]/.test(spec.unit) ? `(${spec.unit})` : undefined))}</text>`);
  frame.height = bottom + 44;
}

// ── heatmap ────────────────────────────────────────────────────────────────────────────────

function drawHeatmap(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const xs = distinct(spec.rows, spec.x!);
  const ys = distinct(spec.rows, spec.y[0]!);
  const cells = new Map<string, number>();
  for (const row of spec.rows) {
    const v = toNumber(row[spec.value!]);
    if (v !== undefined) cells.set(`${row[spec.x!]}\u0000${row[spec.y[0]!]}`, v);
  }
  const all = [...cells.values()];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const header = drawHeader(frame, spec, []);
  const labelWidth = Math.min(130, Math.max(...ys.map((v) => textWidth(truncate(v, 18)))) + 12);
  const plot: Plot = { left: labelWidth, top: header + 4, width: width - labelWidth - 8, height: 0 };
  const cellH = Math.min(34, Math.max(18, 300 / ys.length));
  plot.height = ys.length * cellH;
  const cellW = plot.width / xs.length;
  const bottom = plot.top + plot.height;
  const base = categorical(theme, 0);
  const surface = ink.surface;
  const fillFor = (v: number): string => mix(base, surface, 0.1 + 0.9 * (max === min ? 1 : (v - min) / (max - min)));
  const labelled = spec.labels && cellW >= 34 && cellH >= 18 && xs.length * ys.length <= 150;

  for (const [row, yv] of ys.entries()) {
    parts.push(`<text x="${round(plot.left - 8)}" y="${round(plot.top + cellH * (row + 0.5) + 3.5)}" font-size="${TEXT}" fill="${ink.secondary}" text-anchor="end">${esc(truncate(yv, 18))}<title>${esc(yv)}</title></text>`);
    for (const [col, xv] of xs.entries()) {
      const v = cells.get(`${xv}\u0000${yv}`);
      const x0 = plot.left + cellW * col;
      const y0 = plot.top + cellH * row;
      if (v === undefined) {
        parts.push(`<rect x="${round(x0 + 1)}" y="${round(y0 + 1)}" width="${round(Math.max(1, cellW - 2))}" height="${round(cellH - 2)}" rx="2" fill="none" stroke="${ink.grid}" stroke-width="1"><title>${esc(`${xv} · ${yv}: no data`)}</title></rect>`);
        continue;
      }
      const fill = fillFor(v);
      parts.push(`<rect x="${round(x0 + 1)}" y="${round(y0 + 1)}" width="${round(Math.max(1, cellW - 2))}" height="${round(cellH - 2)}" rx="2" fill="${fill}"><title>${esc(`${xv} · ${yv}: ${withUnit(formatNumber(v), spec.unit)}`)}</title></rect>`);
      if (labelled) parts.push(`<text x="${round(x0 + cellW / 2)}" y="${round(y0 + cellH / 2 + 3.5)}" font-size="${TEXT}" fill="${readableInk(fill)}" text-anchor="middle">${esc(formatNumber(v))}</text>`);
    }
  }
  const every = Math.max(1, Math.ceil((Math.max(...xs.map((v) => Math.min(v.length, 12))) * TEXT * CHAR + 6) / cellW));
  for (const [col, xv] of xs.entries()) {
    if (col % every !== 0) continue;
    parts.push(`<text x="${round(plot.left + cellW * (col + 0.5))}" y="${round(bottom + 15)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">${esc(truncate(xv, 12))}<title>${esc(xv)}</title></text>`);
  }

  // The colour scale: a one-hue ramp from the surface to the full colour.
  const id = `hm${++gradientCounter}`;
  const legendY = bottom + 30;
  const legendW = Math.min(160, plot.width);
  parts.push(`<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${fillFor(min)}"/><stop offset="1" stop-color="${fillFor(max)}"/></linearGradient></defs>`);
  parts.push(`<text x="${round(plot.left)}" y="${round(legendY + 8)}" font-size="${TEXT}" fill="${ink.muted}">${esc(withUnit(formatNumber(min), spec.unit))}</text>`);
  const gx = plot.left + textWidth(withUnit(formatNumber(min), spec.unit)) + 8;
  parts.push(`<rect x="${round(gx)}" y="${round(legendY)}" width="${round(legendW)}" height="9" rx="2" fill="url(#${id})"/>`);
  parts.push(`<text x="${round(gx + legendW + 8)}" y="${round(legendY + 8)}" font-size="${TEXT}" fill="${ink.muted}">${esc(withUnit(formatNumber(max), spec.unit))}</text>`);
  frame.height = legendY + 20;
}

// ── donut ──────────────────────────────────────────────────────────────────────────────────

function drawDonut(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const totals = new Map<string, number>();
  for (const row of spec.rows) {
    const v = toNumber(row[spec.value!]);
    if (v !== undefined && v > 0) totals.set(String(row[spec.category!]), (totals.get(String(row[spec.category!])) ?? 0) + v);
  }
  let slices = [...totals.entries()].map(([name, value]) => ({ name, value }));
  if (slices.length > 8) {
    slices.sort((a, b) => b.value - a.value);
    const rest = slices.slice(7).reduce((sum, s) => sum + s.value, 0);
    slices = [...slices.slice(0, 7), { name: "Other", value: rest }];
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const header = drawHeader(frame, spec, []);
  const side = width >= 440;
  const size = side ? 190 : Math.min(190, width - 20);
  const cx = side ? size / 2 + 4 : width / 2;
  const cy = header + size / 2;
  const outer = size / 2 - 2;
  const inner = outer * 0.62;
  const point = (angle: number, r: number): [number, number] => [cx + Math.sin(angle) * r, cy - Math.cos(angle) * r];

  let angle = 0;
  for (const [index, s] of slices.entries()) {
    const sweep = (s.value / total) * Math.PI * 2;
    const colour = categorical(theme, index);
    const tip = `${s.name}: ${withUnit(formatNumber(s.value), spec.unit)} (${formatNumber((s.value / total) * 100)}%)`;
    if (slices.length === 1 || sweep >= Math.PI * 2 - 1e-6) {
      parts.push(`<path d="M${round(cx)} ${round(cy - outer)} A${round(outer)} ${round(outer)} 0 1 1 ${round(cx - 0.01)} ${round(cy - outer)} L${round(cx - 0.01)} ${round(cy - inner)} A${round(inner)} ${round(inner)} 0 1 0 ${round(cx)} ${round(cy - inner)} Z" fill="${colour}" fill-rule="evenodd"><title>${esc(tip)}</title></path>`);
    } else {
      const [x0, y0] = point(angle, outer);
      const [x1, y1] = point(angle + sweep, outer);
      const [x2, y2] = point(angle + sweep, inner);
      const [x3, y3] = point(angle, inner);
      const large = sweep > Math.PI ? 1 : 0;
      parts.push(`<path d="M${round(x0)} ${round(y0)} A${round(outer)} ${round(outer)} 0 ${large} 1 ${round(x1)} ${round(y1)} L${round(x2)} ${round(y2)} A${round(inner)} ${round(inner)} 0 ${large} 0 ${round(x3)} ${round(y3)} Z" fill="${colour}" stroke="${ink.surface}" stroke-width="2"><title>${esc(tip)}</title></path>`);
    }
    angle += sweep;
  }
  parts.push(`<text x="${round(cx)}" y="${round(cy + 2)}" font-size="20" font-weight="600" fill="${ink.text}" text-anchor="middle">${esc(withUnit(formatNumber(total), spec.unit))}</text>`);
  parts.push(`<text x="${round(cx)}" y="${round(cy + 18)}" font-size="${TEXT}" fill="${ink.muted}" text-anchor="middle">total</text>`);

  // Legend rows carry the numbers, so the slices need no labels of their own.
  const lx = side ? size + 28 : 0;
  let ly = side ? cy - (slices.length * 20) / 2 + 8 : cy + size / 2 + 22;
  for (const [index, s] of slices.entries()) {
    parts.push(`<rect x="${round(lx)}" y="${round(ly - 9)}" width="10" height="10" rx="2" fill="${categorical(theme, index)}"/>`);
    parts.push(`<text x="${round(lx + 16)}" y="${round(ly)}" font-size="12" fill="${ink.secondary}">${esc(truncate(s.name, side ? 24 : 30))}</text>`);
    parts.push(`<text x="${round(width)}" y="${round(ly)}" font-size="12" fill="${ink.text}" text-anchor="end">${esc(formatNumber((s.value / total) * 100))}%</text>`);
    ly += 20;
  }
  frame.height = Math.max(cy + size / 2 + 10, side ? 0 : ly - 6);
}

// ── box plot ───────────────────────────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function drawBox(frame: Frame, spec: ChartSpec): void {
  const { ink, parts, width, theme } = frame;
  const groups = distinct(spec.rows, spec.category!);
  const stats = groups.map((group) => {
    const values = spec.rows
      .filter((row: ChartRow) => String(row[spec.category!]) === group)
      .map((row: ChartRow) => toNumber(row[spec.value!]))
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    const q1 = quantile(values, 0.25);
    const median = quantile(values, 0.5);
    const q3 = quantile(values, 0.75);
    const fence = 1.5 * (q3 - q1);
    const inside = values.filter((v) => v >= q1 - fence && v <= q3 + fence);
    return { group, n: values.length, q1, median, q3, low: inside[0] ?? values[0]!, high: inside[inside.length - 1] ?? values[values.length - 1]!, outliers: values.filter((v) => v < q1 - fence || v > q3 + fence) };
  }).filter((s) => s.n > 0);

  const all = stats.flatMap((s) => [s.low, s.high, ...s.outliers]);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const header = drawHeader(frame, spec, []);
  const plot: Plot = { left: axisLabelWidth(scale, spec.unit), top: header + (spec.yLabel ? 14 : 4), width: 0, height: 250 };
  plot.width = width - plot.left - 12;
  const bottom = plot.top + plot.height;
  const y = linear([scale.min, scale.max], [bottom, plot.top]);
  frame.height = bottom + (spec.xLabel ? 44 : 28);
  drawValueAxisY(frame, plot, scale, y, spec.unit, spec.yLabel);

  const slot = plot.width / stats.length;
  const boxW = Math.min(52, slot * 0.5);
  const colour = categorical(theme, 0);
  const centre = (index: number): number => plot.left + slot * (index + 0.5);
  for (const [index, s] of stats.entries()) {
    const cx = centre(index);
    const tip = `${s.group} (n=${s.n})\nmedian ${withUnit(formatNumber(s.median), spec.unit)}\nQ1–Q3 ${formatNumber(s.q1)} – ${formatNumber(s.q3)}\nrange ${formatNumber(s.low)} – ${formatNumber(s.high)}${s.outliers.length ? `\n${s.outliers.length} outlier${s.outliers.length === 1 ? "" : "s"}` : ""}`;
    parts.push(`<line x1="${round(cx)}" x2="${round(cx)}" y1="${round(y(s.high))}" y2="${round(y(s.low))}" stroke="${colour}" stroke-width="1.5"/>`);
    for (const end of [s.low, s.high]) parts.push(`<line x1="${round(cx - boxW / 4)}" x2="${round(cx + boxW / 4)}" y1="${round(y(end))}" y2="${round(y(end))}" stroke="${colour}" stroke-width="1.5"/>`);
    parts.push(`<rect x="${round(cx - boxW / 2)}" y="${round(y(s.q3))}" width="${round(boxW)}" height="${round(Math.max(1, y(s.q1) - y(s.q3)))}" rx="2" fill="${mix(colour, ink.surface, 0.4)}" stroke="${colour}" stroke-width="1.5"><title>${esc(tip)}</title></rect>`);
    parts.push(`<line x1="${round(cx - boxW / 2)}" x2="${round(cx + boxW / 2)}" y1="${round(y(s.median))}" y2="${round(y(s.median))}" stroke="${ink.text}" stroke-width="2"/>`);
    for (const o of s.outliers) parts.push(`<circle cx="${round(cx)}" cy="${round(y(o))}" r="3" fill="none" stroke="${colour}" stroke-width="1.5"><title>${esc(`${s.group}: ${formatNumber(o)}`)}</title></circle>`);
  }
  categoryTicks(frame, plot, stats.map((s) => s.group), centre, bottom, spec.xLabel);
}

// ── entry ──────────────────────────────────────────────────────────────────────────────────

/** The chart as an SVG document string. */
export function renderChartSvg(spec: ChartSpec, options: ChartRenderOptions = {}): string {
  const theme = options.theme ?? "dark";
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(options.width ?? 560)));
  const frame: Frame = { theme, ink: INK[theme], width, parts: [], top: 0, height: 300 };
  switch (spec.type) {
    case "bar": drawBar(frame, spec); break;
    case "line":
    case "area": drawLine(frame, spec); break;
    case "scatter": drawScatter(frame, spec); break;
    case "histogram": drawHistogram(frame, spec); break;
    case "heatmap": drawHeatmap(frame, spec); break;
    case "donut": drawDonut(frame, spec); break;
    case "box": drawBox(frame, spec); break;
  }
  return wrap(frame, describeChart(spec));
}

/** The palette a chart draws with, for tests and documentation. */
export const CHART_COLOURS = CATEGORICAL;
