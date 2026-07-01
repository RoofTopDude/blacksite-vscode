/* Single source of truth for status presentation across the chat view.
   Before this module, four components (Overview, Inspector, ToolLog, Turn) each
   re-declared their own SIGNAL/pillStyle/statusStyle maps with slightly different
   vocabularies. Consolidating them keeps the status language consistent and makes
   the tone→color mapping unit-testable. Pure helpers carry no JSX; the two shared
   primitives (StatusPill, SignalDot) sit alongside them. */

import { type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ToolState } from "@/lib/format";

export type SignalTone = "idle" | "info" | "ok" | "warn" | "err";

/** Theme variable backing each tone. */
export const TONE_COLOR_VAR: Record<SignalTone, string> = {
  idle: "var(--muted-foreground)",
  info: "var(--s-info)",
  ok: "var(--s-ok)",
  warn: "var(--s-warn)",
  err: "var(--s-err)",
};

/** Tool-call lifecycle state → tone. */
export function toolStateTone(state: ToolState): SignalTone {
  switch (state) {
    case "ok": return "ok";
    case "fail": return "err";
    case "pending": return "warn";
    case "running": return "info";
    default: return "info";
  }
}

/** Assistant-turn chrome status class (see turnChrome) → tone. */
export function turnStatusTone(statusClass: string): SignalTone {
  switch (statusClass) {
    case "streaming": return "info";
    case "pending": return "warn";
    case "error": return "err";
    case "complete": return "ok";
    default: return "idle";
  }
}

/** Overview/compaction pill vocabulary (idle/live/wait/error/done) → tone. */
export function overviewTone(pillClass: string): SignalTone {
  switch (pillClass) {
    case "live": return "info";
    case "wait": return "warn";
    case "error": return "err";
    case "done": return "ok";
    default: return "idle";
  }
}

export function toneColor(tone: SignalTone): string {
  return TONE_COLOR_VAR[tone];
}

/** Foreground + tinted fill + border for a soft status pill. */
export function toneStyle(tone: SignalTone): CSSProperties {
  const c = TONE_COLOR_VAR[tone];
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${c} 28%, transparent)`,
  };
}

/** Soft, rounded status chip. Callers set the text size via className. */
export function StatusPill({ tone, children, className }: { tone: SignalTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px font-semibold leading-tight", className)}
      style={toneStyle(tone)}
    >
      {children}
    </span>
  );
}

/** Small solid tone dot, optionally pulsing while live. */
export function SignalDot({ tone, pulse, className }: { tone: SignalTone; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-block size-1.5 shrink-0 rounded-full", pulse && "signal-pulse", className)}
      style={{ background: toneColor(tone) }}
    />
  );
}
