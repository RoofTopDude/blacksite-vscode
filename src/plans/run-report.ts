/**
 * The account of a plan run, written by the harness when the run ends.
 *
 * Someone who comes back after several hours should not have to reconstruct what happened from a
 * transcript. This lists what was done, how long it took, what checked it, what was never checked,
 * what the run decided and asked, and where it stopped if it did not finish. It states only what
 * the ledger and the plan record: nothing here is the agent's own summary of itself.
 *
 * Pure: markdown out, facts in.
 */

import type { TaskPlan } from "../planning-store.js";
import { formatDuration, type PlanRun } from "./plan-run-model.js";

export interface RunReportFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface RunReportExtras {
  /** Every file changed during the run, summed. */
  filesChanged: readonly RunReportFile[];
  /** Files still owing a check when the report was written. */
  unverifiedNow: readonly string[];
}

const MAX_FILES_LISTED = 40;

function when(ms: number | undefined): string {
  if (!ms) return "—";
  const date = new Date(ms);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function outcomeLine(run: PlanRun, done: number, total: number): string {
  switch (run.status) {
    case "completed": return `Finished: all ${total} steps are done.`;
    case "stopped": return `Stopped by you at ${done} of ${total} steps${run.endReason ? ` (${run.endReason})` : ""}.`;
    case "budget_exhausted": return `Stopped at a ceiling with ${done} of ${total} steps done${run.endReason ? `: ${run.endReason}` : ""}.`;
    case "failed": return `Stopped on an error with ${done} of ${total} steps done${run.endReason ? `: ${run.endReason}` : ""}.`;
    case "paused": return `Paused with ${done} of ${total} steps done${run.endReason ? ` (${run.endReason})` : ""}.`;
    case "interrupted": return `Interrupted with ${done} of ${total} steps done.`;
    default: return `In progress: ${done} of ${total} steps done.`;
  }
}

export function buildRunReport(run: PlanRun, plan: TaskPlan | undefined, extras: RunReportExtras): string {
  const stepByKey = new Map(run.steps.map((step) => [`${step.phaseId}/${step.stepId}`, step]));
  const phases = plan?.phases ?? [];
  const allSteps = phases.flatMap((phase) => phase.steps.map((step) => ({ phase, step, record: stepByKey.get(`${phase.id}/${step.id}`) })));
  const done = allSteps.filter((entry) => entry.step.status === "completed").length;
  const total = allSteps.length || run.steps.length;
  const worked = run.activeMs + run.waitingUserMs + run.waitingProviderMs;

  const lines: string[] = [];
  lines.push(`# Plan run report — ${plan?.title ?? run.planTitle}`);
  lines.push("");
  lines.push(`**${outcomeLine(run, done, total)}**`);
  lines.push("");
  lines.push("## The run");
  lines.push("");
  lines.push(`- Started ${when(run.startedAt)}${run.endedAt ? `, ended ${when(run.endedAt)}` : ""}`);
  lines.push(`- Time: ${formatDuration(worked)} in all — ${formatDuration(run.activeMs)} working, ${formatDuration(run.waitingUserMs)} waiting for you, ${formatDuration(run.waitingProviderMs)} waiting for the model`);
  lines.push(`- Spend: $${run.spentUsd.toFixed(2)}${run.spendPartial ? " (some usage could not be priced, so this is a lower bound)" : ""}${run.charter.maxUsd ? ` of a $${run.charter.maxUsd.toFixed(2)} ceiling` : ""}`);
  lines.push(`- ${run.turns.length} turns, ${run.gatesAnswered} approvals or questions answered, ${run.retries} provider retries, ${run.compactions} context compactions`);
  if (run.model) lines.push(`- Model: ${run.model}`);
  lines.push("");

  lines.push("## Steps");
  lines.push("");
  if (allSteps.length === 0) {
    lines.push("The plan has no steps.");
  } else {
    lines.push("| # | Step | Result | Time | Checked by | Files |");
    lines.push("|---|------|--------|------|-----------|-------|");
    allSteps.forEach(({ phase, step, record }, index) => {
      const duration = record?.startedAt !== undefined && record.endedAt !== undefined && step.status === "completed"
        ? formatDuration(record.endedAt - record.startedAt)
        : "";
      const evidence = record?.evidence ?? step.evidence;
      const checked = evidence?.checks.length ? evidence.checks.join(", ") : step.status === "completed" ? (evidence?.filesChanged.length ? "not checked" : "nothing to check") : "";
      const tries = record && record.attempts > 1 ? ` (tried ${record.attempts}×)` : "";
      const result = step.status === "completed" ? "done" : step.status === "blocked" ? `blocked${record?.blockedReason ? `: ${record.blockedReason}` : ""}` : step.status === "in_progress" ? "in progress" : "not started";
      lines.push(`| ${index + 1} | ${cell(`${phase.title}: ${step.title}`)} | ${cell(result)}${tries} | ${duration} | ${cell(checked)} | ${evidence?.filesChanged.length ?? ""} |`);
    });
  }
  lines.push("");

  const unverifiedSteps = allSteps.filter(({ record, step }) => step.status === "completed" && (record?.evidence ?? step.evidence)?.unverified.length);
  if (unverifiedSteps.length || extras.unverifiedNow.length) {
    lines.push("## Not checked");
    lines.push("");
    lines.push("These changes were made and nothing ran against them. Review them, or run the project's checks.");
    lines.push("");
    for (const { step, record } of unverifiedSteps) {
      const files = (record?.evidence ?? step.evidence)!.unverified;
      lines.push(`- **${step.title}** — ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` (+${files.length - 6} more)` : ""}`);
    }
    if (extras.unverifiedNow.length) lines.push(`- Still owing a check now: ${extras.unverifiedNow.slice(0, 10).join(", ")}${extras.unverifiedNow.length > 10 ? ` (+${extras.unverifiedNow.length - 10} more)` : ""}`);
    lines.push("");
  }

  const blocked = allSteps.filter(({ step }) => step.status === "blocked");
  if (blocked.length) {
    lines.push("## Needs a decision");
    lines.push("");
    for (const { step, record } of blocked) lines.push(`- **${step.title}**${record?.blockedReason ? ` — ${record.blockedReason}` : ""}${step.notes.at(-1) ? ` (last note: ${step.notes.at(-1)!.slice(0, 200)})` : ""}`);
    lines.push("");
  }

  if (extras.filesChanged.length) {
    const added = extras.filesChanged.reduce((sum, file) => sum + file.additions, 0);
    const removed = extras.filesChanged.reduce((sum, file) => sum + file.deletions, 0);
    lines.push("## Files changed");
    lines.push("");
    lines.push(`${extras.filesChanged.length} files, +${added} −${removed}.`);
    lines.push("");
    for (const file of extras.filesChanged.slice(0, MAX_FILES_LISTED)) lines.push(`- \`${file.path}\` (+${file.additions} −${file.deletions})`);
    if (extras.filesChanged.length > MAX_FILES_LISTED) lines.push(`- … and ${extras.filesChanged.length - MAX_FILES_LISTED} more`);
    lines.push("");
  }

  if (run.conductorDecisions.length) {
    lines.push("## What the conductor decided");
    lines.push("");
    for (const decision of run.conductorDecisions.slice(-20)) {
      lines.push(`- ${when(decision.at)} — **${decision.decision}** (${decision.trigger}): ${decision.rationale.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    lines.push("");
  }

  if (run.status !== "completed" && run.lastHandoff) {
    lines.push("## Where it stopped");
    lines.push("");
    lines.push("```");
    lines.push(run.lastHandoff);
    lines.push("```");
    lines.push("");
  }

  if (run.snapshotNote || run.baseline) {
    lines.push("## Restore points");
    lines.push("");
    const restorable = run.steps.filter((step) => step.snapshots && Object.keys(step.snapshots).length).length;
    lines.push(run.snapshotNote
      ? `Restore points were limited: ${run.snapshotNote}.`
      : `${restorable} step${restorable === 1 ? "" : "s"} can be restored to from the step list.`);
    lines.push("");
  }

  return lines.join("\n");
}

/** A title that sorts and reads well in the plan's document list. */
export function runReportTitle(run: PlanRun): string {
  return `Run report ${new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " ")}`;
}
