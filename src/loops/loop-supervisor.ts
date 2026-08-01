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
} from "./loop-scheduler.js";
import {
  laneComplexityFor,
  DEFAULT_MAX_ATTEMPTS,
  type LoopApprovalPosture,
  type LoopIterationOutcome,
  type LoopRecord,
  type LoopTicketState,
} from "./loop-model.js";
import type { LoopStore } from "./loop-store.js";
import type { Ticket } from "../ticket-store.js";

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
  signal: AbortSignal;
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
}

export interface LoopSupervisorHooks {
  /** First park, and any state the user should hear about. */
  notify?(loopId: string, message: string): void;
  /** Surfaced for logging; never thrown from. */
  onError?(loopId: string, error: unknown): void;
}

interface InFlight {
  ticketId: string;
  territory: ReadonlySet<string>;
  promise: Promise<void>;
}

export class LoopSupervisor {
  private readonly _running = new Map<string, AbortController>();
  private readonly _notified = new Set<string>();

  constructor(
    private readonly _store: LoopStore,
    private readonly _tickets: LoopTicketGateway,
    private readonly _dispatcher: LoopDispatcher,
    private readonly _hooks: LoopSupervisorHooks = {},
    private readonly _now: () => number = () => Date.now(),
  ) {}

  isRunning(loopId: string): boolean {
    return this._running.has(loopId);
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

    const controller = new AbortController();
    this._running.set(loopId, controller);
    this._store.setStatus(loopId, "running");

    // Fire-and-forget: the cycle owns its own lifetime and records everything it does to the
    // store, so nothing upstream needs to await it.
    void this._cycle(loopId, controller)
      .catch((error) => {
        this._hooks.onError?.(loopId, error);
        this._store.setStatus(loopId, "failed", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this._running.delete(loopId);
      });
  }

  /** In-flight lanes are left to finish; no further dispatch happens. */
  pause(loopId: string): void {
    this._store.setStatus(loopId, "paused", "Paused.");
    this._running.get(loopId)?.abort("Loop paused.");
  }

  stop(loopId: string, reason = "Stopped."): void {
    this._store.setStatus(loopId, "stopped", reason);
    this._running.get(loopId)?.abort(reason);
  }

  /** Clear a park after the user answers its gate, making the ticket dispatchable again. */
  releasePark(loopId: string, ticketId: string): void {
    this._store.updateTicketState(loopId, ticketId, (state) => {
      delete state.parkedOnGate;
      delete state.parkedAt;
      delete state.parkedSubRequestId;
    });
  }

  private async _cycle(loopId: string, controller: AbortController): Promise<void> {
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
        this._store.setStatus(loopId, "stopped", ceiling);
        return;
      }

      const state = new Map(record.ticketState.map((entry) => [entry.ticketId, entry] as const));
      const scheduled = computeReadySet({
        tickets: this._tickets.tickets(),
        spec: record.definition.queue,
        state,
        inFlight: [...inFlight.values()].map((entry) => entry.territory),
        indexedFiles: this._tickets.indexedFiles(),
        now: this._now(),
      });

      const freeSlots = Math.max(record.definition.workers.concurrency - inFlight.size, 0);
      const action = nextSupervisorAction(scheduled, inFlight.size, freeSlots);

      if (action === "drained") {
        this._store.setStatus(loopId, "drained", "Every ticket in the queue has been worked.");
        return;
      }
      if (action === "blocked") {
        const detail = scheduled.withheld.length
          ? `${scheduled.withheld.length} ticket(s) remain, none dispatchable: `
            + scheduled.withheld.slice(0, 3).map((entry) => `${entry.ticket.id} (${entry.reason})`).join(", ")
          : "No dispatchable tickets remain.";
        this._store.setStatus(loopId, "blocked", detail);
        return;
      }
      if (action === "dispatch") {
        for (const entry of scheduled.ready.slice(0, freeSlots)) {
          inFlight.set(entry.ticket.id, this._launch(loopId, record, entry, controller, inFlight));
        }
        continue;
      }

      // action === "wait": nothing dispatchable right now, but lanes are running. Wake on the
      // first to settle rather than polling.
      if (!inFlight.size) break;
      await Promise.race([...inFlight.values()].map((entry) => entry.promise));
    }

    // Paused or stopped: let whatever is still running record its own outcome.
    await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
  }

  private _launch(
    loopId: string,
    record: LoopRecord,
    entry: ReadyEntry,
    controller: AbortController,
    inFlight: Map<string, InFlight>,
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
          signal: controller.signal,
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

      this._record(loopId, ticket, result, startedAt, opened?.seq);
      inFlight.delete(ticket.id);
    })();

    return { ticketId: ticket.id, territory: entry.territory, promise };
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
  ): void {
    const outcome: LoopIterationOutcome = result.parkedOnGate
      ? "parked"
      : result.ok ? "succeeded" : "failed";

    const settled = {
      ...(result.laneId ? { laneId: result.laneId } : {}),
      ...(result.subRequestId ? { subRequestId: result.subRequestId } : {}),
      runIds: result.runIds,
      outcome,
      detail: result.detail,
      endedAt: new Date(this._now()).toISOString(),
      ...(result.usd != null ? { usd: result.usd } : {}),
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
      if (result.parkedOnGate) {
        state.parkedOnGate = result.parkedOnGate;
        state.parkedAt = new Date(this._now()).toISOString();
        if (result.parkedSubRequestId) state.parkedSubRequestId = result.parkedSubRequestId;
        return;
      }
      // A park is not an attempt: the work never got to fail.
      state.attempts += 1;
    });

    if (result.parkedOnGate) {
      const record = this._store.get(loopId);
      if (record?.definition.approvals.notify && !this._notified.has(loopId)) {
        this._notified.add(loopId);
        this._hooks.notify?.(
          loopId,
          `${ticket.id} is waiting on an approval (${result.parkedOnGate}). The loop is continuing with other tickets.`,
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
    if (ceilings.maxUsd != null && totals.usd >= ceilings.maxUsd) {
      return `Reached the $${ceilings.maxUsd} spend ceiling.`;
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
