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
  /** Work receipts recorded for the step (src/orchestration), when work contracts are on. */
  receiptIds?: string[];
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

/** Routine work a run may do without asking, ticked before it starts (see run-envelope.ts). */
export type RunPermissionValue = "install_dependencies" | "project_scripts" | "git_commit" | "push_run_branch";

export const RUN_PERMISSION_VALUES: readonly RunPermissionValue[] = ["install_dependencies", "project_scripts", "git_commit", "push_run_branch"];

export const RUN_PERMISSION_LABELS: Record<RunPermissionValue, string> = {
  install_dependencies: "install the dependencies the project declares",
  project_scripts: "run the project's test, build and lint scripts",
  git_commit: "commit locally",
  push_run_branch: "push the run's own branch",
};

/**
 * What happens when the run needs the user and nobody answers: queue the decision and carry on
 * with other work, pause after a while, or keep waiting.
 */
export type WhenBlocked = "defer" | "pause" | "wait";

export type DeferredDecisionKind = "approval" | "edit" | "question";
export type DeferredDecisionStatus = "open" | "approved" | "declined" | "answered";

export interface DeferredQuestionView {
  question: string;
  options: Array<{ key: string; label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Something the run needed from the user while they were away, queued instead of waited on. */
export interface DeferredDecisionView {
  id: string;
  kind: DeferredDecisionKind;
  description: string;
  tier?: string;
  questions?: DeferredQuestionView[];
  /** The step the run was on when it asked. */
  stepTitle?: string;
  at: number;
  status: DeferredDecisionStatus;
  resolvedAt?: number;
  /** How it was answered, in words. */
  answer?: string;
}

/** Where a run in an isolated copy came from, and the branch it works on. */
export interface RunIsolationView {
  branch: string;
  baseBranch?: string;
  baseHead: string;
  /** The folder the copy was made from. */
  sourceRoot: string;
  worktreePath: string;
}

export interface TripwireView {
  at: number;
  kind: string;
  title: string;
  detail: string;
  examples?: string[];
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
  whenBlocked: WhenBlocked;
  /** Minutes an unanswered gate waits before it is queued, when `whenBlocked` is "defer". */
  deferAfterMinutes?: number;
  allow: RunPermissionValue[];
  tripwiresOn: boolean;
  /** Open decisions first, then the most recently answered. */
  decisions: DeferredDecisionView[];
  openDecisions: number;
  /** Operations approved without the user during the run: by the reviewer, the charter, or an earlier answer. */
  autoAllowed: number;
  tripwires: TripwireView[];
  isolation?: RunIsolationView;
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
  /** Whether the run can work in an isolated copy, and what that copy would start from. */
  isolation: PreflightIsolation;
}

export interface PreflightIsolation {
  available: boolean;
  reason?: string;
  branch?: string;
  head?: string;
  /** Uncommitted files that would stay behind. */
  dirtyFiles: number;
  notes: string[];
}

/** What the user agrees to when they start a run, as the webview sends it. */
export interface PlanRunCharterInput {
  maxUsd?: number;
  maxMinutes?: number;
  pauseWhenBlockedMinutes?: number;
  providerWaitMinutes?: number;
  notifications?: "attention" | "all" | "off";
  whenBlocked?: WhenBlocked;
  deferAfterMinutes?: number;
  allow?: RunPermissionValue[];
  tripwires?: boolean;
  /** Work in an isolated copy, opened in a new window. */
  isolated?: boolean;
}
