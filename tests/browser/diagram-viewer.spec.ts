import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* The diagram viewer (apps/diagram), against the real built bundle under the real webview CSP.
   What matters here is interaction a unit test cannot see: that wheel zoom holds the point under
   the cursor still, that drag pans, that the source editor re-renders live and keeps the last good
   diagram on screen while an edit does not parse, and that export hands the host a well-formed
   SVG and a real PNG. */

const SOURCE = [
  "---",
  "title: Request lifecycle",
  "---",
  "flowchart TD",
  "  U[\"User message\"] --> C[\"ChatProvider.send()\"]",
  "  C --> S[\"AgentSession.run()\"]",
  "  S --> T{\"Tool call?\"}",
  "  T -->|yes| R[\"Tool router\"] --> S",
  "  T -->|no| F[\"Final answer\"]",
].join("\n");

interface FixtureWindow extends Window {
  __messages: Array<Record<string, unknown>>;
  __state: unknown;
  __violations: string[];
}

function transformOf(style: string): { x: number; y: number; scale: number } {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(style);
  if (!match) throw new Error(`No transform in "${style}"`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

describe("built diagram viewer", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  let origin = "";
  const root = path.resolve("out/webview");
  const font = fs.existsSync(path.join(root, "fonts/lexend-latin.woff2"))
    ? fs.readFileSync(path.join(root, "fonts/lexend-latin.woff2")).toString("base64")
    : "";

  async function openViewer(initialState: unknown = null, file: { name: string; path: string } | null = null): Promise<Page> {
    const viewer = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    await viewer.addInitScript(({ source, initialState, font, file }) => {
      const win = window as unknown as FixtureWindow & { acquireVsCodeApi: unknown };
      win.__messages = [];
      win.__violations = [];
      win.__state = initialState;
      document.addEventListener("securitypolicyviolation", (event) => {
        win.__violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
      win.acquireVsCodeApi = () => ({
        postMessage: (message: Record<string, unknown>) => {
          win.__messages.push(message);
          if (message.type === "diagram_ready") {
            setTimeout(() => window.postMessage({ type: "diagram_init", source, ...(file ? { file } : {}), fonts: { latin: font } }, "*"), 0);
          }
        },
        getState: () => win.__state,
        setState: (state: unknown) => { win.__state = state; },
      });
    }, { source: SOURCE, initialState, font, file });
    await viewer.goto(origin);
    await viewer.locator(".dv-content svg").waitFor({ timeout: 20_000 });
    return viewer;
  }

  const transform = async (target: Page = page) => transformOf(await target.locator(".dv-content").getAttribute("style") ?? "");
  const messages = (type: string, target: Page = page) => target.evaluate(
    (wanted) => (window as unknown as FixtureWindow).__messages.filter((m) => m.type === wanted),
    type,
  );

  beforeAll(async () => {
    if (!fs.existsSync(path.join(root, "diagram.js"))) throw new Error("Run npm run build before npm run test:browser.");
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      if (pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8")
          .replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce")
          .replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", "/diagram.js"));
        return;
      }
      const target = path.resolve(root, `.${pathname}`);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const executablePath = process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync)
      : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
    page = await openViewer();
  });

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("draws the diagram fitted to the window and names the tab after it", async () => {
    const t = await transform();
    const box = await page.locator(".dv-content svg").boundingBox();
    const stage = await page.locator(".dv-stage").boundingBox();
    expect(t.scale).toBeGreaterThan(0.05);
    expect(t.scale).toBeLessThanOrEqual(1.5);
    // Centred horizontally within a couple of pixels.
    expect(Math.abs((box!.x + box!.width / 2) - (stage!.x + stage!.width / 2))).toBeLessThan(3);
    expect(await page.locator(".dv-title-main").textContent()).toBe("Request lifecycle");
    expect(await messages("diagram_title")).toContainEqual({ type: "diagram_title", title: "Request lifecycle · Flowchart" });
  });

  it("zooms with the wheel around the pointer, holding that point still", async () => {
    const before = await transform();
    const pointer = { x: 520, y: 300 };
    const stage = (await page.locator(".dv-viewport").boundingBox())!;
    const local = { x: pointer.x - stage.x, y: pointer.y - stage.y };
    const contentPoint = { x: (local.x - before.x) / before.scale, y: (local.y - before.y) / before.scale };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
    const after = await transform();
    expect(after.scale).toBeGreaterThan(before.scale * 1.1);
    expect(after.x + contentPoint.x * after.scale).toBeCloseTo(local.x, 0);
    expect(after.y + contentPoint.y * after.scale).toBeCloseTo(local.y, 0);
  });

  it("pans by dragging", async () => {
    const before = await transform();
    await page.mouse.move(400, 400);
    await page.mouse.down();
    await page.mouse.move(460, 370, { steps: 4 });
    await page.mouse.up();
    const after = await transform();
    expect(after.x - before.x).toBeCloseTo(60, 0);
    expect(after.y - before.y).toBeCloseTo(-30, 0);
    expect(after.scale).toBe(before.scale);
  });

  it("answers the keyboard: 1 for actual size, 0 to fit, + to zoom in", async () => {
    await page.locator(".dv-viewport").focus();
    await page.keyboard.press("1");
    await page.waitForTimeout(300);
    expect((await transform()).scale).toBeCloseTo(1, 2);
    expect(await page.locator(".dv-zoom-level").textContent()).toBe("100%");
    await page.keyboard.press("+");
    await page.waitForTimeout(300);
    expect((await transform()).scale).toBeCloseTo(1.25, 2);
    await page.keyboard.press("0");
    await page.waitForTimeout(300);
    expect((await transform()).scale).toBeLessThanOrEqual(1.5);
  });

  it("shows the minimap once the diagram overflows, and navigates by it", async () => {
    await page.keyboard.press("2");
    await page.waitForTimeout(300);
    const minimap = page.locator(".dv-minimap");
    await minimap.waitFor();
    const before = await transform();
    const box = (await minimap.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
    await page.waitForTimeout(300);
    const after = await transform();
    expect(after.y).toBeLessThan(before.y);
    await page.keyboard.press("0");
    await page.waitForTimeout(300);
    expect(await minimap.count()).toBe(0);
  });

  it("re-renders as the source is edited, keeping the last good diagram through a parse error", async () => {
    await page.keyboard.press("s");
    const editor = page.getByLabel("Mermaid source");
    await editor.waitFor();
    expect(await editor.inputValue()).toBe(SOURCE);

    await editor.fill(`${SOURCE}\n  F --> [broken`);
    await page.locator(".dv-banner").waitFor({ timeout: 10_000 });
    expect(await page.locator(".dv-content svg").count()).toBe(1);
    expect(await page.locator(".dv-source-foot.is-error").isVisible()).toBe(true);

    await editor.fill(SOURCE.replace("title: Request lifecycle", "title: Edited flow"));
    await page.waitForFunction(() => document.querySelector(".dv-title-main")?.textContent === "Edited flow");
    await page.locator(".dv-banner").waitFor({ state: "detached", timeout: 10_000 });
    expect(await page.locator(".dv-bar .dv-badge").textContent()).toBe("Edited");
    const persisted = await page.evaluate(() => (window as unknown as FixtureWindow).__state) as { diagram: { draft: string; source: string } };
    expect(persisted.diagram.draft).toContain("title: Edited flow");
    expect(persisted.diagram.source).toBe(SOURCE);

    await page.getByRole("button", { name: "Revert to the original" }).click();
    await page.waitForFunction(() => document.querySelector(".dv-title-main")?.textContent === "Request lifecycle");
    expect(await page.locator(".dv-bar .dv-badge").count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator(".dv-viewport").focus();
    await page.keyboard.press("s");
    expect(await editor.count()).toBe(0);
  });

  it("switches to a light canvas and redraws the diagram for it", async () => {
    const darkSvg = await page.locator(".dv-content").innerHTML();
    await page.keyboard.press("t");
    await page.waitForFunction((previous) => document.querySelector(".dv-content")?.innerHTML !== previous, darkSvg);
    expect(await page.locator(".dv-root").getAttribute("data-theme")).toBe("light");
    await page.keyboard.press("t");
    await page.waitForFunction(() => document.querySelector(".dv-root")?.getAttribute("data-theme") === "dark");
  });

  it("exports a standalone SVG with explicit size and the font embedded", async () => {
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: /^SVG\s*\.svg$/ }).click();
    const [save] = await messages("diagram_save") as Array<{ format: string; fileName: string; data: string }>;
    expect(save).toMatchObject({ format: "svg", fileName: "request-lifecycle.svg" });
    expect(save!.data).toMatch(/^<\?xml/);
    expect(save!.data).toMatch(/<svg[^>]* width="\d+"[^>]* height="\d+"/);
    if (font) expect(save!.data).toContain("@font-face");
    const wellFormed = await page.evaluate((markup) => !new DOMParser().parseFromString(markup, "image/svg+xml").querySelector("parsererror"), save!.data);
    expect(wellFormed).toBe(true);
  });

  it("exports a real PNG at twice the diagram's size", async () => {
    await page.evaluate(() => { (window as unknown as FixtureWindow).__messages.length = 0; });
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: /^PNG\s*2× \.png$/ }).click();
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__messages.some((m) => m.type === "diagram_save"), undefined, { timeout: 15_000 });
    const [save] = await messages("diagram_save") as Array<{ format: string; data: string }>;
    expect(save!.format).toBe("png");
    const bytes = Buffer.from(save!.data, "base64");
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    const width = bytes.readUInt32BE(16);
    const diagramWidth = await page.evaluate(() => document.querySelector(".dv-content svg")!.viewBox.baseVal.width);
    expect(width).toBe(Math.round(Math.ceil(diagramWidth) * 2));
  });

  it("lists its shortcuts on ?", async () => {
    await page.locator(".dv-viewport").focus();
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard and mouse shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog").count()).toBe(0);
  });

  it("restores an edit and a theme from persisted state, as after a window reload", async () => {
    const draft = SOURCE.replace("title: Request lifecycle", "title: Restored edit");
    const restored = await openViewer({ diagram: { source: SOURCE, draft, theme: "light", showSource: false, showMinimap: true, sourceWidth: 380 } });
    await restored.waitForFunction(() => document.querySelector(".dv-title-main")?.textContent === "Restored edit");
    expect(await restored.locator(".dv-root").getAttribute("data-theme")).toBe("light");
    expect(await restored.evaluate(() => (window as unknown as FixtureWindow).__violations)).toEqual([]);
    await restored.close();
  });

  /* Every entry receives the same combined CSS, and whether the palette's font tokens or
     Tailwind's self-referencing @theme copies of them win depends on how Vite happens to split
     and name the CSS chunks. Adding this entry once flipped that and dropped Lexend everywhere. */
  it("resolves the panel's font tokens rather than Tailwind's self-referencing ones", async () => {
    const fonts = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return { sans: root.getPropertyValue("--font-sans"), mono: root.getPropertyValue("--font-mono") };
    });
    expect(fonts.sans).toContain("Lexend");
    expect(fonts.mono).toContain("Cascadia Code");
  });

  it("offers to keep an unsaved diagram with the project", async () => {
    const fresh = await openViewer();
    await fresh.getByRole("button", { name: /Save to this project/ }).click();
    expect(await messages("diagram_save_to_project", fresh)).toEqual([{ type: "diagram_save_to_project", source: SOURCE }]);
    // It saves what is on screen, edits included.
    await fresh.keyboard.press("s");
    await fresh.getByLabel("Mermaid source").fill(`${SOURCE}
  F --> G`);
    await fresh.getByRole("button", { name: /Save to this project/ }).click();
    expect((await messages("diagram_save_to_project", fresh)).at(-1)).toMatchObject({ source: `${SOURCE}
  F --> G` });
    await fresh.close();
  });

  const FILE = { name: "request-flow.mmd", path: ".blacksite/context/diagrams/request-flow.mmd" };

  describe("a tab that follows a saved diagram", () => {
    it("names its file, and saves only when there is something to save", async () => {
      const saved = await openViewer(null, FILE);
      expect(await saved.locator(".dv-title-kind", { hasText: "request-flow.mmd" }).getAttribute("title")).toBe(FILE.path);
      const save = saved.getByRole("button", { name: /up to date/ });
      expect(await save.isDisabled()).toBe(true);
      expect(await saved.getByRole("button", { name: /Save to this project/ }).count()).toBe(0);

      await saved.keyboard.press("s");
      await saved.getByLabel("Mermaid source").fill(`${SOURCE}
  F --> G`);
      const dirty = saved.getByRole("button", { name: "Save your changes to request-flow.mmd" });
      expect(await dirty.isEnabled()).toBe(true);
      await dirty.click();
      expect(await messages("diagram_write", saved)).toEqual([{ type: "diagram_write", source: `${SOURCE}
  F --> G` }]);
      await saved.close();
    });

    it("saves on Ctrl+S, including from inside the source editor, and only when edited", async () => {
      const saved = await openViewer(null, FILE);
      await saved.keyboard.press("Control+s");
      expect(await messages("diagram_write", saved)).toEqual([]);
      await saved.keyboard.press("s");
      const editor = saved.getByLabel("Mermaid source");
      await editor.fill(`${SOURCE}
  F --> G`);
      await editor.press("Control+s");
      expect(await messages("diagram_write", saved)).toHaveLength(1);
      await saved.close();
    });

    it("redraws when the file changes, keeping the zoom and pan the reader chose", async () => {
      const saved = await openViewer(null, FILE);
      await saved.locator(".dv-viewport").focus();
      await saved.keyboard.press("2");
      await saved.waitForTimeout(300);
      const before = await transform(saved);
      expect(before.scale).toBeCloseTo(2, 2);

      const updated = SOURCE.replace("Final answer", "Final answer, revised");
      await saved.evaluate((source) => window.postMessage({ type: "diagram_update", source, file: { name: "request-flow.mmd", path: ".blacksite/context/diagrams/request-flow.mmd" } }, "*"), updated);
      await saved.waitForFunction(() => document.querySelector(".dv-content")?.textContent?.includes("Final answer, revised"));
      const after = await transform(saved);
      expect(after.scale).toBeCloseTo(2, 2);
      expect(await saved.locator(".dv-bar .dv-badge").count()).toBe(0);
      await saved.close();
    });

    it("keeps an unsaved edit through an update, and says so", async () => {
      const saved = await openViewer(null, FILE);
      await saved.keyboard.press("s");
      const mine = SOURCE.replace("title: Request lifecycle", "title: My edit");
      await saved.getByLabel("Mermaid source").fill(mine);
      await saved.waitForFunction(() => document.querySelector(".dv-title-main")?.textContent === "My edit");

      await saved.evaluate((source) => window.postMessage({ type: "diagram_update", source, file: { name: "request-flow.mmd", path: ".blacksite/context/diagrams/request-flow.mmd" } }, "*"), SOURCE.replace("User message", "Agent changed this"));
      await saved.getByText("Your edit is kept").waitFor();
      expect(await saved.getByLabel("Mermaid source").inputValue()).toBe(mine);
      expect(await saved.locator(".dv-bar .dv-badge").textContent()).toBe("Edited");

      // Reverting loads the new saved version.
      await saved.getByRole("button", { name: "Revert to the original" }).click();
      await saved.waitForFunction(() => document.querySelector(".dv-content")?.textContent?.includes("Agent changed this"));
      await saved.close();
    });

    it("takes the saved version when its own edit is the one that was just saved", async () => {
      const saved = await openViewer(null, FILE);
      await saved.keyboard.press("s");
      const mine = SOURCE.replace("title: Request lifecycle", "title: My edit");
      await saved.getByLabel("Mermaid source").fill(mine);
      await saved.evaluate((source) => window.postMessage({ type: "diagram_update", source, file: { name: "request-flow.mmd", path: ".blacksite/context/diagrams/request-flow.mmd" } }, "*"), mine);
      await saved.waitForFunction(() => document.querySelectorAll(".dv-bar .dv-badge").length === 0);
      expect(await saved.getByRole("button", { name: /up to date/ }).isDisabled()).toBe(true);
      await saved.close();
    });
  });

  it("does all of it without a CSP violation", async () => {
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).__violations)).toEqual([]);
  });
});
