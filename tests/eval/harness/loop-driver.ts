/**
 * Replays a ticket-loop trace through the real LoopSupervisor, scheduler and LoopStore.
 *
 * Only the lanes and the user are scripted. Lanes resolve on a discrete-event queue in a fixed
 * order — (time, kind, ticket) — so the same trace always produces the same history. A `crash`
 * drops the supervisor and every lane it had in flight (their promises are never resolved, as a
 * dead host's would not be) and builds a new supervisor over the same on-disk store, which then
 * goes through the real `restore()` path.
 */

import { LoopStore } from "../../../src/loops/loop-store.js";
import {
  LoopSupervisor,
  type LoopDispatchRequest,
  type LoopDispatchResult,
  type LoopTicketGateway,
} from "../../../src/loops/loop-supervisor.js";
import type { LoopRecord } from "../../../src/loops/loop-model.js";
import type { WorkContractsMode } from "../../../src/orchestration/flags.js";
import type { ReceiptSummary } from "../../../src/orchestration/work-receipt.js";
import { failureSignature } from "../../../src/plans/run-tripwires.js";
import type { Ticket, TicketStatus } from "../../../src/ticket-store.js";
import { EPOCH, sequentialIds, settle, VirtualClock } from "./canonical.js";
import { costPer, receiptAgreement, type Arm, type Scorecard } from "./scorecard.js";
import { verdicts, type LaneEvent, type LoopTraceEvent, type LoopTraceHeader, type Trace, type TraceTicket } from "./trace.js";

export interface LoopReplay {
  scenario: string;
  arm: Arm;
  loop: Record<string, unknown>;
  tickets: Array<{ id: string; status: string }>;
  ticketLog: Array<{ at: number; id: string; kind: string; note: string }>;
  hooks: Array<{ at: number; hook: string; detail: string }>;
  scorecard: Scorecard;
}

function toTicket(input: TraceTicket, index: number): Ticket {
  return {
    id: input.id,
    title: input.title ?? `Ticket ${input.id}`,
    status: "backlog",
    statusSource: "manual",
    priority: input.priority ?? "normal",
    complexity: input.complexity ?? "small",
    labels: [],
    acceptanceCriteria: input.acceptanceCriteria ?? ["Its tests pass"],
    territory: { files: input.files ?? [], areas: input.areas ?? [] },
    references: [],
    runIds: [],
    blockedBy: input.blockedBy ?? [],
    blocks: [],
    relatedTo: [],
    children: [],
    assignee: "agent",
    origin: "user",
    events: [],
    createdAt: new Date(Date.parse("2025-12-31T00:00:00.000Z") + index * 1000).toISOString(),
    updatedAt: "2025-12-31T00:00:00.000Z",
  } as Ticket;
}

/** The ticket board, in memory. Records every note the loop leaves, in order. */
class ReplayTickets implements LoopTicketGateway {
  readonly log: LoopReplay["ticketLog"] = [];
  constructor(private _tickets: Ticket[], private readonly _clock: VirtualClock) {}
  tickets(): readonly Ticket[] { return this._tickets; }
  indexedFiles(): readonly string[] { return [...new Set(this._tickets.flatMap((ticket) => ticket.territory.files))].sort(); }
  private _set(id: string, status: TicketStatus): void {
    this._tickets = this._tickets.map((ticket) => (ticket.id === id ? { ...ticket, status } : ticket));
  }
  private _note(id: string, kind: string, note: string): void {
    this.log.push({ at: this._clock.elapsed(this._clock.now) ?? 0, id, kind, note: note.slice(0, 200) });
  }
  moveToReview(id: string, note: string): void { this._set(id, "review"); this._note(id, "review", note); }
  noteAttempt(id: string, note: string): void { this._note(id, "attempt", note); }
  blockTicket(id: string, note: string): void { this._set(id, "blocked"); this._note(id, "blocked", note); }
  releaseBlocked(id: string, note: string): void { this._set(id, "backlog"); this._note(id, "released", note); }
}

interface Pending {
  generation: number;
  ticket: string;
  endAt: number;
  resolve: (result: LoopDispatchResult) => void;
  result: LoopDispatchResult;
  spend: Array<[number, number]>;
  request: LoopDispatchRequest;
  startedAt: number;
}

type Timed =
  | { kind: 0; at: number; ticket: string; apply: () => void }
  | { kind: 1; at: number; ticket: string; apply: () => void }
  | { kind: 2; at: number; ticket: string; apply: () => void };

export async function replayLoop(
  trace: Trace<LoopTraceHeader, LoopTraceEvent>,
  options: { dir: string; arm: Arm; workContracts: WorkContractsMode },
): Promise<LoopReplay> {
  const clock = new VirtualClock();
  const ids = sequentialIds();
  const elapsed = (): number => clock.elapsed(clock.now) ?? 0;
  const store = new LoopStore(options.dir, { now: clock.read, newId: ids });
  store.ensureInitialized();
  const tickets = new ReplayTickets(trace.header.setup.tickets.map(toTicket), clock);
  const hooks: LoopReplay["hooks"] = [];
  const lanes = new Map<string, LaneEvent>();
  for (const event of trace.events) if (event.op === "lane") lanes.set(`${event.ticket}#${event.attempt}`, event);
  const attempts = new Map<string, number>();
  const pending: Pending[] = [];
  const touched: Array<{ ticket: string; startedAt: number; endedAt: number; files: string[] }> = [];
  const receipts: Array<{ ticket: string; status: string }> = [];
  const failures = new Map<string, number>();
  let generation = 0;

  const dispatcher = {
    dispatch: (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
      const attempt = (attempts.get(request.ticket.id) ?? 0) + 1;
      attempts.set(request.ticket.id, attempt);
      const script = lanes.get(`${request.ticket.id}#${attempt}`);
      if (options.workContracts !== "off") request.onContract?.(ids("wc"));
      const startedAt = elapsed();
      const base: LoopDispatchResult = { ok: false, detail: "No lane was scripted for this attempt.", filesTouched: [], runIds: [] };
      const result: LoopDispatchResult = script ? { ...base, detail: script.result.ok ? "Done." : "Failed.", ...script.result } : base;
      // The real dispatcher reports what it priced; the scripted lane reports what it spent.
      if (script?.spend?.length && result.usd === undefined) {
        result.usd = Math.round(script.spend.reduce((sum, [, usd]) => sum + usd, 0) * 10_000) / 10_000;
      }
      if (script?.receipt && options.workContracts !== "off") {
        const summary: ReceiptSummary = {
          id: ids("receipt"),
          contractId: `contract_for_${request.ticket.id}_${attempt}`,
          enforcement: options.workContracts === "enforce" ? "enforce" : "observe",
          status: script.receipt,
          filesChanged: result.filesTouched.length,
          uncovered: script.receipt === "succeeded_unverified" ? [...result.filesTouched] : [],
          outOfScope: [],
          next: script.receipt === "failed" ? "A check failed on the changed files." : script.receipt === "succeeded_unverified" ? "Not verified: no passing check covered the changes." : "Ready for review.",
        };
        result.receipt = summary;
        receipts.push({ ticket: request.ticket.id, status: script.receipt });
      }
      return new Promise<LoopDispatchResult>((resolve) => {
        const entry: Pending = {
          generation,
          ticket: request.ticket.id,
          endAt: startedAt + (script?.durationMs ?? 1000),
          resolve,
          result,
          spend: script?.spend ?? [],
          request,
          startedAt,
        };
        pending.push(entry);
        // A stopped loop aborts its lanes; the lane ends at once, cut off.
        request.signal.addEventListener("abort", () => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1);
          resolve({ ok: false, detail: "Cancelled.", filesTouched: [], runIds: [] });
        }, { once: true });
      });
    },
  };

  const makeSupervisor = (): LoopSupervisor => new LoopSupervisor(store, tickets, dispatcher, {
    notify: (_loopId, message) => hooks.push({ at: elapsed(), hook: "notify", detail: message.slice(0, 160) }),
    onSettled: (_loopId, _title, status, reason) => hooks.push({ at: elapsed(), hook: `settled:${status}`, detail: reason.slice(0, 160) }),
    onParked: (_loopId, _title, ticketId, gate) => hooks.push({ at: elapsed(), hook: "parked", detail: `${ticketId}:${gate}` }),
    onReleased: (_loopId, ticketId) => hooks.push({ at: elapsed(), hook: "released", detail: ticketId }),
    onAbandonedContract: (contractId, subject) => hooks.push({ at: elapsed(), hook: "abandoned_contract", detail: `${contractId}:${subject.ticketId}` }),
  }, clock.read, ids);

  const loopRecord = store.create({ title: trace.header.setup.loop.title ?? trace.header.scenario, ...trace.header.setup.loop });
  const loopId = loopRecord.definition.id;
  let supervisor = makeSupervisor();
  let interventions = 0;

  const external = trace.events
    .filter((event): event is Extract<LoopTraceEvent, { op: "user" | "crash" }> => event.op === "user" || event.op === "crash")
    .sort((a, b) => a.at - b.at);

  const applyExternal = (event: Extract<LoopTraceEvent, { op: "user" | "crash" }>): void => {
    if (event.op === "crash") {
      // The host died: every lane in flight is gone with it.
      generation += 1;
      pending.splice(0, pending.length);
      supervisor = makeSupervisor();
      supervisor.restore();
      hooks.push({ at: elapsed(), hook: "crash", detail: "" });
      return;
    }
    if (event.action !== "start") interventions += 1;
    switch (event.action) {
      case "start":
      case "resume":
        supervisor.start(loopId);
        break;
      case "pause":
        supervisor.pause(loopId);
        break;
      case "stop":
        supervisor.stop(loopId);
        break;
      case "release":
        if (event.ticket) supervisor.releasePark(loopId, event.ticket);
        break;
    }
  };

  for (let step = 0; step < 10_000; step += 1) {
    await settle();
    const timed: Timed[] = [];
    for (const lane of pending) {
      if (lane.generation !== generation) continue;
      const spend = lane.spend[0];
      if (spend) {
        timed.push({ kind: 0, at: Math.max(lane.startedAt + spend[0], elapsed()), ticket: lane.ticket, apply: () => {
          lane.spend = lane.spend.slice(1);
          lane.request.onSpend?.(spend[1]);
        } });
      }
      timed.push({ kind: 1, at: lane.endAt, ticket: lane.ticket, apply: () => {
        pending.splice(pending.indexOf(lane), 1);
        touched.push({ ticket: lane.ticket, startedAt: lane.startedAt, endedAt: lane.endAt, files: lane.result.filesTouched });
        if (!lane.result.ok && !lane.result.parkedOnGate) {
          const signature = failureSignature("lane", lane.result.detail);
          failures.set(signature, (failures.get(signature) ?? 0) + 1);
        }
        lane.resolve(lane.result);
      } });
    }
    const next = external[0];
    if (next) timed.push({ kind: 2, at: next.at, ticket: "", apply: () => { external.shift(); applyExternal(next); } });
    if (timed.length === 0) break;
    timed.sort((a, b) => a.at - b.at || a.kind - b.kind || a.ticket.localeCompare(b.ticket));
    const first = timed[0]!;
    clock.now = Math.max(clock.now, EPOCH + first.at);
    first.apply();
  }
  await settle();

  const record = store.get(loopId)!;
  const verdict = verdicts(trace.events);
  const finalTickets = tickets.tickets().map((ticket) => ({ id: ticket.id, status: ticket.status }));
  const selfReported = finalTickets.filter((ticket) => ticket.status === "review");
  const verified = selfReported.filter((ticket) => verdict.get(ticket.id) === "pass").length;
  const falseCompletions = selfReported.filter((ticket) => verdict.get(ticket.id) !== "pass").length;
  let occurred = 0;
  for (let i = 0; i < touched.length; i += 1) {
    for (let j = i + 1; j < touched.length; j += 1) {
      const a = touched[i]!;
      const b = touched[j]!;
      const overlap = a.startedAt < b.endedAt && b.startedAt < a.endedAt;
      if (overlap && a.ticket !== b.ticket && a.files.some((file) => b.files.includes(file))) occurred += 1;
    }
  }
  const dispatchedTickets = new Set(record.iterations.map((iteration) => iteration.ticketId));
  const latestReceipt = new Map<string, string>();
  for (const entry of receipts) latestReceipt.set(entry.ticket, entry.status);
  const agreement = { agree: 0, disagree: 0, unknown: 0 };
  for (const ticket of finalTickets) {
    const status = latestReceipt.get(ticket.id);
    if (status === undefined) continue;
    agreement[receiptAgreement(status, verdict.get(ticket.id))] += 1;
  }
  const endedReason = record.definition.endedReason ?? "";
  const scorecard: Scorecard = {
    scenario: trace.header.scenario,
    subject: "loop",
    arm: options.arm,
    subjects: finalTickets.length,
    verifiedSuccess: verified,
    selfReportedSuccess: selfReported.length,
    falseCompletions,
    elapsedMs: elapsed(),
    costUsd: Math.round(record.totals.usd * 10_000) / 10_000,
    costPerVerifiedSuccess: costPer(record.totals.usd, verified),
    interventions,
    repeatedFailures: [...failures.values()].filter((count) => count > 1).length,
    conflicts: { occurred },
    retries: record.iterations.filter((iteration) => iteration.outcome !== "parked").length - dispatchedTickets.size,
    parks: record.totals.parked,
    abandoned: record.iterations.filter((iteration) => iteration.outcome === "abandoned").length,
    halts: /in a row/.test(endedReason) ? 1 : 0,
    budgetStops: /spend ceiling/.test(endedReason) ? 1 : 0,
    ...(receipts.length ? { receipts: agreement } : {}),
  };

  store.dispose();
  return {
    scenario: trace.header.scenario,
    arm: options.arm,
    loop: describeLoop(record, clock),
    tickets: finalTickets,
    ticketLog: tickets.log,
    hooks,
    scorecard,
  };
}

function describeLoop(record: LoopRecord, clock: VirtualClock): Record<string, unknown> {
  return {
    status: record.definition.status,
    endedReason: record.definition.endedReason,
    totals: record.totals,
    executions: record.executions.map((execution) => ({ status: execution.status, reason: execution.reason, totals: execution.totals })),
    iterations: record.iterations.map((iteration) => ({
      seq: iteration.seq,
      ticketId: iteration.ticketId,
      outcome: iteration.outcome,
      detail: iteration.detail.slice(0, 200),
      startedAt: clock.elapsed(iteration.startedAt),
      endedAt: clock.elapsed(iteration.endedAt),
      usd: iteration.usd,
      contractId: iteration.contractId,
      receiptId: iteration.receiptId,
      receiptStatus: iteration.receiptStatus,
    })),
    ticketState: record.ticketState,
  };
}
