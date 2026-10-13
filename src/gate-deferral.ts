/**
 * A gate nobody answered in time, during an unattended plan run.
 *
 * When a run is set to "queue it and keep going", an approval card or a question that sits
 * unanswered past the run's grace period is not left blocking the whole run. The host records it
 * as a decision for the user to make later and rejects the wait with this error. Its message is
 * written for the agent: what happened, what not to do, and what to do instead.
 *
 * It is an error rather than a new approval answer on purpose. Several callers read anything other
 * than "deny" as permission (the Ticket Loop routing among them), and a deferral must never be
 * mistaken for one. An error that reaches a generic catch still carries the right instruction.
 */

export class GateDeferredError extends Error {
  readonly deferred = true as const;

  constructor(readonly decisionId: string, message: string) {
    super(message);
    this.name = "GateDeferredError";
  }
}

export function isGateDeferred(error: unknown): error is GateDeferredError {
  if (error instanceof GateDeferredError) return true;
  return !!error && typeof error === "object"
    && (error as { deferred?: unknown }).deferred === true
    && typeof (error as { message?: unknown }).message === "string";
}

/**
 * Start the clock on a gate in a run that queues. When it runs out and the gate is still open,
 * `queue` records the decision; if the run took it, `deferred` closes the gate with its id. A
 * run that stopped queueing meanwhile (paused, ended) returns nothing, and the gate keeps waiting
 * exactly as it would have. Returns a function that stops the clock.
 */
export function armGateDeferral(
  graceMs: number | undefined,
  hooks: { stillOpen(): boolean; queue(): { id: string } | undefined; deferred(id: string): void },
): () => void {
  if (graceMs === undefined) return () => undefined;
  const timer = setTimeout(() => {
    if (!hooks.stillOpen()) return;
    const decision = hooks.queue();
    if (decision) hooks.deferred(decision.id);
  }, graceMs);
  return () => clearTimeout(timer);
}

/**
 * What a repeat of the same gated call looks like. The description names the exact command,
 * arguments and what it reaches, so a later approval covers that call and nothing near it.
 */
export function approvalFingerprint(toolName: string, description: string): string {
  return `${toolName}\u0000${description}`;
}

/** The line that replaces a card the run stopped waiting on. */
export function queuedGateNotice(decisionId: string, graceMs: number): string {
  const minutes = Math.round(graceMs / 60_000);
  const waited = graceMs <= 0 ? "" : `No answer after ${minutes >= 1 ? `${minutes} min` : `${Math.round(graceMs / 1000)}s`}, so `;
  return `${waited ? waited : ""}${waited ? "this was" : "This was"} queued for you as ${decisionId} and the run carried on. Answer it from Decisions on the run bar.`;
}

/** What the agent is told when an operation it asked to run was queued for the user. */
export function deferredApprovalMessage(decisionId: string): string {
  return [
    `Deferred (${decisionId}): this operation needs the user's decision, and nobody answered in time, so it has been queued for them and the run carries on.`,
    "Do not retry it now, and do not reach the same result another way.",
    "Mark the step that needs it blocked with plan_update, saying what is waiting, and continue with work that does not depend on it.",
    `You will be told when the user answers ${decisionId}.`,
  ].join(" ");
}

/** What the agent is told when an edit it asked to apply was queued for the user. */
export function deferredEditMessage(decisionId: string): string {
  return [
    `Deferred (${decisionId}): this edit needs the user's approval, and nobody answered in time, so it has been queued for them and the run carries on.`,
    "The files were not changed. Do not apply the same change another way.",
    "Mark the step that needs it blocked with plan_update and continue with work that does not depend on it.",
    `You will be told when the user answers ${decisionId}; if they approve, make the same edit again.`,
  ].join(" ");
}

/** What the agent is told when its question was queued for the user. */
export function deferredQuestionMessage(decisionId: string): string {
  return [
    `Deferred (${decisionId}): nobody answered in time, so your question has been queued for the user and the run carries on.`,
    "Do not guess on anything that would be hard to undo.",
    "If the answer blocks a step, mark that step blocked with plan_update and continue with independent work.",
    "If a sensible default exists and is easy to change later, you may go ahead with it and say so in the step's notes.",
    `You will be told when the user answers ${decisionId}.`,
  ].join(" ");
}
