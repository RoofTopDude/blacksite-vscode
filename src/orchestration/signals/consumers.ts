/**
 * Signal consumers: what the host does about what it noticed.
 *
 * Each consumer is a pure function from a batch of signals and a read-only view of current state
 * to a list of actions. The service applies the actions (or, in observe mode, only records them).
 * The action vocabulary is the whole of what signals can do — wake a running loop, tell the user a
 * loop could continue, flag something for a second look, leave a note on an open ticket. There is
 * no action that starts or resumes a loop, creates work, closes a ticket, or changes a limit or an
 * approval (plan D4, D5).
 *
 * Consumers decide from current state, never from what a signal claims (D2), so the same batch
 * delivered twice, late, or out of order leads to the same actions. And only signals the host
 * observed or a person caused can change readiness (D3); an agent's account only raises a flag.
 *
 * Pure. See docs/orchestration-p1-implementation-plan.md §3.4.
 */

import type { LoopStatus } from "../../loops/loop-model.js";
import { mayChangeState, ticketOfTask, type OrchestrationSignal, type SignalKind } from "./model.js";
import { SCOPE_EXPANSION_FLAG } from "./derive.js";

export interface ReassessmentEntry {
  signalId: string;
  kind: SignalKind;
  taskId: string;
  detail: string;
  at: string;
  source: OrchestrationSignal["provenance"]["source"];
}

export type ReconcileAction =
  | { type: "wake_loop"; loopId: string; signalIds: string[] }
  | { type: "offer_resume"; loopId: string; ready: string[]; because: string; signalIds: string[] }
  | { type: "withdraw_offer"; loopId: string; signalIds: string[] }
  | { type: "flag"; target: { loopId?: string; planRunId?: string }; entry: ReassessmentEntry }
  | { type: "note_ticket"; ticketId: string; signalId: string; text: string };

/** What a consumer may look at. Read-only by construction. */
export interface ReconcileReads {
  loops(): ReadonlyArray<{
    id: string;
    title: string;
    status: LoopStatus;
    blockedOn?: "dependencies" | "mixed";
    resumeOffer?: { ready: readonly string[] };
    /** Tickets this loop has worked on. */
    ticketIds: readonly string[];
  }>;
  isRunning(loopId: string): boolean;
  /** Ticket ids a fresh scheduling pass would dispatch for this loop right now. Dispatches nothing. */
  wouldDispatch(loopId: string): string[];
  /** Whether a ticket exists and is open (not done or cancelled). */
  ticketOpen(ticketId: string): boolean;
}

export interface SignalConsumer {
  id: string;
  kinds: readonly SignalKind[];
  reconcile(batch: readonly OrchestrationSignal[], read: ReconcileReads): ReconcileAction[];
}

/** Changes that can make queued work dispatchable, or not, when they come from an observation. */
const READINESS_KINDS: readonly SignalKind[] = [
  "work_completed", "integration_ready", "dependency_discovered", "verification_failed", "scope_expanded", "contract_conflict",
];

/** C1: a running loop re-checks its queue now, instead of when one of its lanes next finishes. */
export const loopWake: SignalConsumer = {
  id: "loop-wake",
  kinds: READINESS_KINDS,
  reconcile(batch, read) {
    const relevant = batch.filter((signal) => READINESS_KINDS.includes(signal.kind) && mayChangeState(signal));
    if (!relevant.length) return [];
    return read.loops()
      .filter((loop) => loop.status === "running" && read.isRunning(loop.id))
      .map((loop) => ({ type: "wake_loop" as const, loopId: loop.id, signalIds: relevant.map((signal) => signal.id) }));
  },
};

/**
 * C2: a loop that stopped because everything left was waiting on other tickets is told when it
 * could continue — once, and the offer is withdrawn if that stops being true. It is never started.
 */
export const loopUnblocked: SignalConsumer = {
  id: "loop-unblocked",
  kinds: READINESS_KINDS,
  reconcile(batch, read) {
    const relevant = batch.filter((signal) => READINESS_KINDS.includes(signal.kind) && mayChangeState(signal));
    if (!relevant.length) return [];
    const signalIds = relevant.map((signal) => signal.id);
    const out: ReconcileAction[] = [];
    for (const loop of read.loops()) {
      if (loop.status !== "blocked" || loop.blockedOn !== "dependencies") {
        if (loop.resumeOffer && loop.status !== "blocked") out.push({ type: "withdraw_offer", loopId: loop.id, signalIds });
        continue;
      }
      const ready = read.wouldDispatch(loop.id);
      if (!ready.length) {
        if (loop.resumeOffer) out.push({ type: "withdraw_offer", loopId: loop.id, signalIds });
        continue;
      }
      const same = loop.resumeOffer && loop.resumeOffer.ready.length === ready.length && ready.every((id) => loop.resumeOffer!.ready.includes(id));
      if (same) continue;
      // Sorted, so the same facts read the same whatever order they arrived in.
      const finished = [...new Set(relevant
        .filter((signal) => signal.kind === "work_completed")
        .map((signal) => ticketOfTask(signal.taskId))
        .filter((id): id is string => !!id))].sort();
      const because = finished.length
        ? `${finished.slice(0, 3).join(", ")} ${finished.length === 1 ? "is" : "are"} done, so “${loop.title}” can continue with ${ready.slice(0, 3).join(", ")}${ready.length > 3 ? ` and ${ready.length - 3} more` : ""}.`
        : `“${loop.title}” can continue with ${ready.slice(0, 3).join(", ")}${ready.length > 3 ? ` and ${ready.length - 3} more` : ""}.`;
      out.push({ type: "offer_resume", loopId: loop.id, ready, because, signalIds });
    }
    return out;
  },
};

function needsReassessment(signal: OrchestrationSignal): boolean {
  if (!mayChangeState(signal)) return true;
  switch (signal.kind) {
    case "verification_failed":
    case "contract_conflict":
    case "progress_stalled":
      return true;
    case "scope_expanded": {
      const granted = Array.isArray(signal.data?.granted) ? (signal.data!.granted as unknown[]).length : 0;
      return signal.data?.authorized === false || granted > SCOPE_EXPANSION_FLAG;
    }
    default:
      return false;
  }
}

/**
 * C3: things that need judgment are flagged where a person (or, for a plan run, its conductor)
 * will see them. A flag never changes anything; acting on it is someone else's decision.
 */
export const reassess: SignalConsumer = {
  id: "reassess",
  kinds: ["verification_failed", "contract_conflict", "progress_stalled", "scope_expanded", "dependency_discovered", "work_completed", "integration_ready"],
  reconcile(batch, read) {
    const out: ReconcileAction[] = [];
    const loops = read.loops();
    for (const signal of batch) {
      if (!needsReassessment(signal)) continue;
      const entry: ReassessmentEntry = {
        signalId: signal.id, kind: signal.kind, taskId: signal.taskId, detail: signal.detail, at: signal.at, source: signal.provenance.source,
      };
      if (signal.scope?.planRunId) out.push({ type: "flag", target: { planRunId: signal.scope.planRunId }, entry });
      const ticketId = ticketOfTask(signal.taskId);
      const loopIds = new Set<string>();
      if (signal.scope?.loopId) loopIds.add(signal.scope.loopId);
      if (ticketId) for (const loop of loops) if (loop.ticketIds.includes(ticketId)) loopIds.add(loop.id);
      for (const loopId of [...loopIds].sort()) out.push({ type: "flag", target: { loopId }, entry });
    }
    return out;
  },
};

/** C4: a host-observed collision or failed check is written on the open ticket it concerns. */
export const ticketNotes: SignalConsumer = {
  id: "ticket-notes",
  kinds: ["contract_conflict", "verification_failed"],
  reconcile(batch, read) {
    const out: ReconcileAction[] = [];
    for (const signal of batch) {
      if (signal.provenance.source !== "host" || (signal.kind !== "contract_conflict" && signal.kind !== "verification_failed")) continue;
      const ticketId = ticketOfTask(signal.taskId);
      if (!ticketId || !read.ticketOpen(ticketId)) continue;
      out.push({
        type: "note_ticket", ticketId, signalId: signal.id,
        text: `${signal.kind === "contract_conflict" ? "Collision" : "Check failed"}: ${signal.detail}`,
      });
    }
    return out;
  },
};

export const DEFAULT_CONSUMERS: readonly SignalConsumer[] = [loopWake, loopUnblocked, reassess, ticketNotes];

export function describeAction(action: ReconcileAction): { target: string; detail: string } {
  switch (action.type) {
    case "wake_loop":
      return { target: `loop:${action.loopId}`, detail: "Re-checked the queue." };
    case "offer_resume":
      return { target: `loop:${action.loopId}`, detail: action.because };
    case "withdraw_offer":
      return { target: `loop:${action.loopId}`, detail: "Nothing is ready any more; the offer to continue was withdrawn." };
    case "flag":
      return { target: action.target.loopId ? `loop:${action.target.loopId}` : `planrun:${action.target.planRunId}`, detail: action.entry.detail };
    case "note_ticket":
      return { target: `ticket:${action.ticketId}`, detail: action.text };
  }
}
