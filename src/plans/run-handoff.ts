/**
 * The note the harness leaves when a run stops short of finishing.
 *
 * A run that ends at its iteration limit, a spend ceiling, a provider failure or a pause used to
 * leave a bare label and a transcript to read. This writes the account instead: where the plan
 * stood, what changed, what was never checked, and what comes next. It is built from facts the
 * harness already holds, so it costs no model call and cannot be wrong about them. The next turn
 * receives it once, and the user sees it as a card.
 */

export type HandoffReason =
  | "max_iterations"
  | "budget"
  | "provider"
  | "cancelled"
  | "paused"
  | "error"
  | "stalled"
  | "blocked"
  | "halt"
  | "interrupted";

export interface HandoffChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface HandoffInput {
  reason: HandoffReason;
  /** Free detail: the error text, the gate that was waiting, the ceiling that was reached. */
  detail?: string;
  planTitle?: string;
  phaseIndex?: number;
  phaseCount?: number;
  phaseTitle?: string;
  stepPosition?: number;
  stepsTotal?: number;
  stepsDone?: number;
  currentStepTitle?: string;
  nextStepTitle?: string;
  /** Files changed since the run (or turn) began. */
  changes?: readonly HandoffChange[];
  unverifiedFiles?: readonly string[];
  verificationFailed?: boolean;
  lastNarration?: string;
  lastFailure?: { tool: string; error: string };
  iterations?: number;
  maxIterations?: number;
  spentUsd?: number;
  maxUsd?: number;
}

const MAX_FILES_LISTED = 6;
const MAX_HANDOFF_CHARS = 1400;

export function describeStopReason(reason: HandoffReason, input: Pick<HandoffInput, "iterations" | "maxIterations" | "spentUsd" | "maxUsd" | "detail"> = {}): string {
  switch (reason) {
    case "max_iterations":
      return input.maxIterations
        ? `Reached the ${input.maxIterations}-round limit for one request.`
        : "Reached the round limit for one request.";
    case "budget":
      return input.maxUsd !== undefined && input.spentUsd !== undefined
        ? `Spend reached $${input.spentUsd.toFixed(2)} of the $${input.maxUsd.toFixed(2)} ceiling.`
        : "A spend or time ceiling was reached.";
    case "provider":
      return input.detail ? `The model provider kept failing: ${oneLine(input.detail, 160)}` : "The model provider kept failing.";
    case "cancelled": return "Stopped by you.";
    case "paused": return "Paused at the end of a step.";
    case "error": return input.detail ? `Stopped on an error: ${oneLine(input.detail, 160)}` : "Stopped on an error.";
    case "stalled": return "No sign of progress for a long time.";
    case "blocked": return input.detail ? `Waiting on you: ${oneLine(input.detail, 160)}` : "Waiting on you.";
    case "halt": return input.detail ? oneLine(input.detail, 200) : "The conductor stopped the run.";
    case "interrupted": return "VS Code closed or reloaded while the run was working.";
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function listFiles(paths: readonly string[], max = MAX_FILES_LISTED): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} (+${paths.length - max} more)` : shown;
}

/** Build the handoff text. Deterministic: the same facts always produce the same note. */
export function buildHandoff(input: HandoffInput): string {
  const lines: string[] = [`Stopped: ${describeStopReason(input.reason, input)}`];

  const where: string[] = [];
  if (input.planTitle) where.push(input.planTitle);
  if (input.stepPosition && input.stepsTotal) where.push(`step ${input.stepPosition}/${input.stepsTotal}`);
  if (input.currentStepTitle) where.push(`"${oneLine(input.currentStepTitle, 90)}"`);
  if (input.phaseTitle) {
    where.push(input.phaseIndex && input.phaseCount
      ? `in phase ${input.phaseIndex}/${input.phaseCount} "${oneLine(input.phaseTitle, 60)}"`
      : `in phase "${oneLine(input.phaseTitle, 60)}"`);
  }
  if (where.length) lines.push(`Where it got to: ${where.join(" · ")}${input.stepsDone !== undefined && input.stepsTotal ? ` (${input.stepsDone} of ${input.stepsTotal} steps done)` : ""}`);

  const changes = input.changes ?? [];
  if (changes.length) {
    const added = changes.reduce((sum, change) => sum + change.additions, 0);
    const removed = changes.reduce((sum, change) => sum + change.deletions, 0);
    lines.push(`Changed: ${changes.length} file${changes.length === 1 ? "" : "s"} (+${added} −${removed}): ${listFiles(changes.map((change) => change.path))}`);
  } else {
    lines.push("Changed: no files.");
  }

  const unverified = input.unverifiedFiles ?? [];
  if (input.verificationFailed) lines.push("Checks: the last check failed.");
  if (unverified.length) lines.push(`Not checked: ${listFiles(unverified)}`);

  if (input.lastFailure) lines.push(`Last failure: ${input.lastFailure.tool}: ${oneLine(input.lastFailure.error, 180)}`);
  if (input.lastNarration) lines.push(`Last update: "${oneLine(input.lastNarration, 220)}"`);

  if (input.nextStepTitle) lines.push(`Next: "${oneLine(input.nextStepTitle, 100)}"`);
  else if (input.currentStepTitle && input.reason !== "interrupted") lines.push(`Next: finish "${oneLine(input.currentStepTitle, 100)}".`);

  const text = lines.join("\n");
  return text.length > MAX_HANDOFF_CHARS ? `${text.slice(0, MAX_HANDOFF_CHARS - 1)}…` : text;
}

export interface TurnFacts {
  changes: readonly HandoffChange[];
  unverifiedFiles: readonly string[];
  verificationFailed: boolean;
  lastFailure?: { tool: string; error: string };
  lastNarration?: string;
  toolCalls: number;
  /** Step transitions during the turn, already phrased: `completed "Add the parser"`. */
  stepMoves: readonly string[];
}

/**
 * What the harness itself saw during a turn, for the conductor. The executor's last message is
 * the executor's account; this is the record. They usually agree, and the conductor is there for
 * the turns where they do not.
 */
export function buildTurnDigest(facts: TurnFacts): string {
  const lines: string[] = [];
  lines.push(facts.stepMoves.length ? `Steps: ${facts.stepMoves.slice(0, 6).join("; ")}` : "Steps: no step changed state.");
  lines.push(facts.toolCalls ? `Tool calls: ${facts.toolCalls}.` : "Tool calls: none.");
  if (facts.changes.length) {
    const added = facts.changes.reduce((sum, change) => sum + change.additions, 0);
    const removed = facts.changes.reduce((sum, change) => sum + change.deletions, 0);
    lines.push(`Files changed: ${facts.changes.length} (+${added} -${removed}): ${listFiles(facts.changes.map((change) => change.path), 8)}`);
  } else {
    lines.push("Files changed: none.");
  }
  if (facts.verificationFailed) lines.push("Checks: the last check failed.");
  if (facts.unverifiedFiles.length) lines.push(`Not checked: ${listFiles(facts.unverifiedFiles, 8)}`);
  if (facts.lastFailure) lines.push(`Last failed tool: ${facts.lastFailure.tool}: ${oneLine(facts.lastFailure.error, 200)}`);
  return lines.join("\n");
}

/**
 * The text the next turn receives. Framed as the harness's own record, so the model reads it as
 * facts about where it stopped and not as an instruction to follow.
 */
export function handoffForNextTurn(handoff: string): string {
  return [
    "# Where the previous request stopped",
    "Written by the harness from what it observed; use it to pick up the work, not as an instruction.",
    handoff,
  ].join("\n");
}
