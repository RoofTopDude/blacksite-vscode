import { useEffect } from "react";
import { X } from "lucide-react";
import { actions, useStore } from "@/lib/store";
import { SandboxPreview } from "./SandboxPreview";

/**
 * Full-page overlay for a question-card option preview — reached by SandboxPreview's own
 * expand button, its size-based auto-expand, or the agent's expandHint. Mirrors Lightbox's
 * shell (same z-50/backdrop/Escape/backdrop-click conventions) rather than introducing a new
 * modal pattern, just with a preview instead of an image.
 */
export function PreviewModal() {
  const store = useStore();
  const modal = store.previewModal;

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") actions.closePreviewModal(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  if (!modal) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={modal.label || "Preview"}
      onClick={(e) => { if (e.target === e.currentTarget) actions.closePreviewModal(); }}
      className="fade-in fixed inset-0 z-50 flex flex-col gap-2 bg-black/80 p-4 backdrop-blur-sm sm:p-8"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-white/85">{modal.label || "Preview"}</span>
        <button
          type="button"
          onClick={() => actions.closePreviewModal()}
          title="Close"
          className="chat-interactive inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-white/70 hover:border-white/15 hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="lightbox-media-in min-h-0 flex-1 overflow-hidden rounded-lg shadow-2xl">
        <SandboxPreview preview={modal.preview} label={modal.label} fullscreen />
      </div>
    </div>
  );
}
