/* Per-file bookkeeping for the post-edit verification gate.

   ── Why per file ────────────────────────────────────────────────────────────
   The gate used to hold one status for the whole edit set. Any passing check marked every
   changed file verified, so a test run in one project "verified" edits in a sibling project it
   never touched, and a failing check marked every file failed. In a workspace holding many
   codebases that made the gate both too lenient and too noisy. Here each check settles only the
   files it actually covered, and the gate's status is derived from what is left.

   Pure functions over VerificationGateState, so the rules can be tested without a session. */

import type { VerificationGateState } from "../session-state.js";

export interface CheckCoverage {
  /** Outstanding files the check covered and found clean. */
  passed: readonly string[];
  /** Outstanding files the check covered and found failing. */
  failed: readonly string[];
  /** Outstanding files no checker covers: they stop being owed, but are not verified. */
  unchecked: readonly string[];
}

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** Files still owing a check. */
export function outstandingFiles(state: VerificationGateState): string[] {
  if (state.status !== "pending" && state.status !== "failed") return [];
  return state.pendingFiles ?? state.files;
}

/** Outstanding files whose last check failed, reading state saved before per-file tracking. */
export function failedFiles(state: VerificationGateState): string[] {
  if (state.failedFiles) return state.failedFiles;
  return state.status === "failed" ? outstandingFiles(state) : [];
}

/**
 * Apply a change to the edit set. Returns null when nothing is left owing a check (every change
 * netted out), so the caller can restore the state the episode started from.
 */
export function recordMutation(
  state: VerificationGateState,
  added: readonly string[],
  removed: readonly string[],
  now: number,
): VerificationGateState | null {
  const outstanding = outstandingFiles(state);
  const open = outstanding.length > 0;
  const gone = new Set(removed);
  const pending = unique([...outstanding.filter((file) => !gone.has(file)), ...added]);
  if (pending.length === 0) return null;
  const touched = new Set([...added, ...removed]);
  return {
    status: "pending",
    files: unique([...(open ? state.files : []).filter((file) => !gone.has(file)), ...added]),
    pendingFiles: pending,
    // A file changed again needs a fresh check: its earlier verdict no longer describes it.
    failedFiles: failedFiles(state).filter((file) => pending.includes(file) && !touched.has(file)),
    uncheckedFiles: (open ? state.uncheckedFiles ?? [] : []).filter((file) => !touched.has(file)),
    detail: "Changed files have not been checked after the latest mutation.",
    updatedAt: now,
  };
}

/**
 * Apply a check's result. Returns null when the check covered none of the outstanding files (a
 * test in another project, say): it says nothing about this edit set.
 */
export function recordCheck(
  state: VerificationGateState,
  coverage: CheckCoverage,
  method: string,
  detail: string,
  now: number,
): VerificationGateState | null {
  const outstanding = outstandingFiles(state);
  const owed = new Set(outstanding);
  const passed = coverage.passed.filter((file) => owed.has(file));
  const failed = coverage.failed.filter((file) => owed.has(file));
  const unchecked = coverage.unchecked.filter((file) => owed.has(file));
  if (passed.length + failed.length + unchecked.length === 0) return null;

  const cleared = new Set([...passed, ...unchecked]);
  const pending = outstanding.filter((file) => !cleared.has(file));
  const stillFailing = unique([
    ...failedFiles(state).filter((file) => pending.includes(file) && !passed.includes(file)),
    ...failed,
  ]);
  const uncheckedAll = unique([...(state.uncheckedFiles ?? []), ...unchecked]);
  const nothingVerified = state.files.length > 0 && state.files.every((file) => uncheckedAll.includes(file));
  const status: VerificationGateState["status"] = stillFailing.length > 0
    ? "failed"
    : pending.length > 0
      ? "pending"
      : nothingVerified ? "skipped" : "passed";
  return {
    ...state,
    status,
    pendingFiles: pending,
    failedFiles: stillFailing,
    uncheckedFiles: uncheckedAll,
    method,
    detail: status === "skipped" && failed.length === 0 && passed.length === 0
      ? `No checker covers ${uncheckedAll.join(", ")}; nothing was verified.`
      : detail,
    updatedAt: now,
  };
}

/** Drop files from the episode entirely (scratch files the session created and then deleted). */
export function withoutFiles(state: VerificationGateState, gone: readonly string[], now: number): VerificationGateState {
  const drop = new Set(gone);
  const keep = (files: readonly string[] | undefined): string[] | undefined => files?.filter((file) => !drop.has(file));
  return {
    ...state,
    files: state.files.filter((file) => !drop.has(file)),
    pendingFiles: keep(state.pendingFiles ?? (outstandingFiles(state).length > 0 ? state.files : undefined)),
    failedFiles: keep(state.failedFiles),
    uncheckedFiles: keep(state.uncheckedFiles),
    updatedAt: now,
  };
}
