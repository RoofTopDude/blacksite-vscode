import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* Diff navigation, against the real built webview.
   The value of testing it here rather than in a unit test is the wiring: that a change row is a
   real focusable control, that clicking it posts open_tool_diff with the path the host keyed the
   snapshot under, and that a file the host reported no snapshot for falls back to open_file
   instead of silently doing nothing. */

const TURN = "turn-diff";

interface FixtureWindow extends Window {
  __messages: Array<{ type?: string }>;
}

describe("built chat webview — reviewing an agent edit", () => {
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
      win.__messages = [];
      win.acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => win.__messages.push(m as { type?: string }),
        getState: () => ({}),
        setState: () => undefined,
      });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();

    // One batch edit across two files, of which the host only snapshotted the first — so the
    // transcript has both a reviewable row and a row that must degrade to opening the file.
    await page.evaluate((turn) => {
      window.postMessage({ type: "stream_start", id: turn }, "*");
      window.postMessage({
        type: "stream_tool_call", id: turn, toolCallId: "edit-1", toolName: "file_edit_batch",
        input: { edits: [
          { path: "src/alpha.ts", oldString: "a", newString: "b" },
          { path: "src/beta.ts", oldString: "c", newString: "d" },
        ] },
      }, "*");
      window.postMessage({
        type: "stream_tool_result", id: turn, toolCallId: "edit-1", toolName: "file_edit_batch",
        ok: true, summary: "2 files", elapsedMs: 12,
        result: {
          ok: true, files: 2, edits: 2, replacements: 2,
          results: [{ path: "src/alpha.ts", replacements: 1 }, { path: "src/beta.ts", replacements: 1 }],
        },
        diffs: [{ path: "src/alpha.ts", additions: 1, deletions: 1, kind: "modified", line: 7 }],
      }, "*");
    }, TURN);
    await page.getByRole("button", { name: /Batch Edit/ }).first().click();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  async function reset(): Promise<void> {
    await page.evaluate(() => { (window as unknown as FixtureWindow).__messages.length = 0; });
  }

  async function sent(type: string): Promise<unknown[]> {
    return page.evaluate(
      (wanted) => (window as unknown as FixtureWindow).__messages.filter((m) => m.type === wanted),
      type,
    );
  }

  it("opens a snapshotted file's diff from the tool row, aimed at the first changed line", async () => {
    await reset();
    // The "(line 7)" in the label is the point: the host told the row where the change starts,
    // so the reviewer lands on it rather than at the top of the file.
    const row = page.getByRole("button", { name: "Open the diff for src/alpha.ts (line 7)", exact: true });
    await row.waitFor();
    await row.click();
    expect(await sent("open_tool_diff")).toEqual([
      { type: "open_tool_diff", toolCallId: "edit-1", path: "src/alpha.ts" },
    ]);
  });

  it("falls back to opening the file when the host reported no snapshot for it", async () => {
    await reset();
    const row = page.getByRole("button", { name: "Open src/beta.ts", exact: true }).last();
    await row.waitFor();
    await row.click();
    expect(await sent("open_tool_diff")).toEqual([]);
    expect(await sent("open_file")).toEqual([{ type: "open_file", path: "src/beta.ts", line: undefined }]);
  });

  it("offers the same diff from the conversation change ledger", async () => {
    await reset();
    await page.getByRole("button", { name: /^Changes/ }).first().click();
    // The ledger row carries no line hint of its own — it points at the last call that still
    // holds a snapshot for the file, which is what makes its label distinct from the tool row's.
    const row = page.getByRole("button", { name: "Open the diff for src/alpha.ts", exact: true });
    await row.waitFor();
    await row.click();
    expect(await sent("open_tool_diff")).toEqual([
      { type: "open_tool_diff", toolCallId: "edit-1", path: "src/alpha.ts" },
    ]);
  });

  it("opens every diff of a multi-file change in one action", async () => {
    await reset();
    await page.evaluate((turn) => {
      window.postMessage({
        type: "stream_tool_call", id: turn, toolCallId: "edit-2", toolName: "file_edit_batch",
        input: { edits: [
          { path: "src/one.ts", oldString: "a", newString: "b" },
          { path: "src/two.ts", oldString: "c", newString: "d" },
        ] },
      }, "*");
      window.postMessage({
        type: "stream_tool_result", id: turn, toolCallId: "edit-2", toolName: "file_edit_batch",
        ok: true, summary: "2 files", elapsedMs: 8,
        result: {
          ok: true, files: 2, edits: 2, replacements: 2,
          results: [{ path: "src/one.ts", replacements: 1 }, { path: "src/two.ts", replacements: 1 }],
        },
        diffs: [
          { path: "src/one.ts", additions: 1, deletions: 1, kind: "modified", line: 2 },
          { path: "src/two.ts", additions: 4, deletions: 0, kind: "created", line: 0 },
        ],
      }, "*");
    }, TURN);

    // A second call turns on the execution summary, which folds the per-tool groups away.
    await page.getByRole("button", { name: /Execution/ }).first().click();
    await page.getByRole("button", { name: /Batch Edit/ }).first().click();
    const reviewAll = page.getByRole("button", { name: "Review 2 diffs", exact: true }).first();
    await reviewAll.waitFor();
    await reviewAll.click();
    expect(await sent("open_tool_diff")).toEqual([
      { type: "open_tool_diff", toolCallId: "edit-2", all: true },
    ]);
  });
});
