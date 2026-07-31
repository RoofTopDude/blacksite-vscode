import { useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { actions } from "@/lib/store";
import type { QCardOption } from "@/lib/protocol";
import { buildPreviewBaselineCss } from "../../../../shared/preview-baseline";

type Preview = NonNullable<QCardOption["preview"]>;

/** 160px could not hold a realistic component, let alone a layout with a header and a row of
 *  controls, so previews were being authored down to whatever survived the frame. Kept under
 *  AUTO_EXPAND_HEIGHT so the new default still renders inline rather than immediately taking
 *  over the screen. */
const DEFAULT_HEIGHT = 260;
/** Inline previews taller than this auto-open the full-page modal on mount — past this size
 *  the fixed-height scroll frame does a preview a disservice, so don't wait for the agent to
 *  remember expandHint or the user to notice the expand button. */
const AUTO_EXPAND_HEIGHT = 320;

/**
 * The baseline stylesheet every preview starts from — see src/shared/preview-baseline.ts for why
 * it exists and why it is shared with the comparison panel rather than written twice.
 */
function buildPreviewBaseline(): string {
  if (typeof window === "undefined") return buildPreviewBaselineCss(() => "");
  const root = getComputedStyle(document.documentElement);
  return buildPreviewBaselineCss((name) => root.getPropertyValue(name));
}

/** Small bootstrap script (runs before the preview module) that reports uncaught
 *  errors back to the parent frame so the UI can show a fallback instead of a
 *  silently blank iframe. */
function buildErrorReporter(nonce: string): string {
  const body = [
    "window.addEventListener('error', function (e) {",
    "  parent.postMessage({ __qcardPreview: true, status: 'error', message: (e && e.message) || 'Script error' }, '*');",
    "});",
    "window.addEventListener('unhandledrejection', function (e) {",
    "  var r = e && e.reason;",
    "  parent.postMessage({ __qcardPreview: true, status: 'error', message: (r && r.message) || String(r) }, '*');",
    "});",
  ].join("\n");
  return `<script nonce="${nonce}">\n${body}\n</script>`;
}

/** Builds the iframe document for a question-card preview — the shared themed baseline, the
 *  error reporter, then the preview's own module.
 *
 *  blob: documents inherit the CSP of the context that created them (this webview's
 *  `script-src 'nonce-...'`), so the injected script needs the same nonce or it is
 *  silently blocked and the iframe renders blank. */
function buildPreviewHtml(preview: Preview): string {
  const nonce = (window as unknown as { __CSP_NONCE__?: string }).__CSP_NONCE__ ?? "";
  const OPEN = "<" + `script type="module" nonce="${nonce}">`;
  const CLOSE = "</" + "script>";
  const base = (preview.html && preview.html.trim())
    ? preview.html
    : "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
  // The baseline goes in ahead of the preview's own markup and script, so a custom `html` shell
  // inherits the theme too and anything it declares still wins on order.
  const injected = `<style>${buildPreviewBaseline()}</style>`
    + buildErrorReporter(nonce) + "\n" + OPEN + "\n" + (preview.code || "") + "\n" + CLOSE;
  const closeHead = base.search(/<\/head\s*>/i);
  return closeHead >= 0 ? base.slice(0, closeHead) + injected + base.slice(closeHead) : base + injected;
}

type Status = "loading" | "loaded" | "error";

/**
 * Runs a question-card preview inside a sandboxed blob-URL iframe.
 * blob: + sandbox="allow-scripts" is covered by the webview CSP `frame-src blob:`
 * and isolates untrusted preview code from the extension host.
 *
 * Always carries a manual expand affordance into the full-page PreviewModal, and — beyond
 * the agent's own discretion via `preview.expandHint` — auto-opens that modal itself once on
 * mount for anything tall enough that the inline frame would shortchange it. `fullscreen`
 * renders the same preview at container-filling size instead of a fixed inline height; it's
 * how PreviewModal reuses this component rather than duplicating the iframe/CSP plumbing.
 */
export function SandboxPreview({ preview, label, fullscreen = false }: { preview: Preview; label?: string; fullscreen?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const configuredHeight = preview.height && preview.height > 0 ? preview.height : DEFAULT_HEIGHT;
  const autoExpandedRef = useRef(false);

  useEffect(() => {
    if (fullscreen || autoExpandedRef.current) return;
    if (preview.expandHint || configuredHeight > AUTO_EXPAND_HEIGHT) {
      autoExpandedRef.current = true;
      actions.openPreviewModal(label || "Preview", preview);
    }
    // Auto-expand is a one-time "on arrival" decision, not something later re-renders should redo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setStatus("loading");
    setErrorMessage(null);

    const html = buildPreviewHtml(preview);
    const blob = new Blob([html], { type: "text/html" });
    let blobUrl: string | null = URL.createObjectURL(blob);
    const iframe = document.createElement("iframe");
    iframe.className = "qcard-preview-frame";
    iframe.style.height = fullscreen ? "100%" : `${configuredHeight}px`;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = blobUrl;

    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const data = e.data as { __qcardPreview?: boolean; status?: string; message?: string } | null;
      if (!data || !data.__qcardPreview) return;
      if (data.status === "error") { setStatus("error"); setErrorMessage(data.message ?? "Preview failed to render."); }
    };
    window.addEventListener("message", onMessage);

    iframe.addEventListener("load", () => {
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      setStatus((s) => (s === "error" ? s : "loaded"));
    }, { once: true });

    container.appendChild(iframe);
    return () => {
      window.removeEventListener("message", onMessage);
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      iframe.remove();
    };
  }, [preview, configuredHeight, fullscreen]);

  return (
    <div className={fullscreen ? "relative size-full" : "relative mt-1.5"} style={fullscreen ? undefined : { height: configuredHeight }}>
      <div ref={containerRef} className="absolute inset-0" />
      {!fullscreen && (
        <button
          type="button"
          onClick={() => actions.openPreviewModal(label || "Preview", preview)}
          title="Expand to full view"
          className="chat-interactive absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md border border-white/10 bg-black/45 text-white/80 backdrop-blur-sm hover:border-white/25 hover:bg-black/65 hover:text-white"
        >
          <Maximize2 className="size-3.5" />
        </button>
      )}
      {status === "loading" && (
        <div className="qcard-preview-skeleton absolute inset-0 flex items-center justify-center rounded-md">
          <span className="pulse-dot" />
        </div>
      )}
      {status === "error" && (
        <div className="qcard-preview-error absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md px-3 text-center">
          <span className="text-sm font-medium text-destructive">Preview failed to render</span>
          {errorMessage && <span className="max-w-full truncate text-xs text-muted-foreground">{errorMessage}</span>}
        </div>
      )}
    </div>
  );
}
