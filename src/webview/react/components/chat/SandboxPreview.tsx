import { useEffect, useRef } from "react";
import type { QCardOption } from "@/lib/protocol";

type Preview = NonNullable<QCardOption["preview"]>;

/** Builds the iframe document for a question-card preview. Ported verbatim from
 *  the legacy webview — injects the preview code as an inline ES module. */
function buildPreviewHtml(preview: Preview): string {
  const OPEN = "<" + 'script type="module">';
  const CLOSE = "</" + "script>";
  const base = (preview.html && preview.html.trim())
    ? preview.html
    : "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}</style>" +
      "</head><body></body></html>";
  const script = OPEN + "\n" + (preview.code || "") + "\n" + CLOSE;
  const closeHead = base.search(/<\/head\s*>/i);
  return closeHead >= 0 ? base.slice(0, closeHead) + script + base.slice(closeHead) : base + script;
}

/** Runs a question-card preview inside a sandboxed blob-URL iframe.
 *  blob: + sandbox="allow-scripts" is covered by the webview CSP `frame-src blob:`
 *  and isolates untrusted preview code from the extension host. */
export function SandboxPreview({ preview }: { preview: Preview }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const html = buildPreviewHtml(preview);
    const blob = new Blob([html], { type: "text/html" });
    let blobUrl: string | null = URL.createObjectURL(blob);
    const iframe = document.createElement("iframe");
    iframe.className = "qcard-preview-frame";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = blobUrl;
    iframe.addEventListener("load", () => {
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    }, { once: true });
    container.appendChild(iframe);
    return () => {
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      iframe.remove();
    };
  }, [preview]);

  return <div ref={containerRef} className="mt-1.5" />;
}
