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
import type { LoopApprovalVerdict } from "../continuation/approval-review.js";
import type {
  BaseAgentEvent,
  SubagentProvider,
  SubagentProviderMessage,
  SubagentSpawnFailureResult,
  SubagentSpawnToolResult,
} from "../agent-session.js";
import type { LoopDispatchRequest, LoopDispatchResult, LoopDispatcher } from "./loop-supervisor.js";
import type { Ticket } from "../ticket-store.js";

/** Marker used when a gated lane ends without a more specific tier. */
const PARK_MARKER = "awaiting approval";

export interface SubagentLoopDispatcherOptions {
  /**
   * Build a delegation surface bound to one loop's approval posture.
   *
   * Per-dispatch rather than shared, because two loops running at once can have different
   * postures and a single provider could only carry one of them.
   */
  providerFor: (policy: LoopApprovalPolicy) => SubagentProvider;
  /** Independent, no-tools reviewer. A refusal blocks one ticket and frees the worker slot. */
  reviewApproval: (request: LoopApprovalReviewRequest) => Promise<LoopApprovalVerdict>;
  /** Price one child usage event with the provider/model that actually backs loop lanes. */
  estimateUsageCostUsd?: (usage: Extract<BaseAgentEvent, { type: "usage_update" }>) => number | undefined;
  /** The parent session lanes are attributed to. Loops have no chat turn of their own, so this
   *  is the session whose transcript the lane renders into. */
  sessionId: () => string;
}

/** Matches ChatProvider's HeadlessApprovalPolicy. Null would fall through to the interactive
 *  prompt, which an unattended loop must never do — so this never returns null. */
export type LoopApprovalPolicy = (
  tier: string,
  toolName: string,
  description: string,
) => Promise<ApprovalDecision>;

export interface LoopApprovalReviewRequest {
  loopId: string;
  ticket: Ticket;
  tier: string;
  toolName: string;
  description: string;
}

/**
 * Turn the independent continuation reviewer into a decision function for one lane.
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
export function loopApprovalPolicy(
  request: Pick<LoopDispatchRequest, "loopId" | "ticket" | "onProgress">,
  reviewer: (input: LoopApprovalReviewRequest) => Promise<LoopApprovalVerdict>,
  onBlocked?: (verdict: Extract<LoopApprovalVerdict, { action: "block" }>) => void,
): LoopApprovalPolicy {
  return async (tier: string, toolName: string, description: string) => {
    request.onProgress?.({
      kind: "review_started",
      label: `Reviewing ${tier || "gated"} operation`,
      detail: description,
      toolName,
      tier,
    });
    let verdict: LoopApprovalVerdict;
    try {
      verdict = await reviewer({
        loopId: request.loopId,
        ticket: request.ticket,
        tier,
        toolName,
        description,
      });
    } catch (error) {
      verdict = {
        action: "block",
        category: "incoherent",
        reason: `The continuation reviewer failed (${error instanceof Error ? error.message : String(error)}).`,
        whatWouldUnblock: "Retry when the configured provider is available.",
      };
    }
    if (verdict.action === "allow") {
      request.onProgress?.({
        kind: "review_allowed",
        label: "Approved by continuation review",
        detail: verdict.reason,
        toolName,
        tier,
        ok: true,
      });
      return "allow";
    }
    onBlocked?.(verdict);
    request.onProgress?.({
      kind: "review_blocked",
      label: `Blocked by continuation review · ${verdict.category}`,
      detail: [verdict.reason, verdict.whatWouldUnblock ? `To unblock: ${verdict.whatWouldUnblock}` : ""]
        .filter(Boolean).join("\n"),
      toolName,
      tier,
      ok: false,
    });
    return "deny";
  };
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
    let blockedVerdict: Extract<LoopApprovalVerdict, { action: "block" }> | undefined;
    const policy = loopApprovalPolicy(request, this._options.reviewApproval, (verdict) => {
      blockedVerdict = verdict;
    });
    const provider = this._options.providerFor(policy);
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

    const folded = await foldLaneStream(stream, request, this._options.estimateUsageCostUsd);
    if (folded.parkedOnGate && blockedVerdict) {
      folded.detail = [
        blockedVerdict.reason,
        blockedVerdict.whatWouldUnblock ? `To unblock: ${blockedVerdict.whatWouldUnblock}` : "",
      ].filter(Boolean).join("\n");
    }
    return folded;
  }
}

/** Exported for testing: consumes a lane's message stream into a single loop outcome. */
export async function foldLaneStream(
  stream: AsyncGenerator<SubagentProviderMessage>,
  request: Pick<LoopDispatchRequest, "onProgress">,
  estimateUsageCostUsd?: (usage: Extract<BaseAgentEvent, { type: "usage_update" }>) => number | undefined,
): Promise<LoopDispatchResult> {
  let laneId: string | undefined;
  let subRequestId: string | undefined;
  let result: SubagentSpawnToolResult | SubagentSpawnFailureResult | undefined;
  let pendingGate = "";
  let pendingGateDetail = "";
  let usd = 0;
  let spendTracked = false;
  const approvals = new Map<string, { tier: string; description: string }>();

  for await (const message of stream) {
    if (message.type === "subagent_lane_start") {
      laneId = message.laneId;
      subRequestId = message.subRequestId;
      request.onProgress?.({ kind: "lane_started", label: message.label, detail: message.laneId });
      continue;
    }
    if (message.type === "subagent_lane_event") {
      // Persist bounded tool activity and resolve gate outcomes into ticket-level blocks.
      const event = message.event;
      if (event.type === "usage_update") {
        const cost = estimateUsageCostUsd?.(event);
        if (cost != null && Number.isFinite(cost) && cost >= 0) {
          usd += cost;
          spendTracked = true;
        }
      } else if (event.type === "tool_call_start") {
        request.onProgress?.({
          kind: "tool_started", label: event.toolName, detail: event.inputPreview,
          toolCallId: event.toolCallId, toolName: event.toolName,
        });
      } else if (event.type === "tool_call_result") {
        request.onProgress?.({
          kind: "tool_finished", label: event.toolName, detail: event.summary,
          toolCallId: event.toolCallId, toolName: event.toolName, ok: event.ok,
        });
      } else if (event.type === "approval_pending") {
        approvals.set(event.toolCallId, { tier: event.tier, description: event.description });
      } else if (event.type === "approval_result") {
        const gate = approvals.get(event.toolCallId);
        if (!event.granted && gate) {
          pendingGate = gate.tier || PARK_MARKER;
          pendingGateDetail = gate.description;
        }
        approvals.delete(event.toolCallId);
      } else if (event.type === "question_card_pending") {
        pendingGate = "question";
        pendingGateDetail = "The lane required information that was not available to the unattended reviewer.";
      } else if (event.type === "execution_diagnostic") {
        request.onProgress?.({ kind: "diagnostic", label: event.message, ok: event.level !== "error" });
      }
      continue;
    }
    if (message.type === "subagent_lane_complete") {
      request.onProgress?.({
        kind: "lane_finished",
        label: message.ok ? "Lane finished" : "Lane stopped",
        detail: message.ok ? message.answer : message.error,
        ok: message.ok,
      });
      continue;
    }
    if (message.type === "subagent_tool_result") {
      result = message.result;
    }
  }

  if (!pendingGate && approvals.size) {
    const gate = approvals.values().next().value as { tier: string; description: string } | undefined;
    if (gate) {
      pendingGate = gate.tier || PARK_MARKER;
      pendingGateDetail = gate.description;
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
      ...(spendTracked ? { usd } : {}),
    };
  }

  if (pendingGate) {
    return {
      ok: false,
      ...(laneId ? { laneId } : {}),
      subRequestId: result.subRequestId,
      detail: pendingGateDetail || (result.ok ? result.answer : result.error),
      filesTouched: result.ok ? [] : result.filesTouched,
      runIds: [],
      parkedOnGate: pendingGate,
      parkedSubRequestId: result.subRequestId,
      ...(spendTracked ? { usd } : {}),
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
      ...(spendTracked ? { usd } : {}),
    };
  }

  // A lane stopped by review is blocked, not failed: charging it an attempt would burn the
  // retry budget on a safety decision rather than on the work itself.
  return {
    ok: false,
    ...(laneId ? { laneId } : {}),
    subRequestId: result.subRequestId,
    // nextStep is the lane's own retry guidance and is what the next attempt's prompt is built
    // from, so it is carried whole rather than summarized.
    detail: [result.error, result.nextStep].filter(Boolean).join("\n\n"),
    filesTouched: result.filesTouched,
    runIds: [],
    ...(spendTracked ? { usd } : {}),
  };
}
