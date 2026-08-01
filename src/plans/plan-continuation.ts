/**
 * Whether stalled plan work should be handed to the conductor, and what to do with its verdict.
 *
 * Pure. The host wrapper (plan-continuation-service.ts) supplies the plan, the transcript and
 * the model; every decision about *whether to spend anything at all* is made here so it can be
 * tested without one.
 *
 * The asymmetry to keep in mind while reading: asking the conductor costs a model call, and
 * acting on a `continue` costs a whole agent turn. So the gates below are deliberately
 * conservative — the cost of not auto-continuing is that the user types "continue" themselves,
 * and the cost of over-continuing is an unattended agent working on the wrong thing at 3am.
 */

import { canAutoContinue, planIsComplete } from "./plan-recovery.js";
import type { ContinuationTrigger, ContinuationVerdict } from "../continuation/continuation-model.js";
import type { TaskPlan } from "../planning-store.js";

/**
 * How many times in a row the conductor may continue work without the user saying anything.
 *
 * A conductor that keeps answering "continue" is indistinguishable from a runaway loop, and
 * nothing inside a single decision can tell the difference. The budget resets the moment the
 * user sends a message, because that is the only unambiguous evidence a human is still engaged.
 */
export const DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS = 5;

export type ContinuationSkipReason =
  | "disabled"
  | "no_plan"
  | "plan_ineligible"
  | "budget_exhausted"
  | "turn_failed"
  | "awaiting_user"
  | "plan_complete";

export type ContinuationGate =
  | { ask: true; trigger: ContinuationTrigger }
  | { ask: false; reason: ContinuationSkipReason; detail: string };

export interface ContinuationGateInputs {
  enabled: boolean;
  plan: TaskPlan | null;
  /** How the agent's turn ended. */
  stopReason: string;
  /** True when the turn ended errored or cancelled. */
  errored: boolean;
  /** True when the agent is blocked on an approval or a question card. The user is already
   *  being asked something; a conductor talking over that would be noise. */
  awaitingUser: boolean;
  /** Auto-continuations issued since the user last spoke. */
  consecutive: number;
  maxConsecutive?: number;
  /** The agent's last message, used only to pick a trigger. */
  lastMessage: string;
}

/** Rough signal that the agent asked something rather than reported something. Deliberately
 *  crude: getting this wrong only changes the framing sentence the conductor is given, and it
 *  is told to work out the real situation from the message itself either way. */
function looksLikeQuestion(message: string): boolean {
  const tail = message.trim().slice(-400);
  return tail.includes("?");
}

export function continuationGate(inputs: ContinuationGateInputs): ContinuationGate {
  if (!inputs.enabled) {
    return { ask: false, reason: "disabled", detail: "Automatic plan continuation is turned off." };
  }
  // A turn that errored or was cancelled is not a stall. Cancellation in particular is the
  // user saying stop, and continuing through it would be the single most obnoxious thing this
  // feature could do.
  if (inputs.errored || inputs.stopReason === "cancelled") {
    return { ask: false, reason: "turn_failed", detail: `The turn ended as "${inputs.stopReason || "error"}".` };
  }
  if (inputs.awaitingUser || inputs.stopReason === "approval_pending" || inputs.stopReason === "question_pending") {
    return { ask: false, reason: "awaiting_user", detail: "The agent is already waiting on the user." };
  }
  if (!inputs.plan) {
    return { ask: false, reason: "no_plan", detail: "No plan is being executed." };
  }
  if (planIsComplete(inputs.plan)) {
    return { ask: false, reason: "plan_complete", detail: "Every phase is complete." };
  }
  const eligible = canAutoContinue(inputs.plan);
  if (!eligible.ok) {
    return { ask: false, reason: "plan_ineligible", detail: eligible.reason };
  }
  const max = inputs.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE_CONTINUATIONS;
  if (inputs.consecutive >= max) {
    return {
      ask: false,
      reason: "budget_exhausted",
      detail: `The plan has been continued ${inputs.consecutive} times without you saying anything. Stopping to check in.`,
    };
  }

  return { ask: true, trigger: pickTrigger(inputs) };
}

function pickTrigger(inputs: ContinuationGateInputs): ContinuationTrigger {
  if (looksLikeQuestion(inputs.lastMessage)) return "executor_question";
  if (inputs.stopReason === "max_iterations") return "stalled";
  if (!inputs.lastMessage.trim()) return "stalled";
  return "stalled";
}

/** What the host should actually do once the conductor has ruled. */
export type ContinuationAction =
  | { kind: "send"; message: string; rationale: string }
  | { kind: "halt"; category: string; message: string }
  | { kind: "ask"; question: string; why: string };

/**
 * Map a verdict onto a host action.
 *
 * A halt is rendered for the user rather than fed back to the agent, and deliberately so: the
 * executor does not get to argue with it, and an agent told "you were halted for a security
 * reason" would reliably try to explain why it should not have been.
 */
export function continuationAction(verdict: ContinuationVerdict): ContinuationAction {
  switch (verdict.action) {
    case "continue":
      return { kind: "send", message: verdict.message, rationale: verdict.rationale };
    case "ask_user":
      return { kind: "ask", question: verdict.question, why: verdict.why };
    default:
      return {
        kind: "halt",
        category: verdict.category,
        message: haltMessage(verdict.category, verdict.reason, verdict.whatWouldUnblock),
      };
  }
}

const HALT_HEADLINE: Record<string, string> = {
  safety: "Stopped for safety",
  security: "Stopped — security decision needed",
  irrecoverable: "Stopped before an irreversible step",
  intent_drift: "Stopped — this drifted from what you asked",
  incoherent: "Stopped — the plan no longer holds together",
};

export function haltMessage(category: string, reason: string, whatWouldUnblock: string): string {
  const headline = HALT_HEADLINE[category] ?? "Stopped";
  const parts = [`${headline}: ${reason}`];
  if (whatWouldUnblock) parts.push(`To continue: ${whatWouldUnblock}`);
  return parts.join("\n\n");
}

/**
 * The plan a continuation decision would be about.
 *
 * The most recently updated executable plan, not merely the first — a workspace accumulates
 * plans, and the one being worked is the one that just changed. Returns null rather than
 * guessing when nothing qualifies.
 */
export function activeExecutingPlan(plans: readonly TaskPlan[]): TaskPlan | null {
  const candidates = plans
    .filter((plan) => plan.executionApproved && plan.status === "active" && !planIsComplete(plan))
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return candidates[0] ?? null;
}
