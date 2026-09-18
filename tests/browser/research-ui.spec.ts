import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

describe("built Browser & Research webview", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  const root = path.resolve("out/webview");
  const policy = { allowedDomains: ["example.com"], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none" };
  beforeAll(async () => {
    if (!fs.existsSync(path.join(root, "webview.js"))) throw new Error("Run npm run build:webview before npm run test:browser.");
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      if (pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8").replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce").replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", "/webview.js"));
        return;
      }
      const target = path.resolve(root, `.${pathname}`);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const executablePath = process.platform === "win32" ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync) : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 680, height: 960 } });
    await page.addInitScript(() => {
      const win = window as any;
      win.__messages = [];
      win.__persisted = {};
      win.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => win.__messages.push(m), getState: () => ({}), setState: (state: unknown) => { win.__persisted = state; } });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(r => server?.close(() => r())); });
  it("shows complete escaped values, sends human edits and never persists proposals", async () => {
    const original = "first\nsecond\u200b" + "x".repeat(20_000) + "END-OF-EXACT-VALUE";
    await page.evaluate(({ policy, original }) => window.postMessage({ type: "research_state", state: { policy, configured: policy, keyConfigured: false, audits: [], pending: [{ id: "proposal-ui", digest: "digest", session: "session", version: 1, expiresAt: Date.now() + 300_000, kind: "input", operation: "fill", origin: "https://example.com", url: "https://example.com/form", title: "Fixture", document: "doc-ui", purpose: "Entry exposes these values to the page.", fields: [{ target: "ref", label: "Query", type: "text", mode: "replace", value: original }] }] } }, "*"), { policy, original });
    const field = page.getByLabel("Query (text, replace)", { exact: true });
    await field.waitFor();
    expect(await field.inputValue()).toBe(original);
    const escaped = await page.getByLabel("Exact escaped value for Query").textContent();
    expect(escaped).toContain("\\n"); expect(escaped).toContain("\\u200b"); expect(escaped).toContain("END-OF-EXACT-VALUE");
    expect(await page.evaluate(() => JSON.stringify((window as any).__persisted))).not.toContain("END-OF-EXACT-VALUE");
    await field.fill("human correction\nsecond line");
    await page.getByRole("button", { name: "Approve exact values", exact: true }).click();
    const decisions = await page.evaluate(() => (window as any).__messages.filter((m: any) => m.type === "browser_decision"));
    expect(decisions).toEqual([{ type: "browser_decision", decision: { id: "proposal-ui", decision: "edit", values: ["human correction\nsecond line"] } }]);
    expect(await page.getByRole("button", { name: "Approve exact values", exact: true }).isDisabled()).toBe(true);
  });
  it("exposes effective domain settings, provider credentials and explicit delegation controls", async () => {
    await page.evaluate(policy => window.postMessage({ type: "research_state", state: { policy, configured: policy, keyConfigured: false, audits: [], pending: [] } }, "*"), policy);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Agent & delegation", exact: true }).click();
    await page.getByRole("button", { name: /Browser & Research/ }).click();
    expect(await page.getByLabel("Allowed research domains").inputValue()).toBe("example.com");
    expect(await page.getByLabel("Brave API key").getAttribute("type")).toBe("password");
    expect(await page.getByRole("button", { name: "Delegate review for this session", exact: true }).isDisabled()).toBe(true);
    await page.getByLabel("Your original task").fill("Find public documentation");
    await page.getByLabel("Delegated domains").fill("api.search.brave.com");
    await page.getByLabel("Reviewer model ID").fill("test-reviewer");
    await page.getByRole("button", { name: "Delegate review for this session", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__messages.find((m: any) => m.type === "research_delegate"))).toMatchObject({ delegation: { intent: "Find public documentation", domains: ["api.search.brave.com"], operations: ["search"], model: "test-reviewer" } });
  });
});
