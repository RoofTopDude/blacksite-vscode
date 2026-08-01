/**
 * What a run actually did, and whether it matched what it promised.
 *
 * The trace already holds everything needed to answer that; nothing here reads new data. What was
 * missing is the question. A raw event list tells you what happened in order — it does not tell
 * you whether your workspace is dirty right now, which files got written that nobody declared, or
 * which host the run talked to that was not on the manifest. Those are the things a person
 * actually wants after watching an automated sequence run against their code.
 *
 * Pure and host-side: the report needs the full step list and a manifest lookup, which the webview
 * (holding only a bounded window) cannot do. Kept in its own module so it is testable the way
 * apps/runs/view-model.ts is, rather than reachable only by driving a live run.
 */
import type {
  AssertionResult,
  EntityRef,
  ExecutionRun,
  FailureEnvelope,
  ObservationBundle,
  RunEvent,
  RunStep,
  SideEffectRecord,
} from "./run-model.js";

/** The preflight promise, as much of it as the report compares against. Structurally a subset of
 *  SequencePreflightManifest so the service can pass its own manifest straight in. */
export interface PreflightPromise {
  filesystemEffects: Array<{ stepId: string; action: string; target?: string }>;
  commandEffects: Array<{ stepId: string; command: string; args: string[] }>;
  browserOrigins: string[];
  requiredApprovals: Array<{ tier: string; description: string; stepId?: string }>;
  deniedOperations: Array<{ stepId: string; reason: string }>;
  unresolvedDynamicStepCount: number;
  maxDurationMs: number;
}

export interface BlastRadiusGroup {
  class: SideEffectRecord["class"];
  count: number;
  irreversibleCount: number;
  entities: EntityRef[];
  descriptions: string[];
}

export interface PromiseComparison {
  /** Happened, and was declared. */
  asDeclared: string[];
  /** Happened, and was *not* declared. The bucket people actually read. */
  beyondDeclaration: string[];
  /** Declared, but never happened. Usually benign; occasionally the reason a run did nothing. */
  neverHappened: string[];
}

export interface EvidenceRow {
  kind: "assertion" | "diagnostic" | "anomaly";
  label: string;
  detail?: string;
  severity?: string;
  stepId?: string;
  sequenceNumber?: number;
  eventId?: string;
}

export interface PerspectiveSet {
  observationId: string;
  sequenceNumber: number;
  frameCount: number;
  artifactIds: string[];
}

export interface InspectionReport {
  runId: string;
  /** One sentence. The thing worth reading if you read nothing else. */
  verdict: string;
  /** True when irreversible effects landed — i.e. the workspace is not as it was. */
  dirty: boolean;
  blastRadius: BlastRadiusGroup[];
  promise?: PromiseComparison;
  evidence: EvidenceRow[];
  perspectives: PerspectiveSet[];
}

/** Descending severity. A destructive effect and a workspace read are not the same news, and the
 *  order is what carries that without the reader having to know the vocabulary. */
const CLASS_ORDER: SideEffectRecord["class"][] = [
  "destructive", "external_mutation", "workspace_write", "process",
  "network_write", "network_read", "workspace_read", "none",
];

function entityKey(ref: EntityRef): string {
  return `${ref.scheme}:${ref.id}`;
}

/** Effects grouped by class, most consequential first, deduplicated by entity. */
export function blastRadius(steps: RunStep[]): BlastRadiusGroup[] {
  const groups = new Map<SideEffectRecord["class"], BlastRadiusGroup>();
  for (const step of steps) {
    for (const effect of step.sideEffects ?? []) {
      if (effect.class === "none") continue;
      const group = groups.get(effect.class) ?? {
        class: effect.class, count: 0, irreversibleCount: 0, entities: [], descriptions: [],
      };
      group.count += 1;
      if (!effect.reversible) group.irreversibleCount += 1;
      const seen = new Set(group.entities.map(entityKey));
      for (const ref of effect.entityRefs ?? []) {
        if (!seen.has(entityKey(ref))) { group.entities.push(ref); seen.add(entityKey(ref)); }
      }
      if (!group.descriptions.includes(effect.description)) group.descriptions.push(effect.description);
      groups.set(effect.class, group);
    }
  }
  return [...groups.values()].sort(
    (left, right) => CLASS_ORDER.indexOf(left.class) - CLASS_ORDER.indexOf(right.class),
  );
}

/** Effects that had already landed when a run failed and cannot be undone — the concrete answer
 *  to "is my workspace dirty right now?". */
export function irreversibleResidue(steps: RunStep[], failure?: FailureEnvelope): SideEffectRecord[] {
  const fromFailure = failure?.completedSideEffects ?? [];
  const fromSteps = steps.flatMap((step) => step.sideEffects ?? []);
  const byId = new Map<string, SideEffectRecord>();
  for (const effect of [...fromSteps, ...fromFailure]) {
    if (!effect.reversible && effect.class !== "none") byId.set(effect.id, effect);
  }
  return [...byId.values()];
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildVerdict(
  run: ExecutionRun,
  steps: RunStep[],
  failure: FailureEnvelope | undefined,
  residue: SideEffectRecord[],
): string {
  const total = steps.length;
  const completed = steps.filter((step) => step.status === "succeeded").length;
  const duration = run.summary?.durationMs;
  const took = duration !== undefined ? ` after ${(duration / 1000).toFixed(1)}s` : "";

  const residueClause = residue.length > 0
    ? ` ${plural(residue.length, "effect")} cannot be undone — the workspace is not as it was.`
    : "";

  if (failure) {
    const failedStep = steps.find((step) => step.id === failure.failedStepId);
    const at = failedStep ? ` at step ${failedStep.ordinal + 1} of ${total}` : "";
    return `Failed${at} (${failure.category})${took}.${residueClause}`;
  }

  switch (run.status) {
    case "succeeded":
      return `Succeeded — ${completed} of ${total} steps${took}.${residueClause}`;
    case "partial":
      return `Partial — ${completed} of ${total} steps completed${took}.${residueClause}`;
    case "cancelled":
      return `Cancelled after ${completed} of ${total} steps${took}.${residueClause}`;
    case "timed_out":
      return `Timed out after ${completed} of ${total} steps${took}.${residueClause}`;
    default:
      return `${run.status} — ${completed} of ${total} steps${took}.${residueClause}`;
  }
}

function originOf(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}

/**
 * Declared versus observed.
 *
 * This is the part that makes the report an instrument rather than a log viewer, and it is nearly
 * free: the manifest is already stored as an event payload, and the observed side is already on
 * the steps. The interesting output is the middle bucket — an undeclared file write or an
 * unexpected origin is exactly the thing nobody would think to go looking for.
 */
export function comparePromise(
  promise: PreflightPromise,
  steps: RunStep[],
  events: RunEvent[],
): PromiseComparison {
  const asDeclared: string[] = [];
  const beyondDeclaration: string[] = [];
  const neverHappened: string[] = [];

  // ── filesystem ────────────────────────────────────────────────────────────
  const declaredFiles = new Set(
    promise.filesystemEffects.map((effect) => effect.target).filter((t): t is string => !!t),
  );
  const writtenFiles = new Set<string>();
  for (const step of steps) {
    for (const effect of step.sideEffects ?? []) {
      if (effect.class !== "workspace_write" && effect.class !== "destructive") continue;
      for (const ref of effect.entityRefs ?? []) {
        if (ref.scheme === "workspace-file") writtenFiles.add(ref.workspacePath ?? ref.id);
      }
    }
  }
  for (const file of writtenFiles) {
    (declaredFiles.has(file) ? asDeclared : beyondDeclaration).push(`wrote ${file}`);
  }
  for (const file of declaredFiles) {
    if (!writtenFiles.has(file)) neverHappened.push(`declared a write to ${file}`);
  }

  // ── browser origins ───────────────────────────────────────────────────────
  const declaredOrigins = new Set(
    promise.browserOrigins.map((value) => originOf(value) ?? value),
  );
  const contacted = new Set<string>();
  for (const event of events) {
    for (const ref of event.entityRefs ?? []) {
      if (ref.scheme !== "browser-request" && ref.scheme !== "route") continue;
      const origin = originOf(ref.id);
      if (origin) contacted.add(origin);
    }
  }
  for (const origin of contacted) {
    (declaredOrigins.has(origin) ? asDeclared : beyondDeclaration).push(`contacted ${origin}`);
  }
  for (const origin of declaredOrigins) {
    if (!contacted.has(origin)) neverHappened.push(`declared origin ${origin}`);
  }

  // ── commands ──────────────────────────────────────────────────────────────
  const declaredCommands = new Set(promise.commandEffects.map((effect) => effect.command));
  const spawned = new Set<string>();
  for (const step of steps) {
    for (const effect of step.sideEffects ?? []) {
      if (effect.class === "process") spawned.add(effect.description);
    }
  }
  for (const command of spawned) {
    const declared = [...declaredCommands].some((candidate) => command.includes(candidate));
    (declared ? asDeclared : beyondDeclaration).push(`ran ${command}`);
  }

  // ── things worth saying even with nothing to compare against ──────────────
  if (promise.unresolvedDynamicStepCount > 0) {
    asDeclared.push(`${plural(promise.unresolvedDynamicStepCount, "step")} chose a target at runtime`);
  }
  for (const denied of promise.deniedOperations) {
    neverHappened.push(`refused: ${denied.reason}`);
  }

  return { asDeclared, beyondDeclaration, neverHappened };
}

/** Assertions, diagnostics and anomalies, deduplicated and ordered by where they happened. */
export function evidenceLedger(steps: RunStep[], events: RunEvent[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];

  for (const step of steps) {
    for (const assertion of step.assertionResults ?? []) {
      if (assertion.passed) continue;
      rows.push({
        kind: "assertion",
        label: assertion.assertionType,
        ...(assertion.message ? { detail: assertion.message } : {}),
        ...(assertion.severity ? { severity: assertion.severity } : {}),
        stepId: step.id,
      });
    }
  }

  for (const event of events) {
    const severe = event.severity === "warning" || event.severity === "error" || event.severity === "fatal";
    const diagnostic = event.channel === "diagnostic" || event.channel === "assertion";
    if (!severe && !diagnostic) continue;
    rows.push({
      kind: diagnostic ? "diagnostic" : "anomaly",
      label: `${event.channel}:${event.type}`,
      ...(event.severity ? { severity: event.severity } : {}),
      ...(event.stepId ? { stepId: event.stepId } : {}),
      sequenceNumber: event.sequenceNumber,
      eventId: event.id,
    });
  }

  return rows.sort((left, right) => (left.sequenceNumber ?? 0) - (right.sequenceNumber ?? 0));
}

/** Observations holding more than one visual — a perspective sweep, reviewable as a set. */
export function perspectiveSets(observations: ObservationBundle[]): PerspectiveSet[] {
  return observations
    .filter((observation) => observation.visualArtifactIds.length > 1)
    .map((observation) => ({
      observationId: observation.id,
      sequenceNumber: observation.cursor.sequenceNumber,
      frameCount: observation.visualArtifactIds.length,
      artifactIds: [...observation.visualArtifactIds],
    }))
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

export function buildInspectionReport(input: {
  run: ExecutionRun;
  steps: RunStep[];
  events: RunEvent[];
  observations: ObservationBundle[];
  failure?: FailureEnvelope;
  promise?: PreflightPromise;
}): InspectionReport {
  const residue = irreversibleResidue(input.steps, input.failure);
  return {
    runId: input.run.id,
    verdict: buildVerdict(input.run, input.steps, input.failure, residue),
    dirty: residue.length > 0,
    blastRadius: blastRadius(input.steps),
    ...(input.promise ? { promise: comparePromise(input.promise, input.steps, input.events) } : {}),
    evidence: evidenceLedger(input.steps, input.events),
    perspectives: perspectiveSets(input.observations),
  };
}

/** Re-exported so callers can type an assertion list without reaching into run-model. */
export type { AssertionResult };
