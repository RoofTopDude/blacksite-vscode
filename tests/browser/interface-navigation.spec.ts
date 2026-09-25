import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

describe("interface navigation and density", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  const root = path.resolve("out/webview");
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8").replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce").replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", `/${url.searchParams.get("app") ?? "webview"}.js`));
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

  async function open(app = "webview", width = 380): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.addInitScript(() => {
      const win = window as unknown as { acquireVsCodeApi: () => unknown; messages: unknown[] };
      win.messages = [];
      win.acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => win.messages.push(message),
        getState: () => JSON.parse(sessionStorage.getItem("ui-state") ?? "{}"),
        setState: (value: unknown) => sessionStorage.setItem("ui-state", JSON.stringify(value)),
      });
    });
    await page.goto(`${base}/?app=${app}`);
    await page.getByRole("button", { name: "Switch workspace view" }).waitFor();
    return page;
  }

  it("offers ChatGPT sign-in and displays subscription allowance and reset times", async () => {
    const page = await open();
    await page.evaluate(() => window.postMessage({ type: "settings_data", settings: {
      provider: "openai", providerSettings: { openai: { authMode: "chatgpt", model: "test-model", temperature: 1, maxTokens: 8192 } }, maxIterations: 40, disabledTools: [],
    }, models: [] }, "*"));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with ChatGPT", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ type: "chatgpt_account", action: "login" });
    await page.evaluate(() => window.postMessage({ type: "chatgpt_state", state: {
      status: "connected", email: "test@example.com", planType: "plus", updatedAt: Date.now(),
      limits: [{ primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 2000100000 } }],
    } }, "*"));
    await page.getByText("75% remaining", { exact: true }).waitFor();
    expect(await page.getByText("20% remaining", { exact: true }).count()).toBe(1);
    expect(await page.getByText("5-hour window", { exact: true }).count()).toBe(1);
    expect(await page.getByText("7-day window", { exact: true }).count()).toBe(1);
    expect(await page.locator("meter").count()).toBe(2);
    expect(await page.locator('[data-setting="endpoint"]').count()).toBe(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ type: "chatgpt_account", action: "logout" });
    await page.close();
  });

  it("finds a spending control by budget, focuses it, and remembers its section", async () => {
    const page = await open();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search settings" }).fill("budget");
    await page.getByRole("button", { name: /Session ceiling \(USD\)/ }).click();
    const control = page.locator('[data-setting="session-ceiling-usd"] input');
    await control.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[data-setting="session-ceiling-usd"]') !== null);
    expect(await control.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await page.getByRole("tab", { name: "Agent & delegation" }).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("searchbox").fill("does-not-exist");
    expect(await page.getByRole("status").textContent()).toContain("No settings match");
    await page.close();
  });

  it("moves starter prompts into the conversation and keeps advanced controls in a keyboard-dismissable popover", async () => {
    const page = await open();
    await page.getByRole("button", { name: "Plan a change", exact: true }).click();
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement)?.value.includes("Planning goal:"));
    expect(await message.inputValue()).toContain("Planning goal:");
    expect(await page.getByRole("button", { name: "Request mode" }).textContent()).toContain("Plan");
    await page.getByRole("button", { name: "Generation settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Generation settings" }).waitFor();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog", { name: "Generation settings" }).count()).toBe(0);
    await page.close();
  });

  it("persists density and exposes labeled destinations with recent navigation", async () => {
    const page = await open();
    await page.getByLabel("Interface density").selectOption("compact");
    await page.reload();
    expect(await page.getByLabel("Interface density").inputValue()).toBe("compact");
    await page.evaluate(() => window.postMessage({ type: "workspace_ui_state", density: "comfortable", recent: ["chat", "plans"] }, "*"));
    await page.getByRole("button", { name: "Back to Plans", exact: true }).waitFor();
    await page.getByRole("button", { name: "Switch workspace view" }).click();
    await page.getByRole("button", { name: "Tickets", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ type: "workspace_navigate", source: "chat", destination: "tickets" });
    await page.close();
  });

  it("restores a ticket after rebuilding the view and opens its linked plan", async () => {
    const page = await open("tickets");
    const state = { type: "tickets_state", tickets: [{ id: "BLK-1", title: "Investigate rendering", status: "backlog", statusSource: "manual", priority: "normal", assignee: "user", origin: "user", planId: "plan-1", createdAt: "2026-09-18T12:00:00Z", updatedAt: "2026-09-18T12:00:00Z" }], plans: [{ id: "plan-1", title: "Interface improvements" }] };
    await page.evaluate((message) => window.postMessage(message, "*"), state);
    await page.getByText("Investigate rendering", { exact: true }).click();
    await page.getByRole("heading", { name: "Investigate rendering" }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Switch workspace view" }).waitFor();
    await page.evaluate((message) => window.postMessage(message, "*"), state);
    await page.getByRole("heading", { name: "Investigate rendering" }).waitFor();
    await page.getByRole("button", { name: "Interface improvements", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ type: "workspace_navigate", source: "tickets", destination: "plans", entityId: "plan-1" });
    await page.close();
  });

  it("focuses a linked plan and exposes execution evidence as navigation", async () => {
    const page = await open("planning");
    await page.evaluate(() => window.postMessage({ type: "planning_state", focusPlanId: "plan-1", document: { plans: [{ id: "plan-1", title: "Interface improvements", status: "active", phases: [{ id: "phase-1", title: "Verify", status: "in_progress", steps: [], runEvidence: { runIds: ["run-1"], latestRunId: "run-1" } }] }], todoRuns: [] } }, "*"));
    await page.getByRole("button", { name: "Latest: run-1", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ type: "workspace_navigate", source: "plans", destination: "runs", entityId: "run-1" });
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("ui-state") ?? "{}")["planning.focus"])).toEqual({ id: "plan-1" });
    await page.close();
  });

  it("keeps primary panels within narrow and wide viewports at both densities", async () => {
    for (const width of [320, 640]) {
      for (const app of ["webview", "tickets", "planning", "data", "runs", "loops"]) {
        const page = await open(app, width);
        for (const density of ["comfortable", "compact"]) {
          await page.getByLabel("Interface density").selectOption(density);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${app} at ${width}px / ${density}`).toBe(true);
          expect(await page.locator(".workspace-bar").evaluate((node) => node.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
        }
        if (app === "webview") {
          await page.getByRole("button", { name: "Settings", exact: true }).click();
          await page.getByRole("searchbox").waitFor();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await page.close();
      }
    }
  });
});
