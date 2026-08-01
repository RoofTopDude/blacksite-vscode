import { type CSSProperties } from "react";

/**
 * Status → tone. Covers plan/phase/step vocabularies and, since the Run Explorer renders these
 * too, the full nine-value `RunStatus` and seven-value `RunStepStatus` from src/runs/run-model.ts.
 *
 * Those run statuses used to fall through to the muted default, so a *succeeded* run and a
 * *cancelled* one were the same grey — the badge was carrying no signal at exactly the moment
 * someone scanning a run list needs it most.
 */
const STATUS_TONE: Record<string, string> = {
  // In flight
  active: "var(--s-info)", running: "var(--s-info)", in_progress: "var(--s-info)",
  validating: "var(--s-info)", created: "var(--s-info)",
  // Settled well
  completed: "var(--s-ok)", done: "var(--s-ok)", ok: "var(--s-ok)", succeeded: "var(--s-ok)", drained: "var(--s-ok)",
  // Settled badly
  blocked: "var(--s-err)", failed: "var(--s-err)", error: "var(--s-err)",
  // Settled, but not cleanly — a partial run left real side effects behind, so it must not read
  // as success, and a timeout is a failure the user may be able to do something about.
  partial: "var(--s-warn)", timed_out: "var(--s-warn)",
  // Waiting on someone
  pending: "var(--s-warn)", on_hold: "var(--s-warn)", awaiting_approval: "var(--s-warn)", parked: "var(--s-warn)", paused: "var(--s-warn)",
  // Never ran / deliberately stopped
  draft: "var(--muted-foreground)", cancelled: "var(--muted-foreground)", stopped: "var(--muted-foreground)", abandoned: "var(--muted-foreground)",
  skipped: "var(--muted-foreground)",
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
      className={`inline-flex items-center rounded-full border px-1.5 py-px text-xs font-semibold uppercase tracking-[0.05em] ${className || ""}`}
      style={style}
    >
      {status ? status.replace(/_/g, " ") : "—"}
    </span>
  );
}
