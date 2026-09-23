import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  browserActionRequiresConfirmation,
  browserExecutableCandidates,
  ChromiumRunner,
  validateBrowserActionUrls,
} from "../../src/chromium-runner";

interface RunnerInternals {
  _browser: unknown;
  _context: unknown;
  _page: unknown;
  _dispatchRaw: ChromiumRunner["dispatch"];
  _installLocalBoundary(context: unknown): Promise<void>;
}

function internals(runner: ChromiumRunner): RunnerInternals {
  return runner as unknown as RunnerInternals;
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle promptly")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("ChromiumRunner cancellation", () => {
  const actions: Array<{ toolType: string; payload: Record<string, unknown> }> = [
    { toolType: "navigate", payload: { url: "http://localhost:4173/" } },
    { toolType: "click", payload: { selector: "#submit" } },
    { toolType: "type_text", payload: { selector: "#name", text: "Ada" } },
    { toolType: "wait", payload: { timeoutMs: 10_000 } },
    { toolType: "capture_state", payload: {} },
    { toolType: "screenshot", payload: {} },
    { toolType: "evaluate", payload: { script: "1 + 1" } },
    { toolType: "get_text", payload: {} },
  ];

  for (const { toolType, payload } of actions) {
    it(`interrupts an in-flight ${toolType} action by closing its page`, async () => {
      const runner = new ChromiumRunner();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let rejectOperation: ((reason: Error) => void) | undefined;
      const blocked = new Promise<never>((_resolve, reject) => {
        rejectOperation = reject;
      });
      const blockingCall = vi.fn(() => {
        markStarted?.();
        return blocked;
      });
      let closed = false;
      const close = vi.fn(async () => {
        closed = true;
        rejectOperation?.(new Error("Target page has been closed"));
      });
      const page = {
        isClosed: () => closed,
        close,
        goto: blockingCall,
        click: blockingCall,
        fill: blockingCall,
        screenshot: blockingCall,
        evaluate: blockingCall,
        waitForSelector: blockingCall,
        waitForTimeout: blockingCall,
        locator: () => ({
          first: () => ({ innerText: blockingCall }),
        }),
        url: () => "http://localhost:4173/",
        title: async () => "Test",
      };
      internals(runner)._page = page;

      const controller = new AbortController();
      const resultPromise = internals(runner)._dispatchRaw(toolType, payload, controller.signal);
      await started;
      controller.abort();

      await expect(settlesWithin(resultPromise, 250)).resolves.toEqual({
        ok: false,
        error: "Browser action cancelled.",
        cancelled: true,
      });
      expect(close).toHaveBeenCalledOnce();
      expect(internals(runner)._page).toBeNull();
    });
  }

  it("recreates a cancelled page in the existing browser context", async () => {
    const runner = new ChromiumRunner();
    let rejectClick: ((reason: Error) => void) | undefined;
    const firstClick = new Promise<never>((_resolve, reject) => {
      rejectClick = reject;
    });
    let clickStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      clickStarted = resolve;
    });
    let firstClosed = false;
    const firstPage = {
      isClosed: () => firstClosed,
      url: () => "about:blank",
      click: vi.fn(() => {
        clickStarted?.();
        return firstClick;
      }),
      close: vi.fn(async () => {
        firstClosed = true;
        rejectClick?.(new Error("Target page has been closed"));
      }),
    };
    const replacementPage = {
      isClosed: () => false,
      url: () => "about:blank",
      click: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const context = {
      newPage: vi.fn(async () => replacementPage),
      close: vi.fn(async () => undefined),
    };
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const state = internals(runner);
    state._page = firstPage;
    state._context = context;
    state._browser = browser;

    const controller = new AbortController();
    const cancelled = internals(runner)._dispatchRaw("click", { selector: "#first" }, controller.signal);
    await started;
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false, cancelled: true });

    await expect(internals(runner)._dispatchRaw("click", { selector: "#second" })).resolves.toEqual({
      ok: true,
      selector: "#second",
    });
    expect(context.newPage).toHaveBeenCalledOnce();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(replacementPage.click).toHaveBeenCalledWith("#second", { timeout: 10_000 });
  });

  it("blocks a redirect at the persistent context boundary before forwarding Location", async () => {
    const runner = new ChromiumRunner();
    let handler: any;
    await internals(runner)._installLocalBoundary({ route: async (_pattern: string, h: any) => { handler = h; }, routeWebSocket: async () => {} });
    (runner as any)._localOrigins.add("http://localhost:4173");
    const fetch = vi.fn(async () => ({ status: () => 302, headers: () => ({ location: "https://example.com/escaped" }), dispose: async () => {} }));
    const abort = vi.fn(async () => {});
    const fulfill = vi.fn(async () => {});
    await handler({ request: () => ({ url: () => "http://localhost:4173/redirect", method: () => "GET" }), fetch, abort, fulfill });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
    expect(abort).toHaveBeenCalledOnce();
    expect(fulfill).not.toHaveBeenCalled();
  });

  it("refuses a scoped mutation when the current page is already remote", async () => {
    const runner = new ChromiumRunner();
    let closed = false;
    const page = {
      isClosed: () => closed,
      url: () => "https://example.com/escaped",
      click: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        closed = true;
      }),
    };
    internals(runner)._page = page;

    await expect(runner.dispatch(
      "click",
      { selector: "#danger" },
      undefined,
      { allowedOrigins: ["http://localhost:4173"], localOnly: true },
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("escaped its approved local origin scope"),
    });
    expect(page.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledOnce();
    expect(internals(runner)._page).toBeNull();
  });
});

describe("ChromiumRunner navigation security", () => {
  it("rejects local, data, script, and embedded-credential navigation", async () => {
    const runner = new ChromiumRunner();
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,secret",
      "javascript:document.body.innerText",
      "https://user:secret@example.com/",
    ]) {
      await expect(runner.dispatch("navigate", { url })).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/only HTTP\(S\)|embedded credentials/i),
      });
    }
    expect(internals(runner)._page).toBeNull();
  });

  it("rejects non-web navigation nested inside browser_run_script", () => {
    expect(validateBrowserActionUrls("run_script", {
      steps: [{ action: "navigate", url: "https://example.com" }, { action: "navigate", url: "file:///etc/passwd" }],
    })).toMatchObject({ ok: false });
  });

  it("approval-gates navigation and interaction while leaving observation read-only", () => {
    for (const action of ["navigate", "click", "type_text", "evaluate", "run_script", "key"]) {
      expect(browserActionRequiresConfirmation(action), action).toBe(true);
    }
    for (const action of ["screenshot", "get_text", "wait", "capture_state"]) {
      expect(browserActionRequiresConfirmation(action), action).toBe(false);
    }
  });
});

// A real page.screenshot() call (real Chromium/CDP) is out of reach for a unit test — these
// exercise everything ChromiumRunner itself controls around that call: payload plumbing,
// viewport/script/scroll sequencing for capture_matrix, and cleanup guarantees.
describe("ChromiumRunner screenshot capture", () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  function fakePage(overrides: Record<string, unknown> = {}) {
    let closed = false;
    return {
      isClosed: () => closed,
      close: vi.fn(async () => { closed = true; }),
      screenshot: vi.fn(async () => PNG_BYTES),
      url: () => "http://localhost:4173/",
      title: async () => "Test",
      viewportSize: () => ({ width: 1024, height: 768 }),
      setViewportSize: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("returns a base64 PNG data URL and forwards fullPage to the real screenshot call", async () => {
    const runner = new ChromiumRunner();
    const page = fakePage();
    internals(runner)._page = page;

    const result = await internals(runner)._dispatchRaw("screenshot", { fullPage: true });

    expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true, type: "png" });
    expect(result).toMatchObject({
      ok: true,
      dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      sizeBytes: PNG_BYTES.length,
      fullPage: true,
    });
  });

  it("rejects capture_matrix with no perspectives instead of silently producing zero frames", async () => {
    const runner = new ChromiumRunner();
    internals(runner)._page = fakePage();

    const result = await internals(runner)._dispatchRaw("capture_matrix", { perspectives: [] });

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/non-empty/i) });
  });

  it("caps capture_matrix at 12 frames even when more perspectives are requested", async () => {
    const runner = new ChromiumRunner();
    const page = fakePage();
    internals(runner)._page = page;
    const perspectives = Array.from({ length: 15 }, (_, i) => ({ label: `p${i}` }));

    const result = await internals(runner)._dispatchRaw("capture_matrix", { perspectives });

    expect(page.screenshot).toHaveBeenCalledTimes(12);
    expect(result).toMatchObject({ ok: true, frameCount: 12 });
  });

  it("applies script/viewport/scroll between captures, labels each frame, and restores the original viewport", async () => {
    const runner = new ChromiumRunner();
    const page = fakePage();
    internals(runner)._page = page;

    const result = await internals(runner)._dispatchRaw("capture_matrix", {
      perspectives: [
        { label: "wide", script: "document.title", width: 1920, height: 1080 },
        { label: "scrolled", scrollY: 500 },
      ],
    }) as { ok: true; frames: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({ label: "wide", index: 0, applied: { script: true, viewport: { width: 1920, height: 1080 } } });
    expect(result.frames[1]).toMatchObject({ label: "scrolled", index: 1, applied: { scrollY: 500 } });
    expect(page.evaluate).toHaveBeenCalledWith("document.title");
    expect(page.evaluate).toHaveBeenCalledWith("window.scrollTo(0, 500)");
    // First setViewportSize call applies the requested size; the last restores the original —
    // a capture sweep must not leave the page resized for whatever step runs next.
    expect(page.setViewportSize).toHaveBeenNthCalledWith(1, { width: 1920, height: 1080 });
    expect(page.setViewportSize).toHaveBeenLastCalledWith({ width: 1024, height: 768 });
  });

  it("still restores the original viewport when a later frame's capture throws", async () => {
    const runner = new ChromiumRunner();
    const page = fakePage({
      screenshot: vi.fn()
        .mockResolvedValueOnce(PNG_BYTES)
        .mockRejectedValueOnce(new Error("page crashed")),
    });
    internals(runner)._page = page;

    const result = await internals(runner)._dispatchRaw("capture_matrix", {
      perspectives: [{ label: "a", width: 800, height: 600 }, { label: "b", width: 1200, height: 900 }],
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("page crashed") });
    expect(page.setViewportSize).toHaveBeenLastCalledWith({ width: 1024, height: 768 });
  });
});

describe("ChromiumRunner resource cleanup", () => {
  /* A failed video_start (a reload that timed out, a cancel) left the recording context in place
     with no session registered, so video_stop refused it and video kept being written into a temp
     directory nothing removed. */
  it("tears down the recording context and its directory when video_start fails", async () => {
    const runner = new ChromiumRunner();
    const currentPage = {
      isClosed: () => false,
      url: () => "http://localhost:4173/",
      viewportSize: () => ({ width: 1280, height: 800 }),
      close: vi.fn(async () => undefined),
    };
    const currentContext = { storageState: vi.fn(async () => ({ cookies: [], origins: [] })), close: vi.fn(async () => undefined) };
    const recordingPage = {
      isClosed: () => false,
      on: vi.fn(),
      goto: vi.fn(async () => { throw new Error("Timeout 30000ms exceeded"); }),
    };
    const recordingContext = {
      route: vi.fn(async () => undefined),
      routeWebSocket: vi.fn(async () => undefined),
      newPage: vi.fn(async () => recordingPage),
      close: vi.fn(async () => undefined),
    };
    const browser = { isConnected: () => true, newContext: vi.fn(async () => recordingContext) };
    const state = internals(runner) as RunnerInternals & {
      _videoSession: unknown;
      _startVideo(p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    };
    state._page = currentPage;
    state._context = currentContext;
    state._browser = browser;

    await expect(state._startVideo({})).rejects.toThrow(/Timeout/);

    const directory = (browser.newContext.mock.calls[0] as unknown as [{ recordVideo: { dir: string } }])[0].recordVideo.dir;
    expect(recordingContext.close).toHaveBeenCalledOnce();
    expect(fs.existsSync(directory)).toBe(false);
    expect(state._context).toBeNull();
    expect(state._page).toBeNull();
    expect(state._videoSession).toBeUndefined();
  });

  /* Two renders that both found the shared render browser dead each launched a replacement, and
     the first was orphaned when the second overwrote the handle — a headless Chromium that
     nothing, idle close included, ever closed. */
  it("launches one replacement render browser when concurrent renders find the old one dead", async () => {
    const launched: Array<{ isConnected: () => boolean; on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const launch = vi.fn(async () => {
      const browser = { isConnected: () => true, on: vi.fn(), close: vi.fn(async () => undefined) };
      launched.push(browser);
      return browser;
    });
    const runner = new ChromiumRunner(launch as unknown as ConstructorParameters<typeof ChromiumRunner>[0]);
    const state = runner as unknown as { _renderBrowser?: Promise<unknown>; _acquireRenderBrowser(): Promise<unknown> };
    state._renderBrowser = Promise.resolve({ isConnected: () => false });

    const [first, second] = await Promise.all([state._acquireRenderBrowser(), state._acquireRenderBrowser()]);

    expect(launched).toHaveLength(1);
    expect(launch).toHaveBeenCalledWith(true);
    expect(first).toBe(launched[0]);
    expect(second).toBe(launched[0]);
  });
});

describe("browserExecutableCandidates", () => {
  /** Only the machine-wide C:\ locations used to be checked, so a per-user Edge/Chrome or Program
   *  Files on another drive meant "no browser" and every preview and run failed. */
  it("covers per-user installs and Program Files wherever it lives on Windows", () => {
    const candidates = browserExecutableCandidates("win32", {
      PROGRAMFILES: String.raw`D:\Apps`,
      "PROGRAMFILES(X86)": String.raw`D:\Apps (x86)`,
      LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`,
    }, String.raw`C:\Users\dev`);
    expect(candidates).toEqual(expect.arrayContaining([
      String.raw`D:\Apps\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Users\dev\AppData\Local\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Users\dev\AppData\Local\Microsoft\Edge\Application\msedge.exe`,
      String.raw`D:\Apps (x86)\Microsoft\Edge\Application\msedge.exe`,
    ]));
    // Stable Chrome and Edge are preferred over any pre-release channel.
    const firstBeta = candidates.findIndex((candidate) => candidate.includes("Beta"));
    const lastStable = Math.max(...candidates.map((candidate, index) =>
      candidate.includes(String.raw`\Chrome\Application`) || candidate.includes(String.raw`\Edge\Application`) ? index : -1));
    expect(lastStable).toBeLessThan(firstBeta);
  });

  /** Chrome dragged into ~/Applications (the default without admin rights) was invisible. */
  it("looks in ~/Applications as well as /Applications on macOS", () => {
    const candidates = browserExecutableCandidates("darwin", {}, "/Users/dev");
    expect(candidates).toEqual(expect.arrayContaining([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Users/dev/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]));
    expect(candidates[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
