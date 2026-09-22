import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { BrowserDispatchScope, BrowserRunner } from "./chromium-runner.js";
import { buildPreviewBaselineCss, buildPreviewDocument } from "./shared/preview-baseline.js";
import { buildCodePreview, buildMountPreview, type PreviewMount } from "./preview-build.js";

/**
 * Renders a candidate preview headlessly and hands the screenshot back to the agent.
 *
 * The other three parts of this change raise the *ceiling* on preview fidelity — the project's
 * stylesheet, its class inventory, and its real components are all reachable now. None of them
 * raise the *floor*, because the agent still authors previews blind: a preview is written once,
 * into a tool call, in a string literal, with no type-check and no look at the result. The only
 * feedback anyone gets is the user seeing "Preview failed to render". Under blind authorship the
 * risk-minimising move is simple markup that is trivially correct, which is the behaviour that
 * made previews look low-effort in the first place.
 *
 * Letting the agent render and *see* a preview before committing it to a question card converts
 * "capable of fidelity" into "reliably produces fidelity": mistakes become correctable instead of
 * user-visible, so there is no longer a reason to hedge.
 *
 * Deliberately reuses the same document builder as the two live surfaces — a rehearsal that
 * rendered differently from the real thing would be worse than no rehearsal.
 */

export interface PreviewRenderRequest {
  html?: string;
  code?: string;
  /** Workspace-relative dependency context for imports in `code`; useful in monorepos. */
  resolveFrom?: string;
  mount?: PreviewMount;
  /** Viewport for the render. Defaults match the inline chat frame so what the agent sees is what
   *  the user gets. */
  width?: number;
  height?: number;
  /** Milliseconds to settle before capturing, for previews with entry transitions. */
  settleMs?: number;
}

export interface PreviewRenderResult {
  ok: boolean;
  /** PNG data URL — extracted into a real vision block by the session before it reaches the model. */
  dataUrl?: string;
  error?: string;
  /** Uncaught errors the preview reported while rendering. */
  previewErrors?: string[];
  /** Non-empty when a mount build overlaid files. */
  patchedFiles?: string[];
  buildWarnings?: string[];
  width?: number;
  height?: number;
}

/** Matches SandboxPreview's inline frame. */
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 260;
const MAX_DIMENSION = 2000;
const MIN_DIMENSION = 120;
/** Enough for fonts to load and a mount bundle to hydrate, short enough not to stall a turn. */
const DEFAULT_SETTLE_MS = 350;
const MAX_SETTLE_MS = 3_000;

interface PreviewDocumentServer {
  url: string;
  scope: BrowserDispatchScope;
  close(): Promise<void>;
}

async function servePreviewDocument(document: string): Promise<PreviewDocumentServer> {
  const route = `/${randomBytes(18).toString("base64url")}`;
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== route) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Connection": "close",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "connect-src 'none'",
        "style-src 'unsafe-inline' data:",
        "font-src data: blob:",
        "img-src data: blob:",
        "media-src data: blob:",
        "worker-src blob:",
        "script-src 'unsafe-inline'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(document);
  });
  // A transport-level failure after listen() (a reset socket, EMFILE) emits "error" on the
  // server, and an "error" event with no listener throws — here, inside the extension host.
  server.on("error", () => { /* the render reports its own failure; never crash the host */ });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Preview server did not acquire a loopback port.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}${route}`,
    scope: { allowedOrigins: [origin], localOnly: true },
    // close() alone only stops accepting new connections and resolves once every existing socket
    // is gone — a browser that preconnected or kept the connection alive would hold the render
    // open until an idle timeout. The document has already been screenshotted by this point, so
    // tear the sockets down rather than waiting on the peer.
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.round(n), max));
}

/**
 * The theme values a live preview reads off the user's editor do not exist in a headless browser,
 * so the baseline is built against a dark VS Code default. The agent is checking layout, hierarchy
 * and state — none of which depend on the exact swatch — and every alias carries a literal
 * fallback, so an unresolved variable degrades to a sane colour rather than to nothing.
 */
const HEADLESS_THEME: Record<string, string> = {
  "--vscode-editor-background": "#1e1e1e",
  "--vscode-editor-foreground": "#d4d4d4",
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-focusBorder": "#007fd4",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-editorWidget-background": "#252526",
  "--vscode-button-background": "#0e639c",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-input-background": "#3c3c3c",
  "--vscode-editorError-foreground": "#f14c4c",
  "--vscode-editorWarning-foreground": "#cca700",
  "--vscode-charts-green": "#89d185",
  "--vscode-font-family": "system-ui, -apple-system, 'Segoe UI', sans-serif",
  "--vscode-editor-font-family": "ui-monospace, 'Cascadia Code', Menlo, monospace",
  "--vscode-font-size": "13px",
};

/**
 * Build, render, and capture. `projectCss` comes from resolvePreviewProjectCss so the rehearsal
 * carries the same design system the live surfaces do.
 */
export async function renderPreview(
  runner: BrowserRunner,
  request: PreviewRenderRequest,
  options: { workspaceRoot?: string; projectCss?: string; signal?: AbortSignal },
): Promise<PreviewRenderResult> {
  const width = clamp(request.width, DEFAULT_WIDTH, MIN_DIMENSION, MAX_DIMENSION);
  const height = clamp(request.height, DEFAULT_HEIGHT, MIN_DIMENSION, MAX_DIMENSION);
  const settleMs = clamp(request.settleMs, DEFAULT_SETTLE_MS, 0, MAX_SETTLE_MS);

  let code = request.code ?? "";
  let extraCss: string | undefined;
  let patchedFiles: string[] | undefined;
  let buildWarnings: string[] | undefined;

  if (request.mount) {
    const built = await buildMountPreview(options.workspaceRoot ?? "", request.mount);
    if (!built.ok) return { ok: false, error: built.error };
    code = built.code ?? "";
    extraCss = built.css;
    patchedFiles = built.patchedFiles;
    buildWarnings = built.warnings;
  } else if (code.trim()) {
    const built = await buildCodePreview(options.workspaceRoot ?? "", {
      code,
      resolveFrom: request.resolveFrom,
    });
    if (!built.ok) return { ok: false, error: built.error };
    code = built.code ?? "";
    extraCss = built.css;
    buildWarnings = built.warnings;
  }

  if (!code.trim()) return { ok: false, error: "Nothing to render: provide `code` or `mount`." };

  const projectCss = options.projectCss ?? "";
  const document = buildPreviewDocument({
    html: request.html,
    code,
    projectCss,
    baselineCss: buildPreviewBaselineCss((name) => HEADLESS_THEME[name] ?? "", !!projectCss),
    extraCss,
  });

  // The document routinely exceeds 240 KB once the project stylesheet and inlined fonts are in
  // it, which is past what data: navigation handles reliably. A short-lived, unguessable loopback
  // URL avoids granting file: access; its CSP and exact-origin scope contain model-authored code.
  let previewServer: PreviewDocumentServer | undefined;
  try {
    previewServer = await servePreviewDocument(document);
    const { url, scope } = previewServer;

    // The dedicated path: a fresh, exactly-sized context in a headless browser of its own, with no
    // approval prompts (the host wrote and serves this document) and no effect on the agent's own
    // browser session. See ChromiumRunner.renderDocument for why the dispatch route below is only
    // a fallback for runners that cannot do this.
    if (runner.renderDocument) {
      const rendered = await runner.renderDocument(
        { url, width, height, settleMs, inspect: "JSON.stringify(window.__previewErrors || [])" },
        options.signal,
      );
      const previewErrors = parseErrors({ result: rendered.inspected });
      if (!rendered.ok || !rendered.dataUrl) {
        return { ok: false, error: rendered.error ?? "Preview screenshot failed.", previewErrors };
      }
      return {
        ok: true,
        dataUrl: rendered.dataUrl,
        previewErrors: previewErrors.length ? previewErrors : undefined,
        patchedFiles: patchedFiles?.length ? patchedFiles : undefined,
        buildWarnings: buildWarnings?.length ? buildWarnings : undefined,
        width,
        height,
      };
    }

    // Sizing first, so the capture reflects the frame the preview will actually live in. A runner
    // that predates this action (or a remote bridge that lacks it) just reports failure and the
    // render proceeds at the default viewport — worth less, but not worth aborting over.
    await runner.dispatch("set_viewport", { width, height }, options.signal, scope).catch(() => undefined);

    const navigation = await runner.dispatch("navigate", { url }, options.signal, scope) as
      { ok?: boolean; error?: string } | null;
    if (navigation && navigation.ok === false) {
      return { ok: false, error: navigation.error ?? "Preview navigation failed." };
    }
    if (settleMs > 0) await runner.dispatch("wait", { timeoutMs: settleMs }, options.signal, scope);

    const errors = await runner.dispatch(
      "evaluate",
      { script: "JSON.stringify(window.__previewErrors || [])" },
      options.signal,
      scope,
    ) as { ok?: boolean; result?: unknown } | null;
    const previewErrors = parseErrors(errors);

    const shot = await runner.dispatch("screenshot", { fullPage: false }, options.signal, scope) as
      { ok?: boolean; dataUrl?: string; error?: string } | null;
    if (!shot || shot.ok === false || !shot.dataUrl) {
      return { ok: false, error: shot?.error ?? "Preview screenshot failed.", previewErrors };
    }

    return {
      ok: true,
      dataUrl: shot.dataUrl,
      previewErrors: previewErrors.length ? previewErrors : undefined,
      patchedFiles: patchedFiles?.length ? patchedFiles : undefined,
      buildWarnings: buildWarnings?.length ? buildWarnings : undefined,
      width,
      height,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await previewServer?.close().catch(() => undefined);
  }
}

/** ChromiumRunner returns `{ ok, result }`; a bridge implementation may use `value`. */
function parseErrors(result: { value?: unknown; result?: unknown } | null): string[] {
  const raw = result?.result ?? result?.value;
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 10) : [];
  } catch { return []; }
}
