/**
 * The signal service: sources in, consumers out.
 *
 * Sources hand over facts as they happen (a receipt written, the ticket board changed, a loop
 * iteration settled, a plan-run ledger event, a contract issued, a claim collision). Each becomes
 * zero or more signals; a signal already journaled is dropped as a repeat. Signals are collected
 * for {@link COALESCE_MS} and handed to each consumer as one batch, so a burst of a thousand
 * changes costs one re-check per loop, not a thousand.
 *
 * With signals `off` nothing is derived and no file is written. With `observe`, signals and what
 * each consumer would have done are journaled and nothing is applied. With `act`, the actions are
 * applied through the host's ports — which can wake a running loop, offer a resume, flag, and
 * note, and nothing else.
 *
 * No vscode import: the host passes in readers and ports.
 */

import type { LoopIteration } from "../../loops/loop-model.js";
import type { PlanRunEvent } from "../../plans/plan-run-model.js";
import type { Ticket } from "../../ticket-store.js";
import type { SignalsMode } from "../flags.js";
import type { WorkContract } from "../work-contract.js";
import type { WorkReceipt } from "../work-receipt.js";
import {
  DEFAULT_CONSUMERS,
  describeAction,
  type ReassessmentEntry,
  type ReconcileAction,
  type ReconcileReads,
  type SignalConsumer,
} from "./consumers.js";
import {
  deriveContractOverlap,
  deriveFromIterations,
  deriveFromPlanRunEvent,
  deriveFromReceipt,
  deriveFromTicketChange,
  deriveIntegrationReady,
  deriveRunStalled,
  snapshotTicket,
  type TicketSnapshot,
} from "./derive.js";
import type { ReconcileRecord, SignalJournal } from "./journal.js";
import {
  finalizeSignal,
  RECONCILE_CAUSE_PREFIX,
  ticketOfTask,
  type OrchestrationSignal,
  type SignalDraft,
  type SignalSink,
} from "./model.js";

export const COALESCE_MS = 250;

/** The effects signals may have. Applied only when signals are set to `act`. */
export interface SignalPorts {
  wakeLoop(loopId: string): void;
  offerResume(loopId: string, offer: { ready: string[]; because: string; signalIds: string[] }): void;
  withdrawOffer(loopId: string): void;
  flag(target: { loopId?: string; planRunId?: string }, entry: ReassessmentEntry): void;
  noteTicket(ticketId: string, signalId: string, text: string): void;
}

export interface SignalServiceOptions {
  mode: () => SignalsMode;
  journal: SignalJournal;
  reads: ReconcileReads;
  ports: SignalPorts;
  /** The board, for working out what a completion made ready. */
  tickets?: () => readonly Ticket[];
  now?: () => number;
  /** Schedules the coalesced flush. Replays and tests pass one that runs at once. */
  schedule?: (run: () => void, ms: number) => { cancel(): void };
  consumers?: readonly SignalConsumer[];
  onError?: (error: unknown) => void;
}

export class SignalService implements SignalSink {
  private readonly _now: () => number;
  private readonly _schedule: (run: () => void, ms: number) => { cancel(): void };
  private readonly _consumers: readonly SignalConsumer[];
  private _pending: OrchestrationSignal[] = [];
  private _timer: { cancel(): void } | undefined;
  private _tickets = new Map<string, TicketSnapshot>();
  private _ticketsSeeded = false;
  private readonly _iterations = new Map<string, LoopIteration[]>();
  private _disposed = false;

  constructor(private readonly _options: SignalServiceOptions) {
    this._now = _options.now ?? (() => Date.now());
    this._schedule = _options.schedule ?? ((run, ms) => {
      const handle = setTimeout(run, ms);
      return { cancel: () => clearTimeout(handle) };
    });
    this._consumers = _options.consumers ?? DEFAULT_CONSUMERS;
  }

  get mode(): SignalsMode {
    try {
      return this._options.mode();
    } catch {
      return "off";
    }
  }

  // ── Sink ───────────────────────────────────────────────────────────────────

  emit(draft: SignalDraft): void {
    if (this._disposed || this.mode === "off") return;
    if (draft.causeId.startsWith(RECONCILE_CAUSE_PREFIX)) return;
    let stored: OrchestrationSignal | null;
    try {
      stored = this._options.journal.append(finalizeSignal(draft, this._now));
    } catch (error) {
      this._options.onError?.(error);
      return;
    }
    if (!stored) return;
    this._pending.push(stored);
    // A ticket finishing can make others ready: work that out while the board is in front of us.
    const ticketId = ticketOfTask(stored.taskId);
    if (stored.kind === "work_completed" && ticketId && this._options.tickets) {
      for (const follow of deriveIntegrationReady(this._options.tickets(), [ticketId], { id: stored.id, source: stored.provenance.source })) {
        this.emit(follow);
      }
    }
    this._scheduleFlush();
  }

  private _emitAll(drafts: readonly SignalDraft[]): void {
    for (const draft of drafts) this.emit(draft);
  }

  private _scheduleFlush(): void {
    if (this._timer) return;
    this._timer = this._schedule(() => {
      this._timer = undefined;
      this.flush();
    }, COALESCE_MS);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  observeReceipt(receipt: WorkReceipt): void {
    if (this.mode === "off") return;
    this._emitAll(deriveFromReceipt(receipt));
  }

  /** The board changed. The first read only learns the state; transitions after it are signals. */
  observeTickets(tickets: readonly Ticket[]): void {
    if (this.mode === "off") return;
    const seeded = this._ticketsSeeded;
    const next = new Map<string, TicketSnapshot>();
    const drafts: SignalDraft[] = [];
    for (const ticket of tickets) {
      if (seeded) drafts.push(...deriveFromTicketChange(this._tickets.get(ticket.id), ticket));
      next.set(ticket.id, snapshotTicket(ticket));
    }
    this._tickets = next;
    this._ticketsSeeded = true;
    this._emitAll(drafts);
  }

  observeLoopIterations(loopId: string, iterations: readonly LoopIteration[]): void {
    if (this.mode === "off") return;
    const previous = this._iterations.get(loopId);
    this._iterations.set(loopId, iterations.map((entry) => ({ ...entry })));
    // Like the board: what was already settled when the host first looked is not news.
    if (!previous) return;
    this._emitAll(deriveFromIterations(loopId, previous, iterations));
  }

  observePlanRunEvent(runId: string, planId: string, event: PlanRunEvent): void {
    if (this.mode === "off") return;
    this._emitAll(deriveFromPlanRunEvent(runId, planId, event));
  }

  observeRunStalled(runId: string, since: number): void {
    if (this.mode === "off") return;
    this.emit(deriveRunStalled(runId, since));
  }

  observeContractIssued(contract: WorkContract, live: readonly WorkContract[]): void {
    if (this.mode === "off") return;
    this._emitAll(deriveContractOverlap(contract, live));
  }

  // ── Consumers ──────────────────────────────────────────────────────────────

  /** Hand everything collected so far to the consumers. Exposed for tests and replays. */
  flush(): void {
    this._timer?.cancel();
    this._timer = undefined;
    const batch = this._pending;
    this._pending = [];
    if (!batch.length) return;
    this._reconcile(batch, () => batch);
  }

  /**
   * After a restart: hand each consumer whatever it had not yet reconciled. Consumers decide from
   * current state, so a signal seen twice only costs one more look, and none of them can start work.
   */
  replayPending(): void {
    if (this.mode === "off") return;
    const journal = this._options.journal;
    const lowest = Math.min(...this._consumers.map((consumer) => journal.cursor(consumer.id)));
    const backlog = journal.signalsAfter(lowest);
    if (!backlog.length) return;
    this._reconcile(backlog, (consumer) => backlog.filter((signal) => signal.seq > journal.cursor(consumer.id)));
  }

  private _reconcile(all: readonly OrchestrationSignal[], forConsumer: (consumer: SignalConsumer) => readonly OrchestrationSignal[]): void {
    const act = this.mode === "act";
    const at = new Date(this._now()).toISOString();
    const lastSeq = Math.max(...all.map((signal) => signal.seq));
    for (const consumer of this._consumers) {
      const batch = forConsumer(consumer).filter((signal) => consumer.kinds.includes(signal.kind));
      if (batch.length) {
        let actions: ReconcileAction[] = [];
        try {
          actions = consumer.reconcile(batch, this._options.reads);
        } catch (error) {
          this._options.onError?.(error);
        }
        const records: ReconcileRecord[] = [];
        for (const action of actions) {
          let applied = false;
          if (act) {
            try {
              this._apply(action);
              applied = true;
            } catch (error) {
              this._options.onError?.(error);
            }
          }
          const { target, detail } = describeAction(action);
          records.push({
            at,
            consumer: consumer.id,
            signalIds: action.type === "flag" ? [action.entry.signalId] : action.type === "note_ticket" ? [action.signalId] : action.signalIds,
            action: action.type,
            target,
            applied,
            detail,
          });
        }
        try {
          this._options.journal.record(records);
        } catch (error) {
          this._options.onError?.(error);
        }
      }
      try {
        this._options.journal.setCursor(consumer.id, lastSeq);
      } catch (error) {
        this._options.onError?.(error);
      }
    }
  }

  private _apply(action: ReconcileAction): void {
    const ports = this._options.ports;
    switch (action.type) {
      case "wake_loop":
        ports.wakeLoop(action.loopId);
        return;
      case "offer_resume":
        ports.offerResume(action.loopId, { ready: action.ready, because: action.because, signalIds: action.signalIds });
        return;
      case "withdraw_offer":
        ports.withdrawOffer(action.loopId);
        return;
      case "flag":
        ports.flag(action.target, action.entry);
        return;
      case "note_ticket":
        ports.noteTicket(action.ticketId, action.signalId, action.text);
        return;
    }
  }

  dispose(): void {
    this._disposed = true;
    this._timer?.cancel();
    this._timer = undefined;
    this._pending = [];
  }
}
