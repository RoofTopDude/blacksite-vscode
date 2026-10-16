/**
 * Drives a loop: dispatches ready tickets into worker lanes, waits on the first to finish,
 * and repeats until the queue is empty or a ceiling trips.
 *
 * The wait is `Promise.race` over in-flight lanes, not a timer. A loop wakes exactly when a
 * worker frees a slot, so an idle loop consumes nothing at all — which matters when the
 * intended runtime is measured in hours.
 *
 * Every external dependency is injected. The supervisor never imports vscode, the chat
 * provider, or the ticket store directly, so the whole dispatch cycle — including the recovery
 * paths that only fire at 3am — is exercisable in a unit test.
 */

import {
  computeReadySet,
  nextSupervisorAction,
  type ReadyEntry,
  type SchedulerResult,
  type SchedulingGraph,
} from "./loop-scheduler.js";
import {
  laneComplexityFor,
  DEFAULT_MAX_ATTEMPTS,
  type LoopApprovalPosture,
  type LoopActivityKind,
  type LoopIterationOutcome,
  type LoopRecord,
  type LoopTicketState,
} from "./loop-model.js";
import type { LoopStore } from "./loop-store.js";
import type { SchedulerMode } from "../orchestration/flags.js";
import type { Ticket } from "../ticket-store.js";
import { describeReceiptSummary, type ReceiptSummary } from "../orchestration/work-receipt.js";

export interface LoopDispatchRequest {
  loopId: string;
  ticket: Ticket;
  complexity: "standard" | "complex" | "deep";
  profileId?: string;
  /**
   * What the previous attempt did and why it ended, fed into the retry prompt.
   *
   * The point of a retry budget is that the second attempt is *informed* — an identical
   * respawn is the thing lane failure guidance explicitly tells the parent not to do.
   */
  priorAttempt?: string;
  approvals: LoopApprovalPosture;
  onProgress?: (event: LoopDispatchProgress) => void;
  /** Called with each priced model call, so the loop can count spend while a lane is still
   *  running instead of learning about it when the lane ends. */
  onSpend?: (usd: number) => void;
  /** What is left of the loop's spend ceiling, for the lane's work contract. */
  maxUsd?: number;
  /** The dispatcher issued a work contract for this lane. Recorded on the open iteration, so a
   *  host restart mid-lane can still write the lane's receipt. */
  onContract?: (contractId: string) => void;
  signal: AbortSignal;
}

export interface LoopDispatchProgress {
  kind: LoopActivityKind;
  label: string;
  detail?: string;
  toolCallId?: string;
  toolName?: string;
  tier?: string;
  ok?: boolean;
}

export interface LoopDispatchResult {
  ok: boolean;
  laneId?: string;
  subRequestId?: string;
  /** Human-readable outcome. On failure this should be the lane's own nextStep guidance. */
  detail: string;
  filesTouched: string[];
  runIds: string[];
  usd?: number;
  /** Set when the lane stopped on an approval this loop's posture would not grant. Distinct
   *  from a failure: nothing about the work went wrong. */
  parkedOnGate?: string;
  parkedSubRequestId?: string;
  /** What the host observed, when the lane ran under a work contract. */
  receipt?: ReceiptSummary;
}

export interface LoopDispatcher {
  dispatch(request: LoopDispatchRequest): Promise<LoopDispatchResult>;
}

/** The slice of the ticket world a loop needs. Narrow on purpose — a loop may read the queue
 *  and move a ticket to review, and must not be able to close one (closure is the user's). */
export interface LoopTicketGateway {
  tickets(): readonly Ticket[];
  indexedFiles(): readonly string[];
  /** Move to `review` with a note. The worker's terminal state under `user_review` closure. */
  moveToReview(ticketId: string, note: string): void;
  /** Record an attempt that did not produce reviewable work, without changing status. */
  noteAttempt(ticketId: string, note: string): void;
  /** A continuation-review refusal blocks this ticket, never the whole loop. */
  blockTicket?(ticketId: string, note: string): void;
  /** Explicit user retry after inspecting a blocked gate. */
  releaseBlocked?(ticketId: string, note: string): void;
}

export interface LoopSupervisorHooks {
  /** First park, and any state the user should hear about. */
  notify?(loopId: string, message: string): void;
  /** Surfaced for logging; never thrown from. */
  onError?(loopId: string, error: unknown): void;
  /** The loop ended or stopped by itself (drained, blocked, hit a ceiling, failed) — the moments a
   *  person who walked away needs to hear about, as opposed to a pause they asked for. */
  onSettled?(loopId: string, title: string, status: "drained" | "blocked" | "stopped" | "failed", reason: string): void;
  /** A ticket was parked on a refused approval; cleared again by {@link LoopSupervisor.releasePark}. */
  onParked?(loopId: string, title: string, ticketId: string, gate: string): void;
  /** The user started or resumed the loop, so anything it raised about itself is out of date. */
  onStarted?(loopId: string): void;
  onReleased?(loopId: string, ticketId: string): void;
  /** A lane that ran under a work contract was lost to a host restart: record its receipt. */
  onAbandonedContract?(contractId: string, subject: { loopId: string; ticketId: string; iterationSeq: number }): void;
}

/**
 * How a loop schedules this pass (#15), read fresh before every pass. `legacy` (or no graph) is
 * exactly the scheduler as it was. `shadow` dispatches as legacy and records what the graph-aware
 * scheduler would have chosen. `graph` uses it.
 */
export interface LoopSchedulingContext {
  mode: SchedulerMode;
  graph?: SchedulingGraph;
  /** Paths other lanes hold claims on (#19), path → who. */
  held?: ReadonlyMap<string, string>;
  /** Latest receipt status per ticket, for `dependencySatisfiedBy: "verified_review"`. */
  latestReceipt?: (ticketId: string) => string | undefined;
}

export interface LoopSupervisorOptions {
  scheduling?: (record: LoopRecord) => LoopSchedulingContext;
}

/** Past lanes needed before their median spend is trusted to hold a ticket back. */
const BUDGET_SAMPLES = 3;

interface InFlight {
  ticketId: string;
  territory: ReadonlySet<string>;
  promise: Promise<void>;
}

/** Pausing a loop stops it dispatching; the lanes already running finish. Stopping ends them. */
interface LoopControllers {
  /** Aborted by pause or stop: no further lanes are dispatched. */
  cycle: AbortController;
  /** Aborted only by stop: the lanes themselves. */
  lanes: AbortController;
}

export class LoopSupervisor {
  private readonly _running = new Map<string, LoopControllers>();
  private readonly _notified = new Set<string>();
  /** Spend by lanes still running, per loop and ticket. Counted toward the spend ceiling so a
   *  loop does not start another lane while the ones it has are already past it. */
  private readonly _liveUsd = new Map<string, Map<string, number>>();
  /** Per running loop: resolves the cycle's wait early, so it re-schedules now (#14 signals). */
  private readonly _wakers = new Map<string, () => void>();
  /** A wake that arrived while the cycle was not waiting: honoured at its next wait. */
  private readonly _wokenEarly = new Set<string>();

  constructor(
    private readonly _store: LoopStore,
    private readonly _tickets: LoopTicketGateway,
    private readonly _dispatcher: LoopDispatcher,
    private readonly _hooks: LoopSupervisorHooks = {},
    private readonly _now: () => number = () => Date.now(),
    /** Injected for deterministic replays (tests/eval); receives the id's prefix. */
    private readonly _newId: (prefix: string) => string = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    private readonly _options: LoopSupervisorOptions = {},
  ) {}

  /** The last decision recorded per loop, so a loop waiting on the same state does not churn its file. */
  private readonly _lastDecision = new Map<string, string>();

  isRunning(loopId: string): boolean {
    return this._running.has(loopId);
  }

  /**
   * Re-check a running loop's queue now instead of when one of its lanes next finishes — a blocker
   * closed, a ticket became ready. Does nothing for a loop that is not running: waking never starts
   * a loop. Safe to call any number of times; the scheduling pass it causes reads current state.
   */
  wake(loopId: string): void {
    if (!this._running.has(loopId)) return;
    const waker = this._wakers.get(loopId);
    if (waker) {
      this._wakers.delete(loopId);
      waker();
    } else {
      this._wokenEarly.add(loopId);
    }
  }

  /**
   * Reconcile loops that were mid-flight when the host died.
   *
   * A lane does not survive an extension-host restart: retained lanes live in memory, so a
   * loop that was `running` has in-flight work that is simply gone. The work it did is still
   * on disk and in the ticket timeline — what is lost is the lane, not the changes.
   *
   * Loops are left paused rather than resumed. Silently continuing a paid, unattended run
   * after a crash is not a decision this code gets to make.
   */
  restore(): string[] {
    const restored: string[] = [];
    for (const record of this._store.read().loops) {
      if (record.definition.status !== "running") continue;
      const loopId = record.definition.id;

      // Any iteration with no endedAt was in flight when the host went down.
      for (const iteration of record.iterations) {
        if (iteration.endedAt) continue;
        if (iteration.contractId) {
          try {
            this._hooks.onAbandonedContract?.(iteration.contractId, { loopId, ticketId: iteration.ticketId, iterationSeq: iteration.seq });
          } catch { /* the receipt is a record; restoring the loop matters more */ }
        }
        this._store.update(loopId, (live) => {
          const target = live.iterations.find((entry) => entry.seq === iteration.seq);
          if (!target) return false;
          target.outcome = "abandoned";
          target.detail = "The extension host restarted while this lane was running. Any work it "
            + "completed is on disk; the lane itself could not be resumed.";
          target.endedAt = new Date(this._now()).toISOString();
        });
        // Not charged as an attempt: the lane was killed by the host, not by the work.
        this._tickets.noteAttempt(
          iteration.ticketId,
          "A loop lane was interrupted by an extension restart. Re-dispatched on resume.",
        );
      }

      this._store.setStatus(loopId, "paused", "Paused by an extension restart. Resume when ready.");
      restored.push(loopId);
    }
    return restored;
  }

  start(loopId: string): void {
    if (this._running.has(loopId)) return;
    const record = this._store.get(loopId);
    if (!record) return;

    const controllers: LoopControllers = { cycle: new AbortController(), lanes: new AbortController() };
    const execution = this._store.beginExecution(loopId);
    if (!execution) return;
    this._running.set(loopId, controllers);
    this._liveUsd.delete(loopId);
    this._hooks.onStarted?.(loopId);

    // Fire-and-forget: the cycle owns its own lifetime and records everything it does to the
    // store, so nothing upstream needs to await it.
    void this._cycle(loopId, controllers)
      .catch((error) => {
        this._hooks.onError?.(loopId, error);
        this._settle(loopId, "failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this._running.delete(loopId);
        this._liveUsd.delete(loopId);
        this._wakers.delete(loopId);
        this._wokenEarly.delete(loopId);
      });
  }

  /** In-flight lanes are left to finish; no further dispatch happens. */
  pause(loopId: string): void {
    this._store.setStatus(loopId, "paused", "Paused.");
    // The cycle stops dispatching. The lanes keep their own signal, so work already under way is
    // finished and recorded rather than cut off mid-edit and charged as a failure.
    this._running.get(loopId)?.cycle.abort("Loop paused.");
  }

  /** Ends the loop and cancels its lanes. A cancelled lane is recorded as abandoned, not failed. */
  stop(loopId: string, reason = "Stopped."): void {
    this._store.setStatus(loopId, "stopped", reason);
    const controllers = this._running.get(loopId);
    controllers?.cycle.abort(reason);
    controllers?.lanes.abort(reason);
  }

  /** Record a status the loop reached on its own and tell whoever needs to know. */
  private _settle(loopId: string, status: "drained" | "blocked" | "stopped" | "failed", reason: string): void {
    this._store.setStatus(loopId, status, reason);
    const title = this._store.get(loopId)?.definition.title ?? loopId;
    try { this._hooks.onSettled?.(loopId, title, status, reason); } catch { /* a broken surface must not stop the loop */ }
  }

  /** Clear a park after the user answers its gate, making the ticket dispatchable again. */
  releasePark(loopId: string, ticketId: string): void {
    this._store.updateTicketState(loopId, ticketId, (state) => {
      delete state.parkedOnGate;
      delete state.parkedAt;
      delete state.parkedSubRequestId;
    });
    this._tickets.releaseBlocked?.(ticketId, "Released from continuation-review block by the user.");
    this._hooks.onReleased?.(loopId, ticketId);
  }

  private async _cycle(loopId: string, controllers: LoopControllers): Promise<void> {
    const controller = controllers.cycle;
    const inFlight = new Map<string, InFlight>();

    for (;;) {
      if (controller.signal.aborted) break;

      const record = this._store.get(loopId);
      if (!record || record.definition.status !== "running") break;

      const ceiling = this._trippedCeiling(record);
      if (ceiling) {
        // In-flight lanes are allowed to finish — killing work mid-edit to enforce a budget
        // leaves a half-applied change, which is worse than the overage.
        await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
        this._settle(loopId, "stopped", ceiling);
        return;
      }

      const pass = this._schedulePass(record, [...inFlight.values()].map((entry) => entry.territory));
      const scheduled = pass.result;

      const freeSlots = Math.max(record.definition.workers.concurrency - inFlight.size, 0);
      const action = nextSupervisorAction(scheduled, inFlight.size, freeSlots);

      if (action === "drained") {
        this._settle(loopId, "drained", "Every ticket in the queue has been worked.");
        return;
      }
      if (action === "blocked") {
        const detail = scheduled.withheld.length
          ? `${scheduled.withheld.length} ticket(s) remain, none dispatchable: `
            + scheduled.withheld.slice(0, 3).map((entry) => `${entry.ticket.id} (${entry.reason})`).join(", ")
          : "No dispatchable tickets remain.";
        this._settle(loopId, "blocked", detail);
        // Blocked only on other tickets is the one kind of block a closed blocker can clear by
        // itself, so signals may tell the user when it could continue (they never resume it).
        const onlyDependencies = scheduled.withheld.length > 0
          && scheduled.withheld.every((entry) => entry.reason === "blocked" || entry.reason === "incoherent");
        this._store.setBlockedOn(loopId, onlyDependencies ? "dependencies" : "mixed");
        return;
      }
      if (pass.mode !== "legacy") this._recordDecision(loopId, pass, freeSlots, new Set(inFlight.keys()));
      if (action === "dispatch") {
        const dispatched = scheduled.ready.slice(0, freeSlots);
        if (pass.mode === "graph") this._notePassedOver(loopId, dispatched, scheduled.ready.slice(freeSlots));
        for (const entry of dispatched) {
          inFlight.set(entry.ticket.id, this._launch(loopId, record, entry, controllers, inFlight, pass.mode === "graph"));
        }
        continue;
      }

      // action === "wait": nothing dispatchable right now, but lanes are running. Wake on the
      // first to settle rather than polling — or on a wake, when a blocker closed meanwhile.
      if (!inFlight.size) break;
      if (this._wokenEarly.delete(loopId)) continue;
      const woken = new Promise<void>((resolve) => this._wakers.set(loopId, resolve));
      await Promise.race([...[...inFlight.values()].map((entry) => entry.promise), woken]);
      this._wakers.delete(loopId);
    }

    // Paused or stopped: let whatever is still running record its own outcome.
    await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
  }

  /** One scheduling pass over current state. Pure apart from reading the stores. */
  private _schedule(record: LoopRecord, inFlight: ReadonlyArray<ReadonlySet<string>>): SchedulerResult {
    return this._schedulePass(record, inFlight).result;
  }

  private _schedulePass(
    record: LoopRecord,
    inFlight: ReadonlyArray<ReadonlySet<string>>,
  ): { result: SchedulerResult; mode: SchedulerMode; shadow?: SchedulerResult } {
    let context: LoopSchedulingContext = { mode: "legacy" };
    try {
      context = this._options.scheduling?.(record) ?? context;
    } catch (error) {
      // A graph that cannot be read must not stop a loop: schedule as before.
      this._hooks.onError?.(record.definition.id, error);
    }
    const state = new Map(record.ticketState.map((entry) => [entry.ticketId, entry] as const));
    const base = {
      tickets: this._tickets.tickets(),
      spec: record.definition.queue,
      state,
      inFlight,
      indexedFiles: this._tickets.indexedFiles(),
      now: this._now(),
      ...(context.latestReceipt ? { latestReceipt: context.latestReceipt } : {}),
    };
    if (context.mode === "legacy" || !context.graph) return { result: computeReadySet(base), mode: "legacy" };
    const budget = this._budget(record, base.tickets);
    const graphResult = computeReadySet({
      ...base,
      graph: context.graph,
      ...(context.held ? { held: context.held } : {}),
      ...(budget ? { budget } : {}),
    });
    if (context.mode === "graph") return { result: graphResult, mode: "graph" };
    return { result: computeReadySet(base), mode: "shadow", shadow: graphResult };
  }

  /** What is left of the spend ceiling, and what past lanes of each size cost (median, enough samples only). */
  private _budget(record: LoopRecord, tickets: readonly Ticket[]): { remainingUsd: number; medianUsd: Partial<Record<"small" | "medium" | "large", number>> } | undefined {
    const remainingUsd = this._remainingUsd(record);
    if (remainingUsd === undefined) return undefined;
    const complexity = new Map(tickets.map((ticket) => [ticket.id, ticket.complexity ?? "small"] as const));
    const samples: Record<string, number[]> = {};
    for (const iteration of record.iterations) {
      if (!iteration.endedAt || iteration.usd === undefined || iteration.outcome === "running") continue;
      const size = complexity.get(iteration.ticketId) ?? "small";
      (samples[size] ??= []).push(iteration.usd);
    }
    const medianUsd: Partial<Record<"small" | "medium" | "large", number>> = {};
    for (const [size, values] of Object.entries(samples)) {
      if (values.length < BUDGET_SAMPLES) continue;
      const sorted = [...values].sort((a, b) => a - b);
      medianUsd[size as "small" | "medium" | "large"] = sorted[Math.floor(sorted.length / 2)]!;
    }
    return { remainingUsd, medianUsd };
  }

  /** Record the pass when it decided something different from the last one recorded. */
  private _recordDecision(loopId: string, pass: { result: SchedulerResult; mode: SchedulerMode; shadow?: SchedulerResult }, freeSlots: number, running: ReadonlySet<string>): void {
    const chosen = pass.result.ready.slice(0, freeSlots).map((entry) => ({ ticketId: entry.ticket.id, score: entry.score ?? 0, reasons: entry.reasons.slice(0, 8) }));
    const withheld = pass.result.withheld.filter((entry) => !running.has(entry.ticket.id)).map((entry) => ({ ticketId: entry.ticket.id, reason: entry.reason, detail: entry.detail.slice(0, 300) }));
    const wouldChoose = pass.shadow?.ready.slice(0, freeSlots).map((entry) => entry.ticket.id);
    const fingerprint = JSON.stringify([chosen.map((entry) => entry.ticketId), withheld.map((entry) => `${entry.ticketId}:${entry.reason}`), wouldChoose]);
    if (this._lastDecision.get(loopId) === fingerprint) return;
    this._lastDecision.set(loopId, fingerprint);
    this._store.appendDecision(loopId, {
      at: new Date(this._now()).toISOString(),
      mode: pass.mode === "graph" ? "graph" : "shadow",
      chosen,
      withheld,
      ...(wouldChoose ? { wouldChoose } : {}),
    });
  }

  /** Ready tickets left waiting while others ran earn starvation credit; dispatched ones start over. */
  private _notePassedOver(loopId: string, dispatched: readonly ReadyEntry[], waiting: readonly ReadyEntry[]): void {
    if (!waiting.length && !dispatched.some((entry) => entry.reasons.some((reason) => reason.startsWith("passed over")))) return;
    this._store.update(loopId, (record) => {
      for (const entry of dispatched) {
        const state = record.ticketState.find((candidate) => candidate.ticketId === entry.ticket.id);
        if (state) delete state.passedOver;
      }
      for (const entry of waiting) {
        let state = record.ticketState.find((candidate) => candidate.ticketId === entry.ticket.id);
        if (!state) {
          state = { ticketId: entry.ticket.id, attempts: 0, touchedFiles: [] };
          record.ticketState.push(state);
        }
        state.passedOver = (state.passedOver ?? 0) + 1;
      }
    });
  }

  /**
   * The tickets a loop would dispatch if it were started now, nothing in flight. Dispatches
   * nothing and changes nothing: signals use it to tell the user a blocked loop could continue.
   */
  previewReady(loopId: string): string[] {
    const record = this._store.get(loopId);
    if (!record) return [];
    return this._schedule(record, []).ready.map((entry) => entry.ticket.id);
  }

  private _launch(
    loopId: string,
    record: LoopRecord,
    entry: ReadyEntry,
    controllers: LoopControllers,
    inFlight: Map<string, InFlight>,
    explain = false,
  ): InFlight {
    const ticket = entry.ticket;
    const state = record.ticketState.find((candidate) => candidate.ticketId === ticket.id);
    const startedAt = new Date(this._now()).toISOString();

    /* Opened here, before the lane runs, and settled when it finishes. Recording only on
       completion would mean a host crash left no trace of the lane at all — and `restore` looks
       for exactly this: an iteration with no endedAt. Without the open record there is nothing
       to find, and the crashed lane would silently vanish from the loop's history. */
    const opened = this._store.appendIteration(loopId, {
      ticketId: ticket.id,
      runIds: [],
      outcome: "running",
      detail: "In flight.",
      startedAt,
      ...(explain && entry.reasons.length ? { scheduledBecause: entry.reasons.slice(0, 8) } : {}),
    });

    const promise = (async (): Promise<void> => {
      let result: LoopDispatchResult;
      try {
        result = await this._dispatcher.dispatch({
          loopId,
          ticket,
          // An untriaged ticket carries no complexity; "small" is the honest default, since a
          // lane that needs more can be retried at a larger budget but one that over-reserves
          // holds a worker slot it never uses.
          complexity: laneComplexityFor(record.definition.workers.complexityOverride ?? ticket.complexity ?? "small"),
          ...(record.definition.workers.profileId ? { profileId: record.definition.workers.profileId } : {}),
          ...(state?.attempts ? { priorAttempt: this._priorAttemptDetail(record, ticket.id) } : {}),
          approvals: record.definition.approvals,
          ...(this._remainingUsd(record) !== undefined ? { maxUsd: this._remainingUsd(record) } : {}),
          ...(opened ? {
            onContract: (contractId: string) => this._store.settleIteration(loopId, opened.seq, { contractId }),
          } : {}),
          ...(opened ? {
            onProgress: (event: LoopDispatchProgress) => {
              this._store.appendIterationActivity(loopId, opened.seq, {
                ...event,
                id: this._newId("activity"),
                at: new Date(this._now()).toISOString(),
              });
            },
          } : {}),
          onSpend: (usd: number) => {
            const live = this._liveUsd.get(loopId) ?? new Map<string, number>();
            live.set(ticket.id, (live.get(ticket.id) ?? 0) + usd);
            this._liveUsd.set(loopId, live);
          },
          signal: controllers.lanes.signal,
        });
      } catch (error) {
        this._hooks.onError?.(loopId, error);
        result = {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          filesTouched: [],
          runIds: [],
        };
      }

      result = this._resultFromReceipt(result);
      // The spend is in the result now, and counted in the totals once it is recorded.
      this._liveUsd.get(loopId)?.delete(ticket.id);
      this._record(loopId, ticket, result, startedAt, opened?.seq, controllers.lanes.signal.aborted && !result.ok && !result.parkedOnGate);
      inFlight.delete(ticket.id);
    })();

    return { ticketId: ticket.id, territory: entry.territory, promise };
  }

  /** Spend left under the loop's ceiling, counting lanes still running. */
  private _remainingUsd(record: LoopRecord): number | undefined {
    const max = record.definition.ceilings.maxUsd;
    if (max == null) return undefined;
    let live = 0;
    for (const usd of this._liveUsd.get(record.definition.id)?.values() ?? []) live += usd;
    return Math.max(max - record.totals.usd - live, 0.01);
  }

  /**
   * Under an enforcing contract the receipt, not the lane's own ok, decides what happened. A lane
   * that said it was done while a check failed goes back for another attempt instead of to review.
   * Observe mode changes nothing here.
   */
  private _resultFromReceipt(result: LoopDispatchResult): LoopDispatchResult {
    const receipt = result.receipt;
    if (!receipt || receipt.enforcement !== "enforce") return result;
    switch (receipt.status) {
      case "verified":
      case "succeeded_unverified":
        return { ...result, ok: true, detail: `${describeReceiptSummary(receipt)}\n\n${result.detail}`.trim() };
      case "blocked":
        return { ...result, ok: false, parkedOnGate: result.parkedOnGate ?? "approval", ...(result.subRequestId ? { parkedSubRequestId: result.parkedSubRequestId ?? result.subRequestId } : {}) };
      case "partial":
      case "failed": {
        const { parkedOnGate: _ignored, ...rest } = result;
        return { ...rest, ok: false, detail: `${describeReceiptSummary(receipt)}\n\n${result.detail}`.trim() };
      }
      default:
        return result;
    }
  }

  /** The last thing that happened to this ticket, so a retry starts from it. */
  private _priorAttemptDetail(record: LoopRecord, ticketId: string): string {
    for (let index = record.iterations.length - 1; index >= 0; index -= 1) {
      const iteration = record.iterations[index];
      if (iteration?.ticketId === ticketId && iteration.detail) return iteration.detail;
    }
    return "";
  }

  private _record(
    loopId: string,
    ticket: Ticket,
    result: LoopDispatchResult,
    startedAt: string,
    openedSeq?: number,
    cancelled = false,
  ): void {
    // A lane the user stopped did not fail: it was cut off. Charging it an attempt would spend the
    // ticket's retry budget on the user's decision, and counting it would trip the failure ceiling.
    const outcome: LoopIterationOutcome = result.parkedOnGate
      ? "parked"
      : cancelled ? "abandoned" : result.ok ? "succeeded" : "failed";

    const settled = {
      ...(result.laneId ? { laneId: result.laneId } : {}),
      ...(result.subRequestId ? { subRequestId: result.subRequestId } : {}),
      runIds: result.runIds,
      outcome,
      detail: result.detail,
      endedAt: new Date(this._now()).toISOString(),
      ...(result.usd != null ? { usd: result.usd } : {}),
      ...(result.receipt ? { receiptId: result.receipt.id, receiptStatus: result.receipt.status, contractId: result.receipt.contractId } : {}),
    };

    if (openedSeq != null) {
      this._store.settleIteration(loopId, openedSeq, settled);
    } else {
      // The open record could not be written (an unwritable store). Still account for the work.
      this._store.appendIteration(loopId, { ticketId: ticket.id, startedAt, ...settled });
    }

    this._store.updateTicketState(loopId, ticket.id, (state: LoopTicketState) => {
      // Widen the lock with what the lane actually touched. Territory is declared, not
      // enforced; this at least stops the next dispatch being scheduled into a known overlap.
      for (const file of result.filesTouched) {
        if (!state.touchedFiles.includes(file)) state.touchedFiles.push(file);
      }
      // Collided with another lane over files (#19 claims): the scheduler runs it alone next time.
      const conflicts = result.receipt?.conflicts ?? [];
      if (conflicts.length) state.lastClaimConflict = conflicts.slice(0, 3).join(", ");
      else if (result.ok) delete state.lastClaimConflict;
      if (result.parkedOnGate) {
        state.parkedOnGate = result.parkedOnGate;
        state.parkedAt = new Date(this._now()).toISOString();
        if (result.parkedSubRequestId) state.parkedSubRequestId = result.parkedSubRequestId;
        return;
      }
      // A park is not an attempt: the work never got to fail. Neither is a cancellation.
      if (!cancelled) state.attempts += 1;
    });

    if (cancelled) {
      this._tickets.noteAttempt(ticket.id, "The loop was stopped while this lane was running. It was not charged an attempt.");
      return;
    }

    if (result.parkedOnGate) {
      this._tickets.blockTicket?.(
        ticket.id,
        `Automated continuation review blocked an approval (${result.parkedOnGate}). ${result.detail}`.trim(),
      );
      const record = this._store.get(loopId);
      try { this._hooks.onParked?.(loopId, record?.definition.title ?? loopId, ticket.id, result.parkedOnGate); } catch { /* best effort */ }
      if (record?.definition.approvals.notify && !this._notified.has(loopId)) {
        this._notified.add(loopId);
        this._hooks.notify?.(
          loopId,
          `${ticket.id} was blocked by continuation review (${result.parkedOnGate}). The loop is continuing with other tickets.`,
        );
      }
      return;
    }

    if (result.ok) {
      // The worker's terminal state. Closure is the user's under user_review, so a succeeded
      // lane hands the ticket over rather than finishing it.
      this._tickets.moveToReview(ticket.id, result.detail || "Completed by a loop lane. Ready for review.");
      return;
    }

    const attempts = this._store.get(loopId)?.ticketState.find((s) => s.ticketId === ticket.id)?.attempts ?? 0;
    const exhausted = attempts >= DEFAULT_MAX_ATTEMPTS;
    this._tickets.noteAttempt(
      ticket.id,
      exhausted
        ? `Loop attempt ${attempts} failed and the retry budget is spent: ${result.detail}`
        : `Loop attempt ${attempts} failed, will retry: ${result.detail}`,
    );
  }

  /** The first ceiling this loop has crossed, or "" if none. */
  private _trippedCeiling(record: LoopRecord): string {
    const { ceilings } = record.definition;
    const { totals } = record;

    if (ceilings.maxTickets != null && totals.dispatched >= ceilings.maxTickets) {
      return `Reached the ${ceilings.maxTickets}-ticket ceiling.`;
    }
    if (ceilings.maxUsd != null) {
      // Lanes still running count too: their spend is real before it is recorded, and a loop that
      // starts another lane while the ones it has are already past the ceiling is not honouring it.
      let live = 0;
      for (const usd of this._liveUsd.get(record.definition.id)?.values() ?? []) live += usd;
      if (totals.usd + live >= ceilings.maxUsd) return `Reached the $${ceilings.maxUsd} spend ceiling.`;
    }
    if (totals.consecutiveFailures >= ceilings.maxConsecutiveFailures) {
      return `${totals.consecutiveFailures} tickets failed in a row — stopping rather than working through the rest.`;
    }
    if (ceilings.maxWallClockMs != null && record.definition.startedAt) {
      // Elapsed, not running: a loop must not evade its ceiling by being paused and resumed.
      const elapsed = this._now() - Date.parse(record.definition.startedAt);
      if (Number.isFinite(elapsed) && elapsed >= ceilings.maxWallClockMs) {
        return `Reached the ${Math.round(ceilings.maxWallClockMs / 60_000)}-minute wall-clock ceiling.`;
      }
    }
    return "";
  }
}
