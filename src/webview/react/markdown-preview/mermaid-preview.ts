/* Draws Mermaid fences in VS Code's own Markdown preview, where VS Code has no renderer of its
 * own (see src/diagrams/markdown-preview-mermaid.ts, which marks the fences).
 *
 * Not part of the React apps: VS Code loads this into *every* Markdown preview through the
 * markdown.previewScripts contribution, as a classic <script async nonce=…>. So it stays
 * small and does nothing until it finds a marked fence. Only then does it load Mermaid —
 * the library's standalone build, staged next to this file by esbuild.mjs — by adding a
 * script tag carrying this script's own nonce, which is the one thing the preview's
 * `script-src 'nonce-…'` policy will run.
 *
 * Built by esbuild.mjs into out/markdown-preview/, not by Vite.
 */

import { MERMAID_SECURITY_CONFIG } from "../../../shared/mermaid-security";

interface MermaidApi {
  initialize(config: object): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

declare global {
  interface Window { mermaid?: MermaidApi }
}

const MARKER = "blacksite-mermaid";
const DIAGRAM_CLASS = "blacksite-mermaid-diagram";

// Captured while this script is executing; document.currentScript is null afterwards.
const thisScript = document.currentScript as HTMLScriptElement | null;
const nonce = thisScript?.nonce ?? "";
const libraryUrl = thisScript?.src ? new URL("mermaid.min.js", thisScript.src).toString() : "";

let library: Promise<MermaidApi> | null = null;

function loadLibrary(): Promise<MermaidApi> {
  library ??= new Promise<MermaidApi>((resolve, reject) => {
    if (window.mermaid) { resolve(window.mermaid); return; }
    if (!libraryUrl) { reject(new Error("The Mermaid renderer could not be located.")); return; }
    const tag = document.createElement("script");
    tag.src = libraryUrl;
    tag.nonce = nonce;
    tag.async = true;
    tag.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("The Mermaid renderer did not load.")));
    tag.onerror = () => reject(new Error("The Mermaid renderer did not load."));
    document.head.appendChild(tag);
  }).catch((error: unknown) => {
    library = null;
    throw error;
  });
  return library;
}

/** The preview follows the editor theme, unlike Blacksite's own panels. */
function editorTheme(): "dark" | "default" {
  const classes = document.body.classList;
  const dark = classes.contains("vscode-dark")
    || (classes.contains("vscode-high-contrast") && !classes.contains("vscode-high-contrast-light"));
  return dark ? "dark" : "default";
}

function describeError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? "")).trim();
  if (!message) return "Mermaid could not parse this diagram.";
  return message.length > 600 ? `${message.slice(0, 600)}…` : message;
}

/* Keyed by theme and source. The preview re-renders its whole body on every edit to the
   document, and re-running layout for each unchanged diagram on each keystroke is waste. */
const drawn = new Map<string, { svg: string } | { error: string }>();
const DRAWN_LIMIT = 64;
let configuredTheme = "";
let generation = 0;
let sequence = 0;

function slotFor(block: HTMLElement): HTMLElement {
  const existing = block.querySelector<HTMLElement>(`:scope > .${DIAGRAM_CLASS}`);
  if (existing) return existing;
  const slot = document.createElement("div");
  slot.className = DIAGRAM_CLASS;
  block.insertBefore(slot, block.firstChild);
  return slot;
}

function show(block: HTMLElement, result: { svg: string } | { error: string }): void {
  const slot = slotFor(block);
  if ("svg" in result) {
    slot.innerHTML = result.svg;
    block.classList.add("is-rendered");
    block.classList.remove("is-failed");
  } else {
    slot.textContent = result.error;
    block.classList.add("is-failed");
    block.classList.remove("is-rendered");
  }
}

async function renderAll(force = false): Promise<void> {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(`.${MARKER}`))
    .filter((block) => force || !block.classList.contains("is-rendered"));
  if (blocks.length === 0) return;
  const current = ++generation;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadLibrary();
  } catch (error) {
    for (const block of blocks) show(block, { error: describeError(error) });
    return;
  }

  const theme = editorTheme();
  if (configuredTheme !== theme) {
    mermaid.initialize({ ...MERMAID_SECURITY_CONFIG, theme, fontFamily: getComputedStyle(document.body).fontFamily });
    configuredTheme = theme;
  }

  for (const block of blocks) {
    // A newer pass (an edit, a theme change) owns the page now.
    if (current !== generation) return;
    const source = block.querySelector("pre")?.textContent ?? "";
    const key = `${theme}\n${source}`;
    let result = drawn.get(key);
    if (!result) {
      const id = `bs-preview-mermaid-${++sequence}`;
      try {
        result = { svg: (await mermaid.render(id, source)).svg };
      } catch (error) {
        result = { error: describeError(error) };
        document.getElementById(`d${id}`)?.remove();
      }
      if (drawn.size >= DRAWN_LIMIT) drawn.clear();
      drawn.set(key, result);
    }
    if (current !== generation || !block.isConnected) return;
    show(block, result);
  }
}

function start(): void {
  void renderAll();
  // VS Code swaps the preview body in place as the document is edited, and says so.
  window.addEventListener("vscode.markdown.updateContent", () => void renderAll());
  // A theme switch restyles the preview without reloading it; diagrams must follow.
  let theme = editorTheme();
  new MutationObserver(() => {
    const next = editorTheme();
    if (next === theme) return;
    theme = next;
    void renderAll(true);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

export {};
