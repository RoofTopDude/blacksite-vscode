/* The `chart` fence: a JSON description of a chart, for the shapes Mermaid cannot draw.
 *
 * Mermaid covers diagrams and a few charts (pie, one bar-plus-line XY chart, Sankey, radar,
 * treemap). It has no scatter or bubble plot, stacked or grouped bars, histogram, heatmap, or
 * box plot, and no legend for its series. A ```chart block fills that gap. Unlike a drawing
 * language, a chart is data plus a few choices, so the spec is small, and every mistake in it
 * (a field that is not in the data, text where a number belongs) is reported by name.
 *
 * Pure parsing, no DOM and no vscode: the host's diagram_check, the webview's renderer, and
 * the tests all read it through here.
 */

export const CHART_TYPES = ["bar", "line", "area", "scatter", "histogram", "heatmap", "donut", "box"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MAX_CHART_ROWS = 2_000;
export const MAX_CHART_SERIES = 8;
export const MAX_CHART_CATEGORIES = 60;
export const MAX_CHART_SOURCE_CHARS = 120_000;

export type ChartRow = Record<string, unknown>;

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  /** Horizontal axis: a category or number per row. */
  x?: string;
  /** Vertical axis: one field per series (wide data), or one field with `series` (long data). */
  y: string[];
  /** A field whose distinct values become the series (long data). */
  series?: string;
  /** Scatter: a numeric field that sizes each point, making it a bubble plot. */
  size?: string;
  /** Heatmap, donut, histogram, box: the numeric field. */
  value?: string;
  /** Donut and box: the field that names each slice or group. */
  category?: string;
  rows: ChartRow[];
  /** Bar and area: true stacks series; "percent" stacks them to 100%. */
  stack: boolean | "percent";
  /** Bar: draw bars sideways, for long category names. */
  horizontal: boolean;
  /** Histogram: number of bins. Chosen from the data when omitted. */
  bins?: number;
  /** Appended to values: "ms", "%", "tokens". A leading "$", "€" or "£" is put in front instead. */
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  /** Series display names, by field or value. */
  names: Record<string, string>;
  /** false hides the value labels drawn on bars, cells and slices. */
  labels: boolean;
}

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; error: string };

const MAX_TEXT = 200;

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** A finite number from a number, or from text like "1,200", "45%", "$3.50". */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/[,\s$€£%]/g, "");
  if (!cleaned || !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fieldList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  return [];
}

/** Rows from either `[{…}, {…}]` or the compact `{ "columns": […], "rows": [[…], […]] }`. */
function readRows(data: unknown): ChartRow[] | string {
  if (Array.isArray(data)) {
    const rows: ChartRow[] = [];
    for (const [index, row] of data.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return `data row ${index + 1} is not an object. Use [{"field": value}, …] or {"columns": […], "rows": [[…]]}.`;
      rows.push(row as ChartRow);
    }
    return rows;
  }
  if (data && typeof data === "object") {
    const { columns, rows } = data as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(columns) || !columns.every((column) => typeof column === "string") || !Array.isArray(rows)) {
      return "compact data needs a \"columns\" array of names and a \"rows\" array of arrays.";
    }
    const names = columns as string[];
    const out: ChartRow[] = [];
    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row)) return `data row ${index + 1} is not an array.`;
      out.push(Object.fromEntries(names.map((name, at) => [name, row[at]])));
    }
    return out;
  }
  return "`data` is missing. Give an array of row objects, or {\"columns\": […], \"rows\": [[…]]}.";
}

function availableFields(rows: ChartRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 50)) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** Parse the text of a ```chart block. */
export function parseChartSpec(source: string): ChartParse {
  if (source.length > MAX_CHART_SOURCE_CHARS) {
    return { ok: false, error: `The chart is ${source.length.toLocaleString()} characters; the limit is ${MAX_CHART_SOURCE_CHARS.toLocaleString()}. Aggregate the data first.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `A chart block must be JSON (double-quoted keys and strings, no comments or trailing commas): ${detail}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "A chart block must be one JSON object." };
  const input = raw as Record<string, unknown>;

  const type = text(input["type"])?.toLowerCase();
  if (!type || !(CHART_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `\`type\` must be one of: ${CHART_TYPES.join(", ")}.${type ? ` Got "${type}".` : ""}` };
  }

  const rowsOrError = readRows(input["data"]);
  if (typeof rowsOrError === "string") return { ok: false, error: rowsOrError };
  const rows = rowsOrError;
  if (rows.length === 0) return { ok: false, error: "`data` has no rows." };
  if (rows.length > MAX_CHART_ROWS) {
    return { ok: false, error: `\`data\` has ${rows.length.toLocaleString()} rows; the limit is ${MAX_CHART_ROWS.toLocaleString()}. Aggregate or sample it before charting.` };
  }

  const stackInput = input["stack"];
  const spec: ChartSpec = {
    type: type as ChartType,
    ...(text(input["title"]) ? { title: text(input["title"])! } : {}),
    ...(text(input["subtitle"]) ? { subtitle: text(input["subtitle"])! } : {}),
    ...(text(input["x"]) ? { x: text(input["x"])! } : {}),
    y: fieldList(input["y"]),
    ...(text(input["series"]) ? { series: text(input["series"])! } : {}),
    ...(text(input["size"]) ? { size: text(input["size"])! } : {}),
    ...(text(input["value"]) ? { value: text(input["value"])! } : {}),
    ...(text(input["category"]) ? { category: text(input["category"])! } : {}),
    rows,
    stack: stackInput === "percent" ? "percent" : stackInput === true,
    horizontal: input["horizontal"] === true,
    ...(typeof input["bins"] === "number" && input["bins"] >= 2 ? { bins: Math.min(60, Math.round(input["bins"])) } : {}),
    ...(text(input["unit"], 24) ? { unit: text(input["unit"], 24)! } : {}),
    ...(text(input["xLabel"]) ? { xLabel: text(input["xLabel"])! } : {}),
    ...(text(input["yLabel"]) ? { yLabel: text(input["yLabel"])! } : {}),
    names: input["names"] && typeof input["names"] === "object" && !Array.isArray(input["names"])
      ? Object.fromEntries(Object.entries(input["names"] as Record<string, unknown>).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, (value as string).slice(0, 60)]))
      : {},
    labels: input["labels"] !== false,
  };

  // Aliases a model reaches for: a donut or box takes `x`/`y` as its category/value, a histogram
  // takes its numbers from `x`, `y`, or `value`.
  if (spec.type === "donut" || spec.type === "box") {
    spec.category ??= spec.x;
    spec.value ??= spec.y[0];
  }
  if (spec.type === "histogram") spec.value ??= spec.x ?? spec.y[0];

  const problem = checkFields(spec);
  return problem ? { ok: false, error: problem } : { ok: true, spec };
}

function checkFields(spec: ChartSpec): string | undefined {
  const fields = availableFields(spec.rows);
  const where = `Fields in the data: ${fields.join(", ") || "none"}.`;
  const named = (field: string | undefined, role: string): string | undefined =>
    field && !fields.includes(field) ? `\`${role}\` names "${field}", which is not in the data. ${where}` : undefined;

  const numeric = (field: string, role: string): string | undefined => {
    const missing = named(field, role);
    if (missing) return missing;
    for (const [index, row] of spec.rows.entries()) {
      const value = row[field];
      if (value === null || value === undefined || value === "") continue;
      if (toNumber(value) === undefined) return `\`${role}\` "${field}" must be numeric, but row ${index + 1} has ${JSON.stringify(value)}.`;
    }
    return undefined;
  };
  const required = (field: string | undefined, role: string, hint: string): string | undefined =>
    field ? undefined : `A ${spec.type} chart needs \`${role}\` ${hint}.`;

  const issues: Array<string | undefined> = [];
  const series = spec.series;
  issues.push(named(series, "series"), named(spec.x, "x"));

  switch (spec.type) {
    case "bar":
    case "line":
    case "area": {
      issues.push(required(spec.x, "x", "(the category or number along the bottom)"));
      if (spec.y.length === 0) issues.push("A chart needs `y`: a numeric field, or an array of them for several series.");
      for (const field of spec.y) issues.push(numeric(field, "y"));
      if (series && spec.y.length > 1) issues.push("Use either several `y` fields or one `y` with `series`, not both.");
      break;
    }
    case "scatter": {
      issues.push(required(spec.x, "x", "(a numeric field)"));
      if (spec.x) issues.push(numeric(spec.x, "x"));
      if (spec.y.length !== 1) issues.push("A scatter chart needs exactly one `y` field.");
      else issues.push(numeric(spec.y[0]!, "y"));
      if (spec.size) issues.push(numeric(spec.size, "size"));
      break;
    }
    case "histogram": {
      issues.push(required(spec.value, "value", "(the numeric field to bin)"));
      if (spec.value) issues.push(numeric(spec.value, "value"));
      break;
    }
    case "heatmap": {
      issues.push(required(spec.x, "x", "(the column category)"));
      if (spec.y.length !== 1) issues.push("A heatmap needs exactly one `y` field (the row category).");
      issues.push(required(spec.value, "value", "(the numeric field that colours each cell)"));
      if (spec.value) issues.push(numeric(spec.value, "value"));
      issues.push(named(spec.y[0], "y"));
      break;
    }
    case "donut": {
      issues.push(required(spec.category, "category", "(or `x`): the field naming each slice"));
      issues.push(required(spec.value, "value", "(or `y`): the numeric field sizing each slice"));
      if (spec.category) issues.push(named(spec.category, "category"));
      if (spec.value) issues.push(numeric(spec.value, "value"));
      break;
    }
    case "box": {
      issues.push(required(spec.category, "category", "(or `x`): the field naming each group"));
      issues.push(required(spec.value, "value", "(or `y`): the numeric field to summarise"));
      if (spec.category) issues.push(named(spec.category, "category"));
      if (spec.value) issues.push(numeric(spec.value, "value"));
      break;
    }
  }
  const first = issues.find((issue) => issue !== undefined);
  if (first) return first;

  // The limits that keep a chart legible.
  const seriesCount = chartSeriesNames(spec).length;
  if (seriesCount > MAX_CHART_SERIES) {
    return `${seriesCount} series is more than ${MAX_CHART_SERIES}: past that the colours cannot be told apart. Keep the ${MAX_CHART_SERIES - 1} that matter and fold the rest into "Other", or draw one chart per group.`;
  }
  const categories = chartCategories(spec).length;
  if ((spec.type === "bar" || spec.type === "line" || spec.type === "area") && categories > MAX_CHART_CATEGORIES) {
    return `${categories} categories along x is more than ${MAX_CHART_CATEGORIES}. Aggregate (for example to weeks), or show the top ${MAX_CHART_CATEGORIES}.`;
  }
  return undefined;
}

/** The distinct values of `field`, in the order they first appear. */
export function distinct(rows: ChartRow[], field: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[field];
    if (value !== null && value !== undefined && value !== "") seen.add(String(value));
  }
  return [...seen];
}

/** Series names in display order: the `series` field's values, or the `y` fields. */
export function chartSeriesNames(spec: ChartSpec): string[] {
  if (spec.series && (spec.type === "bar" || spec.type === "line" || spec.type === "area" || spec.type === "scatter")) {
    return distinct(spec.rows, spec.series);
  }
  if (spec.type === "bar" || spec.type === "line" || spec.type === "area") return spec.y;
  return [];
}

/** The x categories of a bar, line, or area chart, in the order they first appear. */
export function chartCategories(spec: ChartSpec): string[] {
  return spec.x ? distinct(spec.rows, spec.x) : [];
}

/** What a chart is, in a sentence, for its accessible label and for a tool result. */
export function describeChart(spec: ChartSpec): string {
  const names = chartSeriesNames(spec);
  const kind = spec.type === "donut" ? "Donut chart" : spec.type === "box" ? "Box plot" : `${spec.type[0]!.toUpperCase()}${spec.type.slice(1)} chart`;
  const parts = [spec.title ? `${kind}: ${spec.title}` : kind, `${spec.rows.length} rows`];
  if (names.length > 1) parts.push(`${names.length} series (${names.map((name) => spec.names[name] ?? name).join(", ")})`);
  return parts.join(", ");
}
