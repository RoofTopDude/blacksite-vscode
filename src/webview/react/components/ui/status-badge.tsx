import { type CSSProperties } from "react";

const STATUS_TONE: Record<string, string> = {
  active: "var(--s-info)", running: "var(--s-info)", in_progress: "var(--s-info)",
  completed: "var(--s-ok)", done: "var(--s-ok)", ok: "var(--s-ok)",
  blocked: "var(--s-err)", failed: "var(--s-err)", error: "var(--s-err)",
  pending: "var(--s-warn)", on_hold: "var(--s-warn)",
  draft: "var(--muted-foreground)", cancelled: "var(--muted-foreground)",
};

/** Pill that color-codes a plan/phase/step/run status. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONE[status?.toLowerCase()] || "var(--muted-foreground)";
  const style: CSSProperties = {
    color: tone,
    background: `color-mix(in srgb, ${tone} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${tone} 28%, transparent)`,
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.05em] ${className || ""}`}
      style={style}
    >
      {status ? status.replace(/_/g, " ") : "—"}
    </span>
  );
}
