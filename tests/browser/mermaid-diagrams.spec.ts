import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* Mermaid diagrams, against the real built webview under its real CSP.
   A unit test can check the fence markup, but not the parts that break in practice: that the
   lazily-split Mermaid chunks load under script-src, that the SVG's own <style> survives
   style-src, and that the sanitizer pass leaves a drawable diagram. A CSP violation of any
   kind fails the suite, so a Mermaid upgrade that starts needing eval or a remote asset shows
   up here rather than as a blank block in a user's chat. */

const TURN = "turn-mermaid";

const REPLY = [
  "Here is the request flow.",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[\"handle(request)\"] --> B{Authorized?}",
  "  B -->|yes| C[Run tool]",
  "  B -->|no| D[Ask for approval]",
  "```",
  "",
  "And a sequence:",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant Chat",
  "  participant Host",
  "  Chat->>Host: send",
  "  Host-->>Chat: stream_delta",
  "```",
  "",
  "This one is broken:",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[unclosed --> B",
  "```",
  "",
  "This label tries to load a remote image:",
  "",
  "```mermaid",
  "flowchart TD",
  "  X[\"<img src='https://attacker.example/pixel.png'> beacon\"] --> Y[done]",
  "```",
].join("\n");

interface FixtureWindow extends Window {
  __cspViolations: string[];
  __messages: Array<Record<string, unknown>>;
}

describe("built chat webview — Mermaid diagrams", () => {
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
    page = await browser.newPage({ viewport: { width: 680, height: 960 } });
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
    // Every block settles one way or the other before any test looks at it.
    await page.waitForFunction(
      () => document.querySelectorAll(".cb-mermaid.is-rendered, .cb-mermaid.is-failed").length === 4,
      undefined,
      { timeout: 20_000 },
    );
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  const blocks = () => page.locator(".cb-mermaid");

  it("draws valid diagrams as SVG with the source tucked away", async () => {
    for (const index of [0, 1]) {
      const block = blocks().nth(index);
      expect(await block.getAttribute("class")).toContain("is-rendered");
      expect(await block.locator(".cb-diagram svg").isVisible()).toBe(true);
      expect(await block.locator(":scope > pre").isVisible()).toBe(false);
    }
    expect(await blocks().nth(0).locator(".cb-diagram").textContent()).toContain("handle(request)");
    expect(await blocks().nth(1).locator(".cb-diagram").textContent()).toContain("stream_delta");
  });

  it("shows a diagram that fails to parse as its source plus the parser's message", async () => {
    const broken = blocks().nth(2);
    expect(await broken.getAttribute("class")).toContain("is-failed");
    expect(await broken.locator(".cb-diagram svg").count()).toBe(0);
    expect((await broken.locator(".cb-diagram").textContent())?.trim()).not.toBe("");
    expect(await broken.locator(":scope > pre").isVisible()).toBe(true);
    expect(await broken.locator(":scope > pre").textContent()).toContain("A[unclosed --> B");
    expect(await broken.locator(".cb-toggle").isVisible()).toBe(false);
  });

  it("strips images out of diagram labels while keeping the diagram", async () => {
    const block = blocks().nth(3);
    expect(await block.getAttribute("class")).toContain("is-rendered");
    expect(await block.locator(".cb-diagram").textContent()).toContain("beacon");
    expect(await block.locator(".cb-diagram img, .cb-diagram image").count()).toBe(0);
  });

  it("flips between the diagram and its source", async () => {
    const block = blocks().nth(0);
    await block.getByRole("button", { name: "Source", exact: true }).click();
    expect(await block.locator(":scope > pre").isVisible()).toBe(true);
    expect(await block.locator(".cb-diagram").isVisible()).toBe(false);
    const back = block.getByRole("button", { name: "Diagram", exact: true });
    expect(await back.getAttribute("aria-pressed")).toBe("true");
    await back.click();
    expect(await block.locator(".cb-diagram svg").isVisible()).toBe(true);
    expect(await block.locator(":scope > pre").isVisible()).toBe(false);
  });

  /* The diagram lives in DOM the Markdown component drew into after React committed it. A
     re-render that re-applies innerHTML wipes that without re-running the effect, leaving a
     permanent "Rendering diagram…" — scrolling the transcript is enough to trigger one. */
  it("keeps drawn diagrams through a transcript re-render", async () => {
    const after = await page.evaluate(async () => {
      const first = document.querySelector<HTMLElement>(".cb-mermaid")!;
      first.dataset.probe = "drawn";
      const scroller = first.closest<HTMLElement>(".overflow-y-auto")!;
      const settle = () => new Promise((r) => setTimeout(r, 150));
      scroller.scrollTop = scroller.scrollHeight; await settle();
      scroller.scrollTop = 0; await settle();
      const now = document.querySelector<HTMLElement>(".cb-mermaid")!;
      return { sameNode: now.dataset.probe === "drawn", drawn: document.querySelectorAll(".cb-mermaid .cb-diagram svg").length };
    });
    expect(after).toEqual({ sameNode: true, drawn: 3 });
  });

  it("opens a diagram in the viewer from its Open button, or by clicking the drawing", async () => {
    const opened = () => page.evaluate(() => (window as unknown as FixtureWindow).__messages.filter((m) => m.type === "open_diagram"));
    const first = blocks().nth(0);
    await first.getByRole("button", { name: "Open", exact: true }).click();
    await first.locator(".cb-diagram").click();
    const sequence = blocks().nth(1);
    await sequence.locator(".cb-diagram").click();
    // Each block's own source, exactly as the fence held it.
    const fence = (start: number) => `${REPLY.split("```mermaid\n")[start]!.split("```")[0]}`;
    expect(await opened()).toEqual([
      { type: "open_diagram", source: fence(1) },
      { type: "open_diagram", source: fence(1) },
      { type: "open_diagram", source: fence(2) },
    ]);
    expect(fence(1)).toContain("handle(request)");
    expect(fence(2)).toContain("sequenceDiagram");
    // A diagram that failed to draw has nothing to open.
    expect(await blocks().nth(2).getByRole("button", { name: "Open", exact: true }).isVisible()).toBe(false);
  });

  // See the matching check in diagram-viewer.spec.ts: CSS chunking decides which copy of the
  // font tokens wins, and a new entry once broke it for every panel, the chat included.
  it("keeps the panel's font tokens intact", async () => {
    const sans = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans"));
    expect(sans).toContain("Lexend");
  });

  it("leaves no scratch render containers behind on the page", async () => {
    expect(await page.locator("body > [id^='dbs-mermaid-']").count()).toBe(0);
  });

  it("renders everything without a single CSP violation", async () => {
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).__cspViolations)).toEqual([]);
  });
});
