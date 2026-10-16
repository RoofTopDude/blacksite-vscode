/**
 * Facts → signals. One function per source; each takes what the host already recorded and returns
 * drafts. Nothing here reads a file, a clock or a store.
 *
 * Cause ids are built from the fact itself (a receipt id, a ticket's status and update time, a
 * ledger position), so replaying the same facts yields the same signal ids and the journal drops
 * them as repeats.
 *
 * Pure. See docs/orchestration-p1-implementation-plan.md §3.2–§3.3.
 */

import type { LoopIteration } from "../../loops/loop-model.js";
import type { PlanRunEvent } from "../../plans/plan-run-model.js";
import type { Ticket, TicketActor, TicketEventKind, TicketStatus } from "../../ticket-store.js";
import { pathInScope, type WorkContract } from "../work-contract.js";
import type { WorkReceipt } from "../work-receipt.js";
import {
  stepTaskId,
  ticketTaskId,
  type SignalDraft,
  type SignalProvenanceSource,
  type SignalScope,
} from "./model.js";

const CLOSED: ReadonlySet<TicketStatus> = new Set<TicketStatus>(["done", "cancelled"]);

/** More granted paths than this on one receipt is worth a second look. */
export const SCOPE_EXPANSION_FLAG = 10;

function receiptTask(receipt: WorkReceipt): string {
  const subject = receipt.subject;
  if (subject.ticketId) return ticketTaskId(subject.ticketId);
  if (subject.planId && subject.phaseId && subject.stepId) return stepTaskId(subject.planId, subject.phaseId, subject.stepId);
  if (subject.laneId) return `lane:${subject.laneId}`;
  return `receipt:${receipt.id}`;
}

function receiptScope(receipt: WorkReceipt): SignalScope {
  const subject = receipt.subject;
  return {
    ...(subject.loopId ? { loopId: subject.loopId } : {}),
    ...(subject.planRunId ? { planRunId: subject.planRunId } : {}),
    ...(subject.laneId ? { laneId: subject.laneId } : {}),
    contractId: receipt.contractId,
  };
}

/** What a finished piece of contracted work means for everything around it. */
export function deriveFromReceipt(receipt: WorkReceipt): SignalDraft[] {
  const taskId = receiptTask(receipt);
  const scope = receiptScope(receipt);
  const evidence = [{ kind: "receipt" as const, ref: receipt.id }];
  const provenance = { source: "host" as const, observer: "receipt" };
  const out: SignalDraft[] = [];

  if (receipt.status === "verified" || receipt.status === "succeeded_unverified") {
    out.push({
      kind: "work_completed", taskId, causeId: receipt.id, provenance, scope, evidence,
      detail: receipt.status === "verified"
        ? `${taskId} finished, and a check covered its changes.`
        : `${taskId} finished; no passing check covered its changes.`,
      data: { receiptStatus: receipt.status },
    });
  }

  const failedChecks = receipt.evidence.flatMap((entry) => (entry.kind === "check" ? entry.failed : []));
  if (receipt.verification.result === "failed" || receipt.failure?.kind === "verification_failed") {
    out.push({
      kind: "verification_failed", taskId, causeId: receipt.id, provenance, scope, evidence,
      detail: `A check failed on ${taskId}'s changes${failedChecks.length ? `: ${failedChecks.slice(0, 3).join(", ")}` : ""}.`,
      ...(failedChecks.length ? { data: { failed: failedChecks.slice(0, 20) } } : {}),
    });
  }

  const granted = receipt.observed.granted;
  const outOfScope = receipt.observed.outOfScope;
  if (granted.length || outOfScope.length) {
    out.push({
      kind: "scope_expanded", taskId, causeId: receipt.id, provenance, scope, evidence,
      detail: outOfScope.length
        ? `${taskId} changed ${outOfScope.length} file(s) outside its contract that nothing approved.`
        : `${taskId} was approved to write ${granted.length} file(s) outside its contract.`,
      data: {
        granted: granted.slice(0, 50),
        outOfScope: outOfScope.slice(0, 50),
        // Observe-mode writes outside the territory were never asked about: they are not unauthorized,
        // they are what enforcement would have asked about.
        authorized: outOfScope.length === 0 || receipt.enforcement === "observe",
      },
    });
  }
  return out;
}

/** The parts of a ticket the signal sources compare between reads. */
export interface TicketSnapshot {
  status: TicketStatus;
  blockedBy: readonly string[];
  updatedAt: string;
}

export function snapshotTicket(ticket: Ticket): TicketSnapshot {
  return { status: ticket.status, blockedBy: [...ticket.blockedBy], updatedAt: ticket.updatedAt };
}

function provenanceOf(actor: TicketActor | undefined): SignalProvenanceSource {
  if (actor === "agent") return "model";
  if (actor === "system") return "host";
  return "user";
}

/** Who made the most recent change of this kind, from the ticket's own timeline. */
function lastActor(ticket: Ticket, kinds: readonly TicketEventKind[], to?: string): TicketActor | undefined {
  for (let index = ticket.events.length - 1; index >= 0; index -= 1) {
    const event = ticket.events[index];
    if (!event || !kinds.includes(event.kind)) continue;
    if (to !== undefined && event.kind === "status" && event.to !== to) continue;
    return event.actor;
  }
  return undefined;
}

/**
 * What changed about a ticket since the last read. The first read of a ticket is not a change:
 * the host learns the world as it is, and only transitions after that are signals.
 */
export function deriveFromTicketChange(previous: TicketSnapshot | undefined, ticket: Ticket): SignalDraft[] {
  if (!previous) return [];
  const out: SignalDraft[] = [];
  const taskId = ticketTaskId(ticket.id);
  const at = ticket.updatedAt;

  const wasClosed = CLOSED.has(previous.status);
  const isClosed = CLOSED.has(ticket.status);
  if (!wasClosed && isClosed) {
    const actor = lastActor(ticket, ["status"], ticket.status);
    out.push({
      kind: "work_completed", taskId, causeId: `ticket:${ticket.id}:${ticket.status}@${at}`,
      provenance: { source: provenanceOf(actor), observer: "ticket.status" },
      evidence: [{ kind: "ticket_event", ref: `${ticket.id}:${ticket.status}` }],
      detail: `${ticket.id} was ${ticket.status === "done" ? "closed as done" : "cancelled"}.`,
      data: { status: ticket.status },
    });
  } else if (wasClosed && !isClosed) {
    // Reopened: work counted as finished is not. Anything that went ahead on it should be looked at.
    const actor = lastActor(ticket, ["reopened", "status"]);
    out.push({
      kind: "verification_failed", taskId, causeId: `ticket:${ticket.id}:reopened@${at}`,
      provenance: { source: provenanceOf(actor), observer: "ticket.reopened" },
      evidence: [{ kind: "ticket_event", ref: `${ticket.id}:reopened` }],
      detail: `${ticket.id} was reopened after being ${previous.status === "done" ? "done" : "cancelled"}.`,
      data: { reopened: true },
    });
  }

  const added = ticket.blockedBy.filter((id) => !previous.blockedBy.includes(id));
  if (added.length) {
    const actor = lastActor(ticket, ["link"]);
    out.push({
      kind: "dependency_discovered", taskId, causeId: `ticket:${ticket.id}:blockedBy+${[...added].sort().join(",")}@${at}`,
      provenance: { source: provenanceOf(actor), observer: "ticket.blockedBy" },
      detail: `${ticket.id} now depends on ${added.join(", ")}.`,
      data: { dependsOn: added },
    });
  }
  return out;
}

/**
 * Work that became ready because something it waited on finished: an open ticket whose every
 * `blockedBy` is now closed, and a parent whose children are all in review or closed. `trigger`
 * is the signal that prompted the check; it becomes the cause, so each trigger yields one signal
 * per ready ticket.
 */
export function deriveIntegrationReady(
  tickets: readonly Ticket[],
  completedTicketIds: readonly string[],
  trigger: { id: string; source: SignalProvenanceSource },
): SignalDraft[] {
  if (!completedTicketIds.length) return [];
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const done = new Set(completedTicketIds);
  const out: SignalDraft[] = [];
  const isClosed = (id: string): boolean => {
    const ticket = byId.get(id);
    return !!ticket && CLOSED.has(ticket.status);
  };
  for (const ticket of tickets) {
    if (CLOSED.has(ticket.status)) continue;
    if (ticket.blockedBy.some((id) => done.has(id)) && ticket.blockedBy.every(isClosed)) {
      out.push({
        kind: "integration_ready", taskId: ticketTaskId(ticket.id), causeId: trigger.id,
        provenance: { source: trigger.source, observer: "ticket.blockedBy" },
        detail: `Everything ${ticket.id} depends on is closed (${ticket.blockedBy.join(", ")}).`,
        data: { reason: "dependencies_met", dependsOn: [...ticket.blockedBy] },
      });
    }
    const children = ticket.children ?? [];
    if (children.some((id) => done.has(id))
      && children.length > 0
      && children.every((id) => { const child = byId.get(id); return !!child && (CLOSED.has(child.status) || child.status === "review"); })) {
      out.push({
        kind: "integration_ready", taskId: ticketTaskId(ticket.id), causeId: `${trigger.id}:children`,
        provenance: { source: trigger.source, observer: "ticket.children" },
        detail: `Every child of ${ticket.id} is in review or closed: its parts are ready to bring together.`,
        data: { reason: "children_ready", children: [...children] },
      });
    }
  }
  return out;
}

/** Mentions of other tickets in a lane's own account of why it stopped ("blocked by BLK-9"). */
const PREREQUISITE = /\b(?:blocked by|depends on|waiting (?:on|for)|requires|needs)\b[^.\n]{0,80}?\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

/** Settled loop iterations: what a lane said it needed (model) and a lane stopped for stalling (host). */
export function deriveFromIterations(loopId: string, previous: readonly LoopIteration[], next: readonly LoopIteration[]): SignalDraft[] {
  const before = new Map(previous.map((entry) => [entry.seq, entry] as const));
  const out: SignalDraft[] = [];
  for (const iteration of next) {
    const prior = before.get(iteration.seq);
    if (!iteration.endedAt || prior?.endedAt) continue;
    const taskId = ticketTaskId(iteration.ticketId);
    const causeId = `loop:${loopId}#${iteration.seq}`;
    const scope: SignalScope = { loopId, ...(iteration.laneId ? { laneId: iteration.laneId } : {}), ...(iteration.contractId ? { contractId: iteration.contractId } : {}) };
    if (iteration.outcome === "failed" && /\b(idle|no progress|stalled|watchdog|stopped responding)\b/i.test(iteration.detail)) {
      out.push({
        kind: "progress_stalled", taskId, causeId, scope,
        provenance: { source: "host", observer: "watchdog" },
        detail: `${iteration.ticketId}'s lane stopped making progress and was ended.`,
      });
    }
    if (iteration.outcome === "failed" || iteration.outcome === "parked") {
      const mentions = new Set<string>();
      for (const match of iteration.detail.matchAll(PREREQUISITE)) if (match[1] && match[1] !== iteration.ticketId) mentions.add(match[1]);
      if (mentions.size) {
        out.push({
          kind: "dependency_discovered", taskId, causeId, scope,
          provenance: { source: "model", observer: "lane.report" },
          detail: `${iteration.ticketId}'s lane said it needs ${[...mentions].join(", ")} first.`,
          data: { dependsOn: [...mentions] },
        });
      }
    }
  }
  return out;
}

/** A ledger event's identity: stable across a restart, unlike its position in this host's memory. */
function planRunCause(runId: string, event: PlanRunEvent): string {
  const where = "stepId" in event && "phaseId" in event ? `${event.phaseId}/${event.stepId}` : "kind" in event ? String(event.kind) : "";
  return `planrun:${runId}:${event.type}:${where}@${event.at}`;
}

/** Where a plan-run ledger event means something for the work around it. */
export function deriveFromPlanRunEvent(runId: string, planId: string, event: PlanRunEvent): SignalDraft[] {
  const causeId = planRunCause(runId, event);
  const scope: SignalScope = { planRunId: runId };
  switch (event.type) {
    case "step_completed": {
      const evidence = event.evidence;
      // A step ticked off with nothing on record is the agent's account, not an observation.
      const observed = !!evidence && ((evidence.filesChanged?.length ?? 0) > 0 || (evidence.checks?.length ?? 0) > 0);
      return [{
        kind: "work_completed", taskId: stepTaskId(planId, event.phaseId, event.stepId), causeId, scope,
        provenance: observed ? { source: "host", observer: "step.evidence" } : { source: "model", observer: "plan.step" },
        detail: observed ? `Step “${event.title}” finished with evidence on record.` : `Step “${event.title}” was marked done with no evidence on record.`,
      }];
    }
    case "tripwire": {
      const run = `planrun:${runId}`;
      if (event.kind === "repeated_failure") {
        return [{ kind: "progress_stalled", taskId: run, causeId, scope, provenance: { source: "host", observer: "tripwire" }, detail: event.detail }];
      }
      if (event.kind === "check_regressed") {
        return [{ kind: "verification_failed", taskId: run, causeId, scope, provenance: { source: "host", observer: "tripwire" }, detail: event.detail, ...(event.examples ? { data: { examples: event.examples.slice(0, 10) } } : {}) }];
      }
      if (event.kind === "out_of_territory") {
        return [{ kind: "scope_expanded", taskId: run, causeId, scope, provenance: { source: "host", observer: "tripwire" }, detail: event.detail, data: { authorized: false, ...(event.examples ? { examples: event.examples.slice(0, 10) } : {}) } }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** A plan run that went quiet while a turn was live (the run's own stall attention). */
export function deriveRunStalled(runId: string, since: number): SignalDraft {
  return {
    kind: "progress_stalled", taskId: `planrun:${runId}`, causeId: `planrun:${runId}:quiet@${since}`,
    scope: { planRunId: runId },
    provenance: { source: "host", observer: "run.quiet" },
    detail: "The run has been working for a while without moving a step or changing a file.",
  };
}

/**
 * Two live contracts that may both write the same files. Only explicit territories are compared:
 * a contract that may write the whole workspace overlaps everything, and saying so every time
 * would bury the overlaps that mean something.
 */
export function deriveContractOverlap(contract: WorkContract, live: readonly WorkContract[]): SignalDraft[] {
  const mine = contract.territory.writable;
  if (mine === "workspace") return [];
  const out: SignalDraft[] = [];
  for (const other of live) {
    if (other.id === contract.id) continue;
    const theirs = other.territory.writable;
    if (theirs === "workspace") continue;
    const nested = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const shared = [
      ...mine.files.filter((file) => pathInScope(file, theirs)),
      ...theirs.files.filter((file) => pathInScope(file, mine)),
      ...mine.areas.filter((area) => theirs.areas.some((other) => nested(area, other))),
    ];
    if (!shared.length) continue;
    out.push({
      kind: "contract_conflict", taskId: `contract:${contract.id}`, causeId: `contracts:${[contract.id, other.id].sort().join("+")}`,
      scope: { contractId: contract.id },
      provenance: { source: "host", observer: "contract.issue" },
      detail: `Two running contracts may both write ${[...new Set(shared)].slice(0, 3).join(", ")}.`,
      data: { with: other.id, paths: [...new Set(shared)].slice(0, 20) },
    });
  }
  return out;
}
