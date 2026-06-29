import { useEffect } from "react";
import { X } from "lucide-react";
import { actions, useStore } from "@/lib/store";

export function Lightbox() {
  const store = useStore();
  const box = store.lightbox;

  useEffect(() => {
    if (!box) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") actions.closeLightbox(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [box]);

  if (!box) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={box.label || "Image preview"}
      onClick={(e) => { if (e.target === e.currentTarget) actions.closeLightbox(); }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/80 p-4"
    >
      <img src={box.dataUrl} alt={box.label || "Image preview"} className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-2xl" />
      <div className="text-[11px] text-white/80">{box.label || "Preview"}</div>
      <button type="button" onClick={() => actions.closeLightbox()} className="absolute right-3 top-3 text-2xl leading-none text-white/70 hover:text-white">
        <X className="size-5" />
      </button>
    </div>
  );
}
