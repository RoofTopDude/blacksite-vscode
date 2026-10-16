/**
 * Replays a plan-run trace through the real PlanRunService and PlanRunStore.
 *
 * The chat session is scripted: each `turn` event starts a turn, moves plan steps the way the
 * agent's plan_update calls would, reports spend and ends the turn with a stop reason. Step
 * receipts go through the real LaneContracts and ReceiptStore when work contracts are on. A
 * `crash` disposes the service and opens a new one over the same ledger, through `recover()`.
 */

import { AttentionCenter } from "../../../src/chat/attention.js";
import { PlanRunService, type PlanRunHost, type PlanRunPlanningPort } from "../../../src/plans/plan-run-service.js";
import { PlanRunStore } from "../../../src/plans/plan-run-store.js";
import type { PlanRun } from "../../../src/plans/plan-run-model.js";
import type { PlanningDocument, PlanStepStatus, StepEvidence, TaskPlan } from "../../../src/planning-store.js";
import { LaneContracts } from "../../../src/orchestration/lane-contracts.js";
import { ReceiptStore } from "../../../src/orchestration/receipt-store.js";
import type { WorkContractsMode } from "../../../src/orchestration/flags.js";
import { failureSignature } from "../../../src/plans/run-tripwires.js";
import { EPOCH, sequentialIds, settle, VirtualClock } from "./canonical.js";
import { costPer, receiptAgreement, type Arm, type Scorecard } from "./scorecard.js";
import { verdicts, type PlanRunTraceEvent, type PlanRunTraceHeader, type Trace } from "./trace.js";

export interface PlanRunReplay {
  scenario: string;
  arm: Arm;
  run: Record<string, unknown>;
  launches: Array<{ at: number; origin: string }>;
  scorecard: Scorecard;
}

function buildPlan(header: PlanRunTraceHeader): TaskPlan {
  const setup = header.setup.plan;
  return {
    id: setup.id ?? "plan-1",
    title: setup.title ?? header.scenario,
    status: "active",
    phases: setup.phases.map((phase) => ({
      id: phase.id,
      title: phase.title ?? phase.id,
      status: "pending",
      ...(phase.files ? { files: phase.files } : {}),
      steps: phase.steps.map((step) => ({ id: step.id, title: step.title ?? step.id, status: "pending" as PlanStepStatus, notes: [], updatedAt: "2025-12-31T00:00:00.000Z" })),
      blocks: [], docs: [], notes: [], linkedTodoIds: [], updatedAt: "2025-12-31T00:00:00.000Z",
    })),
    blocks: [], docs: [], agentCanArchive: false, executionApproved: false, notes: [],
    createdAt: "2025-12-31T00:00:00.000Z", updatedAt: "2025-12-31T00:00:00.000Z",
  } as TaskPlan;
}

export async function replayPlanRun(
  trace: Trace<PlanRunTraceHeader, PlanRunTraceEvent>,
  options: { dir: string; arm: Arm; workContracts: WorkContractsMode },
): Promise<PlanRunReplay> {
  const clock = new VirtualClock();
  const ids = sequentialIds();
  const elapsed = (): number => clock.elapsed(clock.now) ?? 0;
  const plan = buildPlan(trace.header);
  const doc: PlanningDocument = { schemaVersion: 3, updatedAt: null, plans: [plan], todoRuns: [] };
  const planning: PlanRunPlanningPort = {
    read: () => structuredClone(doc),
    setExecutionApproved: (_planId, approved) => { plan.executionApproved = approved; },
    setPlanStatus: (_planId, status) => { plan.status = status; },
    setStepEvidence: (_planId, phaseId, stepId, evidence) => {
      const step = plan.phases.find((phase) => phase.id === phaseId)?.steps.find((entry) => entry.id === stepId);
      if (step) step.evidence = evidence;
    },
  };
  const contracts = new LaneContracts({
    store: new ReceiptStore(options.dir, clock.read),
    workspaceRoot: options.dir,
    mode: () => options.workContracts,
    now: clock.read,
    newId: ids,
  });
  const launches: PlanRunReplay["launches"] = [];
  const receipts = new Map<string, string>();
  let evidenceForTurn: Record<string, StepEvidence> = {};
  let live = false;
  const host: PlanRunHost = {
    sessionInfo: () => ({ sessionId: "session_1", provider: "replay", model: "scripted", messageCount: 0 }),
    isTurnLive: () => live,
    launchTurn: (_message, launch) => { launches.push({ at: elapsed(), origin: launch.origin }); },
    requestPause: () => undefined,
    cancelTurn: () => { live = false; },
    retryProviderNow: () => undefined,
    endGrants: () => undefined,
    collectEvidence: ({ phaseId, stepId }) => evidenceForTurn[`${phaseId}/${stepId}`],
    recordStepReceipt: (context) => {
      const recorded = contracts.recordStepReceipt(context);
      if (recorded) receipts.set(`${context.phaseId}/${context.stepId}`, recorded.status);
      return recorded;
    },
    publish: () => undefined,
  };
  const store = new PlanRunStore(options.dir);
  const make = (): PlanRunService => new PlanRunService(store, planning, host, new AttentionCenter(), { now: clock.read, newId: () => "run_1" });
  let service = make();
  service.notePlanChanged(structuredClone(doc));

  const setStep = (phaseId: string, stepId: string, status: PlanStepStatus): void => {
    const phase = plan.phases.find((entry) => entry.id === phaseId);
    const step = phase?.steps.find((entry) => entry.id === stepId);
    if (!phase || !step) throw new Error(`trace names a step the plan does not have: ${phaseId}/${stepId}`);
    step.status = status;
    phase.status = phase.steps.every((entry) => entry.status === "completed") ? "completed"
      : phase.steps.some((entry) => entry.status !== "pending") ? "in_progress" : "pending";
    service.notePlanChanged(structuredClone(doc));
  };

  let interventions = 0;
  let crashes = 0;
  const failures = new Map<string, number>();
  const events = trace.events.filter((event) => event.op !== "verifier").sort((a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0));

  for (const event of events) {
    clock.now = Math.max(clock.now, EPOCH + event.at);
    switch (event.op) {
      case "start": {
        const started = service.start({ planId: plan.id, ...(trace.header.setup.charter ? { charter: trace.header.setup.charter } : {}) });
        if (!started.ok) throw new Error(`run did not start: ${started.error}`);
        break;
      }
      case "turn": {
        const turnId = ids("turn");
        live = true;
        evidenceForTurn = event.evidence ?? {};
        service.noteTurnStart(turnId, event.origin ?? "run");
        for (const agentEvent of event.events ?? []) service.noteAgentEvent(agentEvent);
        // Model calls are priced as they happen, before the plan update that ends the turn's work.
        if (event.spend !== undefined) service.noteSpend(event.spend, false);
        for (const [phaseId, stepId, status] of event.moves ?? []) setStep(phaseId, stepId, status);
        for (const [toolName, message] of event.toolFailures ?? []) {
          const signature = failureSignature(toolName, message);
          failures.set(signature, (failures.get(signature) ?? 0) + 1);
          service.noteToolFailure(toolName, message);
        }
        clock.now += event.durationMs ?? 60_000;
        live = false;
        const stopReason = event.stopReason ?? "end_turn";
        service.noteTurnEnd({
          turnId,
          stopReason,
          iterations: 3,
          errored: stopReason === "error",
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          facts: { changes: [], unverifiedFiles: [], verificationFailed: false, toolCalls: 3, stepMoves: [] },
        });
        evidenceForTurn = {};
        break;
      }
      case "defer":
        service.deferDecision({ kind: "approval", toolCallId: event.id, description: event.description, ...(event.tier ? { tier: event.tier } : {}) });
        break;
      case "answer":
        interventions += 1;
        service.resolveDecision(event.decision, event.status);
        break;
      case "conductor": {
        const context = service.conductorContext();
        context.record({ trigger: "stalled", kind: event.decision, text: event.rationale });
        if (event.decision !== "continue") context.stopped(event.decision, event.rationale);
        break;
      }
      case "user":
        interventions += 1;
        if (event.action === "pause") service.pause();
        else if (event.action === "resume") service.resume();
        else service.stop();
        break;
      case "crash":
        crashes += 1;
        service.dispose();
        service = make();
        service.recover();
        break;
    }
    await settle(3);
  }
  await settle();

  const run = service.current as PlanRun;
  const verdict = verdicts(trace.events);
  const completed = run.steps.filter((step) => step.status === "completed");
  const verified = completed.filter((step) => verdict.get(`${step.phaseId}/${step.stepId}`) === "pass").length;
  const agreement = { agree: 0, disagree: 0, unknown: 0 };
  for (const [key, status] of receipts) agreement[receiptAgreement(status, verdict.get(key))] += 1;
  const scorecard: Scorecard = {
    scenario: trace.header.scenario,
    subject: "plan_run",
    arm: options.arm,
    subjects: run.steps.length,
    verifiedSuccess: verified,
    selfReportedSuccess: completed.length,
    falseCompletions: completed.length - verified,
    elapsedMs: (run.endedAt ?? clock.now) - run.startedAt,
    costUsd: Math.round(run.spentUsd * 10_000) / 10_000,
    costPerVerifiedSuccess: costPer(run.spentUsd, verified),
    interventions,
    repeatedFailures: [...failures.values()].filter((count) => count > 1).length,
    conflicts: { occurred: 0 },
    retries: run.steps.reduce((sum, step) => sum + Math.max(0, step.attempts - 1), 0),
    parks: run.decisions?.length ?? 0,
    abandoned: crashes,
    halts: (run.conductorDecisions.filter((entry) => entry.decision === "halt").length) + (run.tripwireHits?.length ?? 0),
    budgetStops: run.status === "budget_exhausted" ? 1 : 0,
    ...(receipts.size ? { receipts: agreement } : {}),
  };
  service.dispose();
  return {
    scenario: trace.header.scenario,
    arm: options.arm,
    run: describeRun(run),
    launches,
    scorecard,
  };
}

function describeRun(run: PlanRun): Record<string, unknown> {
  return {
    status: run.status,
    endReason: run.endReason,
    spentUsd: run.spentUsd,
    activeMs: run.activeMs,
    waitingUserMs: run.waitingUserMs,
    waitingProviderMs: run.waitingProviderMs,
    retries: run.retries,
    compactions: run.compactions,
    gatesAnswered: run.gatesAnswered,
    turns: run.turns.map((turn) => ({ origin: turn.origin, stopReason: turn.stopReason, stepTransitions: turn.stepTransitions })),
    steps: run.steps.map((step) => ({
      phaseId: step.phaseId,
      stepId: step.stepId,
      status: step.status,
      attempts: step.attempts,
      blockedReason: step.blockedReason,
      evidence: step.evidence ? { checks: step.evidence.checks, unverified: step.evidence.unverified, filesChanged: step.evidence.filesChanged } : undefined,
      receiptIds: step.receiptIds,
    })),
    conductorDecisions: run.conductorDecisions.map((entry) => ({ decision: entry.decision, trigger: entry.trigger })),
    decisions: (run.decisions ?? []).map((decision) => ({ id: decision.id, status: decision.status })),
    tripwires: (run.tripwireHits ?? []).map((hit) => hit.kind),
    lastHandoff: run.lastHandoff?.split("\n")[0],
  };
}
