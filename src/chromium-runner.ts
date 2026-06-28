import * as fs from "fs";
import * as vscode from "vscode";
import type { Browser, Page, BrowserContext } from "playwright-core";

// ── BrowserRunner interface (implemented by ChromiumRunner and BrowserBridge) ─

export interface BrowserRunner {
  dispatch(toolType: string, payload: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
}

// ── System Chrome detection ────────────────────────────────────────────────────

function findSystemChrome(): string | undefined {
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const candidates: string[] = win
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        process.env["LOCALAPPDATA"] ? `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe` : "",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : mac
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ];

  return candidates.filter(Boolean).find((p) => fs.existsSync(p));
}

// ── ChromiumRunner ─────────────────────────────────────────────────────────────

export class ChromiumRunner implements BrowserRunner {
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _launching = false;

  private async _ensurePage(): Promise<Page> {
    if (this._page && !this._page.isClosed()) return this._page;

    if (this._launching) {
      // Wait for ongoing launch
      await new Promise<void>((r) => { const t = setInterval(() => { if (!this._launching) { clearInterval(t); r(); } }, 50); });
      if (this._page && !this._page.isClosed()) return this._page;
    }

    this._launching = true;
    try {
      // Dynamic import so playwright-core stays external to the esbuild bundle
      const { chromium } = await import("playwright-core") as typeof import("playwright-core");

      const executablePath = findSystemChrome();
      const cfg = vscode.workspace.getConfiguration("blacksite");
      const headless = cfg.get<boolean>("browserHeadless") ?? false;

      this._browser = await chromium.launch({
        executablePath,          // undefined = use playwright's own Chromium
        headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      this._context = await this._browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        acceptDownloads: false,
      });

      this._page = await this._context.newPage();

      this._browser.on("disconnected", () => {
        this._browser = null;
        this._context = null;
        this._page = null;
      });
    } finally {
      this._launching = false;
    }

    return this._page!;
  }

  async dispatch(toolType: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      switch (toolType) {
        case "navigate":   return await this._navigate(payload);
        case "click":      return await this._click(payload);
        case "type_text":  return await this._typeText(payload);
        case "screenshot": return await this._screenshot(payload);
        case "get_text":   return await this._getText(payload);
        case "evaluate":   return await this._evaluate(payload);
        default:           return { ok: false, error: `Unknown browser action: ${toolType}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async _navigate(p: Record<string, unknown>): Promise<unknown> {
    const page = await this._ensurePage();
    const url   = String(p["url"] ?? "");
    const waitUntil = p["waitFor"] === "networkidle" ? "networkidle" as const : "load" as const;
    await page.goto(url, { waitUntil, timeout: 30_000 });
    return { ok: true, url: page.url(), title: await page.title() };
  }

  private async _click(p: Record<string, unknown>): Promise<unknown> {
    const page = await this._ensurePage();
    const selector = String(p["selector"] ?? "");
    await page.click(selector, { timeout: 10_000 });
    return { ok: true, selector };
  }

  private async _typeText(p: Record<string, unknown>): Promise<unknown> {
    const page = await this._ensurePage();
    const selector = String(p["selector"] ?? "");
    const text     = String(p["text"] ?? "");
    await page.click(selector, { timeout: 10_000 });
    await page.fill(selector, text);
    return { ok: true, selector, charsTyped: text.length };
  }

  private async _screenshot(p: Record<string, unknown>): Promise<unknown> {
    const page     = await this._ensurePage();
    const fullPage = p["fullPage"] === true;
    const buf      = await page.screenshot({ fullPage, type: "png" });
    const dataUrl  = `data:image/png;base64,${buf.toString("base64")}`;
    // Summary without the full base64 to keep tool result readable
    return { ok: true, dataUrl, sizeBytes: buf.length, url: page.url(), fullPage };
  }

  private async _getText(p: Record<string, unknown>): Promise<unknown> {
    const page     = await this._ensurePage();
    const selector = p["selector"] ? String(p["selector"]) : null;
    const text     = selector
      ? await page.locator(selector).first().innerText({ timeout: 10_000 })
      : await page.evaluate(() => {
          // runs inside the browser page context — document is available there
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (globalThis as any).document?.body?.innerText ?? "";
        }) as string;
    return { ok: true, text: text.slice(0, 50_000), truncated: text.length > 50_000 };
  }

  private async _evaluate(p: Record<string, unknown>): Promise<unknown> {
    const page   = await this._ensurePage();
    const script = String(p["script"] ?? "");
    // page.evaluate(string) evaluates the JS expression/block inside the browser context
    const result = await page.evaluate(script);
    return { ok: true, result };
  }

  async dispose(): Promise<void> {
    await this._page?.close().catch(() => { /* ignore */ });
    await this._context?.close().catch(() => { /* ignore */ });
    await this._browser?.close().catch(() => { /* ignore */ });
    this._page = null;
    this._context = null;
    this._browser = null;
  }
}
