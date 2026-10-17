/**
 * Detects false progress (#20): rounds that change something but bring the task no closer.
 *
 * The duplicate-round detector in AgentSession catches the plainest loop: the same calls getting
 * the same results, back to back. This catches the ones it cannot, because each round differs on
 * the surface:
 *
 *  - repeated_failure: the same tests fail the same way run after run, with edits in between. The
 *    edits are not reaching the failure.
 *  - verification_stagnation: the failures change, but the count of them never goes down across
 *    several runs with edits in between.
 *  - repeated_edit: the same change is applied to a file again and again, or applied and undone
 *    (A to B, then B to A).
 *  - repeated_read: the same read returns the same content several times while nothing edits the
 *    file in between.
 *
 * It reads what the host saw (tool inputs and results), never the model's account, and never
 * token counts. Every signal carries its evidence and a note on when it would be a false positive.
 * Each fires once for the pattern it saw and again only if that pattern starts over.
 *
 * Pure and bounded: per-session state is a few small maps, capped below.
 */

import type { ToolResultBlock, ToolUseBlock } from "@blacksite-agent/llm";
import { inputFingerprint, resultContent, resultFingerprint } from "./tool-round-fingerprint.js";

export interface ProgressThresholds {
  /** Check runs in a row failing identically, with edits between, before repeated_failure. */
  repeatedFailure: number;
  /** Failing check runs in a row whose failure count never drops, with edits between. */
  stagnation: number;
  /** Times one edit (or it and its undo) is applied to a file before repeated_edit. */
  repeatedEdit: number;
  /** Identical reads of an unchanged file before repeated_read. */
  repeatedRead: number;
}

/** Conservative on purpose: a real fix often takes two or three tries. */
export const DEFAULT_PROGRESS_THRESHOLDS: Readonly<ProgressThresholds> = Object.freeze({
  repeatedFailure: 3,
  stagnation: 5,
  repeatedEdit: 3,
  repeatedRead: 4,
});

const LIMITS: Readonly<Record<keyof ProgressThresholds, [number, number]>> = {
  repeatedFailure: [2, 20],
  stagnation: [3, 30],
  repeatedEdit: [2, 20],
  repeatedRead: [2, 30],
};

/** Read thresholds from settings, keeping every value in range and defaulting anything else. */
export function resolveProgressThresholds(raw: unknown): ProgressThresholds {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out = { ...DEFAULT_PROGRESS_THRESHOLDS };
  for (const key of Object.keys(LIMITS) as Array<keyof ProgressThresholds>) {
    const value = Number(source[key]);
    const [min, max] = LIMITS[key];
    if (Number.isInteger(value)) out[key] = Math.min(Math.max(value, min), max);
  }
  return out;
}

export type ProgressSignalKind = "repeated_failure" | "verification_stagnation" | "repeated_edit" | "repeated_read";

export interface ProgressSignal {
  kind: ProgressSignalKind;
  /** One sentence of what was seen, with the evidence. */
  detail: string;
  /** When this is not actually a problem. Shown with the signal so it can be dismissed sensibly. */
  falsePositive: string;
  /** Identifies the pattern, so the same one does not fire twice. */
  key: string;
}

export interface ProgressFacts {
  rounds: number;
  checks: number;
  edits: number;
  signals: Array<Pick<ProgressSignal, "kind" | "detail">>;
}

const CHECK_TOOLS = new Set(["test_run"]);
const EDIT_TOOLS = new Set(["file_edit", "file_edit_batch", "file_write", "json_edit"]);
const READ_TOOLS = new Set(["file_read"]);
const MAX_TRACKED = 200;
const MAX_SIGNALS = 12;

interface CheckOutcome { passed: boolean; failed: number; signature: string; sample: string[] }

function failureOf(content: ToolResultBlock["content"]): CheckOutcome | undefined {
  const value = resultContent(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  const failures = Array.isArray(result.failures) ? result.failures as Array<Record<string, unknown>> : [];
  const failed = Number(result.failed ?? failures.length);
  if (!Number.isFinite(failed)) return undefined;
  const passed = result.ok === true && failed === 0;
  const names = failures.map((item) => `${String(item.test ?? item.name ?? "")}: ${String(item.message ?? "")}`.trim()).sort();
  return { passed, failed, signature: names.join("\n"), sample: names.slice(0, 3) };
}

/** Tool results report failure in their own JSON (`ok: false`); there is no separate error flag. */
function failedResult(result: ToolResultBlock | undefined): boolean {
  const value = result ? resultContent(result.content) : undefined;
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).ok === false;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const candidate = input.path ?? input.file ?? input.filePath ?? input.target;
  return typeof candidate === "string" ? candidate.replace(/\\/g, "/") : undefined;
}

/** An edit and its undo share one key: the unordered pair of before and after text. */
function editKey(name: string, input: Record<string, unknown>): string {
  const before = typeof input.old_string === "string" ? input.old_string : typeof input.oldText === "string" ? input.oldText : undefined;
  const after = typeof input.new_string === "string" ? input.new_string : typeof input.newText === "string" ? input.newText : undefined;
  if (before !== undefined && after !== undefined) return inputFingerprint(name, [before, after].sort());
  return inputFingerprint(name, input);
}

function bounded<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value as K);
}

export class ProgressMonitor {
  private readonly _thresholds: ProgressThresholds;
  private _rounds = 0;
  private _checks = 0;
  private _edits = 0;
  private _editsSinceCheck = 0;
  /** Recent failing checks: their signature, failure count and the edits that came before each. */
  private _failing: Array<{ signature: string; failed: number; editsBefore: number; sample: string[] }> = [];
  private readonly _editCounts = new Map<string, { path: string; count: number }>();
  private readonly _reads = new Map<string, { result: string; count: number; path?: string }>();
  private readonly _fired = new Set<string>();
  private readonly _signals: ProgressSignal[] = [];

  constructor(thresholds: Partial<ProgressThresholds> = {}) {
    this._thresholds = { ...DEFAULT_PROGRESS_THRESHOLDS, ...thresholds };
  }

  /** Record one completed tool round. Returns the signals it raised, usually none. */
  observe(calls: readonly ToolUseBlock[], results: readonly ToolResultBlock[]): ProgressSignal[] {
    this._rounds += 1;
    const raised: ProgressSignal[] = [];
    calls.forEach((call, index) => {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const result = results[index];
      if (EDIT_TOOLS.has(call.name)) this._onEdit(call.name, input, result, raised);
      else if (CHECK_TOOLS.has(call.name) && result) this._onCheck(result, raised);
      else if (READ_TOOLS.has(call.name) && result && !failedResult(result)) this._onRead(call.name, input, result, raised);
    });
    return raised;
  }

  facts(): ProgressFacts {
    return {
      rounds: this._rounds,
      checks: this._checks,
      edits: this._edits,
      signals: this._signals.map(({ kind, detail }) => ({ kind, detail })),
    };
  }

  private _raise(signal: ProgressSignal, into: ProgressSignal[]): void {
    if (this._fired.has(signal.key) || this._signals.length >= MAX_SIGNALS) return;
    this._fired.add(signal.key);
    this._signals.push(signal);
    into.push(signal);
  }

  private _onEdit(name: string, input: Record<string, unknown>, result: ToolResultBlock | undefined, raised: ProgressSignal[]): void {
    // A refused or failed edit changed nothing, so it is neither progress nor repetition.
    if (failedResult(result)) return;
    this._edits += 1;
    this._editsSinceCheck += 1;
    const path = pathOf(input) ?? "(unnamed file)";
    // An edit changes what a read of that file should return.
    for (const [key, entry] of this._reads) if (entry.path === path) this._reads.delete(key);
    const key = `${path}\u0000${editKey(name, input)}`;
    const seen = this._editCounts.get(key) ?? { path, count: 0 };
    seen.count += 1;
    this._editCounts.set(key, seen);
    bounded(this._editCounts);
    if (seen.count >= this._thresholds.repeatedEdit) {
      this._raise({
        kind: "repeated_edit",
        key: `edit:${key}:${Math.floor(seen.count / this._thresholds.repeatedEdit)}`,
        detail: `The same change to ${path} has been applied ${seen.count} times (counting changes that undo it).`,
        falsePositive: "Expected when a file is regenerated on purpose, or a formatter rewrites it the same way each time.",
      }, raised);
    }
  }

  private _onCheck(result: ToolResultBlock, raised: ProgressSignal[]): void {
    const outcome = failureOf(result.content);
    if (!outcome) return;
    this._checks += 1;
    const editsBefore = this._editsSinceCheck;
    this._editsSinceCheck = 0;
    if (outcome.passed) {
      this._failing = [];
      return;
    }
    this._failing.push({ signature: outcome.signature, failed: outcome.failed, editsBefore, sample: outcome.sample });
    if (this._failing.length > this._thresholds.stagnation) this._failing.shift();

    // repeated_failure: the last N failing runs are identical, and edits came between them.
    const n = this._thresholds.repeatedFailure;
    const recent = this._failing.slice(-n);
    const editsBetween = recent.slice(1).reduce((sum, entry) => sum + entry.editsBefore, 0);
    if (recent.length === n && recent.every((entry) => entry.signature === recent[0]!.signature) && editsBetween > 0) {
      this._raise({
        kind: "repeated_failure",
        key: `failure:${recent[0]!.signature}`,
        detail: `${n} test runs in a row failed the same way (${recent[0]!.failed} failing${recent[0]!.sample.length ? `: ${recent[0]!.sample.join("; ")}` : ""}) despite ${editsBetween} edit(s) between them.`,
        falsePositive: "Expected while the edits are diagnostics (logging, a narrowed test) rather than attempted fixes.",
      }, raised);
      return;
    }

    // verification_stagnation: across the window, the failure count never went down.
    const window = this._failing;
    const edited = window.slice(1).reduce((sum, entry) => sum + entry.editsBefore, 0);
    if (window.length >= this._thresholds.stagnation && edited > 0
      && window.every((entry, index) => index === 0 || entry.failed >= window[index - 1]!.failed)) {
      this._raise({
        kind: "verification_stagnation",
        key: `stagnation:${this._checks}`,
        detail: `${window.length} test runs in a row have not reduced the number of failures (${window[0]!.failed} → ${window.at(-1)!.failed}) across ${edited} edit(s).`,
        falsePositive: "Expected when new tests are being added faster than old ones are fixed.",
      }, raised);
      this._failing = this._failing.slice(-1);
    }
  }

  private _onRead(name: string, input: Record<string, unknown>, result: ToolResultBlock, raised: ProgressSignal[]): void {
    const key = inputFingerprint(name, input);
    const fingerprint = resultFingerprint(result.content);
    const path = pathOf(input);
    const seen = this._reads.get(key);
    const entry = seen && seen.result === fingerprint ? { ...seen, count: seen.count + 1 } : { result: fingerprint, count: 1, ...(path ? { path } : {}) };
    this._reads.set(key, entry);
    bounded(this._reads);
    if (entry.count >= this._thresholds.repeatedRead) {
      this._raise({
        kind: "repeated_read",
        key: `read:${key}:${fingerprint}`,
        detail: `${path ?? "The same file"} was read ${entry.count} times with the same result and no edit to it in between.`,
        falsePositive: "Expected when the context was compacted and the file is being re-read to restore it.",
      }, raised);
    }
  }
}

/** The reminder an agent gets when a signal fires and the mode is "nudge". */
export function progressPrompt(signal: ProgressSignal): string {
  return [
    `[Progress check] ${signal.detail}`,
    "Repeating the same approach is unlikely to change the outcome. Before continuing, state what you now believe is wrong, then try something different: a different hypothesis, a narrower reproduction, or reading the code the failure points at.",
    `If the repetition is intentional (${signal.falsePositive.replace(/^Expected /, "for example, ").replace(/\.$/, "")}), say so in one sentence and continue.`,
  ].join("\n");
}
