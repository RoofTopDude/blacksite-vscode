import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* The built Map webview (out/webview/graph.js) driven by host messages the way
   GraphProvider sends them: a two-codebase workspace lands on the Systems
   overview, the outline and scope bar render, and stepping into a codebase
   whose files the render sample dropped asks the host for them. */

function node(id: string, codebase: string, dir: string, x: number, y: number) {
  return { id, dir, codebase, lang: "ts", sizeBytes: 800, inDegree: 1, outDegree: 1, x, y, z: 0.5 };
}

const nodes = [
  ...Array.from({ length: 30 }, (_, i) => node(`web/src/f${i % 3}/page${i}.ts`, "web", `web/src/f${i % 3}`, (i % 6) * 30, Math.floor(i / 6) * 30)),
  ...Array.from({ length: 12 }, (_, i) => node(`api/src/h${i}.ts`, "api", "api/src", 500 + (i % 4) * 30, Math.floor(i / 4) * 30)),
];
const group = (id: string, level: string, key: string, parent: string | null, fileCount: number, renderedCount: number) => ({
  id, level, key, label: key.split("/").pop(), parent, fileCount, renderedCount, langs: [["ts", fileCount]], churn: 4, lastCommitAt: 0, x: 0, y: 0, radius: 10,
});
const hierarchy = {
  groups: [
    group("◈web", "codebase", "web", null, 30, 30),
    group("◈api", "codebase", "api", null, 4000, 12),
    group("▤web/src/f0", "area", "web/src/f0", "◈web", 10, 10),
    group("▤web/src/f1", "area", "web/src/f1", "◈web", 10, 10),
    group("▤web/src/f2", "area", "web/src/f2", "◈web", 10, 10),
    group("▤api/src", "area", "api/src", "◈api", 4000, 12),
  ],
  edges: [
    { id: "grp:sys:import:◈web->◈api", level: "systems", from: "◈web", to: "◈api", kind: "import", count: 120 },
    { id: "grp:sys:cochange:◈web->◈api", level: "systems", from: "◈web", to: "◈api", kind: "cochange", count: 4, unexplained: true },
  ],
  roots: [],
  declaredUnused: [{ fromProject: "web", toProject: "api", fromName: "web", toName: "api", kind: "package", imports: 0 }],
  usedUndeclared: [],
  fileCount: 4030,
};

describe("Codebase Map at scale", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  const root = path.resolve("out/webview");
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8").replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce").replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", "/graph.js"));
        return;
      }
      const target = path.resolve(root, `.${url.pathname}`);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", target.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const executablePath = process.platform === "win32" ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync) : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

  async function open(width = 1280): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const win = window as unknown as { acquireVsCodeApi: () => unknown; messages: unknown[] };
      win.messages = [];
      win.acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => win.messages.push(message),
        getState: () => ({}),
        setState: () => undefined,
      });
    });
    await page.goto(base);
    await page.evaluate(({ nodes: graphNodes, hierarchy: tree }) => {
      window.postMessage({
        type: "graph_state", seq: 3, nodes: graphNodes, edges: [], annotations: [], indexing: false, truncated: true,
        indexedTruncated: false, renderedTruncated: true, indexedFileCount: 4030, renderedNodeCount: graphNodes.length,
        indexedImportEdgeCount: 500, renderedImportEdgeCount: 0, indexedAt: new Date().toISOString(), gitignoreApplied: true,
        config: { traceFadeSeconds: 45, traceShellEvents: true, landingView: "auto" },
      }, "*");
      window.postMessage({ type: "graph_hierarchy", hierarchy: tree }, "*");
    }, { nodes, hierarchy });
    return { page, errors };
  }

  it("lands on the Systems overview with the outline, scope bar, and hidden-coupling findings", async () => {
    const { page, errors } = await open();
    const outline = page.locator("[data-map-region='outline']");
    await outline.waitFor({ timeout: 5000 });
    await expect(outline.getByRole("button", { name: /^api$/ })).toBeTruthy();
    await page.getByRole("button", { name: "Systems", exact: true }).waitFor({ timeout: 5000 });
    expect(await page.getByRole("button", { name: "Systems", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await page.getByText("Following .gitignore").waitFor({ timeout: 5000 });
    await page.getByText("Dependency findings · 1").waitFor({ timeout: 5000 });
    /* Folded codebases are labelled on the canvas with their true counts. */
    await page.locator(".map-group-label", { hasText: "api" }).getByText("codebase · 4,000 files").waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.resolve("out/map-scale-systems.png") });
    expect(errors).toEqual([]);
  });

  it("steps into a codebase from the outline and asks the host for the files the sample dropped", async () => {
    const { page, errors } = await open();
    const outline = page.locator("[data-map-region='outline']");
    await outline.getByRole("button", { name: /^api$/ }).click();
    await page.locator(".map-crumb-current", { hasText: "api" }).waitFor({ timeout: 5000 });
    const messages = await page.evaluate(() => (window as unknown as { messages: Array<Record<string, unknown>> }).messages);
    expect(messages).toContainEqual({ type: "request_scope_detail", groupId: "◈api", level: "codebase", key: "api" });
    /* Backspace returns to the workspace. */
    await page.locator("body").click({ position: { x: 700, y: 400 } });
    await page.keyboard.press("Backspace");
    await page.locator(".map-crumb-current", { hasText: "Workspace" }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.resolve("out/map-scale-scoped.png") });
    expect(errors).toEqual([]);
  });

  it("opens a group's inspector with tabs", async () => {
    const { page, errors } = await open();
    await page.evaluate(() => window.postMessage({ type: "focus_node", path: "api/src/h1.ts" }, "*"));
    await page.locator("[data-map-region='inspector']").waitFor({ timeout: 5000 });
    await page.getByRole("tab", { name: "Relations" }).click();
    await page.getByRole("tab", { name: "Activity" }).click();
    await page.getByText(/Execution Runs|No retained Execution Run/).first().waitFor({ timeout: 5000 });
    expect(errors).toEqual([]);
  });
});
