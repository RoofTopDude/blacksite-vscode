/**
 * The shape of a plan run: one durable record of a long, mostly unattended execution of a plan.
 *
 * A plan run is not a new execution engine. It is the existing agent loop, plan store and
 * conductor, recorded as one thing — started on purpose, accounted for while it goes, and
 * summarised when it stops — so every surface (the chat rail, the Plans panel, the status bar,
 * the run report) reads the same facts instead of reconstructing them per turn.
 *
 * Everything here is pure: no vscode, no filesystem, no clock of its own. The store persists it,
 * the service drives it, and tests replay it.
 */

import type { PlanStepStatus, TaskPlan } from "../planning-store.js";
import type { PlanRunLiveState, PlanRunPhaseView, PlanRunStatus, PlanRunStepView, PlanRunView, StepEvidence } from "./plan-run-view.js";

export type { PlanRunLiveState, PlanRunPhaseView, PlanRunStatus, PlanRunStepView, PlanRunView, StepEvidence };

export const PLAN_RUN_SCHEMA_VERSION = 1;

/**
 * Statuses a run does not come back from. `failed` is not among them: a run that stopped on an
 * error can be resumed, so it stays the current run (accruing no time) until the user decides.
 */
export const TERMINAL_RUN_STATUSES: readonly PlanRunStatus[] = ["completed", "stopped", "budget_exhausted"];

export function isTerminalRunStatus(status: PlanRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Which bucket the elapsed time is currently charged to. */
export type PlanRunClock = "active" | "user" | "provider" | "stopped";

export type PlanRunNotifications = "attention" | "all" | "off";

/** What the user agreed to when they started the run. */
export interface PlanRunCharter {
  /** Hard ceilings. Absent means no ceiling of that kind. */
  maxUsd?: number;
  maxMinutes?: number;
  /** Pause with a handoff after this long blocked on the user. Absent means keep waiting. */
  pauseWhenBlockedMinutes?: number;
  /** How long to keep retrying a provider outage before giving up. */
  providerWaitMinutes: number;
  notifications: PlanRunNotifications;
}

export const DEFAULT_PROVIDER_WAIT_MINUTES = 30;
export const MAX_PROVIDER_WAIT_MINUTES = 240;

export const DEFAULT_CHARTER: PlanRunCharter = {
  providerWaitMinutes: DEFAULT_PROVIDER_WAIT_MINUTES,
  notifications: "attention",
};

export function normalizeCharter(value: unknown): PlanRunCharter {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const positive = (input: unknown, max: number): number | undefined => {
    const n = Number(input);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined;
  };
  const notifications: PlanRunNotifications = record.notifications === "all" || record.notifications === "off"
    ? record.notifications
    : "attention";
  return {
    maxUsd: positive(record.maxUsd, 100_000),
    maxMinutes: positive(record.maxMinutes, 60 * 24 * 14),
    pauseWhenBlockedMinutes: positive(record.pauseWhenBlockedMinutes, 60 * 24),
    providerWaitMinutes: positive(record.providerWaitMinutes, MAX_PROVIDER_WAIT_MINUTES) ?? DEFAULT_PROVIDER_WAIT_MINUTES,
    notifications,
  };
}

export interface PlanRunStep {
  phaseId: string;
  stepId: string;
  title: string;
  status: PlanStepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Times the step moved to in_progress. More than one means it was retried or reopened. */
  attempts: number;
  turnIds: string[];
  evidence?: StepEvidence;
  /** Snapshot tree ids taken when the step finished, keyed by project root. */
  snapshots?: Record<string, string>;
  /** How many messages the conversation held at that point, for "restore conversation too". */
  messageCount?: number;
  blockedReason?: string;
}

export interface ConductorDecisionRecord {
  at: number;
  trigger: string;
  decision: "continue" | "halt" | "ask";
  rationale: string;
}

export type PlanRunTurnOrigin = "user" | "run" | "conductor" | "resume" | "stop_hook" | "steer";

export interface PlanRunTurnRecord {
  id: string;
  origin: PlanRunTurnOrigin;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
  iterations?: number;
  /** The step transitions that happened while this turn ran. */
  stepTransitions: number;
}

export interface PlanRun {
  schema: number;
  id: string;
  planId: string;
  planTitle: string;
  sessionId: string;
  provider?: string;
  model?: string;
  charter: PlanRunCharter;
  status: PlanRunStatus;
  startedAt: number;
  endedAt?: number;
  /** Why the run ended or paused, for the report and the rail. */
  endReason?: string;

  clock: PlanRunClock;
  clockSince: number;
  activeMs: number;
  waitingUserMs: number;
  waitingProviderMs: number;

  spentUsd: number;
  spendPartial: boolean;

  steps: PlanRunStep[];
  turns: PlanRunTurnRecord[];
  conductorDecisions: ConductorDecisionRecord[];

  retries: number;
  compactions: number;
  gatesAnswered: number;
  /** Automatic turns since a step last changed state. The conductor's progress-aware counter. */
  turnsWithoutProgress: number;

  lastHandoff?: string;
  /** The plan document holding the end-of-run report, once written. */
  reportDocId?: string;
  /** Snapshot tree ids taken when the run started, keyed by project root. */
  baseline?: Record<string, string>;
  /** Why snapshots are unavailable, shown instead of pretending they are. */
  snapshotNote?: string;
  /** Opening conversation size, for "restore conversation" to the very start. */
  startMessageCount?: number;
}

export type PlanRunEvent =
  | { type: "run_started"; at: number; planId: string; planTitle: string; charter: PlanRunCharter }
  | { type: "step_started"; at: number; phaseId: string; stepId: string; title: string }
  | { type: "step_completed"; at: number; phaseId: string; stepId: string; title: string; evidence?: StepEvidence }
  | { type: "step_blocked"; at: number; phaseId: string; stepId: string; title: string; reason?: string }
  | { type: "step_reset"; at: number; phaseId: string; stepId: string; title: string }
  | { type: "turn_started"; at: number; turnId: string; origin: PlanRunTurnOrigin }
  | { type: "turn_ended"; at: number; turnId: string; stopReason: string; iterations: number }
  | { type: "gate_wait"; at: number; kind: "approval" | "question"; id: string; description?: string }
  | { type: "gate_resolved"; at: number; id: string; ms: number }
  | { type: "provider_wait"; at: number; reason: string; nextRetryAt?: number }
  | { type: "provider_resumed"; at: number }
  | { type: "provider_retry"; at: number }
  | { type: "compaction"; at: number }
  | { type: "spend"; at: number; usd: number; partial: boolean }
  | { type: "conductor_decision"; at: number; trigger: string; decision: "continue" | "halt" | "ask"; rationale: string }
  | { type: "handoff"; at: number; reason: string; text: string }
  | { type: "snapshot"; at: number; stepId?: string; phaseId?: string; projects: Record<string, string>; skipped?: string; messageCount?: number }
  | { type: "status"; at: number; status: PlanRunStatus; reason?: string };

const MAX_TURN_RECORDS = 400;
const MAX_CONDUCTOR_RECORDS = 200;

export function createPlanRun(input: {
  id: string;
  plan: Pick<TaskPlan, "id" | "title" | "phases">;
  sessionId: string;
  provider?: string;
  model?: string;
  charter: PlanRunCharter;
  now: number;
  startMessageCount?: number;
}): PlanRun {
  const steps: PlanRunStep[] = [];
  for (const phase of input.plan.phases) {
    for (const step of phase.steps) {
      steps.push({
        phaseId: phase.id,
        stepId: step.id,
        title: step.title,
        status: step.status,
        attempts: 0,
        turnIds: [],
      });
    }
  }
  return {
    schema: PLAN_RUN_SCHEMA_VERSION,
    id: input.id,
    planId: input.plan.id,
    planTitle: input.plan.title,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    charter: input.charter,
    status: "running",
    startedAt: input.now,
    clock: "active",
    clockSince: input.now,
    activeMs: 0,
    waitingUserMs: 0,
    waitingProviderMs: 0,
    spentUsd: 0,
    spendPartial: false,
    steps,
    turns: [],
    conductorDecisions: [],
    retries: 0,
    compactions: 0,
    gatesAnswered: 0,
    turnsWithoutProgress: 0,
    startMessageCount: input.startMessageCount,
  };
}

/** Charge the time since the clock was last read to whichever bucket it points at. */
export function advanceClock(run: PlanRun, now: number): void {
  const elapsed = Math.max(0, now - run.clockSince);
  run.clockSince = Math.max(run.clockSince, now);
  if (elapsed === 0) return;
  if (run.clock === "active") run.activeMs += elapsed;
  else if (run.clock === "user") run.waitingUserMs += elapsed;
  else if (run.clock === "provider") run.waitingProviderMs += elapsed;
}

export function setClock(run: PlanRun, clock: PlanRunClock, now: number): void {
  advanceClock(run, now);
  run.clock = clock;
}

/** The bucket a status charges time to. */
export function clockForStatus(status: PlanRunStatus): PlanRunClock {
  switch (status) {
    case "running": return "active";
    case "waiting_user": return "user";
    case "waiting_provider": return "provider";
    default: return "stopped";
  }
}

export function setRunStatus(run: PlanRun, status: PlanRunStatus, now: number, reason?: string): void {
  if (run.status === status && !reason) return;
  setClock(run, clockForStatus(status), now);
  run.status = status;
  if (reason !== undefined) run.endReason = reason;
  else if (status === "running") delete run.endReason;
  if (isTerminalRunStatus(status) && run.endedAt === undefined) run.endedAt = now;
  if (!isTerminalRunStatus(status)) delete run.endedAt;
}

function findStep(run: PlanRun, phaseId: string, stepId: string): PlanRunStep | undefined {
  return run.steps.find((step) => step.phaseId === phaseId && step.stepId === stepId);
}

function ensureStep(run: PlanRun, phaseId: string, stepId: string, title: string): PlanRunStep {
  let step = findStep(run, phaseId, stepId);
  if (!step) {
    // A step the agent added while the run was going.
    step = { phaseId, stepId, title, status: "pending", attempts: 0, turnIds: [] };
    run.steps.push(step);
  }
  return step;
}

function currentTurn(run: PlanRun): PlanRunTurnRecord | undefined {
  return run.turns.at(-1);
}

/** Apply one event. Mutates and returns the run so the service can persist what changed. */
export function applyPlanRunEvent(run: PlanRun, event: PlanRunEvent): PlanRun {
  advanceClock(run, event.at);
  switch (event.type) {
    case "run_started":
      break;
    case "step_started": {
      const step = ensureStep(run, event.phaseId, event.stepId, event.title);
      step.title = event.title;
      step.status = "in_progress";
      step.startedAt = step.startedAt ?? event.at;
      delete step.endedAt;
      delete step.blockedReason;
      step.attempts += 1;
      const turn = currentTurn(run);
      if (turn && !step.turnIds.includes(turn.id)) step.turnIds.push(turn.id);
      if (turn) turn.stepTransitions += 1;
      run.turnsWithoutProgress = 0;
      break;
    }
    case "step_completed": {
      const step = ensureStep(run, event.phaseId, event.stepId, event.title);
      step.title = event.title;
      step.status = "completed";
      step.startedAt = step.startedAt ?? event.at;
      step.endedAt = event.at;
      delete step.blockedReason;
      if (event.evidence) step.evidence = event.evidence;
      const turn = currentTurn(run);
      if (turn && !step.turnIds.includes(turn.id)) step.turnIds.push(turn.id);
      if (turn) turn.stepTransitions += 1;
      run.turnsWithoutProgress = 0;
      break;
    }
    case "step_blocked": {
      const step = ensureStep(run, event.phaseId, event.stepId, event.title);
      step.title = event.title;
      step.status = "blocked";
      step.blockedReason = event.reason;
      const turn = currentTurn(run);
      if (turn && !step.turnIds.includes(turn.id)) step.turnIds.push(turn.id);
      if (turn) turn.stepTransitions += 1;
      run.turnsWithoutProgress = 0;
      break;
    }
    case "step_reset": {
      const step = ensureStep(run, event.phaseId, event.stepId, event.title);
      step.status = "pending";
      delete step.endedAt;
      delete step.blockedReason;
      break;
    }
    case "turn_started": {
      run.turns.push({ id: event.turnId, origin: event.origin, startedAt: event.at, stepTransitions: 0 });
      if (run.turns.length > MAX_TURN_RECORDS) run.turns.splice(0, run.turns.length - MAX_TURN_RECORDS);
      break;
    }
    case "turn_ended": {
      const turn = run.turns.find((entry) => entry.id === event.turnId);
      if (turn) {
        turn.endedAt = event.at;
        turn.stopReason = event.stopReason;
        turn.iterations = event.iterations;
        // A turn that moved no step is a turn without progress. Counted at its end so the
        // conductor's decision, which runs right after, sees it.
        if (turn.stepTransitions === 0 && turn.origin !== "user" && turn.origin !== "run") run.turnsWithoutProgress += 1;
      }
      break;
    }
    case "gate_wait":
    case "gate_resolved":
    case "provider_wait":
    case "provider_resumed":
      // Status changes drive the clock; these only carry detail for the event log.
      if (event.type === "gate_resolved") run.gatesAnswered += 1;
      break;
    case "provider_retry":
      run.retries += 1;
      break;
    case "compaction":
      run.compactions += 1;
      break;
    case "spend":
      if (Number.isFinite(event.usd)) run.spentUsd += Math.max(0, event.usd);
      run.spendPartial ||= event.partial;
      break;
    case "conductor_decision":
      run.conductorDecisions.push({ at: event.at, trigger: event.trigger, decision: event.decision, rationale: event.rationale });
      if (run.conductorDecisions.length > MAX_CONDUCTOR_RECORDS) run.conductorDecisions.splice(0, run.conductorDecisions.length - MAX_CONDUCTOR_RECORDS);
      break;
    case "handoff":
      run.lastHandoff = event.text;
      break;
    case "snapshot": {
      if (event.stepId && event.phaseId) {
        const step = findStep(run, event.phaseId, event.stepId);
        if (step) {
          if (Object.keys(event.projects).length) step.snapshots = event.projects;
          if (event.messageCount !== undefined) step.messageCount = event.messageCount;
        }
      } else {
        if (Object.keys(event.projects).length) run.baseline = event.projects;
        if (event.messageCount !== undefined) run.startMessageCount = event.messageCount;
      }
      if (event.skipped) run.snapshotNote = event.skipped;
      break;
    }
    case "status":
      setRunStatus(run, event.status, event.at, event.reason);
      break;
  }
  return run;
}

// ── View ───────────────────────────────────────────────────────────────────────

export interface PlanRunViewExtras {
  now: number;
  /** Time of the last sign of life from the main session. */
  lastProgressAt?: number;
  providerRetryAt?: number;
  providerWaitReason?: string;
  pauseRequested?: boolean;
  /** How long with no sign of life counts as quiet. */
  quietAfterMs?: number;
}

export const DEFAULT_QUIET_AFTER_MS = 3 * 60_000;

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function liveStateOf(run: PlanRun, quietMs: number | undefined, quietAfterMs: number): PlanRunLiveState {
  switch (run.status) {
    case "waiting_user": return "needs_you";
    case "waiting_provider": return "provider";
    case "paused": return "paused";
    case "interrupted": return "interrupted";
    case "completed": return "done";
    case "stopped": return "stopped";
    case "failed":
    case "budget_exhausted": return "failed";
    case "running":
      return quietMs !== undefined && quietMs >= quietAfterMs ? "quiet" : "working";
  }
}

/**
 * Combine the ledger with the plan as it stands now. The plan is the source of truth for what is
 * done and what is next; the ledger adds when, how long, how often and on what evidence.
 */
export function buildPlanRunView(run: PlanRun, plan: TaskPlan | undefined, extras: PlanRunViewExtras): PlanRunView {
  const { now } = extras;
  const byKey = new Map(run.steps.map((step) => [`${step.phaseId}/${step.stepId}`, step]));
  const liveDelta = run.clock === "stopped" ? 0 : Math.max(0, now - run.clockSince);
  const activeMs = run.activeMs + (run.clock === "active" ? liveDelta : 0);
  const waitingUserMs = run.waitingUserMs + (run.clock === "user" ? liveDelta : 0);
  const waitingProviderMs = run.waitingProviderMs + (run.clock === "provider" ? liveDelta : 0);

  const phases: PlanRunPhaseView[] = [];
  const durations: number[] = [];
  let stepsDone = 0;
  let stepsTotal = 0;
  let position = 0;
  let current: PlanRunView["currentStep"];
  let next: PlanRunView["nextStep"];
  let phaseIndex = 0;
  let phaseTitle: string | undefined;

  const sourcePhases = plan?.phases ?? [];
  sourcePhases.forEach((phase, phaseIdx) => {
    const stepViews: PlanRunStepView[] = [];
    for (const step of phase.steps) {
      const record = byKey.get(`${phase.id}/${step.id}`);
      const startedAt = record?.startedAt;
      const endedAt = step.status === "completed" ? record?.endedAt : undefined;
      const durationMs = startedAt !== undefined
        ? (endedAt ?? (step.status === "in_progress" ? now : undefined)) !== undefined
          ? Math.max(0, (endedAt ?? now) - startedAt)
          : undefined
        : undefined;
      stepsTotal += 1;
      if (step.status === "completed") {
        stepsDone += 1;
        if (durationMs !== undefined && endedAt !== undefined) durations.push(durationMs);
      }
      const view: PlanRunStepView = {
        id: step.id,
        title: step.title,
        status: step.status,
        startedAt,
        endedAt,
        durationMs,
        attempts: record?.attempts ?? 0,
        evidence: record?.evidence ?? step.evidence,
        blockedReason: step.status === "blocked" ? record?.blockedReason : undefined,
        restorable: !!record?.snapshots && Object.keys(record.snapshots).length > 0,
        turnId: record?.turnIds.at(-1),
      };
      stepViews.push(view);
      if (step.status === "in_progress" && !current) {
        current = { phaseId: phase.id, stepId: step.id, title: step.title };
        position = stepsTotal;
        phaseIndex = phaseIdx + 1;
        phaseTitle = phase.title;
      }
    }
    phases.push({ id: phase.id, title: phase.title, status: phase.status, steps: stepViews });
  });

  // With nothing in progress the "current" step is the first one still to do.
  const flat = phases.flatMap((phase) => phase.steps.map((step) => ({ phase, step })));
  if (!current) {
    const open = flat.find((entry) => entry.step.status === "pending" || entry.step.status === "blocked");
    if (open) {
      current = { phaseId: open.phase.id, stepId: open.step.id, title: open.step.title };
      position = flat.indexOf(open) + 1;
      phaseIndex = phases.indexOf(open.phase) + 1;
      phaseTitle = open.phase.title;
    }
  }
  if (current) {
    const at = flat.findIndex((entry) => entry.phase.id === current!.phaseId && entry.step.id === current!.stepId);
    const following = flat.slice(at + 1).find((entry) => entry.step.status === "pending");
    if (following) next = { phaseId: following.phase.id, stepId: following.step.id, title: following.step.title };
  }
  if (!current && stepsTotal > 0) {
    position = stepsTotal;
    phaseIndex = phases.length;
    phaseTitle = phases.at(-1)?.title;
  }

  const quietMs = run.status === "running" && extras.lastProgressAt !== undefined
    ? Math.max(0, now - extras.lastProgressAt)
    : undefined;

  return {
    id: run.id,
    planId: run.planId,
    planTitle: plan?.title ?? run.planTitle,
    status: run.status,
    liveState: liveStateOf(run, quietMs, extras.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    endReason: run.endReason,
    elapsedMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
    activeMs,
    waitingUserMs,
    waitingProviderMs,
    spentUsd: run.spentUsd,
    spendPartial: run.spendPartial,
    maxUsd: run.charter.maxUsd,
    maxMinutes: run.charter.maxMinutes,
    phaseIndex,
    phaseCount: phases.length,
    phaseTitle,
    stepsDone,
    stepsTotal,
    stepPosition: position,
    currentStep: current,
    nextStep: next,
    medianStepMs: median(durations),
    phases,
    lastHandoff: run.lastHandoff,
    turns: run.turns.length,
    retries: run.retries,
    compactions: run.compactions,
    providerRetryAt: run.status === "waiting_provider" ? extras.providerRetryAt : undefined,
    providerWaitReason: run.status === "waiting_provider" ? extras.providerWaitReason : undefined,
    quietMs,
    pauseRequested: !!extras.pauseRequested,
    snapshotNote: run.snapshotNote,
    hasBaseline: !!run.baseline && Object.keys(run.baseline).length > 0,
    hasReport: !!run.reportDocId,
  };
}

/** Seconds → "1h 05m", "7m 12s", "42s". Shared by the rail, the report and the status bar. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Transitions between two reads of the same plan, as run events. Pure so it can be tested. */
export function diffPlanSteps(
  before: Pick<TaskPlan, "phases"> | undefined,
  after: Pick<TaskPlan, "phases"> | undefined,
  at: number,
): PlanRunEvent[] {
  if (!after) return [];
  const previous = new Map<string, PlanStepStatus>();
  for (const phase of before?.phases ?? []) for (const step of phase.steps) previous.set(`${phase.id}/${step.id}`, step.status);
  const events: PlanRunEvent[] = [];
  for (const phase of after.phases) {
    for (const step of phase.steps) {
      const key = `${phase.id}/${step.id}`;
      const was = previous.get(key);
      if (was === step.status) continue;
      // A step added by the agent mid-run starts life pending; that is not a transition.
      if (was === undefined && step.status === "pending") continue;
      const base = { at, phaseId: phase.id, stepId: step.id, title: step.title };
      if (step.status === "in_progress") events.push({ type: "step_started", ...base });
      else if (step.status === "completed") events.push({ type: "step_completed", ...base });
      else if (step.status === "blocked") events.push({ type: "step_blocked", ...base, reason: step.notes.at(-1) });
      else if (step.status === "pending") events.push({ type: "step_reset", ...base });
    }
  }
  return events;
}
