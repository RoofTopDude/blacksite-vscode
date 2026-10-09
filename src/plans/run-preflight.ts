/**
 * What the user sees before a long unattended run starts.
 *
 * A plan that is going to run for hours without anyone watching should be read once, first, by
 * something that has no stake in it being fine. This lints the plan for the gaps that most often
 * turn into a stalled run — a step with no definition of done, a phase that names no files, an
 * open question nobody answered — and summarises the projects it will touch. Everything here is a
 * finding, never a gate: the user decides, and a plan with warnings starts exactly as readily as
 * one without.
 *
 * Pure. The host gathers the project facts (toolchain verdicts, the approval mode) and hands them
 * in; the lint itself needs only the plan.
 */

import type { TaskPlan } from "../planning-store.js";
import type { PreflightApprovalMode, PreflightFinding, PreflightLevel, PreflightProject, PreflightReport } from "./plan-run-view.js";

export type { PreflightApprovalMode, PreflightFinding, PreflightLevel, PreflightProject, PreflightReport };

const MAX_EXAMPLES = 3;
const LARGE_PHASE_STEPS = 12;
const MAX_LISTED_PROJECTS = 12;

function examples(titles: string[]): string[] | undefined {
  return titles.length ? titles.slice(0, MAX_EXAMPLES) : undefined;
}

export function lintPlan(plan: TaskPlan): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const open = plan.phases.flatMap((phase) => phase.steps.filter((step) => step.status !== "completed").map((step) => ({ phase, step })));

  if (open.length === 0) {
    findings.push({ level: "warn", message: "Every step in this plan is already done." });
    return findings;
  }

  const blocked = open.filter(({ step }) => step.status === "blocked");
  if (blocked.length) {
    findings.push({
      level: "warn",
      message: `${blocked.length} step${blocked.length === 1 ? " is" : "s are"} blocked, and the run will meet ${blocked.length === 1 ? "it" : "them"} again.`,
      fix: "Review the blocked steps, decide what each needs, and clear or rewrite them.",
      examples: examples(blocked.map(({ step }) => step.title)),
    });
  }

  const noDone = open.filter(({ phase, step }) => !step.acceptanceCriteria && !(phase.acceptanceCriteria?.length));
  if (noDone.length) {
    findings.push({
      level: "warn",
      message: `${noDone.length} open step${noDone.length === 1 ? " has" : "s have"} no definition of done, so the run cannot tell finished from nearly finished.`,
      fix: "Add acceptance criteria to the steps that have none, saying how each will be checked.",
      examples: examples(noDone.map(({ step }) => step.title)),
    });
  }

  const questions = [...plan.blocks, ...plan.phases.flatMap((phase) => phase.blocks)].filter((block) => block.kind === "open_questions");
  if (questions.length) {
    findings.push({
      level: "warn",
      message: "The plan still lists open questions. The run will have to guess, or stop and ask.",
      fix: "Resolve the open questions in the plan, asking me where a decision is mine to make.",
      examples: examples(questions.map((block) => block.label ?? "Open questions")),
    });
  }

  const openPhases = plan.phases.filter((phase) => phase.steps.some((step) => step.status !== "completed"));
  const noFiles = openPhases.filter((phase) => !phase.files?.length);
  if (noFiles.length) {
    findings.push({
      level: "info",
      message: `${noFiles.length} open phase${noFiles.length === 1 ? " names" : "s name"} no files, so the Map cannot show where ${noFiles.length === 1 ? "it works" : "they work"} and the run cannot check the right projects first.`,
      fix: "Name the files each phase expects to touch.",
      examples: examples(noFiles.map((phase) => phase.title)),
    });
  }

  const large = openPhases.filter((phase) => phase.steps.length > LARGE_PHASE_STEPS);
  if (large.length) {
    findings.push({
      level: "info",
      message: `${large.length} phase${large.length === 1 ? " has" : "s have"} more than ${LARGE_PHASE_STEPS} steps. Smaller phases give clearer progress and better restore points.`,
      examples: examples(large.map((phase) => `${phase.title} (${phase.steps.length} steps)`)),
    });
  }

  const dangling = openPhases.filter((phase) => (phase.dependsOn ?? []).some((id) => !plan.phases.some((other) => other.id === id)));
  if (dangling.length) {
    findings.push({
      level: "info",
      message: "Some phases depend on phases that no longer exist.",
      examples: examples(dangling.map((phase) => phase.title)),
    });
  }

  return findings;
}

export function buildPreflight(input: {
  plan: TaskPlan;
  projects: readonly PreflightProject[];
  approvalMode: PreflightApprovalMode;
  /** True when another run is already open. */
  runOpen?: boolean;
}): PreflightReport {
  const { plan } = input;
  const steps = plan.phases.flatMap((phase) => phase.steps);
  const stepsOpen = steps.filter((step) => step.status !== "completed").length;
  let blocker: string | undefined;
  if (input.runOpen) blocker = "A plan run is already open. Resume or stop it first.";
  else if (["completed", "cancelled", "archived"].includes(plan.status)) blocker = `This plan is ${plan.status}.`;
  else if (plan.status === "on_hold") blocker = "This plan is on hold. Resume it from the Plans panel first.";
  else if (stepsOpen === 0) blocker = "Every step in this plan is already done.";

  const projects = [...input.projects].sort((a, b) => b.issues.length - a.issues.length || b.files - a.files);
  return {
    planId: plan.id,
    planTitle: plan.title,
    stepsOpen,
    stepsTotal: steps.length,
    phaseCount: plan.phases.length,
    findings: lintPlan(plan),
    projects: projects.slice(0, MAX_LISTED_PROJECTS),
    moreProjects: Math.max(0, projects.length - MAX_LISTED_PROJECTS),
    approvalMode: input.approvalMode,
    defaultMaxUsd: plan.budget?.maxUsd,
    canStart: !blocker,
    blocker,
  };
}
