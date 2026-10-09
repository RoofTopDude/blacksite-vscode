/**
 * Runs the conductor when a plan stalls, and acts on its ruling.
 *
 * Thin: every judgment lives in plan-continuation.ts and continuation-model.ts, both pure. This
 * file owns the two things those cannot — the consecutive-continuation counter, and the serial
 * queue that lets a continued turn request the next decision without overlapping the one that
 * launched it.
 */

import {
  continuationAction,
  continuationGate,
  activeExecutingPlan,
  DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
  type ContinuationAction,
  type ContinuationGate,
} from "./plan-continuation.js";
import { buildPlanBrief } from "./plan-recovery.js";
import { decideContinuation, type ContinuationModel, type ContinuationTrigger } from "../continuation/continuation-model.js";
import type { PlanningStore } from "../planning-store.js";

export interface PlanContinuationHooks {
  /** Feed a message back into the agent as a new turn. */
  continueWith(message: string, rationale: string): Promise<void>;
  /** Report a halt or an escalation. Never routed back to the executor — see continuationAction. */
  report(kind: "halt" | "ask", message: string): void;
  /** Optional trace for the transcript, so a continuation is never invisible. */
  trace?(message: string): void;
}

export interface PlanContinuationSettings {
  enabled: boolean;
  maxConsecutive: number;
}

/**
 * What a plan run tells the conductor. Absent when no run is active, in which case the conductor
 * behaves as it always has (settings-driven, counting its own continuations).
 */
export interface PlanContinuationRunContext {
  /** The run steering the conductor, only while it is running (not paused, waiting or ended). */
  active(): { planId: string; consecutive: number } | undefined;
  /** What the harness observed in the turn that just ended. */
  digest(): string | undefined;
  /** Decisions already taken this run, so the same question is not asked twice. */
  priorDecisions(): string[];
  /** Times each step moved to in_progress, keyed `phaseId/stepId` (step ids repeat across phases). */
  ledgerAttempts(): ReadonlyMap<string, number>;
  /** A fact the harness knows better than the message does (a step went blocked). */
  triggerHint(): ContinuationTrigger | undefined;
  /** The conductor ruled. */
  record(decision: { trigger: ContinuationTrigger | undefined; kind: "continue" | "halt" | "ask"; text: string }): void;
  /** A run exists but is not running (paused, waiting on the user, interrupted, failed). The
   *  conductor must not continue it, whatever the global setting says. */
  holds(): boolean;
  /** The conductor will not continue the run (it halted, asked, or ran out of budget). */
  stopped(kind: "halt" | "ask" | "budget", message: string): void;
}

export interface PlanTurnOutcome {
  stopReason: string;
  errored: boolean;
  awaitingUser: boolean;
  lastMessage: string;
}

export class PlanContinuationService {
  private _consecutive = 0;
  /** True while a continuation decision or its resulting turn is in flight. Without this, the
   *  turn a continuation starts would itself end and trigger another decision on top of the
   *  first, and the consecutive counter would never see either. */
  private _busy = false;
  /** The continuation-authored turn can finish while its parent decision is still awaiting
   *  `continueWith`. Keep that settled outcome and evaluate it once the current decision fully
   *  unwinds, so long plans can continue serially without overlapping model calls. */
  private _pendingOutcome?: PlanTurnOutcome;

  constructor(
    private readonly _planning: PlanningStore,
    private readonly _model: () => ContinuationModel | null,
    private readonly _userPrompts: () => string[],
    private readonly _settings: () => PlanContinuationSettings,
    private readonly _hooks: PlanContinuationHooks,
    private readonly _run?: PlanContinuationRunContext,
  ) {}

  /** The user spoke, so the runaway budget resets. This is the only evidence that a human is
   *  still engaged, which is exactly what the budget exists to require. */
  noteUserMessage(): void {
    this._consecutive = 0;
  }

  get consecutive(): number {
    return this._consecutive;
  }

  /**
   * Decide and act after an agent turn ends.
   *
   * Returns the gate result so a caller (or a test) can see why nothing happened. Never throws:
   * a continuation failing is not a reason to disturb the turn that just finished.
   */
  async afterTurn(outcome: PlanTurnOutcome): Promise<ContinuationGate> {
    if (this._busy) {
      this._pendingOutcome = outcome;
      return { ask: false, reason: "turn_failed", detail: "Queued behind the continuation already in flight." };
    }

    if (this._run?.holds()) {
      return { ask: false, reason: "awaiting_user", detail: "The plan run is not running, so it will not be continued automatically." };
    }

    const settings = this._settings();
    // An active plan run turns the conductor on for itself, names its plan, and counts only the
    // automatic turns that moved nothing — a run making steady progress is not a runaway.
    const run = this._run?.active();
    let plan = null;
    try {
      plan = activeExecutingPlan(this._planning.read().plans, run?.planId);
    } catch {
      // An unreadable planning document is not a reason to fail the turn.
    }

    const gate = continuationGate({
      enabled: settings.enabled || !!run,
      plan,
      stopReason: outcome.stopReason,
      errored: outcome.errored,
      awaitingUser: outcome.awaitingUser,
      consecutive: run ? run.consecutive : this._consecutive,
      maxConsecutive: settings.maxConsecutive || DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS,
      lastMessage: outcome.lastMessage,
      triggerHint: run ? this._run?.triggerHint() : undefined,
    });

    if (!gate.ask) {
      // Worth surfacing: a user who turned continuation on and sees it stop should be told it
      // hit its budget rather than left wondering whether the feature works.
      if (gate.reason === "budget_exhausted") {
        this._hooks.report("ask", gate.detail);
        if (run) this._run?.stopped("budget", gate.detail);
      }
      return gate;
    }

    const model = this._model();
    if (!model || !plan) {
      return { ask: false, reason: "disabled", detail: "No model is configured to run the conductor." };
    }

    this._busy = true;
    try {
      this._hooks.trace?.("Asking the conductor whether this plan should continue…");

      const prior = run ? this._run?.priorDecisions() : undefined;
      const verdict = await decideContinuation(model, buildPlanBrief({
        plan,
        userPrompts: this._userPrompts(),
        executorLastMessage: outcome.lastMessage,
        trigger: gate.trigger,
        ...(prior?.length ? { priorDecisions: prior } : {}),
        ...(run ? { turnDigest: this._run?.digest(), ledgerAttempts: this._run?.ledgerAttempts() } : {}),
      }));

      const action = continuationAction(verdict);
      if (run) {
        this._run?.record({
          trigger: gate.trigger,
          kind: action.kind === "send" ? "continue" : action.kind,
          text: action.kind === "send" ? action.rationale : action.kind === "halt" ? action.message : action.question,
        });
      }
      await this._act(action, !!run);
    } catch (error) {
      // decideContinuation already converts a provider failure into a halt, so reaching here
      // means something else broke. Report rather than continue: an unexplained failure is not
      // permission to keep working unattended.
      this._hooks.report("halt", `The conductor could not decide, so the plan was not continued: ${
        error instanceof Error ? error.message : String(error)
      }`);
    } finally {
      this._busy = false;
      const pending = this._pendingOutcome;
      this._pendingOutcome = undefined;
      if (pending) {
        // Do not recurse on the continuation turn's call stack. Apart from being easier to reason
        // about, the microtask boundary lets the just-finished send path publish its settled UI
        // state before another conductor decision begins.
        queueMicrotask(() => { void this.afterTurn(pending); });
      }
    }

    return gate;
  }

  private async _act(action: ContinuationAction, inRun = false): Promise<void> {
    if (action.kind === "send") {
      this._consecutive += 1;
      await this._hooks.continueWith(action.message, action.rationale);
      return;
    }
    // A halt or an escalation both end the automatic run. Resetting the counter here means a
    // user who resolves the issue and says "go on" starts from a full budget rather than an
    // exhausted one they never spent.
    this._consecutive = 0;
    const message = action.kind === "halt" ? action.message : `${action.question}\n\n${action.why}`.trim();
    this._hooks.report(action.kind === "halt" ? "halt" : "ask", message);
    if (inRun) this._run?.stopped(action.kind === "halt" ? "halt" : "ask", message);
  }
}
