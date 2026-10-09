/* One vocabulary for what a status looks like.

   The chat's status pills (signal.tsx) and every panel's status badges (status-badge.tsx) each
   kept their own table, and they disagreed about small things — what "paused" meant, whether
   "blocked" was a warning or an error — so the same word could be amber in the chat and red in the
   Plans panel. Both now read this table. A tone is a meaning, not a colour: idle is "nothing to
   say", info is "in progress", ok is "went well", warn is "waiting on someone or not clean", err is
   "failed or stuck". */

export type SignalTone = "idle" | "info" | "ok" | "warn" | "err";

/** Theme variable backing each tone. */
export const TONE_COLOR_VAR: Record<SignalTone, string> = {
  idle: "var(--muted-foreground)",
  info: "var(--s-info)",
  ok: "var(--s-ok)",
  warn: "var(--s-warn)",
  err: "var(--s-err)",
};

const STATUS_TONES: Record<string, SignalTone> = {
  // In flight
  active: "info", running: "info", in_progress: "info", validating: "info", created: "info", working: "info", live: "info",
  // Settled well
  completed: "ok", done: "ok", ok: "ok", succeeded: "ok", drained: "ok", complete: "ok",
  // Settled badly
  blocked: "err", failed: "err", error: "err", budget_exhausted: "err",
  // Settled, but not cleanly — a partial run left real side effects behind, so it must not read
  // as success, and a timeout is a failure the user may be able to do something about.
  partial: "warn", timed_out: "warn",
  // Waiting on someone. A paused run does not move until a person resumes it, which is the same
  // thing as waiting, and is why it is not drawn as neutral.
  pending: "warn", on_hold: "warn", awaiting_approval: "warn", parked: "warn", paused: "warn",
  needs_you: "warn", waiting_user: "warn", waiting_provider: "warn", interrupted: "warn", quiet: "warn", limit: "warn",
  // Never ran / deliberately stopped
  draft: "idle", cancelled: "idle", stopped: "idle", abandoned: "idle", skipped: "idle", idle: "idle",
};

export function toneOfStatus(status: string | undefined): SignalTone {
  return STATUS_TONES[(status ?? "").toLowerCase()] ?? "idle";
}
