import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import MarkdownIt from "markdown-it";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { mermaidPreviewPlugin } from "../../src/diagrams/markdown-preview-mermaid.js";

/* The Markdown-preview fallback (preview/mermaid-preview.ts), in a page built the way VS Code's
   Markdown preview builds its own: the same strict `script-src 'nonce-…'` policy, the contributed
   script loaded as a classic async nonce'd tag, body classes for the theme, and content swapped in
   place with a vscode.markdown.updateContent event. The load-bearing claim is that the loader can
   bring Mermaid in under that policy at all — by carrying its nonce onto the tag it adds — and
   that it never fetches Mermaid for a document without a diagram. */

const NONCE = "preview-nonce";

const DOCUMENT = [
  "# Architecture",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Webview] --> B[Host]",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[unclosed --> B",
  "```",
].join("\n");

const md = new MarkdownIt();
md.use(mermaidPreviewPlugin);

function previewHtml(body: string): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: data:; media-src 'self' https: data:; script-src 'nonce-${NONCE}'; style-src 'self' 'unsafe-inline' https: data:; font-src 'self' https: data:;">
<link rel="stylesheet" href="/markdown-preview/mermaid-preview.css">
</head><body class="vscode-body vscode-dark"><div class="markdown-body">${body}</div>
<script async src="/markdown-preview/mermaid-preview.js" nonce="${NONCE}" charset="UTF-8"></script>
</body></html>`;
}

describe("Markdown preview fallback", () => {
  let browser: Browser;
  let server: http.Server;
  let origin = "";
  const outDir = path.resolve("out");
  const requests: string[] = [];

  async function open(markdown: string): Promise<Page> {
    const page = await browser.newPage();
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations: string[] }).__violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    await page.goto(`${origin}/?doc=${encodeURIComponent(markdown)}`);
    return page;
  }

  beforeAll(async () => {
    if (!fs.existsSync(path.join(outDir, "markdown-preview/mermaid-preview.js"))) {
      throw new Error("Run npm run build before npm run test:browser.");
    }
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(previewHtml(md.render(url.searchParams.get("doc") ?? "")));
        return;
      }
      const target = path.resolve(outDir, `.${url.pathname}`);
      if (!target.startsWith(outDir + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : "text/javascript");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const executablePath = process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync)
      : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("draws marked fences under the preview's nonce-only script policy", async () => {
    const page = await open(DOCUMENT);
    const blocks = page.locator(".blacksite-mermaid");
    await page.waitForFunction(() => document.querySelectorAll(".blacksite-mermaid.is-rendered, .blacksite-mermaid.is-failed").length === 2, undefined, { timeout: 20_000 });

    const good = blocks.nth(0);
    expect(await good.getAttribute("class")).toContain("is-rendered");
    expect(await good.locator(".blacksite-mermaid-diagram svg").isVisible()).toBe(true);
    expect(await good.locator("pre").isVisible()).toBe(false);

    const broken = blocks.nth(1);
    expect(await broken.getAttribute("class")).toContain("is-failed");
    expect(await broken.locator("pre").isVisible()).toBe(true);
    expect((await broken.locator(".blacksite-mermaid-diagram").textContent())?.trim()).not.toBe("");

    expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    await page.close();
  });

  it("redraws when the preview swaps in edited content", async () => {
    const page = await open(DOCUMENT);
    await page.locator(".blacksite-mermaid.is-rendered").first().waitFor({ timeout: 20_000 });
    const edited = md.render("```mermaid\nsequenceDiagram\n  Chat->>Host: edited\n```");
    await page.evaluate((html) => {
      document.querySelector(".markdown-body")!.innerHTML = html;
      window.dispatchEvent(new CustomEvent("vscode.markdown.updateContent"));
    }, edited);
    await page.waitForFunction(() => document.querySelector(".blacksite-mermaid.is-rendered svg")?.textContent?.includes("edited"), undefined, { timeout: 20_000 });
    await page.close();
  });

  it("follows the editor theme when it changes", async () => {
    const page = await open(DOCUMENT);
    await page.locator(".blacksite-mermaid.is-rendered").first().waitFor({ timeout: 20_000 });
    const dark = await page.locator(".blacksite-mermaid-diagram").first().innerHTML();
    await page.evaluate(() => { document.body.className = "vscode-body vscode-light"; });
    await page.waitForFunction((previous) => document.querySelector(".blacksite-mermaid-diagram")?.innerHTML !== previous, dark, { timeout: 20_000 });
    await page.close();
  });

  it("never loads Mermaid for a document without a diagram", async () => {
    requests.length = 0;
    const page = await open("# Just prose\n\n```ts\nconst x = 1;\n```");
    await page.waitForLoadState("networkidle");
    expect(requests).toContain("/markdown-preview/mermaid-preview.js");
    expect(requests).not.toContain("/markdown-preview/mermaid.min.js");
    await page.close();
  });
});
