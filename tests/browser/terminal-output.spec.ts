import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* A running shell command's output, live, in the built chat webview: the live-action strip
   shows its newest line and opens straight to the terminal; the terminal redraws progress
   lines in place and reports how the command ended. */

const TURN = "turn-term";

describe("built chat webview — live terminal output", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  const root = path.resolve("out/webview");
  const post = (message: Record<string, unknown>): Promise<void> => page.evaluate((m) => window.postMessage(m, "*"), message);

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
    page = await browser.newPage({ viewport: { width: 560, height: 960 } });
    await page.addInitScript(() => {
      const win = window as unknown as { acquireVsCodeApi: unknown };
      win.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => ({}), setState: () => undefined });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("streams a running command into the live strip and its terminal, then reports the exit", async () => {
    await post({ type: "stream_start", id: TURN });
    await post({ type: "stream_tool_call", id: TURN, toolCallId: "sh-1", toolName: "shell_run", input: { command: "npm", args: ["run", "build"], cwd: "web" } });
    await post({ type: "stream_tool_output", id: TURN, toolCallId: "sh-1", chunks: [
      { stream: "stdout", text: "> vite build\n" },
      { stream: "stdout", text: "transforming (12)\rtransforming (240)\r" },
    ] });
    await post({ type: "stream_tool_output", id: TURN, toolCallId: "sh-1", chunks: [{ stream: "stdout", text: "\x1b[32m✓\x1b[39m 2034 modules transformed.\n" }, { stream: "stderr", text: "(!) large chunk\n" }] });

    /* The strip names the command and carries its newest line. */
    const strip = page.locator("button.live-action");
    await strip.getByText("(!) large chunk").waitFor({ timeout: 5000 });
    await strip.click();

    const terminal = page.getByRole("log", { name: "Output of npm run build" });
    await terminal.waitFor({ timeout: 5000 });
    await terminal.getByText("✓ 2034 modules transformed.").waitFor();
    /* The progress line was redrawn in place — each state replaced the last, and the
       finished message replaced the final one — exactly as a terminal shows it. */
    expect(await terminal.getByText(/transforming/).count()).toBe(0);
    expect(await terminal.getByText("> vite build").count()).toBe(1);
    expect(await page.locator(".terminal-line-stderr", { hasText: "(!) large chunk" }).count()).toBe(1);
    await page.locator(".terminal-status", { hasText: "Running" }).waitFor();

    await post({ type: "stream_tool_result", id: TURN, toolCallId: "sh-1", toolName: "shell_run", ok: true, elapsedMs: 4200, result: { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false } });
    await page.locator(".terminal-status", { hasText: "Exit 0" }).waitFor({ timeout: 5000 });
    expect(await terminal.getByText("✓ 2034 modules transformed.").count()).toBe(1);
  });
});
