/**
 * The rehearsal that lets the agent see its own preview before the user does.
 *
 * Everything else raises the ceiling on preview fidelity; this raises the floor. Previews are
 * authored blind — no type-check, no build, no look at the result — so the risk-minimising move is
 * markup simple enough to be trivially correct, which is exactly the low-effort output this is
 * meant to eliminate. Rendering makes mistakes correctable instead of user-visible.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { BrowserRunner } from "../../src/chromium-runner.js";
import { renderPreview } from "../../src/preview-render.js";

interface Call { action: string; payload: Record<string, unknown> }

/** Records the dispatch sequence and serves canned results, including the document the renderer
 *  navigated to — which is the only way to assert what was actually rendered. */
function fakeRunner(overrides: Partial<Record<string, unknown>> = {}): BrowserRunner & {
  calls: Call[];
  document(): string;
} {
  const calls: Call[] = [];
  // Snapshotted during navigate, not read afterwards: the renderer deletes its temp document in a
  // finally block, which a separate test asserts.
  let navigatedDocument = "";
  return {
    calls,
    document: () => navigatedDocument,
    async dispatch(action: string, payload: Record<string, unknown>) {
      calls.push({ action, payload });
      if (action === "navigate") {
        const file = String(payload["url"] ?? "").replace(/^file:\/\/\//, "");
        navigatedDocument = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      }
      if (action in overrides) return overrides[action];
      if (action === "screenshot") return { ok: true, dataUrl: "data:image/png;base64,AAAA", sizeBytes: 4 };
      if (action === "evaluate") return { ok: true, result: "[]" };
      return { ok: true };
    },
    async dispose() { /* nothing to release */ },
  };
}

const repoRoot = path.resolve(__dirname, "..", "..");
const workspace = path.join(repoRoot, ".tmp-preview-render-test");

beforeAll(() => fs.mkdirSync(path.join(workspace, "src"), { recursive: true }));
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

describe("renderPreview", () => {
  it("returns the screenshot as a data URL for the vision block", async () => {
    const runner = fakeRunner();
    const result = await renderPreview(runner, { code: "document.body.textContent='hi'" }, {});
    expect(result.ok).toBe(true);
    expect(result.dataUrl).toBe("data:image/png;base64,AAAA");
  });

  /** A rehearsal at the default 1280x800 would show different wrapping and breakpoints from the
   *  frame the preview actually lives in, which defeats the point of looking at it. */
  it("sizes the viewport to the frame the preview will occupy", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x", width: 420, height: 300 }, {});
    expect(runner.calls[0]).toMatchObject({ action: "set_viewport", payload: { width: 420, height: 300 } });
  });

  it("defaults to the inline chat frame's dimensions", async () => {
    const runner = fakeRunner();
    const result = await renderPreview(runner, { code: "x" }, {});
    expect(result).toMatchObject({ width: 720, height: 260 });
  });

  it("clamps absurd dimensions rather than handing them to the browser", async () => {
    const runner = fakeRunner();
    const result = await renderPreview(runner, { code: "x", width: 99_999, height: -5 }, {});
    expect(result.width).toBeLessThanOrEqual(2000);
    expect(result.height).toBeGreaterThanOrEqual(120);
  });

  /** A runner predating set_viewport (or a remote bridge without it) is worth less, not fatal. */
  it("still renders when the runner cannot set a viewport", async () => {
    const runner = fakeRunner();
    const rejecting: BrowserRunner = {
      dispatch: (action, payload) => (action === "set_viewport"
        ? Promise.reject(new Error("unknown action"))
        : runner.dispatch(action, payload)),
      dispose: async () => { /* nothing to release */ },
    };
    expect((await renderPreview(rejecting, { code: "x" }, {})).ok).toBe(true);
  });

  it("navigates in the documented order: size, load, settle, collect, capture", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x" }, {});
    expect(runner.calls.map((c) => c.action)).toEqual([
      "set_viewport", "navigate", "wait", "evaluate", "screenshot",
    ]);
  });

  it("skips the settle wait when it is set to zero", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x", settleMs: 0 }, {});
    expect(runner.calls.map((c) => c.action)).not.toContain("wait");
  });

  it("passes the settle delay as the runner's timeoutMs", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x", settleMs: 900 }, {});
    expect(runner.calls.find((c) => c.action === "wait")?.payload).toMatchObject({ timeoutMs: 900 });
  });

  /**
   * The rendered document routinely exceeds 240 KB once the project stylesheet and inlined fonts
   * are in it — past what navigation URLs handle reliably.
   */
  it("renders from a file URL rather than a data URL", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x" }, {});
    expect(String(runner.calls.find((c) => c.action === "navigate")?.payload["url"])).toMatch(/^file:\/\/\//);
  });

  it("renders the same document the live surfaces build, project stylesheet included", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "mycode()" }, { projectCss: ".project-class{color:red}" });
    const doc = runner.document();
    expect(doc).toContain(".project-class{color:red}");
    expect(doc).toContain("mycode()");
    expect(doc).toContain("--vscode-editor-background");
  });

  it("cleans up the temp document it rendered from", async () => {
    const runner = fakeRunner();
    await renderPreview(runner, { code: "x" }, {});
    const url = String(runner.calls.find((c) => c.action === "navigate")?.payload["url"]);
    expect(fs.existsSync(url.replace(/^file:\/\/\//, ""))).toBe(false);
  });

  /** Uncaught exceptions inside the sandbox are the most common thing the agent needs to fix, and
   *  they are invisible in a screenshot of a blank frame. */
  it("reports errors the preview threw while rendering", async () => {
    const runner = fakeRunner({ evaluate: { ok: true, result: JSON.stringify(["x is not defined"]) } });
    const result = await renderPreview(runner, { code: "x()" }, {});
    expect(result.previewErrors).toEqual(["x is not defined"]);
  });

  it("omits previewErrors entirely when the preview rendered cleanly", async () => {
    expect((await renderPreview(fakeRunner(), { code: "x" }, {})).previewErrors).toBeUndefined();
  });

  it("tolerates a runner that shapes evaluate results as `value`", async () => {
    const runner = fakeRunner({ evaluate: { ok: true, value: JSON.stringify(["boom"]) } });
    expect((await renderPreview(runner, { code: "x" }, {})).previewErrors).toEqual(["boom"]);
  });

  it("does not treat unparseable evaluate output as an error list", async () => {
    const runner = fakeRunner({ evaluate: { ok: true, result: "not json" } });
    const result = await renderPreview(runner, { code: "x" }, {});
    expect(result.ok).toBe(true);
    expect(result.previewErrors).toBeUndefined();
  });

  it("surfaces a navigation failure instead of returning a blank success", async () => {
    const runner = fakeRunner({ navigate: { ok: false, error: "Timed out" } });
    expect(await renderPreview(runner, { code: "x" }, {})).toMatchObject({ ok: false, error: "Timed out" });
  });

  it("surfaces a screenshot failure", async () => {
    const runner = fakeRunner({ screenshot: { ok: false, error: "Capture failed" } });
    expect(await renderPreview(runner, { code: "x" }, {})).toMatchObject({ ok: false, error: "Capture failed" });
  });

  it("refuses a request with nothing to render", async () => {
    const result = await renderPreview(fakeRunner(), {}, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("provide `code` or `mount`");
  });

  /** Build errors are the feedback that makes a mount preview fixable before the user sees it. */
  it("returns a mount build failure without touching the browser", async () => {
    const runner = fakeRunner();
    const result = await renderPreview(runner, { mount: { entry: "src/missing.js" } }, { workspaceRoot: workspace });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(runner.calls).toHaveLength(0);
  });

  it("renders a mounted component and reports which files the patch touched", async () => {
    fs.writeFileSync(
      path.join(workspace, "src", "widget.js"),
      "export default (host) => { host.textContent = 'before'; };",
      "utf8",
    );
    const runner = fakeRunner();
    const result = await renderPreview(
      runner,
      { mount: { entry: "src/widget.js", patch: [{ file: "src/widget.js", find: "'before'", replace: "'after'" }] } },
      { workspaceRoot: workspace },
    );
    expect(result.ok).toBe(true);
    expect(result.patchedFiles).toEqual(["src/widget.js"]);
    expect(runner.document()).toContain("after");
  });
});
