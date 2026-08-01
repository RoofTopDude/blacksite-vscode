/**
 * Making a plan survive the thing that actually kills long-horizon work: stopping.
 *
 * Two failures, both silent today.
 *
 * **The lie.** A step is marked `in_progress` the moment its work is delegated. If the host
 * restarts — a reload, a crash, closing the window — nothing ever unmarks it. The plan now
 * claims a step is running that nothing is running, and the next session reads that claim and
 * believes it. It will either wait for work that will never finish or skip a step that never
 * started. No agent session outlives the extension host, so at activation any `in_progress`
 * step is provably stale, which makes this cheap to detect and inexcusable to leave.
 *
 * **The dead end.** A step that fails twice sits `blocked` with an error in its notes and no
 * path forward. Something has to look at it and decide. That decision is the conductor's
 * (continuation-model.ts), and this module builds the brief it decides from.
 *
 * Pure — no vscode, no store, no clock beyond an injected `now`. The host wrapper applies what
 * these functions return.
 */

import type { PlanningDocument, TaskPlan, TaskPlanPhase, TaskPlanStep } from "../planning-store.js";
import type { ContinuationBrief, ContinuationStepBrief, ContinuationTrigger } from "../continuation/continuation-model.js";

/** Plan statuses whose steps are still the agent's business. An archived or cancelled plan is
 *  not recovered — its stale steps are history, not unfinished work. */
const LIVE_PLAN_STATUSES: ReadonlySet<string> = new Set(["active", "on_hold", "blocked", "draft"]);

export interface InterruptedStep {
  planId: string;
  planTitle: string;
  phaseId: string;
  phaseTitle: string;
  stepId: string;
  stepTitle: string;
  /** When the step was last written. How long the lie has been standing. */
  updatedAt: string;
}

/**
 * Steps that claim to be running with nothing running them.
 *
 * Call this at activation, before any session starts. At that instant the claim is provably
 * false for every `in_progress` step in the document — there is no live executor to own one.
 * Calling it later would race a legitimately running step and reset it mid-flight, so the
 * timing is part of the contract rather than an implementation detail.
 */
export function findInterruptedSteps(document: PlanningDocument): InterruptedStep[] {
  const out: InterruptedStep[] = [];
  for (const plan of document.plans) {
    if (!LIVE_PLAN_STATUSES.has(plan.status)) continue;
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        if (step.status !== "in_progress") continue;
        out.push({
          planId: plan.id,
          planTitle: plan.title,
          phaseId: phase.id,
          phaseTitle: phase.title,
          stepId: step.id,
          stepTitle: step.title,
          updatedAt: step.updatedAt,
        });
      }
    }
  }
  return out;
}

/**
 * The note left on a recovered step.
 *
 * Written for whoever reads the plan next — a later session, or the user. It has to be
 * unmistakable that the step was interrupted rather than attempted and failed, because those
 * call for different next actions: one wants resuming, the other wants rethinking.
 */
export function interruptionNote(step: InterruptedStep, now: number): string {
  const since = elapsedLabel(now - Date.parse(step.updatedAt));
  return `Returned to pending by recovery: this step was marked in progress ${since}, but the `
    + `extension host restarted and no agent was running it. Any work it completed is on disk — `
    + `check before redoing it.`;
}

function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "earlier";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * How many times this step has been tried.
 *
 * Counted from its own notes rather than stored in a new field. Every attempt already leaves a
 * note — the subagent step sync writes one on both start and finish — so the record exists; a
 * parallel counter could disagree with it, and when a counter and its evidence disagree the
 * counter is the one that is wrong.
 */
const ATTEMPT_NOTE_MARKERS = ["Delegated to a subagent lane", "Subagent lane failed", "Subagent lane interrupted"];

export function attemptsFor(step: TaskPlanStep): number {
  return step.notes.filter((note) => ATTEMPT_NOTE_MARKERS.some((marker) => note.includes(marker))).length;
}

function toStepBrief(step: TaskPlanStep): ContinuationStepBrief {
  return {
    title: step.title,
    ...(step.detail ? { detail: step.detail } : {}),
    ...(step.acceptanceCriteria ? { acceptanceCriteria: step.acceptanceCriteria } : {}),
    // The most recent note is the one that says what happened; earlier ones are history the
    // conductor does not need and would pay for.
    ...(step.notes.length ? { note: step.notes[step.notes.length - 1]! } : {}),
  };
}

/** The step the plan is actually on: the first in_progress step, else the first pending one. */
export function currentStepOf(plan: TaskPlan): { phase: TaskPlanPhase; step: TaskPlanStep } | null {
  for (const status of ["in_progress", "pending"] as const) {
    for (const phase of plan.phases) {
      if (phase.status === "completed") continue;
      for (const step of phase.steps) {
        if (step.status === status) return { phase, step };
      }
    }
  }
  return null;
}

export interface PlanBriefInputs {
  plan: TaskPlan;
  /** The user's own words, oldest first. Supplied by the caller from session history. */
  userPrompts: string[];
  executorLastMessage: string;
  trigger: ContinuationTrigger;
  priorDecisions?: string[];
}

/**
 * Fold a plan into the brief the conductor decides from.
 *
 * Ordering matters and is not alphabetical: completed steps establish what must not be redone,
 * the current step is what the decision is about, and the not-yet-started steps are what make a
 * question about a later phase answerable now instead of deferred to when it is too late to
 * matter.
 */
export function buildPlanBrief(inputs: PlanBriefInputs): ContinuationBrief {
  const { plan } = inputs;
  const current = currentStepOf(plan);

  const completed: ContinuationStepBrief[] = [];
  const remaining: ContinuationStepBrief[] = [];

  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.id === current?.step.id) continue;
      if (step.status === "completed") completed.push(toStepBrief(step));
      else remaining.push(toStepBrief(step));
    }
  }

  return {
    userPrompts: inputs.userPrompts,
    planTitle: plan.title,
    ...(plan.summary ? { planSummary: plan.summary } : {}),
    completed,
    ...(current ? { current: toStepBrief(current.step) } : {}),
    remaining,
    executorLastMessage: inputs.executorLastMessage,
    trigger: inputs.trigger,
    attempts: current ? attemptsFor(current.step) : 0,
    ...(inputs.priorDecisions?.length ? { priorDecisions: inputs.priorDecisions } : {}),
  };
}

/**
 * A plan is finished when every phase is, which is not the same as the agent thinking it is.
 * Used to stop a continuation loop that would otherwise keep asking the conductor what to do
 * about a plan with nothing left in it.
 */
export function planIsComplete(plan: TaskPlan): boolean {
  if (!plan.phases.length) return false;
  return plan.phases.every((phase) => phase.status === "completed");
}

/**
 * Whether a plan may be continued unattended at all.
 *
 * `executionApproved` is the user's explicit go-ahead to *start* implementing. Auto-continuation
 * is strictly more autonomous than that, so it inherits the gate rather than working around it:
 * a plan the user has not approved for execution is not one an unattended conductor gets to
 * push forward.
 */
export function canAutoContinue(plan: TaskPlan): { ok: boolean; reason: string } {
  if (!plan.executionApproved) {
    return { ok: false, reason: "Execution has not been approved for this plan, so it will not be continued automatically." };
  }
  if (!LIVE_PLAN_STATUSES.has(plan.status)) {
    return { ok: false, reason: `The plan is ${plan.status}, so there is nothing to continue.` };
  }
  if (planIsComplete(plan)) {
    return { ok: false, reason: "Every phase is complete." };
  }
  return { ok: true, reason: "" };
}

/**
 * A compact statement of where a plan stands, for a session picking it up cold.
 *
 * Distinct from the conductor's brief: that one is an input to a decision, this one is for a
 * human or an executing agent that just needs to know what is going on. Kept short on purpose —
 * it is injected into context on every turn that touches the plan, so it pays rent continuously.
 */
export function buildResumeBrief(plan: TaskPlan): string {
  const phases = plan.phases.length;
  const donePhases = plan.phases.filter((phase) => phase.status === "completed").length;
  const blocked = plan.phases.flatMap((phase) => phase.steps.filter((step) => step.status === "blocked"));
  const current = currentStepOf(plan);

  const lines = [`Plan "${plan.title}": phase ${Math.min(donePhases + 1, phases)} of ${phases}.`];

  if (current) {
    const attempts = attemptsFor(current.step);
    lines.push(
      `Current step: ${current.step.title}${attempts > 1 ? ` (attempted ${attempts} times)` : ""}.`,
    );
    const lastNote = current.step.notes[current.step.notes.length - 1];
    if (lastNote) lines.push(`  Last note: ${lastNote.slice(0, 300)}`);
  } else if (planIsComplete(plan)) {
    lines.push("Every phase is complete.");
  } else {
    lines.push("No step is currently in progress or pending.");
  }

  if (blocked.length) {
    lines.push(`Blocked: ${blocked.length} step(s) — ${blocked.slice(0, 3).map((step) => step.title).join("; ")}.`);
  }
  return lines.join("\n");
}
