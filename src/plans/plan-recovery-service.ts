/**
 * Applies plan recovery at activation.
 *
 * Thin on purpose — every judgment lives in plan-recovery.ts, which is pure and tested. This
 * file only knows how to write what those functions decide.
 *
 * Timing is the contract: this must run at activation, before any agent session exists. At that
 * instant every `in_progress` step is provably stale, because no session survives a host
 * restart. Run later and it would race a legitimately running step and reset it mid-flight.
 */

import type { PlanningStore } from "../planning-store.js";
import { findInterruptedSteps, interruptionNote, type InterruptedStep } from "./plan-recovery.js";

export interface PlanRecoveryOutcome {
  recovered: InterruptedStep[];
  /** Steps whose recovery write was rejected or failed. Reported rather than swallowed: a step
   *  still claiming to run is exactly the lie this exists to clear. */
  failed: Array<{ step: InterruptedStep; error: string }>;
}

export class PlanRecoveryService {
  constructor(
    private readonly _planning: PlanningStore,
    private readonly _now: () => number = () => Date.now(),
  ) {}

  /**
   * Return every stranded step to `pending` with a note explaining what happened.
   *
   * `pending`, not `blocked`: an interruption is not evidence that the work is unworkable. This
   * matches how a timed-out or cancelled subagent lane is already treated
   * (AgentSession._syncSubagentStepEnd) — the two paths would otherwise disagree about what an
   * interruption means, and the plan would read differently depending on how it was cut short.
   */
  async recover(): Promise<PlanRecoveryOutcome> {
    const outcome: PlanRecoveryOutcome = { recovered: [], failed: [] };

    let interrupted: InterruptedStep[];
    try {
      interrupted = findInterruptedSteps(this._planning.read());
    } catch {
      // An unreadable planning document is not a reason to fail activation. There is also
      // nothing to report: if the document cannot be read, no step was found to be stranded.
      return outcome;
    }

    for (const step of interrupted) {
      try {
        const result = await this._planning.dispatch("update", {
          planId: step.planId,
          phaseId: step.phaseId,
          stepId: step.stepId,
          stepStatus: "pending",
          stepNote: interruptionNote(step, this._now()),
        }, { sessionId: "recovery", requestId: undefined });

        if (result.ok === false) {
          outcome.failed.push({ step, error: typeof result.error === "string" ? result.error : "The step could not be reset." });
        } else {
          outcome.recovered.push(step);
        }
      } catch (error) {
        outcome.failed.push({ step, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return outcome;
  }
}

/** One line for the activation log. Silent when there was nothing to recover, because the
 *  common case is nothing to recover and a message every launch would train people to ignore
 *  the one launch where it mattered. */
export function describeRecovery(outcome: PlanRecoveryOutcome): string {
  if (!outcome.recovered.length && !outcome.failed.length) return "";
  const parts: string[] = [];
  if (outcome.recovered.length) {
    const plans = new Set(outcome.recovered.map((step) => step.planTitle));
    parts.push(
      `Returned ${outcome.recovered.length} interrupted step(s) to pending across `
      + `${plans.size} plan(s): ${[...plans].slice(0, 3).join(", ")}.`,
    );
  }
  if (outcome.failed.length) {
    parts.push(`${outcome.failed.length} step(s) could not be reset and still read as in progress.`);
  }
  return parts.join(" ");
}
