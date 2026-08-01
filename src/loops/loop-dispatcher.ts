/**
 * Turns one ticket into one subagent lane.
 *
 * The adapter between the loop engine (which knows about queues and territory) and the
 * delegation path (which knows about lanes and budgets). It depends on `SubagentProvider` — the
 * interface — rather than on ChatProvider, so the engine never reaches into the chat surface
 * and this whole file is testable against a fake generator.
 *
 * The prompt it builds is the loop's only real leverage over quality. A lane gets one shot at
 * understanding a ticket it can neither see the board for nor ask questions about, so the
 * acceptance criteria go in verbatim and the previous attempt's failure goes in whole.
 */

import type { ApprovalDecision } from "../approval-gate.js";
import type {
  SubagentProvider,
  SubagentProviderMessage,
  SubagentSpawnFailureResult,
  SubagentSpawnToolResult,
} from "../agent-session.js";
import type { LoopDispatchRequest, LoopDispatchResult, LoopDispatcher } from "./loop-supervisor.js";
import type { Ticket } from "../ticket-store.js";

/** Approval tiers a lane may not proceed through unattended park the ticket instead. Recognized
 *  by the description the gate carries, since that is all the lane result exposes. */
const PARK_MARKER = "awaiting approval";

export interface SubagentLoopDispatcherOptions {
  /**
   * Build a delegation surface bound to one loop's approval posture.
   *
   * Per-dispatch rather than shared, because two loops running at once can have different
   * postures and a single provider could only carry one of them.
   */
  providerFor: (policy: LoopApprovalPolicy) => SubagentProvider;
  /** The parent session lanes are attributed to. Loops have no chat turn of their own, so this
   *  is the session whose transcript the lane renders into. */
  sessionId: () => string;
}

/** Matches ChatProvider's HeadlessApprovalPolicy. Null would fall through to the interactive
 *  prompt, which an unattended loop must never do — so this never returns null. */
export type LoopApprovalPolicy = (tier: string, toolName: string, description: string) => ApprovalDecision;

/**
 * Turn a loop's approval posture into a decision function for its lanes.
 *
 * This is what makes the posture real. Without it a lane falls through to the interactive
 * prompt, which for an unattended loop means a modal nobody is present to answer and a worker
 * held until morning — while the configuration screen claims writes are being auto-approved.
 *
 * Denial rather than silence is deliberate: a denied tool call ends the lane promptly with a
 * recorded `approval_pending` event, which is exactly what {@link foldLaneStream} reads back as
 * a park. Leaving the promise unresolved would strand the lane instead.
 *
 * `allow_always` is never returned. That decision writes a permanent project-wide
 * auto-approval, and a loop running at 3am does not get to widen the workspace's standing
 * permissions on the user's behalf.
 */
export function loopApprovalPolicy(autoApproveTiers: readonly string[]): LoopApprovalPolicy {
  const allowed = new Set(autoApproveTiers);
  return (tier: string) => (allowed.has(tier) ? "allow" : "deny");
}

/**
 * The task text a lane receives.
 *
 * Written as a standalone briefing, not a reference: the lane cannot see the board, the parent
 * conversation, or any other ticket. Anything omitted here is simply unavailable to it.
 */
export function buildTicketTask(ticket: Ticket): string {
  const lines = [
    `Work ticket ${ticket.id}: ${ticket.title}`,
    "",
  ];

  if (ticket.description?.trim()) {
    lines.push(ticket.description.trim(), "");
  }

  if (ticket.acceptanceCriteria.length) {
    // Verbatim and prominent. This is the lane's definition of done and, under user_review
    // closure, the rubric the person reviewing it will actually use.
    lines.push("This ticket is done when ALL of these hold:");
    for (const criterion of ticket.acceptanceCriteria) lines.push(`  - ${criterion}`);
    lines.push("");
  } else {
    lines.push(
      "This ticket has no acceptance criteria. State plainly in your answer what you took "
      + "\"done\" to mean, so the reviewer can judge whether that was the right reading.",
      "",
    );
  }

  const territory = [...ticket.territory.files, ...ticket.territory.areas];
  if (territory.length) {
    lines.push(
      "Expected territory (where this work is meant to live):",
      ...territory.map((entry) => `  - ${entry}`),
      "If the work genuinely reaches outside this, say so in your answer — another lane may be "
      + "running against those files right now.",
      "",
    );
  }

  lines.push(
    "You are one lane in an automated loop working a ticket queue. Nobody is reading this in "
    + "real time.",
    "Do the work, then return a synthesis of what you changed and what you verified.",
    "Do NOT mark the ticket done — a person reviews it. Your answer is what they will read.",
  );

  return lines.join("\n");
}

/** Context a retry gets that a first attempt does not. */
export function buildRetryContext(priorAttempt: string): string {
  return [
    "This ticket has been attempted before and did not finish. Here is what happened:",
    "",
    priorAttempt.trim(),
    "",
    "Do not repeat the part that already worked. Start from what is actually still missing, and "
    + "if the previous attempt's approach was the problem, take a different one.",
  ].join("\n");
}

/**
 * Drive one lane to completion and fold its events into a loop outcome.
 *
 * The lane's own failure guidance (`nextStep`) is carried through verbatim into `detail`,
 * because that is what the next attempt's prompt is built from — paraphrasing it here would
 * quietly degrade every retry.
 */
export class SubagentLoopDispatcher implements LoopDispatcher {
  constructor(private readonly _options: SubagentLoopDispatcherOptions) {}

  async dispatch(request: LoopDispatchRequest): Promise<LoopDispatchResult> {
    const context = request.priorAttempt ? buildRetryContext(request.priorAttempt) : undefined;

    const provider = this._options.providerFor(loopApprovalPolicy(request.approvals.autoApproveTiers));
    const stream = provider.spawn({
      parentSessionId: this._options.sessionId(),
      // Namespaced so the transcript can tell loop lanes from ones the user's agent spawned.
      parentToolCallId: `loop:${request.loopId}:${request.ticket.id}`,
      input: {
        task: buildTicketTask(request.ticket),
        ...(context ? { context } : {}),
        complexity: request.complexity,
        label: `${request.ticket.id} — ${request.ticket.title}`.slice(0, 80),
        ...(request.profileId ? { profileId: request.profileId } : {}),
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return foldLaneStream(stream, request);
  }
}

/** Exported for testing: consumes a lane's message stream into a single loop outcome. */
export async function foldLaneStream(
  stream: AsyncGenerator<SubagentProviderMessage>,
  request: Pick<LoopDispatchRequest, "approvals">,
): Promise<LoopDispatchResult> {
  let laneId: string | undefined;
  let subRequestId: string | undefined;
  let result: SubagentSpawnToolResult | SubagentSpawnFailureResult | undefined;
  let pendingGate = "";

  for await (const message of stream) {
    if (message.type === "subagent_lane_start") {
      laneId = message.laneId;
      subRequestId = message.subRequestId;
      continue;
    }
    if (message.type === "subagent_lane_event") {
      // The only lane event the loop cares about: a gate the posture will not auto-approve is
      // what turns this dispatch into a park rather than a failure.
      const event = message.event;
      if (event.type === "approval_pending" && !request.approvals.autoApproveTiers.includes(event.tier)) {
        pendingGate = event.tier || event.description || PARK_MARKER;
      }
      continue;
    }
    if (message.type === "subagent_tool_result") {
      result = message.result;
    }
  }

  if (!result) {
    return {
      ok: false,
      ...(laneId ? { laneId } : {}),
      ...(subRequestId ? { subRequestId } : {}),
      detail: "The lane ended without returning a result.",
      filesTouched: [],
      runIds: [],
    };
  }

  if (result.ok) {
    return {
      ok: true,
      ...(laneId ? { laneId } : {}),
      subRequestId: result.subRequestId,
      detail: result.answer,
      filesTouched: [],
      runIds: [],
    };
  }

  // A lane that stopped on a gate the posture would not grant is parked, not failed: nothing
  // about the work went wrong, and charging it an attempt would burn the retry budget on the
  // user's response time.
  if (pendingGate) {
    return {
      ok: false,
      ...(laneId ? { laneId } : {}),
      subRequestId: result.subRequestId,
      detail: result.error,
      filesTouched: result.filesTouched,
      runIds: [],
      parkedOnGate: pendingGate,
      parkedSubRequestId: result.subRequestId,
    };
  }

  return {
    ok: false,
    ...(laneId ? { laneId } : {}),
    subRequestId: result.subRequestId,
    // nextStep is the lane's own retry guidance and is what the next attempt's prompt is built
    // from, so it is carried whole rather than summarized.
    detail: [result.error, result.nextStep].filter(Boolean).join("\n\n"),
    filesTouched: result.filesTouched,
    runIds: [],
  };
}
