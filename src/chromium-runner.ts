import * as fs from "fs";
import * as vscode from "vscode";
import type { Browser, Page, BrowserContext } from "playwright-core";

// ── BrowserRunner interface (implemented by ChromiumRunner and BrowserBridge) ─

export interface BrowserRunner {
  dispatch(
    toolType: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    scope?: BrowserDispatchScope,
  ): Promise<unknown>;
  dispose(): Promise<void>;
  /**
   * Cheap, synchronous check for whether this runner can actually drive a browser right now.
   * Used to gate browser-tool advertisement so the agent never wastes calls on a runtime that
   * isn't installed. Optional: a runner that omits it is assumed available.
   */
  available?(): boolean;
}

export interface BrowserDispatchScope {
  /** Exact page origins authorized for this action (scheme, host, and port). */
  allowedOrigins: readonly string[];
  /** Reject a malformed scope that attempts to authorize a non-loopback origin. */
  localOnly?: boolean;
}

// ── playwright-core availability probe ───────────────────────────────────────────

let _playwrightInstalled: boolean | undefined;

/**
 * Returns whether playwright-core is resolvable, without loading the (large) module. The VSIX
 * ships it as an external runtime dependency, while incomplete development installs may not have
 * it available — advertising browser tools in that state only burns agent turns on guaranteed failures.
 * Result is cached for the process lifetime.
 */
export function isBrowserRuntimeAvailable(): boolean {
  if (_playwrightInstalled !== undefined) return _playwrightInstalled;
  try {
    // require.resolve checks installation without executing the module (esbuild target is CJS).
    require.resolve("playwright-core");
    _playwrightInstalled = true;
  } catch {
    _playwrightInstalled = false;
  }
  return _playwrightInstalled;
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

const MAX_SCRIPT_STEPS = 25;
const MAX_TELEMETRY_EVENTS = 5_000;
const MAX_DOM_SNAPSHOT_CHARS = 1_000_000;
const MAX_ACCESSIBILITY_NODES = 800;

/** Pointer-path bounds. Each interpolated move is a round trip to the browser, so a path is
 *  bounded on both axes: how many legs it may have, and how finely each leg is subdivided. */
const MAX_PATH_WAYPOINTS = 64;
const MAX_PATH_STEPS_PER_LEG = 60;
/** A held key is a movement input ("W for 400ms"), not a stuck one — bound it so a malformed
 *  step cannot leave a key down for the rest of the run. */
const MAX_KEY_HOLD_MS = 5_000;
const MAX_KEY_SEQUENCE = 32;
/** Perspective-sweep bounds. Every frame is a full PNG held in memory and then persisted, so the
 *  count is the real cost driver; the settle window is per frame and multiplies. */
const MAX_MATRIX_FRAMES = 12;
const MAX_MATRIX_SETTLE_MS = 2_000;

export interface PointerWaypoint { x: number; y: number }

/** Parse and bound a pointer path. Non-finite or malformed points are dropped rather than
 *  coerced to 0,0 — a silent jump to the viewport origin mid-path is worse than a shorter path. */
export function readWaypoints(raw: unknown): PointerWaypoint[] {
  if (!Array.isArray(raw)) return [];
  const points: PointerWaypoint[] = [];
  for (const candidate of raw) {
    if (points.length >= MAX_PATH_WAYPOINTS) break;
    if (Array.isArray(candidate) && candidate.length >= 2) {
      const x = Number(candidate[0]);
      const y = Number(candidate[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      continue;
    }
    if (candidate && typeof candidate === "object") {
      const x = Number((candidate as Record<string, unknown>)["x"]);
      const y = Number((candidate as Record<string, unknown>)["y"]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
  }
  return points;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export type BrowserTelemetryKind =
  | "console"
  | "page_error"
  | "request"
  | "response"
  | "request_failed"
  | "navigation";

export interface BrowserTelemetryEvent {
  sequence: number;
  at: string;
  kind: BrowserTelemetryKind;
  severity?: "debug" | "info" | "warning" | "error";
  data: Record<string, unknown>;
}

function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    url.hash = "";
    return url.toString();
  } catch {
    return value.slice(0, 2_000);
  }
}

function clampTimeout(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30_000) : fallback;
}

class BrowserActionCancelledError extends Error {
  constructor() {
    super("Browser action cancelled.");
    this.name = "AbortError";
  }
}

class BrowserOriginScopeError extends Error {
  constructor(url: string) {
    super(
      `Browser sequence navigation escaped its approved local origin scope: ${sanitizedUrl(url)}`,
    );
    this.name = "BrowserOriginScopeError";
  }
}

function throwIfBrowserCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserActionCancelledError();
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:")
      && (hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "::1"
        || hostname.endsWith(".localhost"));
  } catch {
    return false;
  }
}

function scopedOrigins(scope: BrowserDispatchScope): Set<string> {
  const origins = new Set<string>();
  for (const value of scope.allowedOrigins) {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new Error(`Invalid browser origin scope: ${value}`);
    }
    if (scope.localOnly && !isLoopbackOrigin(origin)) {
      throw new Error(`Browser sequence origin scope is not loopback: ${sanitizedUrl(origin)}`);
    }
    origins.add(origin);
  }
  if (origins.size === 0) throw new Error("Browser sequence origin scope is empty.");
  return origins;
}

function originAllowed(value: string, origins: ReadonlySet<string>): boolean {
  try {
    return origins.has(new URL(value).origin);
  } catch {
    return false;
  }
}

// ── ChromiumRunner ─────────────────────────────────────────────────────────────

export class ChromiumRunner implements BrowserRunner {
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _launching = false;
  private _telemetry: BrowserTelemetryEvent[] = [];
  private _telemetrySequence = 0;

  available(): boolean {
    return isBrowserRuntimeAvailable();
  }

  private async _ensurePage(signal?: AbortSignal): Promise<Page> {
    throwIfBrowserCancelled(signal);
    if (this._page && !this._page.isClosed()) return this._page;

    if (this._launching) {
      // Wait for ongoing launch
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearInterval(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new BrowserActionCancelledError());
        };
        const check = () => {
          if (!this._launching) {
            cleanup();
            resolve();
          }
        };
        const timer = setInterval(check, 50);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else check();
      });
      throwIfBrowserCancelled(signal);
      if (this._page && !this._page.isClosed()) return this._page;
    }

    this._launching = true;
    try {
      // Cancellation closes only the active page, not its context. Reuse that context
      // here so the next action recovers without relaunching Chrome or losing the
      // session's cookies/storage.
      if (this._browser?.isConnected() && this._context) {
        try {
          const page = await this._context.newPage();
          if (signal?.aborted) {
            await page.close().catch(() => { /* ignore */ });
            throw new BrowserActionCancelledError();
          }
          this._page = page;
          this._attachTelemetry(page);
          return page;
        } catch (err) {
          if (signal?.aborted || err instanceof BrowserActionCancelledError) throw err;
          // A context can outlive its last page but can also have been closed by the
          // browser. Dispose the stale handle before creating a fresh context.
          await this._context.close().catch(() => { /* ignore */ });
          this._context = null;
          this._page = null;
        }
      }

      if (this._browser?.isConnected()) {
        const browser = this._browser;
        let context: BrowserContext | null = null;
        let page: Page | null = null;
        try {
          context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            acceptDownloads: false,
          });
          throwIfBrowserCancelled(signal);
          page = await context.newPage();
          throwIfBrowserCancelled(signal);
          this._context = context;
          this._page = page;
          this._attachTelemetry(page);
          return page;
        } catch (err) {
          await page?.close().catch(() => { /* ignore */ });
          await context?.close().catch(() => { /* ignore */ });
          if (!browser.isConnected() && this._browser === browser) this._browser = null;
          throw err;
        }
      }

      // Drop disconnected handles before launching a replacement browser.
      this._browser = null;
      this._context = null;
      this._page = null;

      // Dynamic import keeps playwright-core external to the esbuild bundle. The
      // package is copied into the VSIX as a runtime dependency.
      let chromium: (typeof import("playwright-core"))["chromium"];
      try {
        ({ chromium } = await import("playwright-core") as typeof import("playwright-core"));
      } catch {
        throw new Error(
          "Browser tools require playwright-core. " +
          "Run `npm install playwright-core` in the extension directory and reload VS Code.",
        );
      }

      const executablePath = findSystemChrome();
      const cfg = vscode.workspace.getConfiguration("blacksite");
      const headless = cfg.get<boolean>("browserHeadless") ?? false;

      const browser = await chromium.launch({
        executablePath,          // undefined = use playwright's own Chromium
        headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      let context: BrowserContext | null = null;
      let page: Page | null = null;
      try {
        throwIfBrowserCancelled(signal);
        context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          acceptDownloads: false,
        });
        throwIfBrowserCancelled(signal);
        page = await context.newPage();
        throwIfBrowserCancelled(signal);
      } catch (err) {
        // launch() succeeded but newContext()/newPage() didn't — close the orphaned
        // browser process rather than leaking it; the next call would otherwise never
        // see it (this._browser is only set below, once everything succeeded) and would
        // launch a fresh one on top of it every time this path fails.
        await page?.close().catch(() => { /* ignore */ });
        await context?.close().catch(() => { /* ignore */ });
        await browser.close().catch(() => { /* ignore */ });
        this._context = null;
        this._page = null;
        throw err;
      }

      this._browser = browser;
      this._context = context;
      this._page = page;
      this._attachTelemetry(page);
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

  private async _runAbortable<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfBrowserCancelled(signal);
    if (!signal) return operation();

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        // Playwright does not accept AbortSignal for these APIs. Closing the page is
        // its supported interruption mechanism; retain the context so _ensurePage()
        // can cheaply recreate a page for the next action.
        const page = this._page;
        if (page && this._page === page) this._page = null;
        void page?.close().catch(() => { /* ignore */ });
        reject(new BrowserActionCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private _recordTelemetry(
    kind: BrowserTelemetryKind,
    data: Record<string, unknown>,
    severity?: BrowserTelemetryEvent["severity"],
  ): void {
    this._telemetrySequence += 1;
    this._telemetry.push({
      sequence: this._telemetrySequence,
      at: new Date().toISOString(),
      kind,
      ...(severity ? { severity } : {}),
      data,
    });
    if (this._telemetry.length > MAX_TELEMETRY_EVENTS) {
      this._telemetry.splice(0, this._telemetry.length - MAX_TELEMETRY_EVENTS);
    }
  }

  private _attachTelemetry(page: Page): void {
    page.on("console", (message) => {
      const type = message.type();
      const severity: BrowserTelemetryEvent["severity"] =
        type === "error" ? "error"
        : type === "warning" ? "warning"
        : type === "debug" ? "debug"
        : "info";
      this._recordTelemetry("console", {
        type,
        text: message.text().slice(0, 20_000),
        location: message.location(),
      }, severity);
    });
    page.on("pageerror", (error) => {
      this._recordTelemetry("page_error", {
        name: error.name,
        message: error.message.slice(0, 20_000),
        stack: error.stack?.slice(0, 30_000),
      }, "error");
    });
    page.on("request", (request) => {
      this._recordTelemetry("request", {
        method: request.method(),
        url: sanitizedUrl(request.url()),
        resourceType: request.resourceType(),
        isNavigationRequest: request.isNavigationRequest(),
      }, "debug");
    });
    page.on("response", (response) => {
      const status = response.status();
      this._recordTelemetry("response", {
        status,
        statusText: response.statusText(),
        url: sanitizedUrl(response.url()),
        method: response.request().method(),
        resourceType: response.request().resourceType(),
      }, status >= 500 ? "error" : status >= 400 ? "warning" : "debug");
    });
    page.on("requestfailed", (request) => {
      this._recordTelemetry("request_failed", {
        method: request.method(),
        url: sanitizedUrl(request.url()),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText,
      }, "error");
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this._recordTelemetry("navigation", {
        url: sanitizedUrl(frame.url()),
        name: frame.name(),
      }, "info");
    });
  }

  async dispatch(
    toolType: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    scope?: BrowserDispatchScope,
  ): Promise<unknown> {
    if (signal?.aborted) return { ok: false, error: "Browser action cancelled." };
    try {
      return await this._runAbortable(async () => {
        const origins = scope ? scopedOrigins(scope) : undefined;
        const scopedPage = origins ? await this._ensurePage(signal) : undefined;
        if (origins && scopedPage && toolType !== "navigate"
          && !originAllowed(scopedPage.url(), origins)) {
          const escapedUrl = scopedPage.url();
          await this._closeOriginEscapedPage(scopedPage);
          throw new BrowserOriginScopeError(escapedUrl);
        }

        let blockedUrl: string | undefined;
        const routeHandler = origins && scopedPage
          ? async (route: import("playwright-core").Route): Promise<void> => {
            const request = route.request();
            if (
              request.isNavigationRequest()
              && request.frame() === scopedPage.mainFrame()
              && !originAllowed(request.url(), origins)
            ) {
              blockedUrl = request.url();
              await route.abort("blockedbyclient");
              return;
            }
            await route.continue();
          }
          : undefined;
        if (routeHandler && scopedPage) await scopedPage.route("**/*", routeHandler);

        try {
          let result: unknown;
          switch (toolType) {
            case "navigate":   result = await this._navigate(payload, signal); break;
            case "click":      result = await this._click(payload, signal); break;
            case "type_text":  result = await this._typeText(payload, signal); break;
            case "screenshot": result = await this._screenshot(payload, signal); break;
            case "get_text":   result = await this._getText(payload, signal); break;
            case "evaluate":   result = await this._evaluate(payload, signal); break;
            case "wait":       result = await this._wait(payload, signal); break;
            case "run_script": result = await this._runScript(payload, signal); break;
            case "capture_state": result = await this._captureState(payload, signal); break;
            case "mouse_path":  result = await this._mousePath(payload, signal); break;
            case "drag":        result = await this._drag(payload, signal); break;
            case "hover":       result = await this._hover(payload, signal); break;
            case "scroll":      result = await this._scroll(payload, signal); break;
            case "key":         result = await this._key(payload, signal); break;
            case "capture_matrix": result = await this._captureMatrix(payload, signal); break;
            default: result = { ok: false, error: `Unknown browser action: ${toolType}` };
          }
          if (blockedUrl) throw new BrowserOriginScopeError(blockedUrl);
          const finalPage = origins ? this._page : undefined;
          if (origins && finalPage && !originAllowed(finalPage.url(), origins)) {
            const escapedUrl = finalPage.url();
            await this._closeOriginEscapedPage(finalPage);
            throw new BrowserOriginScopeError(escapedUrl);
          }
          return result;
        } catch (error) {
          if (blockedUrl) throw new BrowserOriginScopeError(blockedUrl);
          throw error;
        } finally {
          if (routeHandler && scopedPage) {
            await scopedPage.unroute("**/*", routeHandler).catch(() => { /* page may have closed */ });
          }
        }
      }, signal);
    } catch (err) {
      if (signal?.aborted || err instanceof BrowserActionCancelledError) {
        return { ok: false, error: "Browser action cancelled.", cancelled: true };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async _closeOriginEscapedPage(page: Page): Promise<void> {
    if (this._page === page) this._page = null;
    await page.close().catch(() => { /* best-effort containment */ });
  }

  private async _navigate(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const url   = String(p["url"] ?? "");
    const waitUntil = p["waitFor"] === "networkidle" ? "networkidle" as const : "load" as const;
    await page.goto(url, { waitUntil, timeout: 30_000 });
    throwIfBrowserCancelled(signal);
    return { ok: true, url: page.url(), title: await page.title() };
  }

  private async _click(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const selector = String(p["selector"] ?? "");
    await page.click(selector, { timeout: 10_000 });
    throwIfBrowserCancelled(signal);
    return { ok: true, selector };
  }

  private async _typeText(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const selector = String(p["selector"] ?? "");
    const text     = String(p["text"] ?? "");
    await page.click(selector, { timeout: 10_000 });
    throwIfBrowserCancelled(signal);
    await page.fill(selector, text);
    throwIfBrowserCancelled(signal);
    return { ok: true, selector, charsTyped: text.length };
  }

  /**
   * Move the cursor along a path rather than teleporting it to a destination.
   *
   * `page.mouse.move` interpolates when given `steps`, which is the difference between an
   * instantaneous jump and something the page can actually react to: hover states, drag
   * thresholds, pointermove handlers, canvas/WebGL orbit controls and game input all read the
   * intermediate positions. Every other action here resolves a selector and acts on its centre,
   * which cannot express any of that.
   *
   * Waypoints are absolute viewport coordinates. `stepsPerLeg` controls smoothness — the cost of a
   * long path is real (each intermediate move is a CDP round trip), so it is bounded.
   */
  private async _mousePath(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const waypoints = readWaypoints(p["path"] ?? p["waypoints"]);
    if (waypoints.length === 0) throw new Error("mouse_path requires a 'path' of {x, y} waypoints.");

    const stepsPerLeg = clampInt(p["stepsPerLeg"], 12, 1, MAX_PATH_STEPS_PER_LEG);
    const holdButton = p["button"] === "left" || p["button"] === "right" || p["button"] === "middle"
      ? p["button"] as "left" | "right" | "middle"
      : undefined;

    // Start at the first waypoint without interpolating into it — otherwise the path begins
    // wherever the cursor happened to be, which makes a run non-reproducible.
    const [origin, ...rest] = waypoints;
    await page.mouse.move(origin!.x, origin!.y);
    throwIfBrowserCancelled(signal);

    if (holdButton) { await page.mouse.down({ button: holdButton }); throwIfBrowserCancelled(signal); }
    try {
      for (const point of rest) {
        await page.mouse.move(point.x, point.y, { steps: stepsPerLeg });
        throwIfBrowserCancelled(signal);
      }
    } finally {
      // Release even if the walk was cancelled partway: leaving a button held would poison every
      // later step against the same page.
      if (holdButton) await page.mouse.up({ button: holdButton }).catch(() => { /* page may be gone */ });
    }

    return {
      ok: true,
      waypoints: waypoints.length,
      stepsPerLeg,
      ...(holdButton ? { button: holdButton } : {}),
      endedAt: waypoints.at(-1),
    };
  }

  /** Press-move-release across a path. Separate from mouse_path's `button` option because a drag
   *  is what the caller means often enough to deserve its own verb. */
  private async _drag(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this._mousePath({ ...p, button: p["button"] ?? "left" }, signal);
  }

  private async _hover(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const selector = String(p["selector"] ?? "");
    if (selector) {
      await page.hover(selector, { timeout: clampTimeout(p["timeoutMs"], 10_000) });
      throwIfBrowserCancelled(signal);
      return { ok: true, selector };
    }
    const x = Number(p["x"]);
    const y = Number(p["y"]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("hover requires either a 'selector' or numeric 'x' and 'y'.");
    }
    await page.mouse.move(x, y);
    throwIfBrowserCancelled(signal);
    return { ok: true, x, y };
  }

  private async _scroll(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const deltaX = Number(p["deltaX"] ?? 0);
    const deltaY = Number(p["deltaY"] ?? 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      throw new Error("scroll requires numeric 'deltaX'/'deltaY'.");
    }
    await page.mouse.wheel(deltaX, deltaY);
    throwIfBrowserCancelled(signal);
    return { ok: true, deltaX, deltaY };
  }

  /**
   * Keyboard input that is not text entry: modifiers, arrows, shortcuts, and held keys.
   *
   * `type_text` fills a field; this presses keys at the page level, which is what a game control
   * scheme or an editor shortcut actually needs. `holdMs` keeps a key down, since "W for 400ms" is
   * a movement input and cannot be expressed as a press.
   */
  private async _key(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const keys = Array.isArray(p["keys"])
      ? (p["keys"] as unknown[]).map((key) => String(key)).filter(Boolean)
      : [String(p["key"] ?? "")].filter(Boolean);
    if (keys.length === 0) throw new Error("key requires 'key' or a non-empty 'keys' array.");

    const holdMs = clampInt(p["holdMs"], 0, 0, MAX_KEY_HOLD_MS);
    for (const key of keys.slice(0, MAX_KEY_SEQUENCE)) {
      if (holdMs > 0) {
        await page.keyboard.down(key);
        throwIfBrowserCancelled(signal);
        try {
          await page.waitForTimeout(holdMs);
        } finally {
          await page.keyboard.up(key).catch(() => { /* page may be gone */ });
        }
      } else {
        await page.keyboard.press(key);
      }
      throwIfBrowserCancelled(signal);
    }
    return { ok: true, keys: keys.slice(0, MAX_KEY_SEQUENCE), ...(holdMs ? { holdMs } : {}) };
  }

  private async _screenshot(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page     = await this._ensurePage(signal);
    const fullPage = p["fullPage"] === true;
    const buf      = await page.screenshot({ fullPage, type: "png" });
    throwIfBrowserCancelled(signal);
    const dataUrl  = `data:image/png;base64,${buf.toString("base64")}`;
    // Summary without the full base64 to keep tool result readable
    return { ok: true, dataUrl, sizeBytes: buf.length, url: page.url(), fullPage };
  }

  /**
   * Capture the same subject from several perspectives in one step.
   *
   * A single screenshot answers "does it render". Design work asks a different question — what
   * does it look like *from the other side*, at the other breakpoint, with that parameter
   * changed — and answering it with N separate steps scatters the evidence across N observations
   * that nothing relates to each other. Here every frame lands in one observation, which is
   * already the right shape: `ObservationBundle.visualArtifactIds` has always been an array.
   *
   * Three perspective kinds, because they cover genuinely different axes:
   *  - `script`  — run a snippet between captures. This is the general case and the one that
   *                drives a 3D camera: orbit the scene, re-render, capture, repeat.
   *  - `viewport`— resize between captures, i.e. a responsive breakpoint sweep.
   *  - `scroll`  — move down the page between captures, for long documents.
   *
   * Each frame is returned with the label and inputs that produced it, so a later comparison is
   * between named perspectives rather than between anonymous images.
   */
  private async _captureMatrix(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const perspectives = Array.isArray(p["perspectives"])
      ? (p["perspectives"] as Record<string, unknown>[]).slice(0, MAX_MATRIX_FRAMES)
      : [];
    if (perspectives.length === 0) {
      throw new Error("capture_matrix requires a non-empty 'perspectives' array.");
    }

    const fullPage = p["fullPage"] === true;
    const settleMs = clampInt(p["settleMs"], 0, 0, MAX_MATRIX_SETTLE_MS);
    const original = page.viewportSize();
    const frames: Array<Record<string, unknown>> = [];

    try {
      for (const [index, perspective] of perspectives.entries()) {
        const label = String(perspective["label"] ?? `perspective-${index + 1}`);
        const applied: Record<string, unknown> = {};

        const script = perspective["script"];
        if (typeof script === "string" && script.trim()) {
          // Same evaluation surface as browser:evaluate — no new capability, just applied
          // between captures so the change and its consequence stay in one observation.
          await page.evaluate(script);
          applied["script"] = true;
          throwIfBrowserCancelled(signal);
        }

        const width = Number(perspective["width"]);
        const height = Number(perspective["height"]);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          await page.setViewportSize({
            width: clampInt(width, 1280, 200, 4096),
            height: clampInt(height, 800, 200, 4096),
          });
          applied["viewport"] = { width, height };
          throwIfBrowserCancelled(signal);
        }

        const scrollY = Number(perspective["scrollY"]);
        if (Number.isFinite(scrollY)) {
          await page.evaluate(`window.scrollTo(0, ${Math.trunc(scrollY)})`);
          applied["scrollY"] = Math.trunc(scrollY);
          throwIfBrowserCancelled(signal);
        }

        // Animations, transitions and a WebGL re-render all need a frame or two before the
        // capture is of the *new* state rather than the old one.
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        throwIfBrowserCancelled(signal);

        const buffer = await page.screenshot({ fullPage, type: "png" });
        throwIfBrowserCancelled(signal);
        frames.push({
          label,
          index,
          dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
          sizeBytes: buffer.length,
          ...(Object.keys(applied).length ? { applied } : {}),
        });
      }
    } finally {
      // Leave the page as it was found. A capture sweep that silently resizes the viewport would
      // change the meaning of every later step in the run.
      if (original) await page.setViewportSize(original).catch(() => { /* page may be gone */ });
    }

    return { ok: true, frames, frameCount: frames.length, url: page.url(), fullPage };
  }

  private async _getText(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page     = await this._ensurePage(signal);
    const selector = p["selector"] ? String(p["selector"]) : null;
    const text     = selector
      ? await page.locator(selector).first().innerText({ timeout: 10_000 })
      : await page.evaluate(() => {
          // runs inside the browser page context — document is available there
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (globalThis as any).document?.body?.innerText ?? "";
        }) as string;
    throwIfBrowserCancelled(signal);
    return { ok: true, text: text.slice(0, 50_000), truncated: text.length > 50_000 };
  }

  private async _evaluate(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page   = await this._ensurePage(signal);
    const script = String(p["script"] ?? "");
    // page.evaluate(string) evaluates the JS expression/block inside the browser context
    const result = await page.evaluate(script);
    throwIfBrowserCancelled(signal);
    return { ok: true, result };
  }

  /**
   * Sequence-only inspection primitive. It deliberately captures no request/response
   * bodies, headers, cookies, storage values, or form values. URLs have credentials and
   * query values removed before leaving the runner.
   */
  private async _captureState(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const since = Number.isFinite(Number(p["sinceTelemetrySequence"]))
      ? Math.max(0, Number(p["sinceTelemetrySequence"]))
      : 0;
    const structural = await page.evaluate(
      ({ maxDomChars, maxA11yNodes }) => {
        // This callback executes inside the browser, while the extension-host
        // tsconfig intentionally has no DOM lib. Keep the DOM value scoped and
        // structurally dynamic rather than adding browser globals to host code.
        const browserGlobal = globalThis as unknown as {
          document: {
            documentElement: { cloneNode(deep: boolean): any };
            body?: { querySelectorAll(selector: string): Iterable<any> };
            baseURI: string;
          };
          innerWidth: number;
          innerHeight: number;
          devicePixelRatio: number;
        };
        const browserDocument = browserGlobal.document;
        const root = browserDocument.documentElement.cloneNode(true);
        root.querySelectorAll("script,style,noscript").forEach((node: any) => node.remove());
        root.querySelectorAll("input,textarea,select,option").forEach((node: any) => {
          node.removeAttribute("value");
          node.removeAttribute("checked");
          node.removeAttribute("selected");
        });
        root.querySelectorAll("[href],[src],[action]").forEach((node: any) => {
          for (const attr of ["href", "src", "action"]) {
            const value = node.getAttribute(attr);
            if (!value) continue;
            try {
              const url = new URL(value, browserDocument.baseURI);
              for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
              url.username = "";
              url.password = "";
              url.hash = "";
              node.setAttribute(attr, url.toString());
            } catch {
              node.setAttribute(attr, value.slice(0, 2_000));
            }
          }
        });
        const html = root.outerHTML;

        const nodes: Array<Record<string, unknown>> = [];
        const elements: any[] = browserDocument.body
          ? Array.from(browserDocument.body.querySelectorAll("a,button,input,select,textarea,[role],[aria-label],h1,h2,h3,h4,h5,h6"))
          : [];
        for (const element of elements.slice(0, maxA11yNodes)) {
          const box = element.getBoundingClientRect();
          const label = element.getAttribute("aria-label")
            ?? element.getAttribute("alt")
            ?? element.innerText
            ?? element.textContent
            ?? "";
          nodes.push({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") ?? undefined,
            label: label.trim().replace(/\s+/g, " ").slice(0, 500),
            disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
            hidden: box.width === 0 || box.height === 0,
            bounds: {
              x: Math.round(box.x),
              y: Math.round(box.y),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
          });
        }
        return {
          dom: html.slice(0, maxDomChars),
          domTruncated: html.length > maxDomChars,
          accessibility: nodes,
          accessibilityTruncated: elements.length > maxA11yNodes,
          viewport: {
            width: browserGlobal.innerWidth,
            height: browserGlobal.innerHeight,
            devicePixelRatio: browserGlobal.devicePixelRatio,
          },
        };
      },
      { maxDomChars: MAX_DOM_SNAPSHOT_CHARS, maxA11yNodes: MAX_ACCESSIBILITY_NODES },
    );
    throwIfBrowserCancelled(signal);
    const telemetry = this._telemetry.filter((event) => event.sequence > since);
    return {
      ok: true,
      url: sanitizedUrl(page.url()),
      title: await page.title(),
      ...structural,
      telemetry,
      telemetrySequence: this._telemetrySequence,
    };
  }

  private async _wait(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const page = await this._ensurePage(signal);
    const selector = p["selector"] ? String(p["selector"]) : "";
    if (selector) {
      await page.waitForSelector(selector, { timeout: clampTimeout(p["timeoutMs"], 10_000) });
      throwIfBrowserCancelled(signal);
      return { ok: true, waitedFor: selector };
    }
    const ms = clampTimeout(p["timeoutMs"], 1_000);
    await page.waitForTimeout(ms);
    throwIfBrowserCancelled(signal);
    return { ok: true, waitedMs: ms };
  }

  /** Runs a sequence of browser actions in one call against the same page, so a
      multi-step visual walkthrough (navigate, screenshot, click, screenshot, …)
      costs one tool round trip instead of one per step. Stops at the first failed
      step unless continueOnError is set; each result is tagged with its index,
      action, and optional label so a long sequence stays easy to read back. */
  private async _runScript(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const rawSteps = Array.isArray(p["steps"]) ? p["steps"] as Record<string, unknown>[] : [];
    const steps = rawSteps.slice(0, MAX_SCRIPT_STEPS);
    const continueOnError = p["continueOnError"] === true;
    const results: Record<string, unknown>[] = [];

    for (let i = 0; i < steps.length; i += 1) {
      throwIfBrowserCancelled(signal);
      const step = steps[i] ?? {};
      const action = String(step["action"] ?? "");
      let stepResult: unknown;
      try {
        switch (action) {
          case "navigate":    stepResult = await this._navigate(step, signal); break;
          case "click":       stepResult = await this._click(step, signal); break;
          case "type":        stepResult = await this._typeText(step, signal); break;
          case "wait":        stepResult = await this._wait(step, signal); break;
          case "screenshot":  stepResult = await this._screenshot(step, signal); break;
          case "get_text":    stepResult = await this._getText(step, signal); break;
          case "evaluate":    stepResult = await this._evaluate(step, signal); break;
          case "mouse_path":  stepResult = await this._mousePath(step, signal); break;
          case "drag":        stepResult = await this._drag(step, signal); break;
          case "hover":       stepResult = await this._hover(step, signal); break;
          case "scroll":      stepResult = await this._scroll(step, signal); break;
          case "key":         stepResult = await this._key(step, signal); break;
          case "capture_matrix": stepResult = await this._captureMatrix(step, signal); break;
          default:            stepResult = { ok: false, error: `Unknown step action '${action}'.` };
        }
      } catch (err) {
        if (signal?.aborted || err instanceof BrowserActionCancelledError) throw err;
        stepResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const label = typeof step["label"] === "string" ? step["label"] : undefined;
      results.push({ index: i, action, ...(label ? { label } : {}), ...(stepResult as object) });
      if ((stepResult as { ok?: boolean } | undefined)?.ok === false && !continueOnError) break;
    }

    const failed = results.some((r) => r["ok"] === false);
    return { ok: !failed || continueOnError, steps: results, stepCount: results.length, stoppedEarly: results.length < steps.length };
  }

  async dispose(): Promise<void> {
    await this._page?.close().catch(() => { /* ignore */ });
    await this._context?.close().catch(() => { /* ignore */ });
    await this._browser?.close().catch(() => { /* ignore */ });
    this._page = null;
    this._context = null;
    this._browser = null;
    this._telemetry = [];
    this._telemetrySequence = 0;
  }
}
