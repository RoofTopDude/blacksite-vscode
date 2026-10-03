import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { CATEGORICAL } from "../../src/shared/diagram-theme.js";

/* Charts and chart-type diagrams, against the real built chat webview under its real CSP.
   Two things are guarded here that a unit test cannot see. The `chart` fence draws through the
   same Markdown component as Mermaid, so it must survive the sanitizer and the CSP and follow
   the panel's width. And the Mermaid data charts (pie, XY, Sankey) used to come out as
   near-black slices and invisible ribbons because their category colours were derived from the
   panel's near-black tints; the assertions below read the colours the browser actually painted. */

const TURN = "turn-charts";

const BAR = JSON.stringify({
  type: "bar", title: "Latency by week", x: "week", y: ["p50", "p95"], unit: "ms",
  data: { columns: ["week", "p50", "p95"], rows: [["w1", 120, 300], ["w2", 140, 280], ["w3", 130, 410]] },
});
const DONUT = JSON.stringify({ type: "donut", title: "Where time went", category: "phase", value: "mins", data: [{ phase: "Reading", mins: 40 }, { phase: "Editing", mins: 25 }, { phase: "Tests", mins: 20 }] });
const BROKEN = JSON.stringify({ type: "bar", x: "week", y: ["p99"], data: [{ week: "w1", p50: 1 }] });
const HOSTILE = JSON.stringify({ type: "bar", title: "<img src=x onerror=alert(1)>", x: "k", y: ["n"], data: [{ k: "<script>alert(1)</script>", n: 1 }] });

const REPLY = [
  "```chart", BAR, "```",
  "```chart", DONUT, "```",
  "```chart", BROKEN, "```",
  "```chart", HOSTILE, "```",
  "```mermaid", "pie showData title Where time went", "  \"Reading\" : 40", "  \"Editing\" : 25", "  \"Tests\" : 20", "  \"Waiting\" : 10", "  \"Other\" : 5", "```",
  "```mermaid", "xychart-beta", "  title \"Latency\"", "  x-axis [w1, w2, w3]", "  y-axis \"ms\" 0 --> 400", "  bar [120, 180, 150]", "  line [100, 170, 160]", "```",
  "```mermaid", "sankey-beta", "", "Tokens,Cache hit,60", "Tokens,Cache miss,40", "```",
  "```mermaid", "---", "config:", "  layout: elk", "---", "flowchart LR", "  A --> B --> C", "  A --> C", "  B --> D", "  C --> D", "```",
  "```mermaid", "venn-beta", "  set A[\"Agents\"]", "  set B[\"Editors\"]", "  union A,B[\"Blacksite\"]", "```",
].join("\n");

interface FixtureWindow extends Window {
  __cspViolations: string[];
  __messages: Array<Record<string, unknown>>;
}

describe("built chat webview: charts", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  const root = path.resolve("out/webview");

  beforeAll(async () => {
    if (!fs.existsSync(path.join(root, "shell.html"))) throw new Error("Run npm run build before npm run test:browser.");
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      if (pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8")
          .replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce")
          .replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", "/webview.js"));
        return;
      }
      const target = path.resolve(root, `.${pathname}`);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const executablePath = process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync)
      : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
    await page.addInitScript(() => {
      const win = window as unknown as FixtureWindow & { acquireVsCodeApi: unknown };
      win.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        win.__cspViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
      win.__messages = [];
      win.acquireVsCodeApi = () => ({
        postMessage: (message: Record<string, unknown>) => { win.__messages.push(message); },
        getState: () => ({}),
        setState: () => undefined,
      });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    await page.evaluate(({ turn, reply }) => {
      window.postMessage({ type: "stream_start", id: turn }, "*");
      window.postMessage({ type: "stream_delta", id: turn, text: reply }, "*");
      window.postMessage({ type: "stream_end", id: turn, stopReason: "end_turn" }, "*");
    }, { turn: TURN, reply: REPLY });
    await page.waitForFunction(
      () => document.querySelectorAll(".cb-chart.is-rendered, .cb-chart.is-failed").length === 4
        && document.querySelectorAll(".cb-mermaid.is-rendered, .cb-mermaid.is-failed").length === 5,
      undefined,
      { timeout: 30_000 },
    );
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  const charts = () => page.locator(".cb-chart");
  const diagrams = () => page.locator(".cb-mermaid");

  it("draws a chart block as SVG with its JSON tucked away", async () => {
    const bar = charts().nth(0);
    expect(await bar.getAttribute("class")).toContain("is-rendered");
    expect(await bar.locator(".cb-diagram svg").isVisible()).toBe(true);
    expect(await bar.locator(":scope > pre").isVisible()).toBe(false);
    const text = await bar.locator(".cb-diagram").textContent();
    expect(text).toContain("Latency by week");
    expect(text).toContain("p95");
  });

  it("gives marks hover text carrying the value and unit", async () => {
    const tips = await charts().nth(0).locator(".cb-diagram svg title").allTextContents();
    expect(tips).toContain("w1 · p50: 120 ms");
  });

  it("paints series in distinct, visible colours", async () => {
    const fills = await charts().nth(0).locator("svg rect[fill^='#']").evaluateAll((rects) => [...new Set(rects.map((r) => r.getAttribute("fill")))]);
    expect(fills.length).toBeGreaterThanOrEqual(2);
    const slices = await charts().nth(1).locator("svg path[fill^='#']").evaluateAll((paths) => paths.map((p) => p.getAttribute("fill")));
    expect(new Set(slices).size).toBe(3);
  });

  it("shows a spec that does not parse as its source plus the reason, naming the field", async () => {
    const broken = charts().nth(2);
    expect(await broken.getAttribute("class")).toContain("is-failed");
    expect(await broken.locator(".cb-diagram svg").count()).toBe(0);
    expect(await broken.locator(".cb-diagram").textContent()).toMatch(/"p99".*not in the data.*week, p50/);
    expect(await broken.locator(":scope > pre").isVisible()).toBe(true);
    expect(await broken.locator(".cb-toggle").isVisible()).toBe(false);
  });

  it("renders hostile labels as text, never as elements", async () => {
    const hostile = charts().nth(3);
    expect(await hostile.getAttribute("class")).toContain("is-rendered");
    expect(await hostile.locator(".cb-diagram img, .cb-diagram script").count()).toBe(0);
    expect(await hostile.locator(".cb-diagram").textContent()).toContain("<img src=x");
  });

  it("flips between the chart and its JSON", async () => {
    const bar = charts().nth(0);
    await bar.getByRole("button", { name: "Source", exact: true }).click();
    expect(await bar.locator(":scope > pre").isVisible()).toBe(true);
    expect(await bar.locator(".cb-diagram").isVisible()).toBe(false);
    await bar.getByRole("button", { name: "Chart", exact: true }).click();
    expect(await bar.locator(".cb-diagram svg").isVisible()).toBe(true);
  });

  it("lays the chart out again for a narrower panel instead of scaling its text", async () => {
    const widthOf = () => charts().nth(0).locator(".cb-diagram svg").evaluate((svg) => svg.viewBox.baseVal.width);
    const wide = await widthOf();
    await page.setViewportSize({ width: 460, height: 1000 });
    await page.waitForFunction((before) => {
      const svg = document.querySelector<SVGSVGElement>(".cb-chart .cb-diagram svg");
      return !!svg && svg.viewBox.baseVal.width < before - 40;
    }, wide, { timeout: 5_000 });
    const narrow = await widthOf();
    expect(narrow).toBeLessThan(wide);
    // The same 11px labels, not shrunken ones.
    expect(await charts().nth(0).locator(".cb-diagram svg text").first().getAttribute("font-size")).not.toBeNull();
    await page.setViewportSize({ width: 760, height: 1000 });
    await page.waitForFunction((before) => document.querySelector<SVGSVGElement>(".cb-chart .cb-diagram svg")!.viewBox.baseVal.width > before + 40, narrow);
  });

  it("offers Save on a diagram but not on a chart, and sends the diagram's source", async () => {
    expect(await charts().nth(0).getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
    await diagrams().nth(0).getByRole("button", { name: "Save", exact: true }).click();
    const saves = await page.evaluate(() => (window as unknown as FixtureWindow).__messages.filter((m) => m.type === "save_diagram"));
    expect(saves).toHaveLength(1);
    expect(String((saves[0] as { source: string }).source)).toContain("pie showData");
  });

  /* The regression these guard: pie slices and the XY palette were derived from the panel's
     near-black tints, so slices were black on black and bars and line were the same cream. */
  it("paints Mermaid pie slices in distinct colours that stand out from the panel", async () => {
    const fills = await diagrams().nth(0).locator("svg path.pieCircle").evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
    expect(fills).toHaveLength(5);
    expect(new Set(fills).size).toBe(5);
    const luminance = (rgb: string): number => {
      const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number) as [number, number, number];
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    for (const fill of fills) expect(luminance(fill)).toBeGreaterThan(0.15);
  });

  it("draws the XY chart's bars and line in the first two palette colours", async () => {
    const hex = (rgb: string): string => `#${(rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    const svg = diagrams().nth(1).locator("svg");
    const bar = await svg.locator("g.bar-plot-0 rect").first().evaluate((el) => getComputedStyle(el).fill);
    const line = await svg.locator("g.line-plot-1 path").first().evaluate((el) => getComputedStyle(el).stroke);
    // Mermaid's own default is two near-identical creams, which read as one series.
    expect(hex(bar)).toBe(CATEGORICAL.dark[0]);
    expect(hex(line)).toBe(CATEGORICAL.dark[1]);
  });

  it("draws Sankey ribbons without the multiply blend that makes them black on a dark panel", async () => {
    const blends = await diagrams().nth(2).locator("svg .link").evaluateAll((links) => links.map((l) => getComputedStyle(l).mixBlendMode));
    expect(blends.length).toBeGreaterThan(0);
    expect(new Set(blends)).toEqual(new Set(["normal"]));
  });

  it("lays out with ELK when a diagram asks for it, under the same CSP", async () => {
    const elk = diagrams().nth(3);
    expect(await elk.getAttribute("class")).toContain("is-rendered");
    expect(await elk.locator(".cb-diagram svg").isVisible()).toBe(true);
    expect(await elk.locator(".cb-diagram").textContent()).toContain("D");
  });

  it("draws the diagram types Mermaid added after the original set", async () => {
    const venn = diagrams().nth(4);
    expect(await venn.getAttribute("class")).toContain("is-rendered");
    expect(await venn.locator(".cb-diagram").textContent()).toContain("Blacksite");
  });

  it("keeps the panel's font tokens intact", async () => {
    const sans = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans"));
    expect(sans).toContain("Lexend");
  });

  it("does all of it without a single CSP violation", async () => {
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).__cspViolations)).toEqual([]);
  });
});
