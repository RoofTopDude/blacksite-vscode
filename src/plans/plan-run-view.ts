/**
 * What a plan run looks like to a person: the shapes the host sends to the chat webview.
 *
 * Kept free of imports on purpose. The webview type-checks against these, and anything they
 * pulled in (the plan store, vscode) would come along with them into a browser build.
 */

export type PlanStepStatusValue = "pending" | "in_progress" | "completed" | "blocked";

export type PlanRunStatus =
  | "running"
  | "waiting_user"
  | "waiting_provider"
  | "paused"
  | "interrupted"
  | "completed"
  | "stopped"
  | "failed"
  | "budget_exhausted";

/** What the run looks like, in one word. */
export type PlanRunLiveState =
  | "working"
  | "needs_you"
  | "provider"
  | "quiet"
  | "paused"
  | "interrupted"
  | "done"
  | "stopped"
  | "failed";

/**
 * What a step was shown to have when it finished. A label for the user and the conductor, never a
 * gate: a step nothing checked is marked unverified, not blocked.
 */
export interface StepEvidence {
  /** Checks that cleared the step's files, e.g. "npm test". */
  checks: string[];
  /** Files changed during the step that no check covered. */
  unverified: string[];
  filesChanged: string[];
  diagnostics?: { errors: number; warnings: number };
  runIds?: string[];
  at: string;
}

export interface PlanRunStepView {
  id: string;
  title: string;
  status: PlanStepStatusValue;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  attempts: number;
  evidence?: StepEvidence;
  blockedReason?: string;
  /** A snapshot exists to restore to after this step. */
  restorable: boolean;
  /** The latest turn that touched the step, to scroll to. */
  turnId?: string;
}

export interface PlanRunPhaseView {
  id: string;
  title: string;
  status: PlanStepStatusValue;
  steps: PlanRunStepView[];
}

export interface PlanRunView {
  id: string;
  planId: string;
  planTitle: string;
  status: PlanRunStatus;
  liveState: PlanRunLiveState;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  /** Wall-clock time the run has existed, to the second the view was built. */
  elapsedMs: number;
  activeMs: number;
  waitingUserMs: number;
  waitingProviderMs: number;
  spentUsd: number;
  spendPartial: boolean;
  maxUsd?: number;
  maxMinutes?: number;
  phaseIndex: number;
  phaseCount: number;
  phaseTitle?: string;
  stepsDone: number;
  stepsTotal: number;
  /** 1-based position of the step being worked among all steps, for "Step 7/23". */
  stepPosition: number;
  currentStep?: { phaseId: string; stepId: string; title: string };
  nextStep?: { phaseId: string; stepId: string; title: string };
  medianStepMs?: number;
  phases: PlanRunPhaseView[];
  lastHandoff?: string;
  turns: number;
  retries: number;
  compactions: number;
  /** Set while waiting on the provider: when the next attempt happens. */
  providerRetryAt?: number;
  providerWaitReason?: string;
  /** Milliseconds since the last sign of life (provider byte, tool output, tool result). */
  quietMs?: number;
  pauseRequested: boolean;
  snapshotNote?: string;
  hasBaseline: boolean;
  /** An end-of-run report has been written and can be opened. */
  hasReport: boolean;
}

// ── Preflight ──────────────────────────────────────────────────────────────────

export type PreflightLevel = "warn" | "info";

export interface PreflightFinding {
  level: PreflightLevel;
  message: string;
  /** What to ask the agent to do about it, when there is a fix it can make. */
  fix?: string;
  /** Titles that make the finding concrete, so it can be found in the plan. */
  examples?: string[];
}

export interface PreflightProject {
  name: string;
  /** Project root relative to the workspace, or "." */
  root: string;
  files: number;
  /** Plain-language problems: a toolchain that is missing or too old, an environment not set up. */
  issues: string[];
}

export type PreflightApprovalMode = "ask" | "auto";

export interface PreflightReport {
  planId: string;
  planTitle: string;
  stepsOpen: number;
  stepsTotal: number;
  phaseCount: number;
  findings: PreflightFinding[];
  projects: PreflightProject[];
  /** Projects beyond the ones listed, so a large workspace stays readable. */
  moreProjects: number;
  approvalMode: PreflightApprovalMode;
  /** The plan's own spend ceiling, offered as the run's default. */
  defaultMaxUsd?: number;
  canStart: boolean;
  blocker?: string;
}

/** What the user agrees to when they start a run, as the webview sends it. */
export interface PlanRunCharterInput {
  maxUsd?: number;
  maxMinutes?: number;
  pauseWhenBlockedMinutes?: number;
  providerWaitMinutes?: number;
  notifications?: "attention" | "all" | "off";
}
