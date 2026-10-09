import { type CSSProperties } from "react";
import { TONE_COLOR_VAR, toneOfStatus } from "@/lib/status-tone";

/**
 * Pill that colour-codes a plan/phase/step/run status.
 *
 * The status → tone table is shared with the chat's status pills (lib/status-tone.ts), so a word
 * means the same thing wherever it appears. It covers the plan/phase/step vocabularies and the
 * full `RunStatus` and `RunStepStatus` sets from src/runs/run-model.ts: those used to fall through
 * to the muted default, so a *succeeded* run and a *cancelled* one were the same grey.
 */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = TONE_COLOR_VAR[toneOfStatus(status)];
  const style: CSSProperties = {
    color: tone,
    background: `color-mix(in srgb, ${tone} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${tone} 28%, transparent)`,
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-1.5 py-px text-xs font-semibold uppercase tracking-[0.05em] ${className || ""}`}
      style={style}
    >
      {status ? status.replace(/_/g, " ") : "—"}
    </span>
  );
}
