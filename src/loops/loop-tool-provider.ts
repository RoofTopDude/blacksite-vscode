/**
 * The agent-facing surface for ticket loops.
 *
 * Two operations, both configuration-only. Neither dispatches: `propose` writes a draft, and a
 * draft is inert until a user starts it from the Loops view with the ceilings and matched
 * tickets on screen. `control` may pause or stop a loop, and may *lower* a ceiling — never
 * raise one, and never start.
 *
 * That asymmetry is the whole safety model. The model is good at triage and bad at judging when
 * it is safe to spend several hours of unattended compute on the user's machine, so it gets the
 * first job and not the second.
 */

import { proposeLoop } from "./loop-proposal.js";
import { defaultApprovalPosture, defaultQueueSpec, type LoopCeilings, type LoopQueueSpec } from "./loop-model.js";
import { MAX_LOOP_CONCURRENCY, type LoopStore } from "./loop-store.js";
import type { LoopSupervisor } from "./loop-supervisor.js";
import type { Ticket, TicketPriority, TicketStatus } from "../ticket-store.js";

export interface LoopToolContext {
  sessionId: string;
}

export interface LoopToolProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: LoopToolContext): Promise<Record<string, unknown>>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function queueFromPayload(payload: Record<string, unknown>): LoopQueueSpec {
  const base = defaultQueueSpec();
  const statuses = stringList(payload.statuses) as TicketStatus[];
  const priorities = stringList(payload.priorities) as TicketPriority[];
  return {
    statuses: statuses.length ? statuses : base.statuses,
    labels: stringList(payload.labels),
    priorities,
    areas: stringList(payload.areas),
    ids: stringList(payload.ticketIds),
    respectBlockedBy: payload.respectBlockedBy !== false,
  };
}

export class LoopToolService implements LoopToolProvider {
  constructor(
    private readonly _store: LoopStore,
    private readonly _supervisor: LoopSupervisor,
    private readonly _tickets: () => readonly Ticket[],
    private readonly _indexedFiles: () => readonly string[],
    /** Nudges the tree to redraw after a write. */
    private readonly _onChange: () => void = () => {},
  ) {}

  async dispatch(op: string, payload: Record<string, unknown>, ctx: LoopToolContext): Promise<Record<string, unknown>> {
    switch (op) {
      case "propose": return this._propose(payload, ctx);
      case "control": return this._control(payload);
      case "list": return this._list();
      default: return { ok: false, error: `Unknown loop operation: ${op}` };
    }
  }

  private _propose(payload: Record<string, unknown>, ctx: LoopToolContext): Record<string, unknown> {
    const title = String(payload.title ?? "").trim();
    if (!title) return { ok: false, error: "A loop needs a title describing what it is working through." };

    const queue = queueFromPayload(payload);
    const proposal = proposeLoop(this._tickets(), queue, this._indexedFiles());

    if (!proposal.matchedTicketIds.length) {
      return {
        ok: false,
        error: "That query matches no open tickets, so there is nothing to propose.",
        nextStep: "Widen the query, or file the tickets first with ticket_file.",
      };
    }

    const concurrency = Math.max(1, Math.min(
      MAX_LOOP_CONCURRENCY,
      Number(payload.concurrency) || proposal.recommendedConcurrency,
    ));

    const record = this._store.create({
      title,
      queue,
      workers: { concurrency },
      // Ceilings the model asked for are accepted here because a draft cannot spend anything;
      // the user sees them before starting, and control() can only ever lower them after.
      ceilings: ceilingsFromPayload(payload),
      approvals: defaultApprovalPosture(),
    });
    this._onChange();

    return {
      ok: true,
      loopId: record.definition.id,
      status: "draft",
      title: record.definition.title,
      matchedTickets: proposal.matchedTicketIds,
      firstWave: proposal.firstWave,
      withheld: proposal.withheld,
      recommendedConcurrency: proposal.recommendedConcurrency,
      concurrencyBasis: proposal.concurrencyBasis,
      configuredConcurrency: concurrency,
      estimate: proposal.estimate,
      concerns: proposal.concerns,
      sessionId: ctx.sessionId,
      nextStep: "This is a DRAFT and will not run. Show the user the matched tickets, the cost "
        + "estimate, and any concerns above, then tell them to start it from the Loops view — "
        + "starting a loop is their decision, not yours. Every ticket a loop completes goes to "
        + "review; the loop never closes one.",
    };
  }

  private _control(payload: Record<string, unknown>): Record<string, unknown> {
    const action = String(payload.action ?? "").trim();
    if (action === "list") return this._list();

    const loopId = String(payload.loopId ?? "").trim();
    const record = this._store.get(loopId);
    if (!record) return { ok: false, error: `No loop with id ${loopId || "(none given)"}.` };

    switch (action) {
      case "inspect":
        return {
          ok: true,
          loopId,
          title: record.definition.title,
          status: record.definition.status,
          totals: record.totals,
          executions: record.executions.slice(-20).map((execution) => ({
            id: execution.id,
            status: execution.status,
            startedAt: execution.startedAt,
            endedAt: execution.endedAt,
            reason: execution.reason,
            spendUsd: Number(execution.totals.usd.toFixed(4)),
            attempted: execution.totals.dispatched,
            succeeded: execution.totals.succeeded,
            failed: execution.totals.failed,
            reviewBlocked: execution.totals.parked,
          })),
          recentLanes: record.iterations.slice(-30).map((iteration) => ({
            ticketId: iteration.ticketId,
            executionId: iteration.executionId,
            laneId: iteration.laneId,
            outcome: iteration.outcome,
            detail: iteration.detail,
            startedAt: iteration.startedAt,
            endedAt: iteration.endedAt,
            activity: iteration.activity.slice(-30),
          })),
          nextStep: "Use the lane activity and continuation-review decisions above to explain progress. "
            + "You may pause or stop the loop, or lower a ceiling; only the user can start/resume it or release a safety block.",
        };

      case "pause":
        this._supervisor.pause(loopId);
        this._onChange();
        return { ok: true, loopId, status: "paused", nextStep: "In-flight lanes will finish; none will start." };

      case "stop":
        this._supervisor.stop(loopId, "Stopped by the agent.");
        this._onChange();
        return { ok: true, loopId, status: "stopped" };

      case "lower_ceilings": {
        const requested = ceilingsFromPayload(payload);
        const lowered = lowerOnly(record.definition.ceilings, requested);
        this._store.update(loopId, (live) => { live.definition.ceilings = lowered; });
        this._onChange();
        return {
          ok: true,
          loopId,
          ceilings: lowered,
          nextStep: "Ceilings can only be lowered. Any value above the current one was ignored — "
            + "raising a ceiling is the user's decision, from the Loops view.",
        };
      }

      case "start":
        return {
          ok: false,
          error: "An agent cannot start a loop.",
          nextStep: "Starting a loop commits the user to unattended spend, so it is theirs to do "
            + "from the Loops view. Tell them the loop is ready and what it will cost.",
        };

      default:
        return { ok: false, error: `Unknown loop action: ${action || "(none)"}. Use pause, stop, or lower_ceilings.` };
    }
  }

  private _list(): Record<string, unknown> {
    return {
      ok: true,
      loops: this._store.read().loops.map((record) => ({
        loopId: record.definition.id,
        title: record.definition.title,
        status: record.definition.status,
        concurrency: record.definition.workers.concurrency,
        attempted: record.totals.dispatched,
        awaitingReview: record.totals.succeeded,
        failed: record.totals.failed,
        parked: record.totals.parked,
        usd: Number(record.totals.usd.toFixed(2)),
        currentExecution: record.executions.at(-1) ? {
          id: record.executions.at(-1)!.id,
          usd: Number(record.executions.at(-1)!.totals.usd.toFixed(2)),
          attempted: record.executions.at(-1)!.totals.dispatched,
        } : undefined,
        activeLanes: record.iterations.filter((iteration) => !iteration.endedAt).map((iteration) => ({
          ticketId: iteration.ticketId,
          laneId: iteration.laneId,
          startedAt: iteration.startedAt,
        })),
        ...(record.definition.endedReason ? { endedReason: record.definition.endedReason } : {}),
      })),
    };
  }
}

function ceilingsFromPayload(payload: Record<string, unknown>): LoopCeilings {
  const num = (key: string): number | undefined => {
    const parsed = Number(payload[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const consecutive = num("maxConsecutiveFailures");
  return {
    ...(num("maxTickets") ? { maxTickets: num("maxTickets") } : {}),
    ...(num("maxUsd") ? { maxUsd: num("maxUsd") } : {}),
    ...(num("maxWallClockMinutes") ? { maxWallClockMs: num("maxWallClockMinutes")! * 60_000 } : {}),
    maxConsecutiveFailures: consecutive ?? 3,
  };
}

/**
 * Merge requested ceilings, keeping whichever is tighter.
 *
 * Written as an explicit min rather than a validation-and-reject because the model should not be
 * able to widen a budget by *accident* either — silently clamping is the behaviour that holds
 * even when the caller was not trying to cheat.
 */
export function lowerOnly(current: LoopCeilings, requested: LoopCeilings): LoopCeilings {
  const tighter = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  };
  return {
    ...(tighter(current.maxTickets, requested.maxTickets) != null
      ? { maxTickets: tighter(current.maxTickets, requested.maxTickets) } : {}),
    ...(tighter(current.maxUsd, requested.maxUsd) != null
      ? { maxUsd: tighter(current.maxUsd, requested.maxUsd) } : {}),
    ...(tighter(current.maxWallClockMs, requested.maxWallClockMs) != null
      ? { maxWallClockMs: tighter(current.maxWallClockMs, requested.maxWallClockMs) } : {}),
    maxConsecutiveFailures: Math.min(current.maxConsecutiveFailures, requested.maxConsecutiveFailures),
  };
}
