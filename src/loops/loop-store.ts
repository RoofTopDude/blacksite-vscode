/**
 * Persistence for ticket loops, at `.blacksite/loops.json`.
 *
 * Follows the additive-schema discipline ticket-store.ts and planning-store.ts already use:
 * every field is optional on read with a defaulted normalization, so an older document reads
 * as a valid current one without a migration pass.
 *
 * Loops outlive the window, which is the whole point — a document here is the only record that
 * an unattended run happened at all, so writes are eager rather than batched.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  defaultApprovalPosture,
  defaultCeilings,
  defaultQueueSpec,
  emptyTotals,
  TERMINAL_LOOP_STATUSES,
  type LoopApprovalPosture,
  type LoopCeilings,
  type LoopDefinition,
  type LoopIteration,
  type LoopIterationOutcome,
  type LoopQueueSpec,
  type LoopRecord,
  type LoopStatus,
  type LoopTicketState,
  type LoopTotals,
  type LoopWorkerSpec,
} from "./loop-model.js";
import type { TicketComplexity, TicketPriority, TicketStatus } from "../ticket-store.js";

const BLACKSITE_DIR = ".blacksite";
const LOOPS_FILE = "loops.json";
const LOOPS_SCHEMA_VERSION = 1;

/** Iterations kept in full. Enough to read back a long run's recent history; bounded so an
 *  hours-long drain does not rewrite a megabyte of JSON on every lane. */
export const MAX_RETAINED_ITERATIONS = 300;

/** Concurrency the UI will not exceed. Not a performance limit — a blast-radius one. Eight
 *  lanes editing one workspace unattended is past the point where territory locking is the
 *  thing keeping you safe. */
export const MAX_LOOP_CONCURRENCY = 8;

export interface LoopDocument {
  schemaVersion: number;
  loops: LoopRecord[];
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function text(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const trimmed = text(item, 200);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalPositive(value: unknown, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), max);
}

const LOOP_STATUSES: ReadonlySet<string> = new Set<LoopStatus>([
  "draft", "running", "paused", "blocked", "drained", "stopped", "failed",
]);

const TICKET_STATUSES: ReadonlySet<string> = new Set<TicketStatus>([
  "triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled",
]);

const PRIORITIES: ReadonlySet<string> = new Set<TicketPriority>(["urgent", "high", "normal", "low"]);
const COMPLEXITIES: ReadonlySet<string> = new Set<TicketComplexity>(["small", "medium", "large"]);

const OUTCOMES: ReadonlySet<string> = new Set<LoopIterationOutcome>([
  "running", "succeeded", "failed", "parked", "abandoned", "cancelled",
]);

function normalizeQueue(value: unknown): LoopQueueSpec {
  const raw = (value ?? {}) as Record<string, unknown>;
  const base = defaultQueueSpec();
  const statuses = stringList(raw.statuses).filter((s): s is TicketStatus => TICKET_STATUSES.has(s));
  const priorities = stringList(raw.priorities).filter((p): p is TicketPriority => PRIORITIES.has(p));
  return {
    statuses: statuses.length ? statuses : base.statuses,
    labels: stringList(raw.labels),
    priorities,
    areas: stringList(raw.areas),
    ids: stringList(raw.ids, 500),
    respectBlockedBy: raw.respectBlockedBy !== false,
  };
}

function normalizeWorkers(value: unknown): LoopWorkerSpec {
  const raw = (value ?? {}) as Record<string, unknown>;
  const override = text(raw.complexityOverride, 20);
  return {
    concurrency: positiveInt(raw.concurrency, 1, 1, MAX_LOOP_CONCURRENCY),
    ...(text(raw.profileId, 80) ? { profileId: text(raw.profileId, 80) } : {}),
    ...(COMPLEXITIES.has(override) ? { complexityOverride: override as TicketComplexity } : {}),
  };
}

function normalizeCeilings(value: unknown): LoopCeilings {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    ...(optionalPositive(raw.maxTickets, 10_000) ? { maxTickets: optionalPositive(raw.maxTickets, 10_000) } : {}),
    // 7 days. Past that a "loop" is a standing process and wants a different conversation.
    ...(optionalPositive(raw.maxWallClockMs, 7 * 24 * 60 * 60 * 1000)
      ? { maxWallClockMs: optionalPositive(raw.maxWallClockMs, 7 * 24 * 60 * 60 * 1000) }
      : {}),
    ...(optionalPositive(raw.maxUsd, 100_000) ? { maxUsd: optionalPositive(raw.maxUsd, 100_000) } : {}),
    maxConsecutiveFailures: positiveInt(raw.maxConsecutiveFailures, defaultCeilings().maxConsecutiveFailures, 1, 50),
  };
}

function normalizeApprovals(value: unknown): LoopApprovalPosture {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    autoApproveTiers: stringList(raw.autoApproveTiers, 10),
    onGate: raw.onGate === "wait" ? "wait" : "park",
    notify: raw.notify !== false,
  };
}

function normalizeTicketState(value: unknown): LoopTicketState[] {
  if (!Array.isArray(value)) return [];
  const out: LoopTicketState[] = [];
  for (const item of value) {
    const raw = (item ?? {}) as Record<string, unknown>;
    const ticketId = text(raw.ticketId, 60);
    if (!ticketId) continue;
    out.push({
      ticketId,
      attempts: positiveInt(raw.attempts, 0, 0, 1000),
      ...(text(raw.parkedOnGate, 300) ? { parkedOnGate: text(raw.parkedOnGate, 300) } : {}),
      ...(text(raw.parkedAt, 40) ? { parkedAt: text(raw.parkedAt, 40) } : {}),
      ...(text(raw.parkedSubRequestId, 80) ? { parkedSubRequestId: text(raw.parkedSubRequestId, 80) } : {}),
      touchedFiles: stringList(raw.touchedFiles, 200),
    });
  }
  return out;
}

function normalizeTotals(value: unknown): LoopTotals | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number => {
    const parsed = Number(raw[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const totals: LoopTotals = {
    dispatched: num("dispatched"),
    succeeded: num("succeeded"),
    failed: num("failed"),
    parked: num("parked"),
    usd: num("usd"),
    consecutiveFailures: num("consecutiveFailures"),
  };
  return totals.dispatched > 0 ? totals : undefined;
}

function normalizeIterations(value: unknown, loopId: string): LoopIteration[] {
  if (!Array.isArray(value)) return [];
  const out: LoopIteration[] = [];
  for (const item of value) {
    const raw = (item ?? {}) as Record<string, unknown>;
    const ticketId = text(raw.ticketId, 60);
    if (!ticketId) continue;
    const outcome = text(raw.outcome, 20);
    out.push({
      loopId,
      ticketId,
      seq: positiveInt(raw.seq, out.length + 1, 1, Number.MAX_SAFE_INTEGER),
      ...(text(raw.laneId, 80) ? { laneId: text(raw.laneId, 80) } : {}),
      ...(text(raw.subRequestId, 80) ? { subRequestId: text(raw.subRequestId, 80) } : {}),
      runIds: stringList(raw.runIds, 50),
      outcome: (OUTCOMES.has(outcome) ? outcome : "failed") as LoopIterationOutcome,
      detail: text(raw.detail, 2000),
      startedAt: text(raw.startedAt, 40) || nowIso(),
      ...(text(raw.endedAt, 40) ? { endedAt: text(raw.endedAt, 40) } : {}),
      ...(Number.isFinite(Number(raw.usd)) ? { usd: Number(raw.usd) } : {}),
    });
  }
  return out;
}

function addTotals(into: LoopTotals, from: LoopTotals): LoopTotals {
  into.dispatched += from.dispatched;
  into.succeeded += from.succeeded;
  into.failed += from.failed;
  into.parked += from.parked;
  into.usd += from.usd;
  // Deliberately not summed: a run of failures is only "consecutive" if nothing succeeded
  // since, and the retained window is what knows that. Carrying the retired streak forward
  // only when the window has no verdict of its own keeps the ceiling honest across a trim.
  return into;
}

function foldTotals(iterations: readonly LoopIteration[], retired?: LoopTotals): LoopTotals {
  const totals = emptyTotals();
  for (const iteration of iterations) {
    totals.dispatched += 1;
    totals.usd += iteration.usd ?? 0;
    // An iteration still in flight has no verdict yet. Folding it either way would be a guess,
    // and guessing "failure" would let a loop stop itself simply for being busy.
    if (iteration.outcome === "running") continue;
    if (iteration.outcome === "succeeded") {
      totals.succeeded += 1;
      totals.consecutiveFailures = 0;
    } else if (iteration.outcome === "failed" || iteration.outcome === "abandoned") {
      totals.failed += 1;
      totals.consecutiveFailures += 1;
    } else if (iteration.outcome === "parked") {
      totals.parked += 1;
      // A park says nothing about whether the work is failing, so it must not count toward
      // the consecutive-failure ceiling — nor reset it.
    }
  }
  if (!retired) return totals;
  const settledInWindow = iterations.some((entry) => entry.outcome === "succeeded" || entry.outcome === "failed" || entry.outcome === "abandoned");
  const carried = settledInWindow ? totals.consecutiveFailures : retired.consecutiveFailures + totals.consecutiveFailures;
  const merged = addTotals(totals, retired);
  merged.consecutiveFailures = carried;
  return merged;
}

/** Drop the oldest iterations past the retention window, folding their arithmetic into
 *  `retired` so no total is lost by the trim. */
function trimIterations(record: LoopRecord): void {
  if (record.iterations.length <= MAX_RETAINED_ITERATIONS) return;
  const overflow = record.iterations.slice(0, record.iterations.length - MAX_RETAINED_ITERATIONS);
  record.iterations = record.iterations.slice(overflow.length);
  const retired = record.retired ?? emptyTotals();
  record.retired = addTotals(retired, foldTotals(overflow));
}

function normalizeRecord(value: unknown, index: number): LoopRecord | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const rawDefinition = (raw.definition ?? {}) as Record<string, unknown>;
  const id = text(rawDefinition.id, 60) || `loop_${index + 1}`;
  const title = text(rawDefinition.title, 200);
  if (!title) return null;

  const status = text(rawDefinition.status, 20);
  const definition: LoopDefinition = {
    id,
    title,
    // `running` survives the read, because it is the evidence that the host died mid-loop —
    // erasing it here would hide exactly the state LoopSupervisor.restore needs to find in
    // order to reconcile the abandoned lanes and pause the loop.
    status: (LOOP_STATUSES.has(status) ? status : "draft") as LoopStatus,
    queue: normalizeQueue(rawDefinition.queue),
    workers: normalizeWorkers(rawDefinition.workers),
    ceilings: normalizeCeilings(rawDefinition.ceilings),
    approvals: normalizeApprovals(rawDefinition.approvals),
    closure: "user_review",
    ...(text(rawDefinition.startedAt, 40) ? { startedAt: text(rawDefinition.startedAt, 40) } : {}),
    ...(text(rawDefinition.endedAt, 40) ? { endedAt: text(rawDefinition.endedAt, 40) } : {}),
    ...(text(rawDefinition.endedReason, 500) ? { endedReason: text(rawDefinition.endedReason, 500) } : {}),
    createdAt: text(rawDefinition.createdAt, 40) || nowIso(),
    updatedAt: text(rawDefinition.updatedAt, 40) || nowIso(),
  };

  const iterations = normalizeIterations(raw.iterations, id);
  const retired = normalizeTotals(raw.retired);
  return {
    definition,
    iterations,
    ticketState: normalizeTicketState(raw.ticketState),
    // Recomputed rather than trusted: totals are a projection of the iteration list plus the
    // retired window, and a stored total that disagrees with those is always the wrong one.
    totals: foldTotals(iterations, retired),
    ...(retired ? { retired } : {}),
  };
}

export function normalizeLoopDocument(value: unknown): LoopDocument {
  const raw = (value ?? {}) as Record<string, unknown>;
  const rawLoops = Array.isArray(raw.loops) ? raw.loops : [];
  const loops: LoopRecord[] = [];
  const seen = new Set<string>();
  rawLoops.forEach((entry, index) => {
    const record = normalizeRecord(entry, index);
    if (!record || seen.has(record.definition.id)) return;
    seen.add(record.definition.id);
    loops.push(record);
  });
  return { schemaVersion: LOOPS_SCHEMA_VERSION, loops, updatedAt: text(raw.updatedAt, 40) || nowIso() };
}

function defaultDocument(): LoopDocument {
  return { schemaVersion: LOOPS_SCHEMA_VERSION, loops: [], updatedAt: nowIso() };
}

export interface CreateLoopInput {
  title: string;
  queue?: Partial<LoopQueueSpec>;
  workers?: Partial<LoopWorkerSpec>;
  ceilings?: Partial<LoopCeilings>;
  approvals?: Partial<LoopApprovalPosture>;
}

export class LoopStore implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<LoopDocument>();
  readonly onDidChange = this._emitter.event;

  constructor(private readonly _workspaceRoot: string) {}

  dispose(): void {
    this._emitter.dispose();
  }

  filePath(): string {
    return path.join(this._workspaceRoot, BLACKSITE_DIR, LOOPS_FILE);
  }

  ensureInitialized(): void {
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs.existsSync(this.filePath())) {
      fs.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}\n`, "utf8");
    }
  }

  read(): LoopDocument {
    try {
      return normalizeLoopDocument(JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as unknown);
    } catch {
      // Unreadable or absent reads as empty rather than throwing: a corrupt loops file must not
      // take the extension down, and there is nothing here that cannot be recreated.
      return defaultDocument();
    }
  }

  get(loopId: string): LoopRecord | undefined {
    return this.read().loops.find((record) => record.definition.id === loopId);
  }

  create(input: CreateLoopInput): LoopRecord {
    const document = this.read();
    const record: LoopRecord = {
      definition: {
        id: `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: text(input.title, 200) || "Untitled loop",
        // Always draft. A loop that dispatched the moment it was described would make an
        // hours-long unattended spend a side effect of asking for one.
        status: "draft",
        queue: { ...defaultQueueSpec(), ...input.queue },
        workers: { concurrency: 1, ...input.workers },
        ceilings: { ...defaultCeilings(), ...input.ceilings },
        approvals: { ...defaultApprovalPosture(), ...input.approvals },
        closure: "user_review",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      iterations: [],
      ticketState: [],
      totals: emptyTotals(),
    };
    document.loops.push(record);
    this._write(document);
    return record;
  }

  /** Mutate one loop in place. The callback receives a mutable copy; returning false abandons
   *  the write, so a no-op transition does not churn the file or fire a change event. */
  update(loopId: string, mutate: (record: LoopRecord) => boolean | void): LoopRecord | undefined {
    const document = this.read();
    const record = document.loops.find((candidate) => candidate.definition.id === loopId);
    if (!record) return undefined;
    if (mutate(record) === false) return record;
    record.definition.updatedAt = nowIso();
    trimIterations(record);
    record.totals = foldTotals(record.iterations, record.retired);
    this._write(document);
    return record;
  }

  setStatus(loopId: string, status: LoopStatus, reason?: string): LoopRecord | undefined {
    return this.update(loopId, (record) => {
      if (record.definition.status === status) return false;
      record.definition.status = status;
      if (status === "running" && !record.definition.startedAt) record.definition.startedAt = nowIso();
      if (TERMINAL_LOOP_STATUSES.has(status)) {
        record.definition.endedAt = nowIso();
        if (reason) record.definition.endedReason = reason;
      } else {
        delete record.definition.endedAt;
        delete record.definition.endedReason;
      }
    });
  }

  appendIteration(loopId: string, iteration: Omit<LoopIteration, "loopId" | "seq">): LoopIteration | undefined {
    let created: LoopIteration | undefined;
    this.update(loopId, (record) => {
      const seq = record.iterations.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
      created = { ...iteration, loopId, seq };
      record.iterations.push(created);
    });
    return created;
  }

  /** Settle an iteration that was opened at dispatch. Silently no-ops if the seq is unknown,
   *  which is the right behaviour when a loop was deleted mid-lane. */
  settleIteration(loopId: string, seq: number, patch: Partial<Omit<LoopIteration, "loopId" | "seq">>): void {
    this.update(loopId, (record) => {
      const target = record.iterations.find((entry) => entry.seq === seq);
      if (!target) return false;
      Object.assign(target, patch);
    });
  }

  /** Read-modify-write of one ticket's loop state, creating it on first touch. */
  updateTicketState(loopId: string, ticketId: string, mutate: (state: LoopTicketState) => void): void {
    this.update(loopId, (record) => {
      let state = record.ticketState.find((entry) => entry.ticketId === ticketId);
      if (!state) {
        state = { ticketId, attempts: 0, touchedFiles: [] };
        record.ticketState.push(state);
      }
      mutate(state);
    });
  }

  delete(loopId: string): void {
    const document = this.read();
    const next = document.loops.filter((record) => record.definition.id !== loopId);
    if (next.length === document.loops.length) return;
    document.loops = next;
    this._write(document);
  }

  private _write(document: LoopDocument): void {
    const normalized = normalizeLoopDocument({ ...document, updatedAt: nowIso() });
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    fs.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this._emitter.fire(normalized);
  }
}
