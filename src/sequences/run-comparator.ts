import type {
  ExecutionRun,
  ObservationBundle,
  RunEvent,
  RunStep,
  StoredRunArtifact,
} from "../runs/run-model.js";
import type { RunStore } from "../runs/run-store.js";

export const RUN_COMPARISON_CHANNELS = [
  "visual",
  "structure",
  "behavior",
  "log",
  "network",
  "performance",
  "filesystem",
] as const;

export type RunComparisonChannel = typeof RUN_COMPARISON_CHANNELS[number];

export interface RunComparisonOptions {
  stepIds?: readonly string[];
  surface?: string;
  channels?: readonly RunComparisonChannel[];
}

export interface RunComparisonChange {
  channel: RunComparisonChannel;
  kind: "added" | "removed" | "changed";
  summary: string;
  severity?: "info" | "warning" | "error";
}

export interface RunComparisonSide {
  runId: string;
  step?: RunStep;
  observation?: ObservationBundle;
  events: RunEvent[];
  artifacts: StoredRunArtifact[];
}

export interface RunComparisonAlignment {
  id: string;
  label: string;
  confidence?: number;
  left?: RunComparisonSide;
  right?: RunComparisonSide;
  changes: RunComparisonChange[];
}

export interface RunComparison {
  leftRunId: string;
  rightRunId: string;
  summary: {
    changed: number;
    added: number;
    removed: number;
    unchanged: number;
    findings: string[];
  };
  alignments: RunComparisonAlignment[];
}

type AlignmentMode = "semantic" | "step_id" | "ordinal";

function comparisonChannelForEvent(event: RunEvent): RunComparisonChannel | undefined {
  switch (event.channel) {
    case "visual":
    case "artifact":
      return "visual";
    case "state":
      return "structure";
    case "action":
    case "application_event":
    case "assertion":
      return "behavior";
    case "log":
    case "diagnostic":
      return "log";
    case "network":
      return "network";
    case "metric":
      return "performance";
    case "filesystem":
      return "filesystem";
    default:
      return undefined;
  }
}

function comparisonChannelForArtifact(artifact: StoredRunArtifact): RunComparisonChannel | undefined {
  if (artifact.mediaType?.startsWith("image/") || artifact.kind === "screenshot") return "visual";
  if (artifact.kind && /(?:dom|accessibility|state|structure)/i.test(artifact.kind)) return "structure";
  if (artifact.kind && /(?:file|filesystem|workspace|patch|diff)/i.test(artifact.kind)) return "filesystem";
  if (artifact.kind === "adapter-result" || artifact.role === "result") return "behavior";
  return undefined;
}

function artifactHashesForChannel(
  artifacts: readonly StoredRunArtifact[],
  channel: RunComparisonChannel,
): string[] {
  return artifacts
    .filter((artifact) => comparisonChannelForArtifact(artifact) === channel)
    .map((artifact) => artifact.sha256)
    .sort();
}

function equalHashes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

function channelCounts(events: RunEvent[]): Map<RunComparisonChannel, number> {
  const counts = new Map<RunComparisonChannel, number>();
  for (const event of events) {
    const channel = comparisonChannelForEvent(event);
    if (channel) counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return counts;
}

const VOLATILE_EVENT_PAYLOAD_KEYS = new Set([
  "artifactIds",
  "eventId",
  "handleId",
  "laneId",
  "monotonicTimestampNs",
  "observationId",
  "runId",
  "run_id",
  "sequenceNumber",
  "stepId",
  "telemetrySequence",
]);

function comparableEventPayload(value: unknown, key = "", depth = 0): unknown {
  if (VOLATILE_EVENT_PAYLOAD_KEYS.has(key)) return undefined;
  if (depth > 6) return "[nested]";
  if (Array.isArray(value)) {
    return value.map((item) => comparableEventPayload(item, "", depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
      const child = comparableEventPayload(
        (value as Record<string, unknown>)[childKey],
        childKey,
        depth + 1,
      );
      if (child !== undefined) output[childKey] = child;
    }
    return output;
  }
  return value;
}

function eventSignatures(
  events: readonly RunEvent[],
  channel: RunComparisonChannel,
): string[] {
  return events
    .filter((event) => comparisonChannelForEvent(event) === channel)
    .map((event) => JSON.stringify([
      event.type,
      event.severity ?? "info",
      event.source.adapterId,
      event.source.producer,
      event.entityRefs
        .map((ref) => `${ref.scheme}:${ref.id}`)
        .sort(),
      comparableEventPayload(event.inlinePayload),
    ]))
    .sort();
}

function normalizeSurface(value: string): string {
  let normalized = value.trim();
  try {
    normalized = new URL(normalized).pathname;
  } catch {
    // Stable surface IDs do not need to be URLs.
  }
  normalized = normalized.replace(/^(?:route|story|surface|ui-component):/i, "");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function matchesSurfaceValue(candidate: unknown, requested: string): boolean {
  return typeof candidate === "string"
    && candidate.trim().length > 0
    && normalizeSurface(candidate) === requested;
}

function stepMatchesSurface(step: RunStep, run: ExecutionRun, requestedSurface: string): boolean {
  const requested = normalizeSurface(requestedSurface);
  if (!requested) return false;
  const refs = [
    ...step.targetEntityRefs,
    ...(step.resolvedAction?.resolvedTarget ? [step.resolvedAction.resolvedTarget] : []),
  ];
  for (const ref of refs) {
    if (matchesSurfaceValue(ref.id, requested)
      || matchesSurfaceValue(`${ref.scheme}:${ref.id}`, requested)
      || matchesSurfaceValue(ref.label, requested)) {
      return true;
    }
  }
  const input = step.declaredAction.input ?? {};
  for (const key of ["surface", "surfaceId", "route", "url", "story", "storyId"]) {
    if (matchesSurfaceValue(input[key], requested)) return true;
  }
  return matchesSurfaceValue(run.target.id, requested)
    || matchesSurfaceValue(run.target.label, requested);
}

function selectedChannels(channels: readonly RunComparisonChannel[] | undefined): Set<RunComparisonChannel> {
  return new Set(channels === undefined ? RUN_COMPARISON_CHANNELS : channels);
}

function isStepIdArray(
  value: readonly string[] | RunComparisonOptions | undefined,
): value is readonly string[] {
  return Array.isArray(value);
}

function stepLabel(step: RunStep): string {
  return `${step.ordinal + 1}. ${step.declaredAction.adapterId ?? "adapter"}:${step.declaredAction.type}`;
}

function semanticKey(step: RunStep): string {
  const input = step.declaredAction.input ?? {};
  const target = typeof input["url"] === "string"
    ? input["url"]
    : typeof input["path"] === "string"
      ? input["path"]
      : typeof input["selector"] === "string"
        ? input["selector"]
        : "";
  return `${step.declaredAction.adapterId ?? ""}:${step.declaredAction.type}:${target}`.toLowerCase();
}

function alignedPairs(
  left: RunStep[],
  right: RunStep[],
  mode: AlignmentMode,
): Array<{ key: string; confidence: number; left?: RunStep; right?: RunStep }> {
  if (mode === "ordinal") {
    return Array.from({ length: Math.max(left.length, right.length) }, (_, ordinal) => ({
      key: `ordinal:${ordinal}`,
      confidence: 0.75,
      left: left[ordinal],
      right: right[ordinal],
    }));
  }
  const rightBuckets = new Map<string, RunStep[]>();
  for (const step of right) {
    const key = mode === "step_id" ? step.id : semanticKey(step);
    const bucket = rightBuckets.get(key) ?? [];
    bucket.push(step);
    rightBuckets.set(key, bucket);
  }
  const pairs: Array<{ key: string; confidence: number; left?: RunStep; right?: RunStep }> = [];
  const used = new Set<RunStep>();
  for (const step of left) {
    const key = mode === "step_id" ? step.id : semanticKey(step);
    const match = rightBuckets.get(key)?.find((candidate) => !used.has(candidate));
    if (match) used.add(match);
    pairs.push({
      key,
      confidence: mode === "step_id" ? 1 : match ? 0.9 : 0.4,
      left: step,
      ...(match ? { right: match } : {}),
    });
  }
  for (const step of right) {
    if (used.has(step)) continue;
    const key = mode === "step_id" ? step.id : semanticKey(step);
    pairs.push({ key, confidence: 0.4, right: step });
  }
  return pairs;
}

async function sideFor(
  store: RunStore,
  runId: string,
  step: RunStep,
  observations: ObservationBundle[],
  artifacts: StoredRunArtifact[],
  channels: ReadonlySet<RunComparisonChannel>,
): Promise<RunComparisonSide> {
  const observation = observations.find((candidate) => candidate.id === step.afterObservationId)
    ?? [...observations].reverse().find((candidate) => candidate.stepId === step.id);
  const from = step.startCursor?.sequenceNumber;
  const to = step.endCursor?.sequenceNumber;
  const events = (await store.readEvents(runId, {
    ...(from !== undefined ? { fromSequence: from } : {}),
    ...(to !== undefined ? { toSequence: to } : {}),
    limit: 100_000,
  })).filter((event) => {
    const channel = comparisonChannelForEvent(event);
    return channel !== undefined && channels.has(channel);
  });
  const attachedArtifacts = artifacts.filter((artifact) => (
    observation
      ? artifact.observationId === observation.id
        || (!artifact.observationId && artifact.stepId === step.id)
      : artifact.stepId === step.id
  ));
  return {
    runId,
    step,
    ...(observation && (channels.has("visual") || channels.has("structure")) ? { observation } : {}),
    events,
    artifacts: attachedArtifacts.filter((artifact) => {
      const channel = comparisonChannelForArtifact(artifact);
      return channel !== undefined && channels.has(channel);
    }),
  };
}

function compareSides(
  left: RunComparisonSide,
  right: RunComparisonSide,
  channels: ReadonlySet<RunComparisonChannel>,
): RunComparisonChange[] {
  const changes: RunComparisonChange[] = [];
  if (channels.has("behavior") && left.step?.status !== right.step?.status) {
    changes.push({
      channel: "behavior",
      kind: "changed",
      summary: `Step status changed from ${left.step?.status ?? "missing"} to ${right.step?.status ?? "missing"}.`,
      severity: right.step?.status === "failed" ? "error" : "warning",
    });
  }
  const leftFailed = left.step?.assertionResults.filter((result) => !result.passed).length ?? 0;
  const rightFailed = right.step?.assertionResults.filter((result) => !result.passed).length ?? 0;
  if (channels.has("behavior") && leftFailed !== rightFailed) {
    changes.push({
      channel: "behavior",
      kind: "changed",
      summary: `Failed assertions changed from ${leftFailed} to ${rightFailed}.`,
      severity: rightFailed > leftFailed ? "error" : "info",
    });
  }
  const leftResults = artifactHashesForChannel(left.artifacts, "behavior");
  const rightResults = artifactHashesForChannel(right.artifacts, "behavior");
  if (channels.has("behavior")
    && (leftResults.length > 0 || rightResults.length > 0)
    && !equalHashes(leftResults, rightResults)) {
    changes.push({
      channel: "behavior",
      kind: "changed",
      summary: "Captured action result artifacts differ.",
      severity: "warning",
    });
  }
  if (channels.has("structure")
    && left.observation?.stateDigest !== right.observation?.stateDigest
    && (left.observation?.stateDigest || right.observation?.stateDigest)) {
    changes.push({
      channel: "structure",
      kind: "changed",
      summary: "Captured structural state changed.",
      severity: "warning",
    });
  }
  const leftVisual = new Set(
    left.artifacts.filter((artifact) => artifact.mediaType?.startsWith("image/")).map((artifact) => artifact.sha256),
  );
  const rightVisual = new Set(
    right.artifacts.filter((artifact) => artifact.mediaType?.startsWith("image/")).map((artifact) => artifact.sha256),
  );
  if (channels.has("visual") && (leftVisual.size > 0 || rightVisual.size > 0)) {
    const exactMatch = leftVisual.size === rightVisual.size && [...leftVisual].every((hash) => rightVisual.has(hash));
    if (!exactMatch) {
      changes.push({
        channel: "visual",
        kind: "changed",
        summary: "Captured visual artifacts differ (candidate difference; review before classifying as a defect).",
        severity: "warning",
      });
    }
  }
  const leftChannels = channelCounts(left.events);
  const rightChannels = channelCounts(right.events);
  for (const channel of new Set([...leftChannels.keys(), ...rightChannels.keys()])) {
    if (!channels.has(channel)) continue;
    const before = leftChannels.get(channel) ?? 0;
    const after = rightChannels.get(channel) ?? 0;
    if (before !== after) {
      changes.push({
        channel,
        kind: "changed",
        summary: `${channel} event count changed from ${before} to ${after}.`,
        severity: channel === "log" && after > before ? "warning" : "info",
      });
      continue;
    }
    const leftSignatures = eventSignatures(left.events, channel);
    const rightSignatures = eventSignatures(right.events, channel);
    if (!equalHashes(leftSignatures, rightSignatures)) {
      changes.push({
        channel,
        kind: "changed",
        summary: `${channel} event details changed.`,
        severity: channel === "log" ? "warning" : "info",
      });
    }
  }
  return changes;
}

function oneSidedChanges(
  side: RunComparisonSide,
  kind: "added" | "removed",
  channels: ReadonlySet<RunComparisonChannel>,
): RunComparisonChange[] {
  const changes: RunComparisonChange[] = [];
  const direction = kind === "added" ? "right" : "left";
  if (channels.has("behavior")) {
    changes.push({
      channel: "behavior",
      kind,
      summary: `Step exists only in the ${direction} run.`,
      severity: kind === "added" ? "info" : "warning",
    });
  }
  if (channels.has("visual")
    && side.artifacts.some((artifact) => comparisonChannelForArtifact(artifact) === "visual")) {
    changes.push({
      channel: "visual",
      kind,
      summary: `Captured visual evidence exists only in the ${direction} run.`,
      severity: "warning",
    });
  }
  if (channels.has("structure") && (
    (side.observation?.structuralArtifactIds.length ?? 0) > 0
    || !!side.observation?.stateDigest
    || side.artifacts.some((artifact) => comparisonChannelForArtifact(artifact) === "structure")
  )) {
    changes.push({
      channel: "structure",
      kind,
      summary: `Captured structural evidence exists only in the ${direction} run.`,
      severity: "warning",
    });
  }
  const counts = channelCounts(side.events);
  for (const channel of ["log", "network", "performance", "filesystem"] as const) {
    const count = counts.get(channel) ?? 0;
    if (!channels.has(channel) || count === 0) continue;
    changes.push({
      channel,
      kind,
      summary: `${count} ${channel} event(s) exist only in the ${direction} run.`,
      severity: channel === "log" ? "warning" : "info",
    });
  }
  return changes;
}

export async function compareRuns(
  store: RunStore,
  leftRun: ExecutionRun,
  rightRun: ExecutionRun,
  mode: AlignmentMode = "semantic",
  requestedOptions?: readonly string[] | RunComparisonOptions,
): Promise<RunComparison> {
  const [allLeftSteps, allRightSteps, leftObservations, rightObservations, leftArtifacts, rightArtifacts] =
    await Promise.all([
      store.getSteps(leftRun.id),
      store.getSteps(rightRun.id),
      store.listObservations(leftRun.id),
      store.listObservations(rightRun.id),
      store.listArtifacts(leftRun.id),
      store.listArtifacts(rightRun.id),
    ]);
  const options: RunComparisonOptions = isStepIdArray(requestedOptions)
    ? { stepIds: requestedOptions }
    : requestedOptions ?? {};
  const channels = selectedChannels(options.channels);
  const scope = options.stepIds?.length ? new Set(options.stepIds) : undefined;
  const leftSteps = allLeftSteps.filter((step) =>
    (!scope || scope.has(step.id))
    && (!options.surface || stepMatchesSurface(step, leftRun, options.surface)),
  );
  const rightSteps = allRightSteps.filter((step) =>
    (!scope || scope.has(step.id))
    && (!options.surface || stepMatchesSurface(step, rightRun, options.surface)),
  );
  const pairs = alignedPairs(leftSteps, rightSteps, mode);
  const alignments: RunComparisonAlignment[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    if (!pair.left) {
      const right = await sideFor(
        store,
        rightRun.id,
        pair.right!,
        rightObservations,
        rightArtifacts,
        channels,
      );
      const changes = oneSidedChanges(right, "added", channels);
      if (changes.length > 0) added += 1;
      else unchanged += 1;
      alignments.push({
        id: `alignment-${index + 1}`,
        label: stepLabel(pair.right!),
        confidence: pair.confidence,
        right,
        changes,
      });
      continue;
    }
    if (!pair.right) {
      const left = await sideFor(
        store,
        leftRun.id,
        pair.left,
        leftObservations,
        leftArtifacts,
        channels,
      );
      const changes = oneSidedChanges(left, "removed", channels);
      if (changes.length > 0) removed += 1;
      else unchanged += 1;
      alignments.push({
        id: `alignment-${index + 1}`,
        label: stepLabel(pair.left),
        confidence: pair.confidence,
        left,
        changes,
      });
      continue;
    }
    const [left, right] = await Promise.all([
      sideFor(store, leftRun.id, pair.left, leftObservations, leftArtifacts, channels),
      sideFor(store, rightRun.id, pair.right, rightObservations, rightArtifacts, channels),
    ]);
    const changes = compareSides(left, right, channels);
    if (changes.length > 0) changed += 1;
    else unchanged += 1;
    alignments.push({
      id: `alignment-${index + 1}`,
      label: `${stepLabel(pair.left)} ↔ ${stepLabel(pair.right)}`,
      confidence: pair.confidence,
      left,
      right,
      changes,
    });
  }

  const findings: string[] = [];
  if (channels.has("log")
    && rightRun.summary?.errorCount
    && rightRun.summary.errorCount > (leftRun.summary?.errorCount ?? 0)) {
    findings.push(`The right run recorded ${rightRun.summary.errorCount - (leftRun.summary?.errorCount ?? 0)} additional error event(s).`);
  }
  if (changed > 0) findings.push(`${changed} aligned step(s) contain candidate differences requiring review.`);
  return {
    leftRunId: leftRun.id,
    rightRunId: rightRun.id,
    summary: { changed, added, removed, unchanged, findings },
    alignments,
  };
}
