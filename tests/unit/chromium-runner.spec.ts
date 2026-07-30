import { describe, expect, it, vi } from "vitest";
import { ChromiumRunner } from "../../src/chromium-runner";

interface RunnerInternals {
  _browser: unknown;
  _context: unknown;
  _page: unknown;
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
      const resultPromise = runner.dispatch(toolType, payload, controller.signal);
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
    const cancelled = runner.dispatch("click", { selector: "#first" }, controller.signal);
    await started;
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false, cancelled: true });

    await expect(runner.dispatch("click", { selector: "#second" })).resolves.toEqual({
      ok: true,
      selector: "#second",
    });
    expect(context.newPage).toHaveBeenCalledOnce();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(replacementPage.click).toHaveBeenCalledWith("#second", { timeout: 10_000 });
  });

  it("blocks a loopback navigation that redirects outside its approved origin", async () => {
    const runner = new ChromiumRunner();
    const mainFrame = {};
    let routeHandler: ((route: {
      request(): {
        isNavigationRequest(): boolean;
        frame(): unknown;
        url(): string;
      };
      abort(): Promise<void>;
      continue(): Promise<void>;
    }) => Promise<void>) | undefined;
    const aborted = vi.fn(async () => undefined);
    const continued = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
        routeHandler = handler;
      }),
      unroute: vi.fn(async () => undefined),
      mainFrame: () => mainFrame,
      goto: vi.fn(async () => {
        await routeHandler?.({
          request: () => ({
            isNavigationRequest: () => true,
            frame: () => mainFrame,
            url: () => "https://example.com/escaped",
          }),
          abort: aborted,
          continue: continued,
        });
        throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      }),
      url: () => "http://localhost:4173/",
      title: vi.fn(async () => "Local"),
      close: vi.fn(async () => undefined),
    };
    internals(runner)._page = page;

    await expect(runner.dispatch(
      "navigate",
      { url: "http://localhost:4173/redirect" },
      undefined,
      { allowedOrigins: ["http://localhost:4173"], localOnly: true },
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("escaped its approved local origin scope"),
    });
    expect(aborted).toHaveBeenCalledOnce();
    expect(continued).not.toHaveBeenCalled();
    expect(page.title).not.toHaveBeenCalled();
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
