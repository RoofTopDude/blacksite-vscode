/**
 * Strategic verdicts (#16): what the conductor may propose beyond continue, halt and ask.
 *
 * A proposal is a request, never an action. The conductor still has no tools and no authority.
 * `decideStrategicVerdict` records what the host does with each proposal (applied, deferred or
 * rejected) and why. Nothing here can grant a permission, raise a budget or limit, edit a file, or
 * close a ticket. A reply that asks for one of those halts the run, because a conductor that asks
 * for authority has misread its role.
 *
 * Three guards sit on top of the model. Proposals are consulted only at milestones (a step stalled,
 * or failed twice), not after every turn. Each run has a call budget, and the whole path turns off
 * with one flag, which falls back to the legacy conductor. A repeated plan is treated as oscillation
 * and rejected.
 *
 * Every failure is a halt, as in continuation-model.ts. Pure apart from the injected model.
 */

import { createHash } from "node:crypto";
import {
  buildContinuationSystemPrompt, buildContinuationUserPrompt, decideContinuation, extractJsonObject,
  parseContinuationVerdict, type ContinuationBrief, type ContinuationModel, type ContinuationTrigger,
  type ContinuationVerdict, type HaltCategory,
} from "./continuation-model.js";

export interface ReplanProposal {
  action: "replan";
  summary: string;
  steps: Array<{ title: string }>;
  rationale: string;
}
export interface DelegateProposal {
  action: "delegate";
  workId: string;
  target: string;
  rationale: string;
}
export interface ReallocateProposal {
  action: "reallocate";
  workId: string;
  toLane: string;
  rationale: string;
}
export interface VerifyProposal {
  action: "verify";
  workId: string;
  rationale: string;
}
export interface BlockProposal {
  action: "block";
  reason: string;
  whatWouldUnblock: string;
}

export type StrategicProposal = ReplanProposal | DelegateProposal | ReallocateProposal | VerifyProposal | BlockProposal;
export type StrategicVerdict = ContinuationVerdict | StrategicProposal;

export const PROPOSAL_ACTIONS: ReadonlySet<string> = new Set(["replan", "delegate", "reallocate", "verify", "block"]);
export const MAX_REPLAN_STEPS = 12;

/** Keys that name a capability the conductor does not hold. Seeing one makes the whole reply a halt. */
const FORBIDDEN_KEY = /^(grant|permission|approv|budget|limit|max|cost|usd|close|edit|write|patch|command|shell|tool|dispatch|allow|status)/i;

function halt(category: HaltCategory, reason: string, whatWouldUnblock = "Review the run and continue it by hand if it should proceed."): ContinuationVerdict {
  return { action: "halt", category, reason, whatWouldUnblock };
}

function text(value: unknown, max: number, required: boolean): string | undefined {
  if (typeof value !== "string") return required ? undefined : "";
  const trimmed = value.trim();
  if (!trimmed && required) return undefined;
  return trimmed.length <= max ? trimmed : undefined;
}

/**
 * Parse a conductor reply that may contain a proposal. Legacy verdicts go through the unchanged
 * parser, so their behaviour is identical with the strategic path on or off.
 */
export function parseStrategicVerdict(raw: string): StrategicVerdict {
  const parsed = extractJsonObject(raw);
  const action = typeof parsed?.action === "string" ? parsed.action : "";
  if (!parsed || !PROPOSAL_ACTIONS.has(action)) return parseContinuationVerdict(raw);

  if (Object.keys(parsed).some((key) => FORBIDDEN_KEY.test(key))) {
    return halt("security", "The conductor asked for a permission, budget, limit or ticket change it cannot make, so the run stopped rather than applying it.");
  }
  const malformed = () => halt("incoherent", `The conductor's ${action} proposal was malformed, so the run stopped rather than guessing what it meant.`);

  switch (action) {
    case "replan": {
      const summary = text(parsed.summary, 500, true);
      const rationale = text(parsed.rationale, 500, false);
      if (summary === undefined || rationale === undefined || !Array.isArray(parsed.steps)) return malformed();
      if (parsed.steps.length < 1 || parsed.steps.length > MAX_REPLAN_STEPS) return malformed();
      const steps: Array<{ title: string }> = [];
      for (const step of parsed.steps) {
        const title = text((step as Record<string, unknown> | null)?.title, 200, true);
        if (title === undefined) return malformed();
        steps.push({ title });
      }
      return { action: "replan", summary, steps, rationale };
    }
    case "delegate": {
      const workId = text(parsed.workId, 200, true);
      const target = text(parsed.target, 200, true);
      const rationale = text(parsed.rationale, 500, false);
      return workId === undefined || target === undefined || rationale === undefined ? malformed() : { action: "delegate", workId, target, rationale };
    }
    case "reallocate": {
      const workId = text(parsed.workId, 200, true);
      const toLane = text(parsed.toLane, 200, true);
      const rationale = text(parsed.rationale, 500, false);
      return workId === undefined || toLane === undefined || rationale === undefined ? malformed() : { action: "reallocate", workId, toLane, rationale };
    }
    case "verify": {
      const workId = text(parsed.workId, 200, true);
      const rationale = text(parsed.rationale, 500, false);
      return workId === undefined || rationale === undefined ? malformed() : { action: "verify", workId, rationale };
    }
    case "block": {
      const reason = text(parsed.reason, 500, true);
      const whatWouldUnblock = text(parsed.whatWouldUnblock, 500, false);
      return reason === undefined || whatWouldUnblock === undefined ? malformed() : { action: "block", reason, whatWouldUnblock };
    }
    default:
      return malformed();
  }
}

// ── Policy and run state ──────────────────────────────────────────────────────

export interface StrategicPolicy {
  /** The `blacksite.orchestration.strategicConductor` flag. Off means the legacy conductor only. */
  enabled: boolean;
  /** Replan proposals a run may make before further ones are rejected. */
  maxReplans: number;
  /** Strategic model calls a run may make. Each one is metered; past the cap the legacy path answers. */
  maxCalls: number;
}

export const DEFAULT_STRATEGIC_POLICY: StrategicPolicy = Object.freeze({ enabled: false, maxReplans: 2, maxCalls: 6 });

export interface StrategicRunState {
  /** Strategic model calls made this run. */
  calls: number;
  /** Replan proposals made this run, whatever became of them. */
  replans: number;
  /** Fingerprints of every plan proposed this run, so a return to one of them is oscillation. */
  plans: string[];
}

export const EMPTY_STRATEGIC_STATE: StrategicRunState = Object.freeze({ calls: 0, replans: 0, plans: [] });

export type Disposition = "applied" | "deferred" | "rejected";

export interface StrategicDecision {
  action: StrategicVerdict["action"];
  disposition: Disposition;
  /** One sentence for the user: why this happened. */
  reason: string;
}

/**
 * Whether a decision is worth a strategic consult at all. The rest the legacy conductor answers.
 * Milestones only: a stalled step, a step that failed twice, or something the host flagged since
 * the last decision (a false-progress signal, a check failing on finished work). Never per turn.
 */
export function consultsStrategy(trigger: ContinuationTrigger, attempts: number, flagged = false): boolean {
  if (flagged && trigger !== "executor_question") return true;
  if (trigger === "stalled") return true;
  if (trigger === "step_failed") return attempts >= 2;
  return false;
}

export function planFingerprint(steps: readonly { title: string }[]): string {
  const normalized = steps.map((step) => step.title.trim().toLowerCase().replace(/\s+/g, " "));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function strategicCallAllowed(policy: StrategicPolicy, state: StrategicRunState): { allowed: true } | { allowed: false; reason: string } {
  if (!policy.enabled) return { allowed: false, reason: "The strategic conductor is off." };
  if (state.calls >= policy.maxCalls) return { allowed: false, reason: `The strategic conductor's budget of ${policy.maxCalls} calls for this run is used up.` };
  return { allowed: true };
}

/**
 * Decide what the host does with a verdict. Legacy verdicts are always applied, unchanged. A
 * proposal is never applied by the conductor itself: it is deferred for a person, rejected, or, for
 * `block`, applied as a stop, which is what the run would do anyway.
 */
export function decideStrategicVerdict(
  verdict: StrategicVerdict,
  policy: StrategicPolicy,
  state: StrategicRunState,
): { decision: StrategicDecision; state: StrategicRunState } {
  if (verdict.action === "continue" || verdict.action === "halt" || verdict.action === "ask_user") {
    return { decision: { action: verdict.action, disposition: "applied", reason: "The legacy conductor's decision." }, state };
  }
  const off = `The strategic conductor is off, so the ${verdict.action} proposal was not acted on.`;
  if (!policy.enabled) return { decision: { action: verdict.action, disposition: "deferred", reason: off }, state };

  if (verdict.action === "replan") {
    const fingerprint = planFingerprint(verdict.steps);
    const next: StrategicRunState = { ...state, replans: state.replans + 1, plans: [...state.plans, fingerprint] };
    if (state.plans.includes(fingerprint)) {
      return { decision: { action: "replan", disposition: "rejected", reason: "This plan was already proposed in this run, so the conductor is oscillating between plans." }, state: next };
    }
    if (state.replans >= policy.maxReplans) {
      return { decision: { action: "replan", disposition: "rejected", reason: `The run has already proposed ${policy.maxReplans} plan changes.` }, state: next };
    }
    return { decision: { action: "replan", disposition: "deferred", reason: "A change to the plan needs your approval before it is applied." }, state: next };
  }
  if (verdict.action === "delegate" || verdict.action === "reallocate") {
    return { decision: { action: verdict.action, disposition: "deferred", reason: "Starting or moving work needs your approval under this run's budget and scope." }, state };
  }
  if (verdict.action === "verify") {
    return { decision: { action: "verify", disposition: "deferred", reason: "A read-only verification needs to be started from the Ticket Loop or by you." }, state };
  }
  return { decision: { action: "block", disposition: "applied", reason: "The conductor stopped the run; a person has to unblock it." }, state };
}

/** What the user reads for a proposal. Legacy verdicts never reach this. */
export function describeProposal(proposal: StrategicProposal): { question: string } {
  switch (proposal.action) {
    case "replan":
      return { question: `The conductor proposes a plan change: ${proposal.summary}\n\n${proposal.steps.map((step, index) => `${index + 1}. ${step.title}`).join("\n")}` };
    case "delegate":
      return { question: `The conductor proposes handing ${proposal.workId} to ${proposal.target}.` };
    case "reallocate":
      return { question: `The conductor proposes moving ${proposal.workId} to ${proposal.toLane}.` };
    case "verify":
      return { question: `The conductor proposes a read-only verification of ${proposal.workId}.` };
    case "block":
      return { question: `The conductor stopped the run: ${proposal.reason}${proposal.whatWouldUnblock ? `\n\nTo continue: ${proposal.whatWouldUnblock}` : ""}` };
  }
}

/** The verdict the plan run acts on. Proposals become a question, so nothing continues without a person. */
export function toActionableVerdict(verdict: StrategicVerdict, decision: StrategicDecision): ContinuationVerdict {
  if (verdict.action === "continue" || verdict.action === "halt" || verdict.action === "ask_user") return verdict;
  return { action: "ask_user", question: describeProposal(verdict).question, why: `${decision.disposition}: ${decision.reason}` };
}

// ── Running one decision ──────────────────────────────────────────────────────

const PROPOSAL_ADDENDUM = [
  "",
  "Strategic proposals. Beyond continue, halt and ask_user, you may return one of these. The host decides what happens to it; you do not:",
  '  {"action":"replan","summary":"<what changes>","steps":[{"title":"<step>"}],"rationale":"<why>"}',
  '  {"action":"delegate","workId":"<id>","target":"<ticket or phase>","rationale":"<why>"}',
  '  {"action":"reallocate","workId":"<id>","toLane":"<lane>","rationale":"<why>"}',
  '  {"action":"verify","workId":"<id>","rationale":"<why>"}',
  '  {"action":"block","reason":"<why the run stops>","whatWouldUnblock":"<what a human must do>"}',
  "",
  "Propose a replan only when the remaining steps are wrong, not when one step is merely hard.",
  "You cannot grant permissions, change budgets or limits, edit files, or close tickets. A reply that asks for any of those halts the run.",
].join("\n");

export function buildStrategicSystemPrompt(): string {
  return buildContinuationSystemPrompt() + PROPOSAL_ADDENDUM;
}

export interface StrategicOutcome {
  /** What the plan run acts on. Always a legacy verdict. */
  verdict: ContinuationVerdict;
  /** Absent when the legacy path answered, which is always when the strategic path is off. */
  decision?: StrategicDecision;
  state: StrategicRunState;
}

/**
 * Run one decision. When the strategic path is off, not consulted for this trigger, or out of
 * budget, this is exactly `decideContinuation`: no state changes and no new behaviour.
 */
export async function decideWithStrategy(
  model: ContinuationModel,
  brief: ContinuationBrief,
  policy: StrategicPolicy,
  state: StrategicRunState,
  context: { flagged?: boolean } = {},
): Promise<StrategicOutcome> {
  const allowed = strategicCallAllowed(policy, state);
  if (!allowed.allowed || !consultsStrategy(brief.trigger, brief.attempts, context.flagged)) {
    return { verdict: await decideContinuation(model, brief), state };
  }

  const metered: StrategicRunState = { ...state, calls: state.calls + 1 };
  let verdict: StrategicVerdict;
  try {
    const raw = await model.decide(buildStrategicSystemPrompt(), buildContinuationUserPrompt(brief));
    verdict = parseStrategicVerdict(raw);
  } catch (error) {
    // As in decideContinuation: a provider outage is not permission to keep going.
    return {
      verdict: halt("incoherent", `The conductor could not be reached (${error instanceof Error ? error.message : String(error)}), so the run stopped.`, "Retry once the provider is reachable."),
      state: metered,
    };
  }
  const { decision, state: next } = decideStrategicVerdict(verdict, policy, metered);
  return { verdict: toActionableVerdict(verdict, decision), decision, state: next };
}
