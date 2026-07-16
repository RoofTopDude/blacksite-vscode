import { useEffect, useRef, useState } from "react";
import type { QCardOption } from "@/lib/protocol";

type Preview = NonNullable<QCardOption["preview"]>;

const DEFAULT_HEIGHT = 160;

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

/** Builds the iframe document for a question-card preview. Ported verbatim from
 *  the legacy webview — injects the preview code as an inline ES module.
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
    : "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}</style>" +
      "</head><body></body></html>";
  const script = buildErrorReporter(nonce) + "\n" + OPEN + "\n" + (preview.code || "") + "\n" + CLOSE;
  const closeHead = base.search(/<\/head\s*>/i);
  return closeHead >= 0 ? base.slice(0, closeHead) + script + base.slice(closeHead) : base + script;
}

type Status = "loading" | "loaded" | "error";

/** Runs a question-card preview inside a sandboxed blob-URL iframe.
 *  blob: + sandbox="allow-scripts" is covered by the webview CSP `frame-src blob:`
 *  and isolates untrusted preview code from the extension host. */
export function SandboxPreview({ preview }: { preview: Preview }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const height = preview.height && preview.height > 0 ? preview.height : DEFAULT_HEIGHT;

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
    iframe.style.height = `${height}px`;
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
  }, [preview, height]);

  return (
    <div className="relative mt-1.5" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      {status === "loading" && (
        <div className="qcard-preview-skeleton absolute inset-0 flex items-center justify-center rounded-md" style={{ height }}>
          <span className="pulse-dot" />
        </div>
      )}
      {status === "error" && (
        <div className="qcard-preview-error absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md px-3 text-center" style={{ height }}>
          <span className="text-sm font-medium text-destructive">Preview failed to render</span>
          {errorMessage && <span className="max-w-full truncate text-xs text-muted-foreground">{errorMessage}</span>}
        </div>
      )}
    </div>
  );
}
