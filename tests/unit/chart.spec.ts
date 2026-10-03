import { describe, expect, it } from "vitest";
import { formatNumber, renderChartSvg, withUnit } from "../../src/shared/chart-render.js";
import {
  MAX_CHART_CATEGORIES, MAX_CHART_ROWS, chartCategories, chartSeriesNames, parseChartSpec, toNumber,
  type ChartSpec,
} from "../../src/shared/chart-spec.js";

function spec(input: unknown): ChartSpec {
  const parsed = parseChartSpec(JSON.stringify(input));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

function error(input: unknown): string {
  const parsed = parseChartSpec(typeof input === "string" ? input : JSON.stringify(input));
  if (parsed.ok) throw new Error("expected the spec to be refused");
  return parsed.error;
}

const WEEKS = [{ week: "w1", p50: 120, p95: 300 }, { week: "w2", p50: 140, p95: 280 }];

describe("parseChartSpec", () => {
  it("reads wide data: several y fields are several series", () => {
    const parsed = spec({ type: "bar", x: "week", y: ["p50", "p95"], data: WEEKS });
    expect(chartSeriesNames(parsed)).toEqual(["p50", "p95"]);
    expect(chartCategories(parsed)).toEqual(["w1", "w2"]);
  });

  it("reads long data: one y, and the series field's values are the series", () => {
    const parsed = spec({ type: "line", x: "day", y: "ms", series: "route", data: [
      { day: "d1", ms: 5, route: "A" }, { day: "d1", ms: 7, route: "B" }, { day: "d2", ms: 6, route: "A" },
    ] });
    expect(chartSeriesNames(parsed)).toEqual(["A", "B"]);
  });

  it("reads compact data as columns and rows", () => {
    const parsed = spec({ type: "bar", x: "w", y: ["n"], data: { columns: ["w", "n"], rows: [["a", 1], ["b", 2]] } });
    expect(parsed.rows).toEqual([{ w: "a", n: 1 }, { w: "b", n: 2 }]);
  });

  it("accepts numbers written as text, and says which row has something else", () => {
    expect(toNumber("1,200")).toBe(1200);
    expect(toNumber("45%")).toBe(45);
    expect(toNumber("$3.50")).toBe(3.5);
    expect(toNumber("n/a")).toBeUndefined();
    expect(toNumber(Number.NaN)).toBeUndefined();
    expect(error({ type: "bar", x: "w", y: ["n"], data: [{ w: "a", n: 1 }, { w: "b", n: "lots" }] })).toMatch(/"n" must be numeric, but row 2 has "lots"/);
  });

  it("names the fields that exist when one is wrong", () => {
    expect(error({ type: "bar", x: "week", y: ["p99"], data: WEEKS })).toMatch(/"p99".*not in the data.*week, p50, p95/);
    expect(error({ type: "bar", x: "when", y: ["p50"], data: WEEKS })).toMatch(/"when".*Fields in the data/);
  });

  it("explains JSON mistakes and a missing type", () => {
    expect(error("{ type: 'bar' }")).toMatch(/must be JSON/);
    expect(error("[1,2]")).toMatch(/one JSON object/);
    expect(error({ x: "w", data: WEEKS })).toMatch(/`type` must be one of/);
    expect(error({ type: "pie", data: WEEKS })).toMatch(/Got "pie"/);
    expect(error({ type: "bar", x: "week", y: ["p50"] })).toMatch(/`data` is missing/);
    expect(error({ type: "bar", x: "week", y: ["p50"], data: [] })).toMatch(/no rows/);
  });

  it("holds each type to the fields it needs", () => {
    expect(error({ type: "scatter", x: "a", y: ["b", "c"], data: [{ a: 1, b: 2, c: 3 }] })).toMatch(/exactly one `y`/);
    expect(error({ type: "heatmap", x: "a", y: ["b"], data: [{ a: 1, b: 2 }] })).toMatch(/`value`/);
    expect(error({ type: "histogram", data: [{ a: 1 }] })).toMatch(/`value`/);
    expect(error({ type: "donut", data: [{ a: 1 }] })).toMatch(/`category`/);
    expect(error({ type: "bar", y: ["p50"], data: WEEKS })).toMatch(/needs `x`/);
    expect(error({ type: "bar", x: "week", y: ["p50", "p95"], series: "week", data: WEEKS })).toMatch(/either several `y`/);
  });

  it("takes donut and box fields from x and y, and a histogram's from x", () => {
    expect(spec({ type: "donut", x: "n", y: ["v"], data: [{ n: "a", v: 1 }] })).toMatchObject({ category: "n", value: "v" });
    expect(spec({ type: "histogram", x: "v", data: [{ v: 1 }, { v: 2 }] })).toMatchObject({ value: "v" });
  });

  it("enforces the limits that keep a chart legible", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `s${i}`);
    expect(error({ type: "line", x: "w", y: nine, data: [Object.fromEntries([["w", "a"], ...nine.map((n) => [n, 1])])] })).toMatch(/9 series is more than 8/);
    const many = Array.from({ length: MAX_CHART_CATEGORIES + 1 }, (_, i) => ({ w: `c${i}`, n: i }));
    expect(error({ type: "bar", x: "w", y: ["n"], data: many })).toMatch(/categories along x/);
    expect(error({ type: "bar", x: "w", y: ["n"], data: Array.from({ length: MAX_CHART_ROWS + 1 }, () => ({ w: "a", n: 1 })) })).toMatch(/rows; the limit/);
  });
});

describe("number formatting", () => {
  it("is compact and keeps small values readable", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(0.123)).toBe("0.12");
    expect(formatNumber(3.456)).toBe("3.46");
    expect(formatNumber(120)).toBe("120");
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(12500)).toBe("12.5k");
    expect(formatNumber(3_400_000)).toBe("3.4M");
    expect(formatNumber(-2500)).toBe("-2,500");
  });

  it("puts currency in front and other units after", () => {
    expect(withUnit("5", "$")).toBe("$5");
    expect(withUnit("5", "%")).toBe("5%");
    expect(withUnit("5", "ms")).toBe("5 ms");
    expect(withUnit("5", undefined)).toBe("5");
  });
});

describe("renderChartSvg", () => {
  const draw = (input: unknown, options = {}): string => renderChartSvg(spec(input), options);

  const SAMPLES: Record<string, unknown> = {
    bar: { type: "bar", x: "week", y: ["p50", "p95"], data: WEEKS },
    stackedPercent: { type: "bar", x: "week", y: ["p50", "p95"], stack: "percent", data: WEEKS },
    horizontal: { type: "bar", x: "week", y: ["p50"], horizontal: true, data: WEEKS },
    line: { type: "line", x: "week", y: ["p50", "p95"], data: WEEKS },
    numericLine: { type: "line", x: "n", y: ["v"], data: [{ n: 1, v: 3 }, { n: 5, v: 9 }, { n: 10, v: 4 }] },
    area: { type: "area", x: "week", y: ["p50", "p95"], stack: true, data: WEEKS },
    scatter: { type: "scatter", x: "a", y: "b", size: "c", series: "d", data: [{ a: 1, b: 2, c: 3, d: "x" }, { a: 2, b: 1, c: 6, d: "y" }] },
    histogram: { type: "histogram", value: "v", data: Array.from({ length: 50 }, (_, i) => ({ v: i % 17 })) },
    heatmap: { type: "heatmap", x: "h", y: "d", value: "n", data: [{ h: "9", d: "Mon", n: 1 }, { h: "10", d: "Mon", n: 5 }, { h: "9", d: "Tue", n: 3 }] },
    donut: { type: "donut", category: "p", value: "m", data: [{ p: "a", m: 3 }, { p: "b", m: 1 }] },
    singleSlice: { type: "donut", category: "p", value: "m", data: [{ p: "only", m: 3 }] },
    box: { type: "box", category: "r", value: "v", data: Array.from({ length: 20 }, (_, i) => ({ r: i % 2 ? "A" : "B", v: i })) },
  };

  it.each(Object.entries(SAMPLES))("draws a %s chart as a well-formed, sized SVG", (_name, input) => {
    const svg = draw(input);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+(\.\d+)? \d+(\.\d+)?"/);
    expect(svg).toContain('role="img"');
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    // Balanced elements: every <title>, <text> and <g> opened is closed.
    for (const tag of ["text", "title", "defs", "linearGradient"]) {
      expect((svg.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length).toBe((svg.match(new RegExp(`</${tag}>`, "g")) ?? []).length);
    }
  });

  it("escapes everything that comes from the data", () => {
    const svg = draw({ type: "bar", title: "<script>alert(1)</script>", x: "w", y: ["n"], data: [{ w: "\"><img src=x onerror=alert(1)>", n: 1 }] });
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("draws a legend for two or more series and none for one", () => {
    expect(draw(SAMPLES["bar"])).toContain(">p95</text>");
    const single = draw({ type: "bar", x: "week", y: ["p50"], data: WEEKS });
    expect(single).not.toContain(">p50</text>");
  });

  it("uses series display names", () => {
    expect(draw({ type: "bar", x: "week", y: ["p50", "p95"], names: { p50: "Median" }, data: WEEKS })).toContain(">Median</text>");
  });

  it("gives every mark hover text with its value and unit", () => {
    const svg = draw({ type: "bar", x: "week", y: ["p50"], unit: "ms", data: WEEKS });
    expect(svg).toContain("<title>w1 · p50: 120 ms</title>");
  });

  it("folds a ninth donut slice into Other", () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ p: `s${i}`, m: 12 - i }));
    const svg = draw({ type: "donut", category: "p", value: "m", data });
    expect(svg).toContain("Other");
    expect((svg.match(/<path /g) ?? []).length).toBe(8);
  });

  it("lays out for the width it is given, within limits", () => {
    expect(draw(SAMPLES["bar"], { width: 330 })).toContain('viewBox="0 0 330 ');
    expect(draw(SAMPLES["bar"], { width: 50 })).toContain('viewBox="0 0 260 ');
    expect(draw(SAMPLES["bar"], { width: 5000 })).toContain('viewBox="0 0 900 ');
  });

  it("draws light and dark with different ink", () => {
    expect(draw(SAMPLES["bar"], { theme: "dark" })).not.toBe(draw(SAMPLES["bar"], { theme: "light" }));
  });

  it("copes with a missing value in a line chart, and with a series that is all zeros", () => {
    expect(draw({ type: "line", x: "w", y: ["a", "b"], data: [{ w: 1, a: 1, b: 2 }, { w: 2, a: 2 }, { w: 3, a: 3, b: 1 }] })).not.toMatch(/NaN/);
    expect(draw({ type: "bar", x: "w", y: ["a"], data: [{ w: "x", a: 0 }, { w: "y", a: 0 }] })).not.toMatch(/NaN/);
    expect(draw({ type: "histogram", value: "v", data: [{ v: 5 }, { v: 5 }, { v: 5 }] })).not.toMatch(/NaN/);
    expect(draw({ type: "heatmap", x: "h", y: "d", value: "n", data: [{ h: "a", d: "b", n: 4 }] })).not.toMatch(/NaN/);
  });
});
