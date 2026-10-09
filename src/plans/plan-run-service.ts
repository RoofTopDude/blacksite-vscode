/**
 * Drives a plan run: starts it, accounts for it while it goes, and ends it honestly.
 *
 * The service owns no model calls and no UI. It is a state machine fed by the places that already
 * know things — the chat provider (turns, gates, spend, provider waits), the plan store (step
 * transitions) — and it answers with a ledger on disk, a view for the webview, attention items
 * for whoever has to act, and a context for the conductor. Everything it touches outside itself
 * goes through the narrow `PlanRunHost`, which is also what lets tests run a whole run in memory.
 */

import { randomUUID } from "crypto";
import type { PlanningDocument, StepEvidence, TaskPlan } from "../planning-store.js";
import { AttentionCenter, type AttentionItem } from "../chat/attention.js";
import type { PlanContinuationRunContext } from "./plan-continuation-service.js";
import type { ContinuationTrigger } from "../continuation/continuation-model.js";
import {
  applyPlanRunEvent,
  buildPlanRunView,
  createPlanRun,
  diffPlanSteps,
  formatDuration,
  isTerminalRunStatus,
  normalizeCharter,
  type PlanRun,
  type PlanRunEvent,
  type PlanRunStatus,
  type PlanRunTurnOrigin,
  type PlanRunView,
} from "./plan-run-model.js";
import type { PlanRunStore } from "./plan-run-store.js";
import {
  buildHandoff,
  buildTurnDigest,
  type HandoffInput,
  type HandoffReason,
  type TurnFacts,
} from "./run-handoff.js";
import { buildResumeBrief, planIsComplete } from "./plan-recovery.js";

export interface PlanRunPlanningPort {
  read(): PlanningDocument;
  setExecutionApproved(planId: string, approved: boolean): unknown;
  setPlanStatus(planId: string, status: TaskPlan["status"]): unknown;
  setStepEvidence(planId: string, phaseId: string, stepId: string, evidence: StepEvidence): unknown;
}

export interface SnapshotOutcome {
  /** Tree id per project root. Empty when nothing could be captured. */
  projects: Record<string, string>;
  /** Why capture was skipped or partial, shown to the user rather than hidden. */
  skipped?: string;
}

export interface PlanRunHost {
  sessionInfo(): { sessionId: string; provider?: string; model?: string; messageCount: number } | undefined;
  isTurnLive(): boolean;
  /** Start a turn for the run. Returns once launched, not when finished. */
  launchTurn(message: string, options: { origin: PlanRunTurnOrigin; userText: string; label: string }): void;
  requestPause(): void;
  cancelTurn(): void;
  retryProviderNow(): void;
  /** Called when the run ends or is stopped, so approvals given for it do not outlive it. */
  endGrants(): void;
  /** What a finished step was shown to have. */
  collectEvidence?(context: { phaseId: string; stepId: string; startedAt?: number; now: number }): StepEvidence | undefined;
  /** Capture the working tree of the projects the plan touches. */
  captureSnapshot?(context: { label: string; plan: TaskPlan }): Promise<SnapshotOutcome | undefined>;
  /** Write the end-of-run report somewhere the user can open it. Returns the document id. */
  saveReport?(run: PlanRun, plan: TaskPlan | undefined): string | undefined | Promise<string | undefined>;
  publish(view: PlanRunView | null): void;
}

export interface PlanRunServiceOptions {
  now?: () => number;
  newId?: () => string;
}

/** The turn-level facts the chat provider hands over when a turn ends. */
export interface PlanRunTurnEnd {
  turnId: string;
  stopReason: string;
  iterations: number;
  errored: boolean;
  errorMessage?: string;
  facts: TurnFacts;
  maxIterations?: number;
  /** Counts for the handoff, supplied because only the provider knows the live verification state. */
  detail?: string;
}

const QUIET_ATTENTION_MS = 10 * 60_000;
const TICK_MS = 30_000;
const SAVE_THROTTLE_MS = 4_000;
const PUBLISH_THROTTLE_MS = 150;
const MAX_PRIOR_DECISIONS = 8;

type AgentEventLike = { type: string; [key: string]: unknown };

export class PlanRunService {
  private _run: PlanRun | undefined;
  private _lastPlan: TaskPlan | undefined;
  private _lastProgressAt = 0;
  private _pauseRequested = false;
  private _providerRetryAt: number | undefined;
  private _providerWaitReason: string | undefined;
  private readonly _openGates = new Map<string, { at: number; kind: "approval" | "question" }>();
  private _blockedSince: number | undefined;
  private _stallRaised = false;
  private _resumeHint: ContinuationTrigger | undefined;
  private _lastDigest: string | undefined;
  private _lastTurnBlockedStep = false;
  private _lastCompressionCount = 0;
  private _saveTimer: ReturnType<typeof setTimeout> | undefined;
  private _dirty = false;
  private _publishTimer: ReturnType<typeof setTimeout> | undefined;
  private _tick: ReturnType<typeof setInterval> | undefined;
  private _snapshotQueue: Promise<void> = Promise.resolve();
  private readonly _now: () => number;
  private readonly _newId: () => string;

  constructor(
    private readonly _store: PlanRunStore,
    private readonly _planning: PlanRunPlanningPort,
    private readonly _host: PlanRunHost,
    readonly attention: AttentionCenter,
    options: PlanRunServiceOptions = {},
  ) {
    this._now = options.now ?? (() => Date.now());
    this._newId = options.newId ?? (() => `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`);
  }

  dispose(): void {
    this._flushSave();
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._publishTimer) clearTimeout(this._publishTimer);
    this._stopTicking();
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** The run that is current: running, paused, interrupted or failed — not one that has ended. */
  get active(): PlanRun | undefined {
    return this._run && !isTerminalRunStatus(this._run.status) ? this._run : undefined;
  }

  /** The last run, even after it ended (the report and the "Done" state read it). */
  get current(): PlanRun | undefined {
    return this._run;
  }

  get pauseRequested(): boolean {
    return this._pauseRequested;
  }

  /** How long a provider outage may be waited out, in ms. Zero when no run is active to wait. */
  providerOutageWaitMs(): number {
    const run = this.active;
    if (!run) return 0;
    if (run.status !== "running" && run.status !== "waiting_provider") return 0;
    return run.charter.providerWaitMinutes * 60_000;
  }

  view(): PlanRunView | null {
    const run = this._run;
    if (!run) return null;
    return buildPlanRunView(run, this._planOf(run), {
      now: this._now(),
      lastProgressAt: this._lastProgressAt || undefined,
      providerRetryAt: this._providerRetryAt,
      providerWaitReason: this._providerWaitReason,
      pauseRequested: this._pauseRequested,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Reconcile a run left behind by a host that died: it was working, and now it is not. */
  recover(): PlanRun | undefined {
    const run = this._store.list().find((entry) => !isTerminalRunStatus(entry.status));
    if (!run) return undefined;
    this._run = run;
    this._lastPlan = this._planOf(run);
    if (run.status === "running" || run.status === "waiting_user" || run.status === "waiting_provider") {
      this._apply({ type: "status", at: this._now(), status: "interrupted", reason: "VS Code closed or reloaded while this run was working." });
      this._save();
      this._raise({
        id: `run:${run.id}:interrupted`,
        kind: "run_interrupted",
        severity: "needs_you",
        source: "run",
        title: `Run interrupted at step ${this._stepLabel()}`,
        detail: "VS Code closed or reloaded while the plan was running. Resume it from the run bar.",
      });
    }
    this._publishNow();
    return run;
  }

  start(input: { planId: string; charter?: unknown }): { ok: true; run: PlanRun } | { ok: false; error: string } {
    if (this.active) return { ok: false, error: "A plan run is already open. Resume or stop it first." };
    const plan = this._planning.read().plans.find((entry) => entry.id === input.planId);
    if (!plan) return { ok: false, error: "That plan no longer exists." };
    if (["completed", "cancelled", "archived"].includes(plan.status)) return { ok: false, error: `That plan is ${plan.status}.` };
    if (plan.status === "on_hold") return { ok: false, error: "That plan is on hold. Resume it from the Plans panel first." };
    if (planIsComplete(plan) || !plan.phases.some((phase) => phase.steps.some((step) => step.status !== "completed"))) {
      return { ok: false, error: "Every step in that plan is already done." };
    }
    const session = this._host.sessionInfo();
    if (!session) return { ok: false, error: "No chat session is available to run the plan." };

    const now = this._now();
    const charter = normalizeCharter(input.charter);
    const run = createPlanRun({
      id: this._newId(),
      plan,
      sessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
      charter,
      now,
      startMessageCount: session.messageCount,
    });
    this._run = run;
    this._lastPlan = plan;
    this._pauseRequested = false;
    this._providerRetryAt = undefined;
    this._providerWaitReason = undefined;
    this._openGates.clear();
    this._blockedSince = undefined;
    this._stallRaised = false;
    this._resumeHint = undefined;
    this._lastDigest = undefined;
    this._lastTurnBlockedStep = false;
    this._lastProgressAt = now;
    this._event({ type: "run_started", at: now, planId: plan.id, planTitle: plan.title, charter });
    this._save();

    // The run is the user's go-ahead: the plan may now be executed, and an auto-continuing
    // conductor needs an active plan to drive.
    this._planning.setExecutionApproved(plan.id, true);
    if (plan.status !== "active" && plan.status !== "blocked") this._planning.setPlanStatus(plan.id, "active");

    this._startTicking();
    this._queueSnapshot(`Start of run`, undefined);
    this._publishNow();

    if (!this._host.isTurnLive()) {
      this._host.launchTurn(kickoffMessage(plan), { origin: "run", userText: `Run the plan "${plan.title}".`, label: "plan run" });
    }
    return { ok: true, run };
  }

  /** Ask the run to stop at the end of the current tool round. */
  pause(): void {
    const run = this.active;
    if (!run || run.status === "paused") return;
    if (this._host.isTurnLive()) {
      this._pauseRequested = true;
      this._host.requestPause();
      this._publishSoon();
      return;
    }
    // Between turns there is nothing to wait for.
    this._settleAsPaused("Paused by you.", "paused");
  }

  resume(): { ok: boolean; error?: string } {
    const run = this.active;
    if (!run) return { ok: false, error: "There is no run to resume." };
    if (run.status === "running" || run.status === "waiting_provider") return { ok: true };
    const plan = this._planOf(run);
    if (!plan) return { ok: false, error: "The plan for this run no longer exists." };
    if (plan.status === "on_hold" || plan.status === "cancelled" || plan.status === "archived") {
      return { ok: false, error: `The plan is ${plan.status.replace("_", " ")}. Resume the plan first.` };
    }
    const wasInterrupted = run.status === "interrupted";
    this._pauseRequested = false;
    this._blockedSince = undefined;
    this._resolveRunAttention(run);
    this._apply({ type: "status", at: this._now(), status: "running" });
    if (wasInterrupted) this._resumeHint = "interrupted";
    this._planning.setExecutionApproved(plan.id, true);
    this._save();
    this._startTicking();
    this._publishNow();
    if (!this._host.isTurnLive()) {
      const message = [
        "[Plan run resumed]",
        buildResumeBrief(plan),
        run.lastHandoff ? `\nWhere the run stopped:\n${run.lastHandoff}` : "",
        "\nPick the plan up from the current step. Anything already finished is on disk; check before redoing it.",
      ].filter(Boolean).join("\n");
      this._host.launchTurn(message, { origin: "resume", userText: `Resume the plan "${plan.title}".`, label: "plan run" });
    }
    return { ok: true };
  }

  stop(reason = "Stopped by you."): void {
    const run = this.active;
    if (!run) return;
    this._pauseRequested = false;
    if (this._host.isTurnLive()) this._host.cancelTurn();
    this._finish("stopped", reason, "cancelled");
  }

  /** The run is waiting out a provider outage and the user wants to try again now. */
  retryProvider(): void {
    if (this.active?.status === "waiting_provider") this._host.retryProviderNow();
  }

  // ── Feeds from the chat provider ─────────────────────────────────────────

  noteTurnStart(turnId: string, origin: PlanRunTurnOrigin): void {
    const run = this.active;
    if (!run) return;
    const now = this._now();
    this._lastProgressAt = now;
    this._stallRaised = false;
    this._lastTurnBlockedStep = false;
    this.attention.resolve(`run:${run.id}:stalled`);
    // A person speaking again is the answer to a conductor question, and ends a stale error stop.
    // A paused run stays paused: a side question is not an instruction to resume the plan.
    if ((origin === "user" || origin === "steer") && (run.status === "waiting_user" && this._openGates.size === 0)) {
      this._resolveRunAttention(run);
      this._apply({ type: "status", at: now, status: "running" });
    }
    this._event({ type: "turn_started", at: now, turnId, origin });
    this._save();
    this._publishSoon();
  }

  noteTurnEnd(end: PlanRunTurnEnd): string | undefined {
    const run = this.active ?? (this._run && this._run.turns.some((turn) => turn.id === end.turnId) ? this._run : undefined);
    if (!run) return undefined;
    let handoffText: string | undefined;
    const now = this._now();
    this._openGates.clear();
    this._blockedSince = undefined;
    this._providerRetryAt = undefined;
    this._providerWaitReason = undefined;
    if (run.status === "waiting_user" && !this._conductorHold) this._apply({ type: "status", at: now, status: "running" });
    if (run.status === "waiting_provider") this._apply({ type: "status", at: now, status: "running" });
    this._event({ type: "turn_ended", at: now, turnId: end.turnId, stopReason: end.stopReason, iterations: end.iterations });

    const moves = this._stepMovesIn(run, end.turnId);
    this._lastTurnBlockedStep = moves.blocked;
    this._lastDigest = buildTurnDigest({ ...end.facts, stepMoves: moves.phrases });

    const plan = this._planOf(run);
    const handoffBase = this._handoffBase(run, plan, end);

    switch (end.stopReason) {
      case "paused": {
        const text = buildHandoff({ ...handoffBase, reason: "paused" });
        handoffText = text;
        this._event({ type: "handoff", at: now, reason: "paused", text });
        this._settleAsPaused("Paused at the end of a step.", "paused");
        break;
      }
      case "cancelled": {
        const text = buildHandoff({ ...handoffBase, reason: "cancelled" });
        handoffText = text;
        this._event({ type: "handoff", at: now, reason: "cancelled", text });
        // Stopping a turn stops the run's momentum, not the run. Stop in the rail ends it.
        if (this.active && this.active.status === "running") this._settleAsPaused("Stopped by you.", "paused");
        break;
      }
      case "error":
      case "protocol_violation":
      case "context_window_exceeded":
      case "refusal": {
        const text = buildHandoff({ ...handoffBase, reason: "error", detail: end.errorMessage ?? end.detail });
        handoffText = text;
        this._event({ type: "handoff", at: now, reason: "error", text });
        this._settleAsFailed(end.errorMessage ?? `The turn ended with ${end.stopReason}.`);
        break;
      }
      case "max_iterations": {
        const text = buildHandoff({ ...handoffBase, reason: "max_iterations" });
        handoffText = text;
        this._event({ type: "handoff", at: now, reason: "max_iterations", text });
        break;
      }
      default:
        break;
    }
    this._save();
    this._publishSoon();
    return handoffText;
  }

  /**
   * Resolves once the restore points queued so far have been taken. The plan tool waits on this
   * before it answers, so the snapshot for "step 7 done" is the files as they were then, not as
   * the next step has already begun to change them.
   */
  async settleSnapshots(maxWaitMs = 150_000): Promise<void> {
    await Promise.race([this._snapshotQueue, new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs))]);
  }

  /** Called for every agent event of the run's session, lane events included. */
  noteAgentEvent(event: AgentEventLike): void {
    const run = this._run;
    if (!run || isTerminalRunStatus(run.status)) return;
    const now = this._now();
    switch (event.type) {
      case "text_delta":
      case "thinking_delta":
      case "tool_call_start":
      case "tool_call_result":
      case "iteration_start":
      case "steer_delivered":
        this._noteProgress(now);
        if (run.status === "waiting_provider" && event.type !== "iteration_start") this._leaveProviderWait(now);
        break;
      case "approval_pending":
      case "question_card_pending": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const kind = event.type === "approval_pending" ? "approval" : "question";
        this._openGates.set(id, { at: now, kind });
        this._event({ type: "gate_wait", at: now, kind, id, description: typeof event.description === "string" ? event.description : undefined });
        if (run.status === "running") {
          this._blockedSince = now;
          this._apply({ type: "status", at: now, status: "waiting_user" });
        }
        this._publishSoon();
        break;
      }
      case "approval_result":
      case "question_card_result": {
        const id = String(event.toolCallId ?? "");
        const gate = this._openGates.get(id);
        if (!gate) break;
        this._openGates.delete(id);
        this._event({ type: "gate_resolved", at: now, id, ms: now - gate.at });
        this._noteProgress(now);
        if (this._openGates.size === 0 && run.status === "waiting_user") {
          this._blockedSince = undefined;
          this._apply({ type: "status", at: now, status: "running" });
        }
        this._publishSoon();
        break;
      }
      case "provider_activity": {
        if (event.outage === true) {
          this._providerRetryAt = typeof event.retryAt === "number" ? event.retryAt : undefined;
          this._providerWaitReason = typeof event.message === "string" ? event.message : undefined;
          if (run.status === "running") {
            this._event({ type: "provider_wait", at: now, reason: this._providerWaitReason ?? "provider unavailable", nextRetryAt: this._providerRetryAt });
            this._apply({ type: "status", at: now, status: "waiting_provider" });
            this._raise({
              id: `run:${run.id}:provider`,
              kind: "provider_wait",
              severity: "info",
              source: "run",
              title: "Waiting for the model provider",
              detail: this._providerWaitReason,
            });
          }
          this._publishSoon();
        } else if (event.phase === "retrying") {
          this._event({ type: "provider_retry", at: now });
        } else if (run.status === "waiting_provider" && event.phase !== "idle") {
          this._leaveProviderWait(now);
        }
        break;
      }
      case "runtime_state": {
        const state = event.state as { compressionCount?: number } | undefined;
        const count = state?.compressionCount ?? 0;
        if (count > this._lastCompressionCount) {
          for (let i = this._lastCompressionCount; i < count; i++) this._event({ type: "compaction", at: now });
          this._dirty = true;
        }
        this._lastCompressionCount = count;
        break;
      }
      default:
        break;
    }
  }

  /** Output from a running command also counts as a sign of life. */
  noteProgress(): void {
    this._noteProgress(this._now());
  }

  noteSpend(usd: number | undefined, partial: boolean): void {
    const run = this.active;
    if (!run) return;
    const now = this._now();
    this._event({ type: "spend", at: now, usd: usd ?? 0, partial: partial || usd === undefined });
    this._dirty = true;
    this._scheduleSave();
    const max = run.charter.maxUsd;
    if (max !== undefined && run.spentUsd >= max && run.status !== "paused") {
      if (this._host.isTurnLive()) this._host.cancelTurn();
      const text = `Spend reached $${run.spentUsd.toFixed(2)} of the $${max.toFixed(2)} ceiling for this run.`;
      this._event({ type: "handoff", at: now, reason: "budget", text: this._handoffText("budget", { spentUsd: run.spentUsd, maxUsd: max }) });
      this._finish("budget_exhausted", text, "budget");
      return;
    }
    this._publishSoon();
  }

  /** The plan store changed. Turn step transitions into ledger events and notice a finished plan. */
  notePlanChanged(document: PlanningDocument): void {
    const run = this._run;
    if (!run || isTerminalRunStatus(run.status)) return;
    const plan = document.plans.find((entry) => entry.id === run.planId);
    if (!plan) {
      this._finish("stopped", "The plan was deleted.", "cancelled");
      return;
    }
    const now = this._now();
    const events = diffPlanSteps(this._lastPlan, plan, now);
    this._lastPlan = plan;
    for (const event of events) {
      if (event.type === "step_completed") {
        const step = run.steps.find((entry) => entry.phaseId === event.phaseId && entry.stepId === event.stepId);
        const evidence = this._host.collectEvidence?.({ phaseId: event.phaseId, stepId: event.stepId, startedAt: step?.startedAt, now });
        this._event(evidence ? { ...event, evidence } : event);
        if (evidence) {
          try { this._planning.setStepEvidence(run.planId, event.phaseId, event.stepId, evidence); } catch { /* evidence is a label, never a reason to fail */ }
        }
        this._queueSnapshot(`After "${event.title}"`, { phaseId: event.phaseId, stepId: event.stepId });
      } else {
        this._event(event);
      }
    }

    if (plan.status === "on_hold" && run.status !== "paused" && run.status !== "interrupted") {
      if (plan.budget?.exceeded) {
        this._settleAsPaused("The plan's spend ceiling was reached.", "paused");
        this._raise({ id: `run:${run.id}:budget`, kind: "budget", severity: "needs_you", source: "run", title: "Plan spend ceiling reached", detail: "The plan is on hold. Raise the ceiling and resume it to continue." });
      } else {
        this._settleAsPaused("The plan was put on hold.", "paused");
      }
    } else if (plan.status === "cancelled" || plan.status === "archived") {
      this._finish("stopped", `The plan was ${plan.status}.`, "cancelled");
      return;
    }

    if (planIsComplete(plan) || plan.status === "completed") {
      this._finish("completed", "Every step is done.", undefined);
      return;
    }
    if (events.length) {
      this._save();
      this._publishSoon();
    }
  }

  /** The user typed a message: the run's runaway budget resets via progress, not via this. */
  noteUserMessage(): void {
    const run = this.active;
    if (!run) return;
    this._resumeHint = undefined;
  }

  /**
   * The user put the files back to how they were after a step. The steps after it no longer
   * describe the files, so the plan is reset by the caller; the run stops here and waits to be
   * resumed on purpose.
   */
  noteRestored(label: string): void {
    const run = this.active;
    if (!run) return;
    if (this._host.isTurnLive()) this._host.cancelTurn();
    this._event({ type: "handoff", at: this._now(), reason: "halt", text: `Stopped: ${label}` });
    this._settleAsPaused(label, "halt");
  }

  /** Set by the host after a snapshot completes. */
  private _recordSnapshot(outcome: SnapshotOutcome | undefined, target: { phaseId: string; stepId: string } | undefined): void {
    const run = this._run;
    if (!run || !outcome) return;
    const info = this._host.sessionInfo();
    this._event({
      type: "snapshot",
      at: this._now(),
      ...(target ? { phaseId: target.phaseId, stepId: target.stepId } : {}),
      projects: outcome.projects,
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      messageCount: info?.messageCount,
    });
    this._save();
    this._publishSoon();
  }

  // ── Conductor ────────────────────────────────────────────────────────────

  /** True while a conductor ask holds the run, so a turn ending does not mark it running again. */
  private _conductorHold = false;

  conductorContext(): PlanContinuationRunContext {
    return {
      active: () => {
        const run = this.active;
        if (!run || run.status !== "running" || this._pauseRequested) return undefined;
        return { planId: run.planId, consecutive: run.turnsWithoutProgress };
      },
      holds: () => {
        const run = this.active;
        return !!run && (run.status !== "running" || this._pauseRequested);
      },
      digest: () => this._lastDigest,
      priorDecisions: () => (this._run?.conductorDecisions ?? [])
        .filter((entry) => entry.decision !== "halt")
        .slice(-MAX_PRIOR_DECISIONS)
        .map((entry) => `${entry.decision === "ask" ? "Asked the user" : "Continued"} (${entry.trigger}): ${entry.rationale}`),
      ledgerAttempts: () => new Map((this._run?.steps ?? []).map((step) => [`${step.phaseId}/${step.stepId}`, step.attempts] as const)),
      triggerHint: () => {
        if (this._resumeHint) {
          const hint = this._resumeHint;
          this._resumeHint = undefined;
          return hint;
        }
        return this._lastTurnBlockedStep ? "step_failed" : undefined;
      },
      record: ({ trigger, kind, text }) => {
        this._event({ type: "conductor_decision", at: this._now(), trigger: trigger ?? "stalled", decision: kind, rationale: text.slice(0, 500) });
        this._dirty = true;
        this._scheduleSave();
      },
      stopped: (kind, message) => {
        const run = this.active;
        if (!run) return;
        const now = this._now();
        if (kind === "ask") {
          this._conductorHold = true;
          this._apply({ type: "status", at: now, status: "waiting_user", reason: message.slice(0, 300) });
          this._raise({
            id: `run:${run.id}:ask`,
            kind: "conductor_ask",
            severity: "needs_you",
            source: "run",
            title: "The run has a question for you",
            detail: message.slice(0, 400),
          });
        } else {
          this._conductorHold = false;
          const text = this._handoffText(kind === "halt" ? "halt" : "stalled", { detail: message });
          this._event({ type: "handoff", at: now, reason: kind === "halt" ? "halt" : "stalled", text });
          this._settleAsPaused(message.slice(0, 300), "paused");
          this._raise({
            id: `run:${run.id}:${kind}`,
            kind: kind === "halt" ? "conductor_halt" : "budget",
            severity: "needs_you",
            source: "run",
            title: kind === "halt" ? "The run was stopped by the conductor" : "The run is waiting for a check-in",
            detail: message.slice(0, 400),
          });
        }
        this._save();
        this._publishSoon();
      },
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _planOf(run: PlanRun): TaskPlan | undefined {
    // The plan store tells us about every write, so the copy from the last one is current and
    // reading the whole document again for each view would only repeat that work.
    if (this._lastPlan?.id === run.planId) return this._lastPlan;
    try {
      return this._planning.read().plans.find((entry) => entry.id === run.planId);
    } catch {
      return undefined;
    }
  }

  private _stepLabel(): string {
    const view = this.view();
    return view ? `${view.stepPosition}/${view.stepsTotal}` : "?";
  }

  private _apply(event: PlanRunEvent): void {
    const run = this._run;
    if (!run) return;
    if (event.type === "status" && event.status === "running") this._conductorHold = false;
    applyPlanRunEvent(run, event);
    this._store.appendEvent(run.id, event);
    this._dirty = true;
  }

  private _event(event: PlanRunEvent): void {
    this._apply(event);
  }

  private _noteProgress(now: number): void {
    this._lastProgressAt = now;
    if (this._stallRaised && this._run) {
      this._stallRaised = false;
      this.attention.resolve(`run:${this._run.id}:stalled`);
    }
  }

  private _leaveProviderWait(now: number): void {
    const run = this._run;
    if (!run || run.status !== "waiting_provider") return;
    this._providerRetryAt = undefined;
    this._providerWaitReason = undefined;
    this._event({ type: "provider_resumed", at: now });
    this._apply({ type: "status", at: now, status: "running" });
    this.attention.resolve(`run:${run.id}:provider`);
    this._publishSoon();
  }

  private _stepMovesIn(run: PlanRun, turnId: string): { phrases: string[]; blocked: boolean } {
    const turn = run.turns.find((entry) => entry.id === turnId);
    const phrases: string[] = [];
    let blocked = false;
    if (!turn) return { phrases, blocked };
    for (const step of run.steps) {
      if (!step.turnIds.includes(turnId)) continue;
      phrases.push(`${step.status.replace("_", " ")} "${step.title}"`);
      if (step.status === "blocked") blocked = true;
    }
    return { phrases, blocked };
  }

  private _handoffBase(run: PlanRun, plan: TaskPlan | undefined, end: PlanRunTurnEnd): Omit<HandoffInput, "reason"> {
    const view = this.view();
    return {
      planTitle: plan?.title ?? run.planTitle,
      phaseIndex: view?.phaseIndex,
      phaseCount: view?.phaseCount,
      phaseTitle: view?.phaseTitle,
      stepPosition: view?.stepPosition,
      stepsTotal: view?.stepsTotal,
      stepsDone: view?.stepsDone,
      currentStepTitle: view?.currentStep?.title,
      nextStepTitle: view?.nextStep?.title,
      changes: end.facts.changes,
      unverifiedFiles: end.facts.unverifiedFiles,
      verificationFailed: end.facts.verificationFailed,
      lastNarration: end.facts.lastNarration,
      lastFailure: end.facts.lastFailure,
      iterations: end.iterations,
      maxIterations: end.maxIterations,
      spentUsd: run.spentUsd,
      maxUsd: run.charter.maxUsd,
    };
  }

  private _handoffText(reason: HandoffReason, extra: Partial<HandoffInput> = {}): string {
    const run = this._run;
    const view = this.view();
    return buildHandoff({
      reason,
      planTitle: view?.planTitle ?? run?.planTitle,
      phaseIndex: view?.phaseIndex,
      phaseCount: view?.phaseCount,
      phaseTitle: view?.phaseTitle,
      stepPosition: view?.stepPosition,
      stepsTotal: view?.stepsTotal,
      stepsDone: view?.stepsDone,
      currentStepTitle: view?.currentStep?.title,
      nextStepTitle: view?.nextStep?.title,
      ...extra,
    });
  }

  private _settleAsPaused(reason: string, handoffReason: HandoffReason): void {
    const run = this.active;
    if (!run) return;
    this._pauseRequested = false;
    this._providerRetryAt = undefined;
    this._apply({ type: "status", at: this._now(), status: "paused", reason });
    if (!run.lastHandoff || handoffReason === "paused") {
      this._event({ type: "handoff", at: this._now(), reason: handoffReason, text: run.lastHandoff ?? this._handoffText(handoffReason) });
    }
    this._raise({
      id: `run:${run.id}:paused`,
      kind: "run_paused",
      severity: "info",
      source: "run",
      title: "Run paused",
      detail: reason,
    });
    this._save();
    this._publishSoon();
  }

  private _settleAsFailed(message: string): void {
    const run = this.active;
    if (!run) return;
    this._pauseRequested = false;
    this._apply({ type: "status", at: this._now(), status: "failed", reason: message.slice(0, 300) });
    this._raise({
      id: `run:${run.id}:failed`,
      kind: "run_failed",
      severity: "error",
      source: "run",
      title: `Run stopped on an error at step ${this._stepLabel()}`,
      detail: message.slice(0, 400),
    });
  }

  private _finish(status: "completed" | "stopped" | "budget_exhausted", reason: string, handoffReason: HandoffReason | undefined): void {
    const run = this._run;
    if (!run || isTerminalRunStatus(run.status)) return;
    const now = this._now();
    this._pauseRequested = false;
    this._conductorHold = false;
    this._openGates.clear();
    this._providerRetryAt = undefined;
    this._providerWaitReason = undefined;
    if (handoffReason && status !== "completed" && !run.lastHandoff) {
      this._event({ type: "handoff", at: now, reason: handoffReason, text: this._handoffText(handoffReason) });
    }
    this._apply({ type: "status", at: now, status, reason });
    this._resolveRunAttention(run);
    this._host.endGrants();
    this._stopTicking();
    this._flushSave();
    const plan = this._planOf(run);
    try {
      void Promise.resolve(this._host.saveReport?.(run, plan)).then((docId) => {
        if (!docId) return;
        run.reportDocId = docId;
        this._save();
        this._publishNow();
      }, () => undefined);
    } catch { /* the report is a courtesy; the ledger is the record */ }
    if (status === "completed") {
      this._raise({
        id: `run:${run.id}:done`,
        kind: "run_done",
        severity: "success",
        source: "run",
        title: `Plan run finished in ${formatDuration(run.activeMs + run.waitingUserMs + run.waitingProviderMs)}`,
        detail: `${run.steps.filter((step) => step.status === "completed").length} steps done, $${run.spentUsd.toFixed(2)} spent.`,
      });
    } else if (status === "budget_exhausted") {
      this._raise({
        id: `run:${run.id}:budget`,
        kind: "budget",
        severity: "error",
        source: "run",
        title: "Run stopped at its ceiling",
        detail: reason,
      });
    }
    this._publishNow();
  }

  private _resolveRunAttention(run: PlanRun): void {
    this.attention.resolveWhere((item) => item.source === "run" && item.id.startsWith(`run:${run.id}:`) && item.kind !== "run_done");
  }

  private _raise(item: Omit<AttentionItem, "at">): void {
    this.attention.raise({ ...item, at: this._now() });
  }

  /** Snapshots are serialised: two captures at once would race the same private index. */
  private _queueSnapshot(label: string, target: { phaseId: string; stepId: string } | undefined): void {
    const capture = this._host.captureSnapshot;
    const run = this._run;
    if (!capture || !run) return;
    this._snapshotQueue = this._snapshotQueue.then(async () => {
      const plan = this._planOf(run);
      if (!plan) return;
      try {
        const outcome = await capture.call(this._host, { label, plan });
        this._recordSnapshot(outcome, target);
      } catch (error) {
        this._recordSnapshot({ projects: {}, skipped: error instanceof Error ? error.message : String(error) }, target);
      }
    });
  }

  // ── Persistence, publishing, ticking ─────────────────────────────────────

  private _save(): void {
    if (!this._run) return;
    this._dirty = false;
    try { this._store.save(this._run); } catch { /* disk trouble must not stop the run */ }
  }

  private _scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined;
      if (this._dirty) this._save();
    }, SAVE_THROTTLE_MS);
  }

  private _flushSave(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = undefined; }
    if (this._dirty) this._save();
  }

  private _publishNow(): void {
    if (this._publishTimer) { clearTimeout(this._publishTimer); this._publishTimer = undefined; }
    this._host.publish(this.view());
  }

  private _publishSoon(): void {
    if (this._publishTimer) return;
    this._publishTimer = setTimeout(() => {
      this._publishTimer = undefined;
      this._host.publish(this.view());
    }, PUBLISH_THROTTLE_MS);
  }

  private _startTicking(): void {
    if (this._tick) return;
    this._tick = setInterval(() => this._onTick(), TICK_MS);
  }

  private _stopTicking(): void {
    if (this._tick) { clearInterval(this._tick); this._tick = undefined; }
  }

  /** Time-driven checks: ceilings, a stuck wait, a quiet run. */
  private _onTick(): void {
    const run = this.active;
    if (!run) { this._stopTicking(); return; }
    const now = this._now();
    const used = (run.clock === "stopped" ? 0 : Math.max(0, now - run.clockSince))
      + run.activeMs + run.waitingUserMs + run.waitingProviderMs;
    const maxMs = run.charter.maxMinutes !== undefined ? run.charter.maxMinutes * 60_000 : undefined;
    if (maxMs !== undefined && used >= maxMs && run.status !== "paused" && run.status !== "interrupted" && run.status !== "failed") {
      if (this._host.isTurnLive()) this._host.cancelTurn();
      this._event({ type: "handoff", at: now, reason: "budget", text: this._handoffText("budget", { detail: `The ${run.charter.maxMinutes}-minute time ceiling was reached.` }) });
      this._finish("budget_exhausted", `The ${run.charter.maxMinutes}-minute time ceiling was reached.`, "budget");
      return;
    }
    const blockedLimit = run.charter.pauseWhenBlockedMinutes;
    if (run.status === "waiting_user" && !this._conductorHold && blockedLimit !== undefined && this._blockedSince !== undefined
      && now - this._blockedSince >= blockedLimit * 60_000) {
      const waitingOn = [...this._openGates.values()][0]?.kind ?? "your answer";
      this._event({ type: "handoff", at: now, reason: "blocked", text: this._handoffText("blocked", { detail: `Waited ${blockedLimit} minutes for ${waitingOn}.` }) });
      if (this._host.isTurnLive()) this._host.cancelTurn();
      this._settleAsPaused(`Paused after waiting ${blockedLimit} minutes for you.`, "blocked");
      return;
    }
    if (run.status === "running" && this._host.isTurnLive() && this._lastProgressAt && now - this._lastProgressAt >= QUIET_ATTENTION_MS && !this._stallRaised) {
      this._stallRaised = true;
      this._raise({
        id: `run:${run.id}:stalled`,
        kind: "run_stalled",
        severity: "needs_you",
        source: "run",
        title: "The run may be stalled",
        detail: `Nothing has come back from the agent for ${formatDuration(now - this._lastProgressAt)}.`,
      });
    }
    this._publishSoon();
  }
}

/** The one message that starts a run. The plan itself rides in the context tail already. */
export function kickoffMessage(plan: Pick<TaskPlan, "title" | "id">): string {
  return [
    `[Plan run] Execute the plan "${plan.title}" (${plan.id}) from where it stands.`,
    "Work through its phases in order. Mark each step in_progress when you start it and completed when it is done and checked (plan_update). If a step is blocked, mark it blocked with a note saying what you need, and carry on with anything independent.",
    "Keep going until the plan is finished or you genuinely need the user.",
  ].join("\n");
}

export type { PlanRunStatus };
