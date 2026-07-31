import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  classifyOperation,
  normalizeCommandName,
  resolveShellConfirmation,
  type CommandPolicy,
  type LocalRuntime,
} from "@blacksite/local-runtime";
import type { BrowserDispatchScope, BrowserRunner } from "../chromium-runner.js";
import type { PlanningStore } from "../planning-store.js";
import type { TicketStore } from "../ticket-store.js";
import {
  type AssertionResult,
  type EntityRef,
  type ExecutionRun,
  type FailureEnvelope,
  type ObservationBundle,
  type RunEvent,
  type RunEventChannel,
  type RunEventInput,
  type RunStep,
  type RunSummary,
  type RunStatus,
  type SideEffectRecord,
  type StoredRunArtifact,
  type TerminalRunStatus,
} from "../runs/run-model.js";
import type { RunStore } from "../runs/run-store.js";
import {
  discoverBrowserSurfaces,
  type BrowserDiscoveryInput,
  type DiscoveredSurface,
  type DiscoverySource,
} from "./browser-discovery.js";
import {
  compileSequence,
  type CompiledSequence,
  type CompiledSequenceStep,
  SequenceValidationError,
} from "./sequence-compiler.js";
import {
  compareRuns,
  RUN_COMPARISON_CHANNELS,
  type RunComparison,
  type RunComparisonChannel,
} from "./run-comparator.js";

const MAX_INLINE_TEXT = 20_000;
const MAX_INSPECT_EVENTS = 500;
const DEFAULT_INSPECT_BEFORE = 25;
const DEFAULT_INSPECT_AFTER = 50;
const MAX_IMAGE_DATA_BYTES = 5 * 1024 * 1024;
export interface SequenceDispatchContext {
  sessionId: string;
  signal?: AbortSignal;
  confirmed?: boolean;
}

export interface SequenceToolProvider {
  dispatch(
    operation: string,
    payload: Record<string, unknown>,
    context: SequenceDispatchContext,
  ): Promise<Record<string, unknown>>;
  rejectPendingApproval?(
    payload: Record<string, unknown>,
    context: Pick<SequenceDispatchContext, "sessionId">,
    reason?: string,
  ): void;
  /** Compact, bounded live-context summary for the next model turn. */
  buildWorkspaceContextSummary?(): string;
}

export interface SequenceServiceOptions {
  workspaceRoot: string;
  runStore: RunStore;
  runtime: LocalRuntime;
  browser?: BrowserRunner;
  planning?: Pick<PlanningStore, "isExecutionApproved" | "attachRunEvidence">
    & Partial<Pick<PlanningStore, "read">>;
  tickets?: Pick<TicketStore, "attachRunEvidence"> & Partial<Pick<TicketStore, "read">>;
  commandPolicy?: () => CommandPolicy;
}

interface PendingApproval {
  compiled: CompiledSequence;
  runId: string;
  approvalStepId: string;
  description: string;
  tier: string;
  unrecognizedCommand: boolean;
}

interface ActiveExecution {
  controller: AbortController;
  timedOut: boolean;
}

interface ExecutionCounters {
  artifactBytes: number;
  telemetrySequence: number;
  maxArtifactBytes: number;
}

interface ActionResult {
  ok: boolean;
  value: Record<string, unknown>;
  sideEffects: SideEffectRecord[];
}

interface SequencePreflightManifest {
  sequenceId: string;
  resolvedSteps: Array<{
    id: string;
    adapterId: string;
    action: string;
    entityRefs: EntityRef[];
    sideEffectClass: SideEffectRecord["class"];
  }>;
  unresolvedDynamicStepCount: number;
  filesystemEffects: Array<{ stepId: string; action: string; target?: string }>;
  commandEffects: Array<{ stepId: string; command: string; args: string[] }>;
  browserOrigins: string[];
  externalEffects: Array<{ stepId: string; action: string }>;
  requiredApprovals: Array<{ tier: string; description: string; stepId?: string }>;
  deniedOperations: Array<{ stepId: string; reason: string }>;
  maxDurationMs: number;
  maxArtifactBytes: number;
  captureProfile: string;
}

interface MapRunSummary {
  id: string;
  title: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
}

interface MapRunEvent {
  id: string;
  path: string;
  kind: string;
  at: number;
  laneId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

interface SelectedInspectEvents {
  events: RunEvent[];
  effectiveBefore: number;
  effectiveAfter: number;
  truncated: boolean;
}

function selectInspectEvents(
  beforeCandidates: RunEvent[],
  anchor: RunEvent | undefined,
  afterCandidates: RunEvent[],
  beforeWeight: number,
  afterWeight: number,
): SelectedInspectEvents {
  const sideCapacity = Math.max(0, MAX_INSPECT_EVENTS - (anchor ? 1 : 0));
  const totalWeight = beforeWeight + afterWeight;
  let beforeSlots = totalWeight > 0
    ? Math.floor(sideCapacity * beforeWeight / totalWeight)
    : 0;
  let afterSlots = totalWeight > 0 ? sideCapacity - beforeSlots : 0;
  if (beforeWeight === 0) {
    beforeSlots = 0;
    afterSlots = sideCapacity;
  } else if (afterWeight === 0) {
    beforeSlots = sideCapacity;
    afterSlots = 0;
  }

  let effectiveBefore = Math.min(beforeSlots, beforeCandidates.length);
  let effectiveAfter = Math.min(afterSlots, afterCandidates.length);
  let spare = sideCapacity - effectiveBefore - effectiveAfter;
  if (spare > 0 && effectiveBefore < beforeCandidates.length) {
    const added = Math.min(spare, beforeCandidates.length - effectiveBefore);
    effectiveBefore += added;
    spare -= added;
  }
  if (spare > 0 && effectiveAfter < afterCandidates.length) {
    effectiveAfter += Math.min(spare, afterCandidates.length - effectiveAfter);
  }

  const beforeEvents = effectiveBefore > 0
    ? beforeCandidates.slice(-effectiveBefore)
    : [];
  const afterEvents = effectiveAfter > 0
    ? afterCandidates.slice(0, effectiveAfter)
    : [];
  return {
    events: [...beforeEvents, ...(anchor ? [anchor] : []), ...afterEvents],
    effectiveBefore,
    effectiveAfter,
    truncated: effectiveBefore < beforeCandidates.length || effectiveAfter < afterCandidates.length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForPoll(signal: AbortSignal, milliseconds = 75): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    url.hash = "";
    return url.toString();
  } catch {
    return value.slice(0, 2_000);
  }
}

function safeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (/password|passwd|secret|token|authorization|cookie|api[-_]?key|credential/i.test(key)) return "[redacted]";
  if (/^args?$/i.test(key) && typeof value === "string"
    && /(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|credential)(?:=|:|\s)/i.test(value)) {
    return "[redacted argument]";
  }
  if (/^script$/i.test(key) && typeof value === "string") {
    return `[redacted ${value.length} chars]`;
  }
  if (typeof value === "string") {
    const sanitized = (/^https?:\/\//i.test(value) ? sanitizeUrl(value) : value)
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
      .replace(
        /\b(password|passwd|secret|token|api[-_]?key|credential)(\s*[:=]\s*)[^\s,;&]+/gi,
        "$1$2[redacted]",
      );
    return sanitized.length > MAX_INLINE_TEXT ? `${sanitized.slice(0, MAX_INLINE_TEXT)}…` : sanitized;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => safeValue(item, key, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      output[childKey] = safeValue(childValue, childKey, depth + 1);
    }
    return output;
  }
  return value;
}

function safeActionValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (/password|passwd|secret|token|authorization|cookie|api[-_]?key|credential/i.test(key)) {
    return "[redacted]";
  }
  if (/^(text|value|script|body|content)$/i.test(key) && typeof value === "string") {
    return `[redacted ${value.length} chars]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => safeActionValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      output[childKey] = safeActionValue(childValue, childKey, depth + 1);
    }
    return output;
  }
  return safeValue(value, key, depth);
}

function source(adapterId: string, producer = "sequence-service"): RunEventInput["source"] {
  return { adapterId, producer };
}

function workspaceFingerprint(workspaceRoot: string): string {
  const hash = createHash("sha256").update(path.resolve(workspaceRoot));
  for (const candidate of [".git/HEAD", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum"]) {
    try {
      const filePath = path.join(workspaceRoot, candidate);
      const stat = fs.statSync(filePath);
      hash.update(candidate).update(String(stat.size)).update(stat.mtime.toISOString());
      if (candidate === ".git/HEAD" && stat.size < 8_192) hash.update(fs.readFileSync(filePath));
    } catch {
      // Optional fingerprint input.
    }
  }
  return hash.digest("hex");
}

function environmentFingerprint(): string {
  return createHash("sha256")
    .update(`${process.platform}:${process.arch}:${process.version}`)
    .digest("hex");
}

function statusFromAbort(active: ActiveExecution): TerminalRunStatus {
  return active.timedOut ? "timed_out" : "cancelled";
}

function initialRun(compiled: CompiledSequence, runId: string): ExecutionRun {
  return {
    id: runId,
    title: compiled.definition.title,
    sequenceId: compiled.definition.id ?? `seq-${runId}`,
    sequenceVersion: 1,
    status: "validating",
    target: compiled.definition.target,
    adapterIds: [...new Set(compiled.steps.map((step) => step.adapterId))],
    ...(compiled.definition.parentRunId ? { parentRunId: compiled.definition.parentRunId } : {}),
    ...(compiled.definition.baselineRunId ? { baselineRunId: compiled.definition.baselineRunId } : {}),
    ...(compiled.definition.planId ? { planId: compiled.definition.planId } : {}),
    ...(compiled.definition.phaseId ? { phaseId: compiled.definition.phaseId } : {}),
    ticketIds: compiled.definition.ticketIds ?? [],
    workspaceFingerprint: "",
    environmentFingerprint: environmentFingerprint(),
    stepIds: compiled.steps.map((step) => step.definition.id!),
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: compiled.retentionClass,
  };
}

function initialSteps(compiled: CompiledSequence, runId: string): RunStep[] {
  return compiled.steps.map((step, ordinal) => ({
    id: step.definition.id!,
    runId,
    ordinal,
    declaredAction: {
      ...step.definition.action,
      ...(step.definition.action.input
        ? { input: safeActionValue(step.definition.action.input) as Record<string, unknown> }
        : {}),
    },
    ...(step.definition.dependsOn?.length
      ? { dependsOnStepIds: [...step.definition.dependsOn] }
      : {}),
    ...(step.definition.assertions?.length
      ? { declaredAssertions: step.definition.assertions.map((assertion) => ({
          ...assertion,
          ...(assertion.input ? { input: { ...assertion.input } } : {}),
        })) }
      : {}),
    targetEntityRefs: step.entityRefs,
    status: "pending",
    assertionResults: [],
    sideEffects: [],
  }));
}

function sequenceBrowserScope(compiled: CompiledSequence): BrowserDispatchScope | undefined {
  if (!compiled.steps.some((step) => step.adapterId === "browser")) return undefined;
  const origins = new Set<string>();
  const candidates = [
    text(compiled.definition.target.configuration?.["entrypoint"]),
    ...compiled.steps
      .filter((step) => (
        step.adapterId === "browser" && step.definition.action.type === "navigate"
      ))
      .map((step) => text(step.definition.action.input?.["url"])),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // The compiler rejects invalid browser URLs. Keep this helper fail-closed
      // if a future caller constructs a compiled sequence manually.
    }
  }
  return {
    allowedOrigins: [...origins],
    localOnly: true,
  };
}

function pendingKey(sessionId: string, fingerprint: string): string {
  return `${sessionId}:${fingerprint}`;
}

function responseResult(response: Awaited<ReturnType<LocalRuntime["handleMessage"]>>): Record<string, unknown> {
  if (response.error) return { ok: false, error: response.error.message };
  return record(response.result);
}

function eventEntityRefs(step: CompiledSequenceStep): EntityRef[] {
  const refs = [...step.entityRefs];
  const input = step.definition.action.input ?? {};
  const pathValue = text(input["path"]);
  const url = text(input["url"]);
  if (pathValue && !refs.some((ref) => ref.workspacePath === pathValue)) {
    refs.push({
      scheme: "workspace-file",
      id: pathValue.replace(/\\/g, "/"),
      workspacePath: pathValue.replace(/\\/g, "/"),
      label: path.basename(pathValue),
    });
  }
  if (url && !refs.some((ref) => ref.scheme === "route" && ref.id === url)) {
    refs.push({ scheme: "route", id: sanitizeUrl(url), label: sanitizeUrl(url) });
  }
  return refs;
}

function actionSideEffects(step: CompiledSequenceStep, result: Record<string, unknown>): SideEffectRecord[] {
  const type = step.definition.action.type;
  const effect = declaredSideEffectClass(step);
  let reversible = !(step.adapterId === "test" && type === "run")
    && !(step.adapterId === "process" && (type === "start" || type === "stop"));
  if (step.adapterId === "browser") {
    reversible = !BROWSER_MUTATING_ACTIONS.has(type);
  }
  if (effect === "none") return [];
  return [{
    id: `effect-${randomUUID()}`,
    class: effect,
    description: `${step.adapterId}:${type}`,
    entityRefs: eventEntityRefs(step),
    reversible,
    metadata: {
      ok: result["ok"] !== false,
      ...(result["unknownOutcome"] === true ? { outcome: "unknown" } : {}),
    },
  }];
}

function processSideEffectClass(command: string, args: string[]): SideEffectRecord["class"] {
  const tier = classifyOperation(command, args).tier;
  if (tier === "destructive") return "destructive";
  const base = normalizeCommandName(command);
  const first = String(args[0] ?? "").toLowerCase();
  const externalMutation = (
    (base === "git" && first === "push")
    || (base === "docker" && first === "push")
    || (base === "terraform" && ["apply", "destroy"].includes(first))
    || (base === "kubectl" && !["get", "describe", "logs", "explain", "api-resources", "api-versions", "version"].includes(first))
    || (base === "helm" && ["install", "upgrade", "uninstall", "rollback", "push"].includes(first))
    || (["npm", "pnpm", "yarn", "cargo", "poetry"].includes(base) && first === "publish")
    || ["gh", "ssh", "scp", "sftp"].includes(base)
    || (base === "rsync" && args.some((arg) => /^[\w.-]+@[\w.-]+:/.test(String(arg))))
    || (["curl", "wget"].includes(base) && args.some((arg) =>
      /^(?:-d|--data(?:-.+)?|--upload-file|-T|--method)$/i.test(String(arg))
      || /^--request=(?!GET$|HEAD$)/i.test(String(arg))
      || /^-X(?:POST|PUT|PATCH|DELETE)$/i.test(String(arg))))
  );
  if (externalMutation) return "external_mutation";
  return tier === "network" ? "network_read" : "process";
}

/** Browser actions that change page state rather than only observing it. Shared by the
 *  side-effect classifier and the reversibility rule so the two can never disagree. */
const BROWSER_MUTATING_ACTIONS = new Set([
  "click", "type", "type_text", "evaluate", "mouse_path", "drag", "key",
]);

function declaredSideEffectClass(step: CompiledSequenceStep): SideEffectRecord["class"] {
  const type = step.definition.action.type;
  if (step.adapterId === "workspace") return "workspace_read";
  if (step.adapterId === "process") {
    const input = step.definition.action.input ?? {};
    return type === "start"
      ? processSideEffectClass(
          text(input["command"]) ?? "",
          Array.isArray(input["args"]) ? input["args"].map(String) : [],
        )
      : "process";
  }
  if (step.adapterId === "test") return "process";
  if (step.adapterId === "browser") {
    // Conservative on purpose: this feeds the preflight manifest and the approval gate, so
    // over-classifying costs a prompt while under-classifying mutates a page silently. A pointer
    // path can drag when it holds a button, and driving it at all commits interactive state; a
    // key press is input by definition. Hover and scroll only move the viewport or a highlight.
    return BROWSER_MUTATING_ACTIONS.has(type) ? "network_write" : "network_read";
  }
  return "none";
}

function isRepeatableResumeAction(adapterId: string, action: string): boolean {
  if (adapterId === "workspace") {
    return ["read_file", "list_directory", "glob", "search_files"].includes(action);
  }
  if (adapterId === "test") return action === "detect";
  if (adapterId === "browser") {
    // Hover and scroll leave nothing behind, so replaying them on resume is safe. Pointer paths,
    // drags and key presses are deliberately absent: replaying input is not idempotent.
    return ["navigate", "wait", "screenshot", "get_text", "hover", "scroll"].includes(action);
  }
  return false;
}

function safeContinuationStep(step: CompiledSequenceStep): boolean {
  return isRepeatableResumeAction(step.adapterId, step.definition.action.type);
}

function failureRecoverability(sideEffects: SideEffectRecord[]): FailureEnvelope["recoverability"] {
  return sideEffects.some((effect) => !effect.reversible)
    ? "manual_intervention"
    : "resume_supported";
}

function highestApprovalTier(current: string, candidate: string): string {
  const rank: Readonly<Record<string, number>> = {
    read: 0,
    write: 1,
    network: 2,
    destructive: 3,
  };
  return (rank[candidate] ?? Number.MAX_SAFE_INTEGER) > (rank[current] ?? -1)
    ? candidate
    : current;
}

function eventKind(event: RunEvent): string {
  if (event.channel === "filesystem") {
    return /write|edit|delete|move/i.test(event.type) ? "edit" : "read";
  }
  if (event.channel === "diagnostic" || event.severity === "error" || event.severity === "fatal") return "diagnostic";
  if (event.channel === "visual") return "render";
  if (event.channel === "network" || event.type.includes("navigation")) return "nav";
  if (event.source.adapterId === "process" || event.source.adapterId === "test") return "shell";
  return "execute";
}

function artifactView(artifact: StoredRunArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    kind: artifact.kind,
    fileName: artifact.fileName,
    role: artifact.role,
    stepId: artifact.stepId,
    observationId: artifact.observationId,
  };
}

export class SequenceService implements SequenceToolProvider {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly active = new Map<string, ActiveExecution>();

  constructor(private readonly options: SequenceServiceOptions) {}

  get runStore(): RunStore {
    return this.options.runStore;
  }

  async dispatch(
    operation: string,
    payload: Record<string, unknown>,
    context: SequenceDispatchContext,
  ): Promise<Record<string, unknown>> {
    try {
      switch (operation) {
        case "discover": return await this.discover(payload, context.signal);
        case "execute": return await this.execute(payload, context);
        case "inspect": return this.inspect(payload);
        case "compare": return await this.compare(payload);
        case "resume": return await this.resume(payload, context);
        case "search": return this.search(payload);
        default: return { ok: false, error: `Unknown sequence operation: ${operation}` };
      }
    } catch (error) {
      if (error instanceof SequenceValidationError) {
        return { ok: false, error: error.message, issues: error.issues };
      }
      return { ok: false, error: errorMessage(error) };
    }
  }

  rejectPendingApproval(
    payload: Record<string, unknown>,
    context: Pick<SequenceDispatchContext, "sessionId">,
    reason = "User denied the operation.",
  ): void {
    let compiled: CompiledSequence;
    try {
      compiled = compileSequence(payload);
    } catch {
      return;
    }
    const key = pendingKey(context.sessionId, compiled.fingerprint);
    const pending = this.pendingApprovals.get(key);
    if (!pending) return;
    this.pendingApprovals.delete(key);
    this.failBeforeExecution(
      pending.runId,
      reason,
      "approval_denied",
      pending.approvalStepId,
    );
  }

  cancelRun(runId: string): boolean {
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      return true;
    }
    const pendingEntry = [...this.pendingApprovals.entries()]
      .find(([, pending]) => pending.runId === runId);
    if (!pendingEntry) return false;
    this.pendingApprovals.delete(pendingEntry[0]);
    for (const step of this.options.runStore.getSteps(runId)) {
      if (step.status === "pending" || step.status === "awaiting_approval") {
        this.options.runStore.updateStep(runId, step.id, { status: "cancelled" });
      }
    }
    this.options.runStore.appendEvent(runId, {
      channel: "diagnostic",
      type: "run_cancelled",
      severity: "warning",
      source: source("sequence"),
      entityRefs: [],
      inlinePayload: { reason: "Cancelled while awaiting approval." },
    });
    const run = this.options.runStore.finalizeRun(runId, {
      status: "cancelled",
      summary: this.buildSummary(runId, "cancelled", "The run was cancelled while awaiting approval."),
    });
    this.attachEvidence(run);
    return true;
  }

  setPinned(runId: string, pinned: boolean): ExecutionRun {
    const run = this.options.runStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.planId && run.phaseId) {
      const result = this.options.planning?.attachRunEvidence(run.planId, run.phaseId, {
        runId,
        status: run.status,
        baseline: pinned,
      });
      if (result?.["ok"] === false) {
        throw new Error(String(result["error"] ?? "Could not update the plan baseline."));
      }
    }
    return this.options.runStore.setRetention(runId, pinned ? "pinned" : "standard");
  }

  buildWorkspaceContextSummary(): string {
    const runs = this.options.runStore.listRuns({ limit: 5 }).runs;
    if (runs.length === 0) return "";
    return runs.map((run) => {
      const counts = run.summary
        ? `${run.summary.completedSteps}/${run.summary.totalSteps} steps, ${run.summary.errorCount} errors`
        : `${run.stepIds.length} declared steps`;
      const links = [
        run.planId ? `plan ${run.planId}${run.phaseId ? `/${run.phaseId}` : ""}` : "",
        run.ticketIds.length ? `tickets ${run.ticketIds.join(",")}` : "",
        run.baselineRunId ? `baseline ${run.baselineRunId}` : "",
      ].filter(Boolean).join(" · ");
      return `  ${run.id} [${run.status}] ${run.title ?? run.summary?.title ?? run.sequenceId} — ${counts}${links ? ` · ${links}` : ""}`;
    }).join("\n");
  }

  listRunSummaries(limit: number): MapRunSummary[] {
    return this.options.runStore.listRuns({ limit: numberInRange(limit, 100, 1, 500) }).runs.map((run) => ({
      id: run.id,
      title: run.title ?? run.summary?.title ?? run.target.label ?? run.sequenceId,
      status: run.status,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.summary ? { eventCount: run.summary.eventCount } : {}),
    }));
  }

  getMapEventWindow(
    runId: string,
    fromElapsedMs: number,
    toElapsedMs: number,
    limit: number,
  ): MapRunEvent[] {
    const events = this.options.runStore.readEventsByElapsedMs(runId, fromElapsedMs, toElapsedMs, {
      limit: numberInRange(limit, 2_000, 1, 2_000),
    });
    const origin = this.options.runStore.getEventTimeOrigin(runId);
    if (!origin) return [];
    const originNs = BigInt(origin);
    return events.flatMap((event): MapRunEvent[] => {
      const ref = event.entityRefs.find((candidate) => candidate.workspacePath)
        ?? event.entityRefs.find((candidate) => candidate.scheme === "workspace-file");
      const eventPath = ref?.workspacePath ?? (ref?.scheme === "workspace-file" ? ref.id : undefined);
      if (!eventPath) return [];
      const elapsedNs = BigInt(event.monotonicTimestampNs) - originNs;
      return [{
        id: event.id,
        path: eventPath.replace(/\\/g, "/"),
        kind: eventKind(event),
        at: Number(elapsedNs / 1_000_000n),
        ...(event.laneId ? { laneId: event.laneId } : {}),
      }];
    });
  }

  elapsedMsAtSequence(runId: string, sequenceNumber: number | undefined): number {
    if (!sequenceNumber || sequenceNumber < 1) return 0;
    const origin = this.options.runStore.getEventTimeOrigin(runId);
    if (!origin) return 0;
    const event = this.options.runStore.readEvents(runId, {
      fromSequence: sequenceNumber,
      toSequence: sequenceNumber,
      limit: 1,
    })[0];
    if (!event) return 0;
    return Number((BigInt(event.monotonicTimestampNs) - BigInt(origin)) / 1_000_000n);
  }

  private async discover(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const target = record(payload["target"]);
    const adapter = text(target["adapter"]);
    const knownAdapters = ["browser", "workspace", "process", "test"];
    if (!adapter || !knownAdapters.includes(adapter)) {
      const message = `Unsupported discovery adapter '${adapter ?? "(missing)"}'.`;
      return {
        ok: false,
        error: message,
        failure: {
          code: "unsupported_discovery_adapter",
          message,
          adapter: adapter ?? null,
          supportedAdapters: knownAdapters,
        },
      };
    }
    if (adapter !== "browser") {
      const include = Array.isArray(payload["include"]) ? payload["include"].map(String) : [];
      const surfaces: DiscoveredSurface[] = [];
      if (adapter === "workspace") {
        const result = await this.options.runtime.handleMessage({
          type: "system.list_directory",
          payload: { path: ".", limit: numberInRange(payload["limit"], 50, 1, 200) },
        }, signal);
        const value = responseResult(result);
        for (const entry of Array.isArray(value["entries"]) ? value["entries"] : []) {
          const item = record(entry);
          const id = String(item["name"] ?? "");
          surfaces.push({
            id: `file:${id}`,
            kind: "file",
            label: id,
            source: "filesystem",
            confidence: 1,
            reachable: true,
            path: id,
            entityRef: { scheme: "workspace-file", id, workspacePath: id, label: id },
          });
        }
      }
      return {
        ok: true,
        adapter,
        surfaces,
        matched: surfaces.length,
        include,
        coverage: { sources: ["filesystem"], limitedAdapterDiscovery: adapter !== "workspace" },
      };
    }
    const result = await discoverBrowserSurfaces(
      this.options.workspaceRoot,
      {
        entrypoint: text(target["entrypoint"]),
        sources: Array.isArray(payload["sources"]) ? payload["sources"].map(String) as DiscoverySource[] : undefined,
        include: Array.isArray(payload["include"]) ? payload["include"].map(String) as BrowserDiscoveryInput["include"] : undefined,
        limit: numberInRange(payload["limit"], 50, 1, 200),
        cursor: text(payload["cursor"]),
      },
      this.options.browser,
      signal,
    );
    return { ok: true, adapter: "browser", ...result };
  }

  private createValidatedRun(compiled: CompiledSequence): string {
    const runId = `run-${randomUUID()}`;
    const run = initialRun(compiled, runId);
    run.workspaceFingerprint = workspaceFingerprint(this.options.workspaceRoot);
    this.options.runStore.createRun(run);
    this.options.runStore.putSteps(runId, initialSteps(compiled, runId));
    this.options.runStore.appendEvent(runId, {
      channel: "action",
      type: "run_validated",
      severity: "info",
      source: source("sequence"),
      entityRefs: [],
      inlinePayload: {
        sequenceFingerprint: compiled.fingerprint,
        title: compiled.definition.title,
        stepCount: compiled.steps.length,
        adapters: run.adapterIds,
      },
    });
    return runId;
  }

  private preflight(compiled: CompiledSequence): {
    denied?: string;
    deniedStepId?: string;
    confirmation?: { tier: string; description: string; unrecognizedCommand: boolean };
    manifest: SequencePreflightManifest;
  } {
    const descriptions: string[] = [];
    let tier = "read";
    let unrecognizedCommand = false;
    const policy = this.options.commandPolicy?.() ?? {};
    const filesystemEffects: SequencePreflightManifest["filesystemEffects"] = [];
    const commandEffects: SequencePreflightManifest["commandEffects"] = [];
    const browserOrigins = new Set<string>();
    const externalEffects: SequencePreflightManifest["externalEffects"] = [];
    const requiredApprovals: SequencePreflightManifest["requiredApprovals"] = [];
    const deniedOperations: SequencePreflightManifest["deniedOperations"] = [];
    const resolvedSteps = compiled.steps.map((step) => {
      const input = step.definition.action.input ?? {};
      const action = step.definition.action.type;
      if (step.adapterId === "workspace") {
        filesystemEffects.push({
          stepId: step.definition.id!,
          action,
          ...(text(input["path"]) ? { target: text(input["path"]) } : {}),
        });
      }
      if (step.adapterId === "process") {
        const args = Array.isArray(input["args"]) ? input["args"].map(String) : [];
        commandEffects.push({
          stepId: step.definition.id!,
          command: text(input["command"]) ?? "",
          args: args.map((arg) => String(safeValue(arg, "args"))),
        });
      }
      if (step.adapterId === "test" && action === "run") {
        commandEffects.push({
          stepId: step.definition.id!,
          command: "test harness",
          args: text(input["filter"]) ? [text(input["filter"])!] : [],
        });
      }
      if (step.adapterId === "browser") {
        for (const candidate of [text(input["url"]), text(compiled.definition.target.configuration?.["entrypoint"])]) {
          if (!candidate) continue;
          try { browserOrigins.add(new URL(candidate).origin); } catch { /* validated relative target */ }
        }
      }
      const sideEffectClass = declaredSideEffectClass(step);
      if (sideEffectClass === "external_mutation" || sideEffectClass === "destructive") {
        externalEffects.push({ stepId: step.definition.id!, action });
      }
      return {
        id: step.definition.id!,
        adapterId: step.adapterId,
        action,
        entityRefs: step.entityRefs,
        sideEffectClass,
      };
    });
    const manifest = (): SequencePreflightManifest => ({
      sequenceId: compiled.definition.id ?? compiled.fingerprint,
      resolvedSteps,
      unresolvedDynamicStepCount: compiled.steps.filter((step) =>
        step.adapterId === "browser"
        && ["click", "type_text", "get_text"].includes(step.definition.action.type)
        && !text(step.definition.action.input?.["selector"]),
      ).length,
      filesystemEffects,
      commandEffects,
      browserOrigins: [...browserOrigins],
      externalEffects,
      requiredApprovals,
      deniedOperations,
      maxDurationMs: compiled.definition.limits.timeoutMs,
      maxArtifactBytes: compiled.definition.limits.maxArtifactBytes ?? 100 * 1024 * 1024,
      captureProfile: compiled.definition.captureProfile ?? "standard",
    });
    for (const step of compiled.steps) {
      if (step.adapterId !== "process" || step.definition.action.type !== "start") continue;
      const input = step.definition.action.input ?? {};
      const command = text(input["command"]) ?? "";
      const args = Array.isArray(input["args"]) ? input["args"].map(String) : [];
      const effectClass = declaredSideEffectClass(step);
      if (effectClass === "external_mutation" || effectClass === "destructive") {
        const reason = effectClass === "destructive"
          ? `Destructive command '${command}' is outside retained sequence scope. Run it separately through its dedicated supervised approval path.`
          : `External mutation '${command}' is outside retained sequence scope. Run it separately through its dedicated supervised approval path.`;
        deniedOperations.push({ stepId: step.definition.id!, reason });
        return {
          denied: reason,
          deniedStepId: step.definition.id!,
          manifest: manifest(),
        };
      }
      const outcome = resolveShellConfirmation(command, args, false, undefined, policy);
      if (outcome.kind === "denied") {
        deniedOperations.push({ stepId: step.definition.id!, reason: outcome.error });
        return {
          denied: outcome.error,
          deniedStepId: step.definition.id!,
          manifest: manifest(),
        };
      }
      if (outcome.kind === "confirm") {
        descriptions.push(outcome.description);
        tier = highestApprovalTier(tier, outcome.tier);
        unrecognizedCommand ||= outcome.unrecognizedCommand === true;
        requiredApprovals.push({
          tier: outcome.tier,
          description: outcome.description,
          stepId: step.definition.id,
        });
      }
    }
    return descriptions.length > 0
      ? { confirmation: { tier, description: descriptions.join("\n"), unrecognizedCommand }, manifest: manifest() }
      : { manifest: manifest() };
  }

  private async execute(
    payload: Record<string, unknown>,
    context: SequenceDispatchContext,
  ): Promise<Record<string, unknown>> {
    const freshCompiled = compileSequence(payload);
    const key = pendingKey(context.sessionId, freshCompiled.fingerprint);
    const pending = this.pendingApprovals.get(key);
    let compiled = pending?.compiled ?? freshCompiled;
    let runId = pending?.runId;

    if (!runId) {
      runId = this.createValidatedRun(compiled);
      const linkError = this.validateEvidenceLinks(compiled);
      if (linkError) return this.failBeforeExecution(runId, linkError, "precondition");
      if (compiled.definition.planId && !this.options.planning?.isExecutionApproved(compiled.definition.planId)) {
        return this.failBeforeExecution(
          runId,
          `Plan '${compiled.definition.planId}' has not approved execution.`,
          "precondition",
        );
      }
      const preflight = this.preflight(compiled);
      this.options.runStore.appendEvent(runId, {
        channel: "action",
        type: "preflight_completed",
        severity: preflight.denied ? "error" : preflight.confirmation ? "warning" : "info",
        source: source("sequence"),
        entityRefs: [],
        inlinePayload: safeValue(preflight.manifest),
      });
      if (preflight.denied) {
        return this.failBeforeExecution(
          runId,
          preflight.denied,
          "permission",
          preflight.deniedStepId,
        );
      }
      if (preflight.confirmation && !context.confirmed) {
        const value: PendingApproval = {
          compiled,
          runId,
          approvalStepId: preflight.manifest.requiredApprovals[0]?.stepId
            ?? compiled.steps.find((step) => step.adapterId === "process")?.definition.id
            ?? compiled.steps[0]!.definition.id!,
          ...preflight.confirmation,
        };
        this.pendingApprovals.set(key, value);
        this.options.runStore.updateRun(runId, { status: "awaiting_approval" });
        this.options.runStore.updateStep(runId, value.approvalStepId, { status: "awaiting_approval" });
        return {
          ok: true,
          requiresConfirmation: true,
          tier: value.tier,
          description: value.description,
          unrecognizedCommand: value.unrecognizedCommand,
          runId,
          preflight: safeValue(preflight.manifest),
        };
      }
    }

    if (pending && !context.confirmed) {
      return {
        ok: true,
        requiresConfirmation: true,
        tier: pending.tier,
        description: pending.description,
        unrecognizedCommand: pending.unrecognizedCommand,
        runId: pending.runId,
      };
    }
    if (pending) {
      this.pendingApprovals.delete(key);
      // Recompile and re-evaluate current plan/policy state at the approval
      // boundary. A queued confirmation is not authority to execute stale input
      // after policy or workspace state changed.
      compiled = freshCompiled;
      runId = pending.runId;
      const linkError = this.validateEvidenceLinks(compiled);
      if (linkError) return this.failBeforeExecution(runId, linkError, "precondition");
      if (compiled.definition.planId && !this.options.planning?.isExecutionApproved(compiled.definition.planId)) {
        return this.failBeforeExecution(
          runId,
          `Plan '${compiled.definition.planId}' no longer approves execution.`,
          "precondition",
        );
      }
      const revalidated = this.preflight(compiled);
      this.options.runStore.appendEvent(runId, {
        channel: "action",
        type: "preflight_revalidated",
        severity: revalidated.denied ? "error" : revalidated.confirmation ? "warning" : "info",
        source: source("sequence"),
        entityRefs: [],
        inlinePayload: safeValue(revalidated.manifest),
      });
      if (revalidated.denied) {
        return this.failBeforeExecution(
          runId,
          revalidated.denied,
          "permission",
          revalidated.deniedStepId,
        );
      }
    }
    return await this.runCompiled(compiled, runId, context.signal, context.confirmed === true);
  }

  private validateEvidenceLinks(compiled: CompiledSequence): string | undefined {
    const definition = compiled.definition;
    if (definition.planId && definition.phaseId && this.options.planning?.read) {
      const plan = this.options.planning.read().plans.find((candidate) => candidate.id === definition.planId);
      if (!plan) return `Plan not found: ${definition.planId}`;
      if (!plan.phases.some((phase) => phase.id === definition.phaseId)) {
        return `Phase '${definition.phaseId}' was not found in plan '${definition.planId}'.`;
      }
    }
    if ((definition.ticketIds?.length ?? 0) > 0 && this.options.tickets?.read) {
      const known = new Set(this.options.tickets.read().tickets.map((ticket) => ticket.id));
      const missing = definition.ticketIds!.filter((ticketId) => !known.has(ticketId));
      if (missing.length > 0) return `Ticket not found: ${missing.join(", ")}`;
    }
    for (const [label, linkedRunId] of [
      ["Parent", definition.parentRunId],
      ["Baseline", definition.baselineRunId],
    ] as const) {
      if (!linkedRunId) continue;
      const linked = this.options.runStore.getRun(linkedRunId);
      if (!linked) return `${label} run not found: ${linkedRunId}`;
    }
    return undefined;
  }

  private failBeforeExecution(
    runId: string,
    message: string,
    category: FailureEnvelope["category"],
    failedStepId?: string,
  ): Record<string, unknown> {
    const steps = this.options.runStore.getSteps(runId);
    const failedStep = steps.find((step) => step.id === failedStepId) ?? steps[0];
    const diagnostic = this.options.runStore.appendEvent(runId, {
      channel: "diagnostic",
      type: category,
      severity: "error",
      source: source("sequence"),
      entityRefs: failedStep?.targetEntityRefs ?? [],
      inlinePayload: { message },
    });
    const observation = this.putLogicalObservation(runId, failedStep?.id, diagnostic, "diagnostic");
    if (failedStep) {
      const failure: FailureEnvelope = {
        category,
        message,
        failedStepId: failedStep.id,
        diagnosticObservationId: observation.id,
        relatedEventIds: [diagnostic.id],
        completedSideEffects: [],
        unexecutedStepIds: steps.filter((step) => step.id !== failedStep.id).map((step) => step.id),
        recoverability: category === "approval_denied" ? "manual_intervention" : "restart_required",
      };
      this.options.runStore.updateStep(runId, failedStep.id, {
        status: "failed",
        failure,
        afterObservationId: observation.id,
        endCursor: observation.cursor,
      });
    }
    for (const step of steps) {
      if (step.id === failedStep?.id) continue;
      if (step.status === "pending" || step.status === "awaiting_approval" || step.status === "running") {
        this.options.runStore.updateStep(runId, step.id, { status: "skipped" });
      }
    }
    const run = this.options.runStore.finalizeRun(runId, {
      status: "failed",
      summary: this.buildSummary(runId, "failed", message),
    });
    const evidenceWarnings = this.attachEvidence(run);
    return {
      ok: false,
      error: message,
      runId,
      status: run.status,
      observationId: observation.id,
      ...(evidenceWarnings.length > 0 ? { evidenceWarnings } : {}),
    };
  }

  private async runCompiled(
    compiled: CompiledSequence,
    runId: string,
    parentSignal: AbortSignal | undefined,
    confirmed: boolean,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const active: ActiveExecution = { controller, timedOut: false };
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => {
      active.timedOut = true;
      controller.abort();
    }, compiled.definition.limits.timeoutMs);
    this.active.set(runId, active);
    const counters: ExecutionCounters = {
      artifactBytes: 0,
      telemetrySequence: 0,
      maxArtifactBytes: compiled.definition.limits.maxArtifactBytes ?? 100 * 1024 * 1024,
    };
    const browserScope = sequenceBrowserScope(compiled);
    const startedAt = new Date().toISOString();
    this.options.runStore.updateRun(runId, { status: "running", startedAt });
    this.options.runStore.appendEvent(runId, {
      channel: "action",
      type: "run_started",
      severity: "info",
      source: source("sequence"),
      entityRefs: [],
      inlinePayload: { title: compiled.definition.title },
    });

    let lastSuccessfulStepId: string | undefined;
    let lastCheckpointId: string | undefined;
    let failed = 0;
    let completed = 0;
    const allEffects: SideEffectRecord[] = [];
    const failedStepIds = new Set<string>();
    let actionAttemptedStepId: string | undefined;
    try {
      for (let ordinal = 0; ordinal < compiled.steps.length; ordinal += 1) {
        if (controller.signal.aborted) break;
        const step = compiled.steps[ordinal]!;
        const stored = this.options.runStore.getSteps(runId).find((candidate) => candidate.id === step.definition.id)!;
        const blockedByFailure = (step.definition.dependsOn ?? []).some((dependency) => failedStepIds.has(dependency));
        const unsafeAfterFailure = compiled.definition.failurePolicy === "continue_safe"
          && failedStepIds.size > 0
          && !safeContinuationStep(step);
        if (blockedByFailure || unsafeAfterFailure) {
          this.options.runStore.updateStep(runId, stored.id, { status: "skipped" });
          // A step skipped because its prerequisite is unavailable is itself
          // unavailable to downstream dependants.
          if (blockedByFailure) failedStepIds.add(stored.id);
          this.options.runStore.appendEvent(runId, {
            stepId: stored.id,
            channel: "action",
            type: "step_skipped",
            severity: "warning",
            source: source(step.adapterId),
            entityRefs: eventEntityRefs(step),
            inlinePayload: {
              reason: blockedByFailure
                ? "A declared dependency failed."
                : "continue_safe only permits read-only steps after a failure.",
            },
          });
          continue;
        }
        const start = this.options.runStore.appendEvent(runId, {
          stepId: stored.id,
          ...(compiled.laneId ? { laneId: compiled.laneId } : {}),
          channel: "action",
          type: "step_started",
          severity: "info",
          source: source(step.adapterId),
          entityRefs: eventEntityRefs(step),
          inlinePayload: {
            ordinal,
            action: step.definition.action.type,
            params: safeActionValue(step.definition.action.input ?? {}),
          },
        });
        this.options.runStore.updateStep(runId, stored.id, {
          status: "running",
          startCursor: { sequenceNumber: start.sequenceNumber, monotonicTimestampNs: start.monotonicTimestampNs, eventId: start.id },
        });

        let before: ObservationBundle | undefined;
        if (step.capture && step.adapterId === "browser") {
          before = await this.captureBrowserObservation(
            runId,
            step,
            "before",
            counters,
            controller.signal,
            browserScope,
          );
          this.options.runStore.updateStep(runId, stored.id, { beforeObservationId: before.id });
        }

        actionAttemptedStepId = stored.id;
        const action = await this.dispatchAction(
          runId,
          step,
          counters,
          controller.signal,
          confirmed,
          browserScope,
        );
        // Commit the side-effect ledger immediately after the adapter returns.
        // Assertions and after-state capture are evidence work and may fail; they
        // must never erase a mutation that already occurred.
        allEffects.push(...action.sideEffects);
        this.options.runStore.updateStep(runId, stored.id, {
          sideEffects: action.sideEffects,
        });
        if (controller.signal.aborted) {
          const cancelled = this.options.runStore.appendEvent(runId, {
            stepId: stored.id,
            ...(compiled.laneId ? { laneId: compiled.laneId } : {}),
            channel: "diagnostic",
            type: active.timedOut ? "step_timed_out" : "step_cancelled",
            severity: "warning",
            source: source(step.adapterId),
            entityRefs: eventEntityRefs(step),
          });
          this.options.runStore.updateStep(runId, stored.id, {
            status: "cancelled",
            sideEffects: action.sideEffects,
            endCursor: {
              sequenceNumber: cancelled.sequenceNumber,
              monotonicTimestampNs: cancelled.monotonicTimestampNs,
              eventId: cancelled.id,
            },
          });
          break;
        }
        const assertionResults = await this.evaluateAssertions(
          step,
          action.value,
          controller.signal,
          browserScope,
        );
        const assertionFailed = assertionResults.some((result) => !result.passed && result.severity !== "warning");
        for (const assertion of assertionResults) {
          this.options.runStore.appendEvent(runId, {
            stepId: stored.id,
            channel: "assertion",
            type: assertion.passed ? "assertion_passed" : "assertion_failed",
            severity: assertion.passed ? "info" : assertion.severity === "warning" ? "warning" : "error",
            source: source(step.adapterId),
            entityRefs: assertion.entityRefs ?? eventEntityRefs(step),
            inlinePayload: safeValue(assertion),
          });
        }

        const actionFailed = !action.ok || assertionFailed;
        let after: ObservationBundle | undefined;
        if ((step.capture || actionFailed) && step.adapterId === "browser") {
          after = await this.captureBrowserObservation(
            runId,
            step,
            actionFailed ? "failure" : "after",
            counters,
            controller.signal,
            browserScope,
          );
        }

        const end = this.options.runStore.appendEvent(runId, {
          stepId: stored.id,
          ...(compiled.laneId ? { laneId: compiled.laneId } : {}),
          channel: actionFailed ? "diagnostic" : "action",
          type: actionFailed ? "step_failed" : "step_succeeded",
          severity: actionFailed ? "error" : "info",
          source: source(step.adapterId),
          entityRefs: eventEntityRefs(step),
          inlinePayload: safeValue(action.value),
        });
        if (!after && actionFailed) after = this.putLogicalObservation(runId, stored.id, end, "diagnostic");
        if (!after && step.capture) after = this.putLogicalObservation(runId, stored.id, end, "standard");

        if (actionFailed) {
          failed += 1;
          failedStepIds.add(stored.id);
          const diagnostic = after ?? this.putLogicalObservation(runId, stored.id, end, "diagnostic");
          const message = String(action.value["error"] ?? assertionResults.find((result) => !result.passed)?.message ?? "Step failed.");
          const failure: FailureEnvelope = {
            category: assertionFailed ? "assertion_failure" : "adapter_error",
            message,
            failedStepId: stored.id,
            ...(lastSuccessfulStepId ? { lastSuccessfulStepId } : {}),
            ...(lastCheckpointId ? { lastCheckpointId } : {}),
            diagnosticObservationId: diagnostic.id,
            relatedEventIds: [end.id],
            completedSideEffects: allEffects,
            unexecutedStepIds: compiled.steps.slice(ordinal + 1).map((candidate) => candidate.definition.id!),
            recoverability: failureRecoverability(allEffects),
          };
          this.options.runStore.updateStep(runId, stored.id, {
            status: "failed",
            assertionResults,
            sideEffects: action.sideEffects,
            ...(after ? { afterObservationId: after.id } : {}),
            endCursor: { sequenceNumber: end.sequenceNumber, monotonicTimestampNs: end.monotonicTimestampNs, eventId: end.id },
            failure,
          });
          // The following iteration decides whether the *next* step is a safe
          // read-only continuation and whether its dependencies remain valid.
          const canContinue = compiled.definition.failurePolicy !== "stop";
          if (!canContinue) break;
          continue;
        }

        completed += 1;
        lastSuccessfulStepId = stored.id;
        let checkpointId: string | undefined;
        if (step.definition.checkpoint) {
          checkpointId = typeof step.definition.checkpoint === "string"
            ? step.definition.checkpoint
            : `checkpoint-${stored.id}`;
          lastCheckpointId = checkpointId;
          const run = this.options.runStore.getRun(runId)!;
          this.options.runStore.updateRun(runId, {
            checkpointIds: [...new Set([...run.checkpointIds, checkpointId])],
          });
          this.options.runStore.appendEvent(runId, {
            stepId: stored.id,
            channel: "state",
            type: "checkpoint_created",
            severity: "info",
            source: source(step.adapterId),
            entityRefs: eventEntityRefs(step),
            inlinePayload: {
              checkpointId,
              checkpointCapability: "marker_only",
              replayability: allEffects.every((effect) => effect.reversible) ? "R2" : "R1",
              restorable: false,
            },
          });
        }
        this.options.runStore.updateStep(runId, stored.id, {
          status: "succeeded",
          assertionResults,
          sideEffects: action.sideEffects,
          ...(after ? { afterObservationId: after.id } : {}),
          ...(checkpointId ? { checkpointId } : {}),
          endCursor: { sequenceNumber: end.sequenceNumber, monotonicTimestampNs: end.monotonicTimestampNs, eventId: end.id },
        });
      }
    } catch (error) {
      failed += 1;
      const message = errorMessage(error);
      const diagnosticEvent = this.options.runStore.appendEvent(runId, {
        channel: "diagnostic",
        type: "coordinator_error",
        severity: "fatal",
        source: source("sequence"),
        entityRefs: [],
        inlinePayload: { message },
      });
      const current = this.options.runStore.getSteps(runId).find((step) => step.status === "running");
      if (current) {
        if (current.id === actionAttemptedStepId && current.sideEffects.length === 0) {
          const attempted = compiled.steps.find((step) => step.definition.id === current.id);
          if (attempted) {
            const unknownEffects = actionSideEffects(attempted, {
              ok: false,
              unknownOutcome: true,
            });
            allEffects.push(...unknownEffects);
            this.options.runStore.updateStep(runId, current.id, {
              sideEffects: unknownEffects,
            });
          }
        }
        const observation = this.putLogicalObservation(
          runId,
          current.id,
          { ...diagnosticEvent, stepId: current.id, entityRefs: current.targetEntityRefs },
          "diagnostic",
        );
        const failure: FailureEnvelope = {
          category: "adapter_error",
          message,
          failedStepId: current.id,
          ...(lastSuccessfulStepId ? { lastSuccessfulStepId } : {}),
          ...(lastCheckpointId ? { lastCheckpointId } : {}),
          diagnosticObservationId: observation.id,
          relatedEventIds: [diagnosticEvent.id],
          completedSideEffects: allEffects,
          unexecutedStepIds: this.options.runStore.getSteps(runId)
            .filter((step) => step.ordinal > current.ordinal)
            .map((step) => step.id),
          recoverability: failureRecoverability(allEffects),
        };
        this.options.runStore.updateStep(runId, current.id, {
          status: "failed",
          failure,
          sideEffects: this.options.runStore.getSteps(runId)
            .find((step) => step.id === current.id)?.sideEffects ?? [],
          afterObservationId: observation.id,
          endCursor: observation.cursor,
        });
      }
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
      this.active.delete(runId);
    }

    const terminal: TerminalRunStatus = controller.signal.aborted
      ? statusFromAbort(active)
      : failed === 0
        ? "succeeded"
        : completed > 0
          ? "partial"
          : "failed";
    if (controller.signal.aborted) {
      for (const step of this.options.runStore.getSteps(runId)) {
        if (step.status === "running" || step.status === "pending") {
          this.options.runStore.updateStep(runId, step.id, { status: "cancelled" });
        }
      }
      this.options.runStore.appendEvent(runId, {
        channel: "diagnostic",
        type: active.timedOut ? "run_timed_out" : "run_cancelled",
        severity: "warning",
        source: source("sequence"),
        entityRefs: [],
      });
    } else {
      for (const step of this.options.runStore.getSteps(runId)) {
        if (step.status === "pending" || step.status === "awaiting_approval") {
          this.options.runStore.updateStep(runId, step.id, { status: "skipped" });
        }
      }
    }
    const finalized = this.options.runStore.finalizeRun(runId, {
      status: terminal,
      summary: this.buildSummary(
        runId,
        terminal,
        terminal === "succeeded"
          ? "All sequence steps completed."
          : terminal === "timed_out"
            ? "The run reached its duration limit."
            : terminal === "cancelled"
              ? "The run was cancelled."
              : "The run retained partial or failure evidence.",
      ),
    });
    const evidenceWarnings = this.attachEvidence(finalized);
    const observations = this.options.runStore.listObservations(runId);
    const finalSteps = this.options.runStore.getSteps(runId);
    const failedStep = finalSteps.find((step) => step.status === "failed");
    const coverage = {
      completed: finalSteps.filter((step) => step.status === "succeeded").length,
      failed: finalSteps.filter((step) => step.status === "failed").length,
      skipped: finalSteps.filter((step) => step.status === "skipped" || step.status === "cancelled").length,
      total: finalSteps.length,
    };
    const anomalies = this.options.runStore.findLastEvents(
      runId,
      (event) => event.severity !== "info",
      20,
      { channels: ["diagnostic"] },
    )
      .map((event) => ({ type: event.type, event_id: event.id }));
    return {
      ok: terminal === "succeeded",
      runId,
      run_id: runId,
      status: terminal,
      summary: finalized.summary,
      stepIds: finalized.stepIds,
      keyObservationIds: observations.slice(-5).map((observation) => observation.id),
      coverage,
      ...(failedStep ? { failed_step_id: failedStep.id } : {}),
      ...(lastCheckpointId ? { last_checkpoint_id: lastCheckpointId } : {}),
      key_observation_ids: observations.slice(-5).map((observation) => observation.id),
      anomalies,
      resume_capability: terminal !== "succeeded"
        && allEffects.every((effect) => effect.reversible)
        ? "logical"
        : "none",
      ...(evidenceWarnings.length > 0 ? { evidenceWarnings } : {}),
      inspectHint: `Use sequence_inspect with run_id '${runId}' and a step_id, observation_id, or sequence_number.`,
    };
  }

  private async dispatchAction(
    runId: string,
    step: CompiledSequenceStep,
    counters: ExecutionCounters,
    signal: AbortSignal,
    confirmed: boolean,
    browserScope: BrowserDispatchScope | undefined,
  ): Promise<ActionResult> {
    const input = step.definition.action.input ?? {};
    let value: Record<string, unknown>;
    if (signal.aborted) return { ok: false, value: { ok: false, error: "Cancelled." }, sideEffects: [] };
    if (step.adapterId === "browser") {
      if (!this.options.browser) value = { ok: false, error: "Browser runtime is unavailable." };
      else {
        value = record(await this.options.browser.dispatch(
          step.definition.action.type,
          input,
          signal,
          browserScope,
        ));
        if (step.definition.action.type === "screenshot" && typeof value["dataUrl"] === "string") {
          const stored = this.storeDataUrlArtifact(runId, step.definition.id!, value["dataUrl"], "action-screenshot", counters);
          value = {
            ...value,
            dataUrl: undefined,
            ...(stored ? { artifactId: stored.id } : {}),
          };
        }
      }
    } else if (step.adapterId === "test" && step.definition.action.type === "run") {
      try {
        value = await this.runTestsCancellable(input, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        value = { ok: false, cancelled: true, error: "Test run cancelled." };
      }
    } else {
      const runtimeType = this.runtimeType(step);
      if (!runtimeType) value = { ok: false, error: `Unsupported ${step.adapterId} action '${step.definition.action.type}'.` };
      else {
        const payload = step.adapterId === "process" && step.definition.action.type === "start"
          ? { ...input, confirmed }
          : input;
        value = responseResult(await this.options.runtime.handleMessage({ type: runtimeType, payload }, signal));
      }
    }
    const ok = value["ok"] !== false;
    const sideEffects = actionSideEffects(step, value);
    const resultArtifact = this.storeLargeResult(runId, step, value, counters);
    this.options.runStore.appendEvent(runId, {
      stepId: step.definition.id,
      channel: step.adapterId === "workspace"
        ? "filesystem"
        : step.adapterId === "process" || step.adapterId === "test"
          ? "log"
          : "action",
      type: `${step.adapterId}_${step.definition.action.type}_result`,
      severity: ok ? "info" : "error",
      source: source(step.adapterId, "adapter"),
      entityRefs: eventEntityRefs(step),
      inlinePayload: resultArtifact
        ? {
            ok,
            error: typeof value["error"] === "string" ? safeValue(value["error"], "error") : undefined,
            artifactId: resultArtifact.id,
            resultKeys: Object.keys(value).slice(0, 50),
          }
        : safeValue(value),
      ...(resultArtifact ? { payloadArtifactId: resultArtifact.id } : {}),
    });
    return { ok, value, sideEffects };
  }

  private async runTestsCancellable(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const detected = responseResult(await this.options.runtime.handleMessage({
      type: "test.detect",
      payload: { root: input["root"] ?? this.options.workspaceRoot },
    }, signal));
    const framework = String(detected["framework"] ?? "unknown");
    const filter = text(input["filter"]);
    let command = "";
    let args: string[] = [];
    switch (framework) {
      case "vitest":
        command = "npx";
        args = ["vitest", "run", "--reporter=default", ...(filter ? [filter] : [])];
        break;
      case "jest":
        command = "npx";
        args = ["jest", "--passWithNoTests", ...(filter ? ["--testPathPattern", filter] : [])];
        break;
      case "pytest":
        command = "python";
        args = ["-m", "pytest", "--tb=short", "-q", ...(filter ? ["-k", filter] : [])];
        break;
      case "go":
        command = "go";
        args = ["test", "./...", ...(filter ? ["-run", filter] : [])];
        break;
      default:
        return { ok: false, framework, error: "No supported test framework was detected." };
    }
    const startedAt = Date.now();
    const started = responseResult(await this.options.runtime.handleMessage({
      type: "system.process.start",
      payload: {
        command,
        args,
        cwd: input["cwd"],
        allowStdin: false,
        // test_run is already a dedicated, allowlisted harness operation. This
        // skips only confirmation; explicit command-policy denies still win.
        confirmed: true,
      },
    }, signal));
    if (started["ok"] === false) return { ...started, framework };
    const handleId = text(record(started["process"])["handleId"]);
    if (!handleId) return { ok: false, framework, error: "Test process did not return a handle." };
    const chunks: string[] = [];
    let cursor = 0;
    let finalProcess = record(started["process"]);
    const readOutput = async (): Promise<void> => {
      const page = responseResult(await this.options.runtime.handleMessage({
        type: "system.process.read_output",
        payload: { handleId, cursor, limit: 2_000 },
      }, signal));
      const output = record(page["output"]);
      for (const entry of Array.isArray(output["entries"]) ? output["entries"] : []) {
        const value = record(entry);
        chunks.push(String(value["text"] ?? ""));
      }
      const nextCursor = Number(output["nextCursor"]);
      if (Number.isSafeInteger(nextCursor) && nextCursor >= cursor) cursor = nextCursor;
      finalProcess = record(page["process"]);
    };
    for (;;) {
      if (signal.aborted) {
        await this.options.runtime.handleMessage({
          type: "system.process.stop",
          payload: { handleId },
        }).catch(() => undefined);
        return {
          ok: false,
          framework,
          cancelled: true,
          error: "Test run cancelled.",
          rawOutput: chunks.join("").slice(-200_000),
          durationMs: Date.now() - startedAt,
        };
      }
      await readOutput();
      const status = String(finalProcess["status"] ?? "");
      if (status && status !== "running") break;
      const current = responseResult(await this.options.runtime.handleMessage({
        type: "system.process.status",
        payload: { handleId },
      }, signal));
      finalProcess = record(current["process"]);
      if (String(finalProcess["status"] ?? "") !== "running") {
        await readOutput();
        break;
      }
      await waitForPoll(signal);
    }
    const rawOutput = chunks.join("").slice(-200_000);
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const match of rawOutput.matchAll(/(\d+)\s+(passed|failed|skipped|pending)\b/gi)) {
      const count = Number(match[1] ?? 0);
      const kind = match[2]?.toLowerCase();
      if (kind === "passed") passed = Math.max(passed, count);
      else if (kind === "failed") failed = Math.max(failed, count);
      else skipped = Math.max(skipped, count);
    }
    const exitCode = typeof finalProcess["exitCode"] === "number" ? finalProcess["exitCode"] : null;
    const ok = String(finalProcess["status"] ?? "") === "completed" && exitCode === 0;
    return {
      ok,
      framework,
      passed,
      failed: ok ? failed : Math.max(1, failed),
      skipped,
      failures: ok
        ? []
        : rawOutput.split(/\r?\n/).filter((line) => /\b(fail|error|assert)/i.test(line)).slice(0, 50),
      rawOutput,
      durationMs: Date.now() - startedAt,
      exitCode,
      process: finalProcess,
    };
  }

  private runtimeType(step: CompiledSequenceStep): string | undefined {
    const action = step.definition.action.type;
    if (step.adapterId === "workspace") {
      return {
        read_file: "system.read_file",
        list_directory: "system.list_directory",
        glob: "system.glob",
        search_files: "system.search_files",
      }[action];
    }
    if (step.adapterId === "process") {
      return {
        start: "system.process.start",
        status: "system.process.status",
        read_output: "system.process.read_output",
        stop: "system.process.stop",
      }[action];
    }
    if (step.adapterId === "test") return action === "detect" ? "test.detect" : action === "run" ? "test.run" : undefined;
    return undefined;
  }

  private async evaluateAssertions(
    step: CompiledSequenceStep,
    result: Record<string, unknown>,
    signal: AbortSignal,
    browserScope: BrowserDispatchScope | undefined,
  ): Promise<AssertionResult[]> {
    const assertions = step.definition.assertions ?? [];
    const output: AssertionResult[] = [];
    for (const assertion of assertions) {
      const input = assertion.input ?? {};
      const expected = String(input["expected"] ?? "");
      let passed = false;
      let actual: unknown;
      switch (assertion.type) {
        case "result_ok":
          actual = result["ok"];
          passed = result["ok"] !== false;
          break;
        case "url_contains":
          actual = result["url"];
          passed = String(actual ?? "").includes(expected);
          break;
        case "text_contains": {
          actual = result["text"];
          if (typeof actual !== "string" && step.adapterId === "browser" && this.options.browser) {
            const queried = record(await this.options.browser.dispatch(
              "get_text",
              text(input["selector"]) ? { selector: input["selector"] } : {},
              signal,
              browserScope,
            ));
            actual = queried["text"];
          }
          passed = String(actual ?? "").includes(expected);
          break;
        }
        case "selector_exists": {
          const selector = text(input["selector"]) ?? expected;
          if (step.adapterId === "browser" && this.options.browser && selector) {
            const queried = record(await this.options.browser.dispatch(
              "evaluate",
              { script: `Boolean(document.querySelector(${JSON.stringify(selector)}))` },
              signal,
              browserScope,
            ));
            actual = queried["result"];
            passed = actual === true;
          }
          break;
        }
        case "equals":
          actual = result["result"] ?? result["value"];
          passed = String(actual ?? "") === expected;
          break;
        default:
          actual = undefined;
          passed = false;
      }
      output.push({
        assertionType: assertion.type,
        passed,
        message: passed
          ? `Assertion '${assertion.type}' passed.`
          : text(input["message"]) ?? `Assertion '${assertion.type}' failed; expected '${expected}'.`,
        severity: assertion.severity ?? "error",
        entityRefs: eventEntityRefs(step),
        metadata: { expected, actual: safeValue(actual) },
      });
    }
    return output;
  }

  private storeLargeResult(
    runId: string,
    step: CompiledSequenceStep,
    value: Record<string, unknown>,
    counters: ExecutionCounters,
  ): StoredRunArtifact | undefined {
    const serialized = JSON.stringify(safeValue(value));
    if (Buffer.byteLength(serialized) <= MAX_INLINE_TEXT) return undefined;
    return this.storeArtifact(
      runId,
      Buffer.from(serialized),
      {
        mediaType: "application/json",
        kind: "adapter-result",
        fileName: `${step.definition.id}-result.json`,
        role: "result",
        stepId: step.definition.id,
      },
      counters,
    );
  }

  private storeDataUrlArtifact(
    runId: string,
    stepId: string,
    dataUrl: string,
    role: string,
    counters: ExecutionCounters,
    observationId?: string,
  ): StoredRunArtifact | undefined {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) return undefined;
    const bytes = Buffer.from(match[2]!, "base64");
    return this.storeArtifact(
      runId,
      bytes,
      {
        mediaType: match[1]!,
        kind: "screenshot",
        fileName: `${stepId}-${role}.png`,
        role,
        stepId,
        ...(observationId ? { observationId } : {}),
      },
      counters,
    );
  }

  private storeArtifact(
    runId: string,
    content: Buffer | string,
    options: Parameters<RunStore["putArtifact"]>[2],
    counters: ExecutionCounters,
  ): StoredRunArtifact | undefined {
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (counters.artifactBytes + bytes > counters.maxArtifactBytes) {
      this.options.runStore.appendEvent(runId, {
        channel: "artifact",
        type: "artifact_budget_exceeded",
        severity: "warning",
        source: source("sequence"),
        entityRefs: [],
        inlinePayload: { attemptedBytes: bytes },
      });
      return undefined;
    }
    counters.artifactBytes += bytes;
    return this.options.runStore.putArtifact(runId, content, options);
  }

  private async captureBrowserObservation(
    runId: string,
    step: CompiledSequenceStep,
    phase: "before" | "after" | "failure",
    counters: ExecutionCounters,
    signal: AbortSignal,
    browserScope: BrowserDispatchScope | undefined,
  ): Promise<ObservationBundle> {
    const observationId = `observation-${randomUUID()}`;
    const requested = this.options.runStore.appendEvent(runId, {
      stepId: step.definition.id,
      channel: "visual",
      type: `capture_${phase}_requested`,
      severity: "debug",
      source: source("browser", "capture"),
      entityRefs: eventEntityRefs(step),
    });
    const visualArtifactIds: string[] = [];
    const structuralArtifactIds: string[] = [];
    const stateArtifactIds: string[] = [];
    if (this.options.browser && !signal.aborted) {
      const screenshot = record(await this.options.browser.dispatch(
        "screenshot",
        { fullPage: false },
        signal,
        browserScope,
      ));
      if (typeof screenshot["dataUrl"] === "string") {
        const artifact = this.storeDataUrlArtifact(
          runId,
          step.definition.id!,
          screenshot["dataUrl"],
          phase,
          counters,
          observationId,
        );
        if (artifact) visualArtifactIds.push(artifact.id);
      }
      const state = record(await this.options.browser.dispatch("capture_state", {
        sinceTelemetrySequence: counters.telemetrySequence,
      }, signal, browserScope));
      counters.telemetrySequence = Number(state["telemetrySequence"] ?? counters.telemetrySequence);
      const dom = typeof state["dom"] === "string" ? state["dom"] : "";
      if (dom) {
        const artifact = this.storeArtifact(runId, dom, {
          mediaType: "text/html",
          kind: "dom-snapshot",
          fileName: `${step.definition.id}-${phase}.html`,
          role: "structure",
          stepId: step.definition.id,
          observationId,
        }, counters);
        if (artifact) structuralArtifactIds.push(artifact.id);
      }
      const accessibility = JSON.stringify({
        nodes: state["accessibility"] ?? [],
        truncated: state["accessibilityTruncated"] === true,
      });
      const accessibilityArtifact = this.storeArtifact(runId, accessibility, {
        mediaType: "application/json",
        kind: "accessibility-snapshot",
        fileName: `${step.definition.id}-${phase}-accessibility.json`,
        role: "structure",
        stepId: step.definition.id,
        observationId,
      }, counters);
      if (accessibilityArtifact) structuralArtifactIds.push(accessibilityArtifact.id);
      const stateDocument = JSON.stringify({
        url: state["url"],
        title: state["title"],
        viewport: state["viewport"],
        domTruncated: state["domTruncated"],
      });
      const stateArtifact = this.storeArtifact(runId, stateDocument, {
        mediaType: "application/json",
        kind: "browser-state",
        fileName: `${step.definition.id}-${phase}-state.json`,
        role: "state",
        stepId: step.definition.id,
        observationId,
      }, counters);
      if (stateArtifact) stateArtifactIds.push(stateArtifact.id);
      this.recordBrowserTelemetry(runId, step, state["telemetry"]);
    }
    const captured = this.options.runStore.appendEvent(runId, {
      stepId: step.definition.id,
      channel: "visual",
      type: `capture_${phase}_completed`,
      severity: "info",
      source: source("browser", "capture"),
      entityRefs: eventEntityRefs(step),
      inlinePayload: {
        observationId,
        visualArtifacts: visualArtifactIds.length,
        structuralArtifacts: structuralArtifactIds.length,
        stateArtifacts: stateArtifactIds.length,
      },
    });
    const digest = createHash("sha256")
      .update([...structuralArtifactIds, ...stateArtifactIds].join(":"))
      .digest("hex");
    const observation: ObservationBundle = {
      id: observationId,
      runId,
      stepId: step.definition.id,
      cursor: {
        sequenceNumber: captured.sequenceNumber,
        monotonicTimestampNs: captured.monotonicTimestampNs,
        eventId: captured.id,
      },
      visualArtifactIds,
      structuralArtifactIds,
      stateArtifactIds,
      eventRange: {
        firstSequenceNumber: requested.sequenceNumber,
        lastSequenceNumber: captured.sequenceNumber,
      },
      entityRefs: eventEntityRefs(step),
      stateDigest: digest,
      captureProfile: step.definition.captureProfile ?? "diagnostic",
    };
    this.options.runStore.putObservation(observation);
    const run = this.options.runStore.getRun(runId)!;
    this.options.runStore.updateRun(runId, {
      keyObservationIds: [...new Set([...run.keyObservationIds, observation.id])].slice(-20),
    });
    return observation;
  }

  private recordBrowserTelemetry(
    runId: string,
    step: CompiledSequenceStep,
    value: unknown,
  ): void {
    if (!Array.isArray(value)) return;
    const inputs: RunEventInput[] = [];
    for (const candidate of value.slice(0, 5_000)) {
      const event = record(candidate);
      const kind = String(event["kind"] ?? "telemetry");
      const data = record(event["data"]);
      let channel: RunEventChannel = "application_event";
      if (kind === "request" || kind === "response" || kind === "request_failed") channel = "network";
      if (kind === "console") channel = "log";
      if (kind === "page_error") channel = "diagnostic";
      const refs = eventEntityRefs(step);
      const url = text(data["url"]);
      if (url) refs.push({ scheme: "browser-request", id: sanitizeUrl(url), label: sanitizeUrl(url) });
      inputs.push({
        stepId: step.definition.id,
        channel,
        type: `browser_${kind}`,
        severity: event["severity"] === "error"
          ? "error"
          : event["severity"] === "warning"
            ? "warning"
            : event["severity"] === "debug"
              ? "debug"
              : "info",
        source: {
          ...source("browser", "playwright"),
          ...(text(event["at"]) ? { sourceTimestamp: text(event["at"]) } : {}),
        },
        entityRefs: refs,
        inlinePayload: safeValue(data),
      });
    }
    if (inputs.length > 0) this.options.runStore.appendEvents(runId, inputs);
  }

  private putLogicalObservation(
    runId: string,
    stepId: string | undefined,
    event: RunEvent,
    captureProfile: string,
  ): ObservationBundle {
    const observation: ObservationBundle = {
      id: `observation-${randomUUID()}`,
      runId,
      ...(stepId ? { stepId } : {}),
      cursor: {
        sequenceNumber: event.sequenceNumber,
        monotonicTimestampNs: event.monotonicTimestampNs,
        eventId: event.id,
      },
      visualArtifactIds: [],
      structuralArtifactIds: [],
      stateArtifactIds: [],
      eventRange: {
        firstSequenceNumber: event.sequenceNumber,
        lastSequenceNumber: event.sequenceNumber,
      },
      entityRefs: event.entityRefs,
      captureProfile,
    };
    return this.options.runStore.putObservation(observation);
  }

  private buildSummary(runId: string, status: TerminalRunStatus, finding: string): RunSummary {
    const run = this.options.runStore.getRun(runId)!;
    const steps = this.options.runStore.getSteps(runId);
    const eventStats = this.options.runStore.getEventStats(runId);
    const observations = this.options.runStore.listObservations(runId);
    const artifacts = this.options.runStore.listArtifacts(runId);
    const anomalyTypes = new Set<string>();
    let fromSequence = 1;
    while (true) {
      const diagnostics = this.options.runStore.readEvents(runId, {
        fromSequence,
        channels: ["diagnostic"],
        limit: 100_000,
      });
      for (const event of diagnostics) anomalyTypes.add(event.type);
      const last = diagnostics.at(-1);
      if (!last || diagnostics.length < 100_000) break;
      fromSequence = last.sequenceNumber + 1;
    }
    const failure = steps.find((step) => step.failure)?.failure;
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    return {
      title: run.title ?? run.target.label ?? run.sequenceId,
      outcome: status,
      completedSteps: steps.filter((step) => step.status === "succeeded").length,
      totalSteps: steps.length,
      eventCount: eventStats.eventCount,
      observationCount: observations.length,
      artifactCount: artifacts.length,
      warningCount: eventStats.warningCount,
      errorCount: eventStats.errorCount,
      replayability: steps.some((step) => step.sideEffects.some((effect) => !effect.reversible)) ? "R1" : "R2",
      ...(Number.isFinite(started) ? { durationMs: Math.max(0, Date.now() - started) } : {}),
      anomalyTypes: [...anomalyTypes],
      keyFindings: [finding],
      ...(failure ? { failure } : {}),
      metadata: { workspaceFingerprint: run.workspaceFingerprint },
    };
  }

  private attachEvidence(run: ExecutionRun): string[] {
    const warnings: string[] = [];
    if (run.planId && run.phaseId) {
      try {
        const result = this.options.planning?.attachRunEvidence(run.planId, run.phaseId, {
          runId: run.id,
          status: run.status,
          ...(run.baselineRunId ? { baselineRunId: run.baselineRunId } : {}),
          unresolvedAnomalyIds: run.summary?.anomalyTypes ?? [],
        });
        if (result && result["ok"] === false) {
          warnings.push(String(result["error"] ?? `Could not attach run evidence to ${run.planId}/${run.phaseId}.`));
        }
      } catch (error) {
        warnings.push(`Could not attach run evidence to ${run.planId}/${run.phaseId}: ${errorMessage(error)}`);
      }
    }
    for (const ticketId of run.ticketIds) {
      try {
        const result = this.options.tickets?.attachRunEvidence(ticketId, {
          runId: run.id,
          status: run.status,
          summary: run.summary?.keyFindings?.[0],
        });
        if (result && result["ok"] === false) {
          warnings.push(String(result["error"] ?? `Could not attach run evidence to ticket ${ticketId}.`));
        }
      } catch (error) {
        warnings.push(`Could not attach run evidence to ticket ${ticketId}: ${errorMessage(error)}`);
      }
    }
    return warnings;
  }

  private inspect(payload: Record<string, unknown>): Record<string, unknown> {
    const runId = text(payload["run_id"]) ?? "";
    const run = this.options.runStore.getRun(runId);
    if (!run) return { ok: false, error: `Run not found: ${runId}` };
    const steps = this.options.runStore.getSteps(runId);
    const observations = this.options.runStore.listObservations(runId);
    const seek = record(payload["seek"]);
    let cursor: number | undefined;
    let selectedStep: RunStep | undefined;
    let selectedObservation: ObservationBundle | undefined;
    if (text(seek["step_id"])) selectedStep = steps.find((step) => step.id === text(seek["step_id"]));
    if (!selectedStep && Number.isFinite(Number(seek["step_ordinal"]))) {
      selectedStep = steps.find((step) => step.ordinal === Number(seek["step_ordinal"]));
    }
    if (text(seek["observation_id"])) {
      selectedObservation = observations.find((observation) => observation.id === text(seek["observation_id"]));
    }
    if (text(seek["event_id"])) {
      const event = this.options.runStore.findEvent(runId, text(seek["event_id"])!);
      cursor = event?.sequenceNumber;
    }
    if (Number.isFinite(Number(seek["sequence_number"]))) cursor = Number(seek["sequence_number"]);
    const requestedTimestamp = text(seek["monotonic_timestamp_ns"]);
    if (requestedTimestamp && /^\d+$/.test(requestedTimestamp)) {
      const atOrAfter = this.options.runStore.readEvents(runId, {
        fromMonotonicTimestampNs: requestedTimestamp,
        limit: 1,
      })[0];
      const atOrBefore = atOrAfter
        ? undefined
        : this.options.runStore.readEventsEndingAt(runId, {
          toMonotonicTimestampNs: requestedTimestamp,
          limit: 1,
        }).at(-1);
      cursor = (atOrAfter ?? atOrBefore)?.sequenceNumber;
    }
    if (text(seek["checkpoint_id"])) {
      selectedStep = steps.find((step) => step.checkpointId === text(seek["checkpoint_id"]));
    }
    if (text(seek["entity_id"])) {
      const entityId = text(seek["entity_id"]);
      selectedStep = steps.find((step) => step.targetEntityRefs.some((ref) => ref.id === entityId));
      selectedObservation = observations.find((observation) => observation.entityRefs.some((ref) => ref.id === entityId));
    }
    if (text(seek["anomaly_type"])) {
      const anomalyType = text(seek["anomaly_type"])!;
      const event = this.options.runStore.findFirstEvent(
        runId,
        (candidate) => candidate.type.includes(anomalyType),
        { channels: ["diagnostic"] },
      );
      cursor = event?.sequenceNumber;
    }
    if (text(seek["query"])) {
      const query = text(seek["query"])!.toLowerCase();
      selectedStep = steps.find((step) =>
        `${step.id} ${step.declaredAction.adapterId ?? ""} ${step.declaredAction.type} ${JSON.stringify(step.declaredAction.input ?? {})}`
          .toLowerCase()
          .includes(query),
      );
      if (!selectedStep) {
        const event = this.options.runStore.findFirstEvent(
          runId,
          (candidate) => `${candidate.type} ${JSON.stringify(candidate.inlinePayload ?? {})}`
            .toLowerCase()
            .includes(query),
        );
        cursor = event?.sequenceNumber;
      }
    }
    if (selectedObservation) cursor = selectedObservation.cursor.sequenceNumber;
    if (selectedStep) {
      const phase = text(seek["phase"]);
      if (phase === "before") {
        selectedObservation = observations.find(
          (observation) => observation.id === selectedStep!.beforeObservationId,
        );
        cursor = selectedObservation?.cursor.sequenceNumber
          ?? selectedStep.startCursor?.sequenceNumber;
      } else if (phase === "failure") {
        selectedObservation = selectedStep.failure
          ? observations.find(
            (observation) => observation.id === selectedStep!.failure!.diagnosticObservationId,
          )
          : observations.find(
            (observation) => observation.id === selectedStep!.afterObservationId,
          );
        cursor = selectedObservation?.cursor.sequenceNumber
          ?? selectedStep.endCursor?.sequenceNumber
          ?? selectedStep.startCursor?.sequenceNumber;
      } else {
        selectedObservation = observations.find(
          (observation) => observation.id === selectedStep!.afterObservationId,
        );
        cursor = selectedObservation?.cursor.sequenceNumber
          ?? selectedStep.endCursor?.sequenceNumber
          ?? selectedStep.startCursor?.sequenceNumber;
      }
    }
    cursor ??= Math.max(1, run.summary?.eventCount ?? this.options.runStore.getEventStats(runId).eventCount);
    const window = record(payload["window"]);
    const before = numberInRange(window["before_events"], DEFAULT_INSPECT_BEFORE, 0, MAX_INSPECT_EVENTS);
    const after = numberInRange(window["after_events"], DEFAULT_INSPECT_AFTER, 0, MAX_INSPECT_EVENTS);
    const channels = Array.isArray(payload["channels"]) ? payload["channels"].map(String) as RunEventChannel[] : undefined;
    const anchor = this.options.runStore.readEvents(runId, {
      fromSequence: cursor,
      toSequence: cursor,
      limit: 1,
    })[0];
    const hasTimeWindow = Number.isFinite(Number(window["before_ms"]))
      || Number.isFinite(Number(window["after_ms"]));
    const requestedBeforeMs = numberInRange(window["before_ms"], 0, 0, 600_000);
    const requestedAfterMs = numberInRange(window["after_ms"], 0, 0, 600_000);
    const visibleAnchor = anchor && (!channels?.length || channels.includes(anchor.channel))
      ? anchor
      : undefined;
    let selectedEvents: SelectedInspectEvents;
    if (hasTimeWindow && anchor) {
      const anchorNs = BigInt(anchor.monotonicTimestampNs);
      const beforeNs = BigInt(Math.trunc(requestedBeforeMs * 1_000_000));
      const afterNs = BigInt(Math.trunc(requestedAfterMs * 1_000_000));
      const beforeCandidates = beforeNs > 0n && anchorNs > 0n
        ? this.options.runStore.readEventsEndingAt(runId, {
          fromMonotonicTimestampNs: (anchorNs > beforeNs ? anchorNs - beforeNs : 0n).toString(),
          toMonotonicTimestampNs: (anchorNs - 1n).toString(),
          ...(channels?.length ? { channels } : {}),
          limit: MAX_INSPECT_EVENTS + 1,
        })
        : [];
      const afterCandidates = afterNs > 0n
        ? this.options.runStore.readEvents(runId, {
          fromMonotonicTimestampNs: (anchorNs + 1n).toString(),
          toMonotonicTimestampNs: (anchorNs + afterNs).toString(),
          ...(channels?.length ? { channels } : {}),
          limit: MAX_INSPECT_EVENTS + 1,
        })
        : [];
      selectedEvents = selectInspectEvents(
        beforeCandidates,
        visibleAnchor,
        afterCandidates,
        requestedBeforeMs,
        requestedAfterMs,
      );
    } else {
      const beforeCandidates = before > 0 && cursor > 1
        ? this.options.runStore.readEvents(runId, {
          fromSequence: Math.max(1, cursor - before),
          toSequence: cursor - 1,
          ...(channels?.length ? { channels } : {}),
          limit: before,
        })
        : [];
      const afterCandidates = after > 0
        ? this.options.runStore.readEvents(runId, {
          fromSequence: cursor + 1,
          toSequence: cursor + after,
          ...(channels?.length ? { channels } : {}),
          limit: after,
        })
        : [];
      selectedEvents = selectInspectEvents(
        beforeCandidates,
        visibleAnchor,
        afterCandidates,
        before,
        after,
      );
    }
    const events = selectedEvents.events;
    selectedObservation ??= observations.find((observation) =>
      cursor! >= observation.eventRange.firstSequenceNumber
      && cursor! <= observation.eventRange.lastSequenceNumber,
    );
    selectedStep ??= steps.find((step) =>
      cursor! >= (step.startCursor?.sequenceNumber ?? Number.MAX_SAFE_INTEGER)
      && cursor! <= (step.endCursor?.sequenceNumber ?? Number.MAX_SAFE_INTEGER),
    );
    const artifacts = this.options.runStore.listArtifacts(runId).filter((artifact) => (
      selectedObservation
        ? artifact.observationId === selectedObservation.id
          || (!artifact.observationId && artifact.stepId === selectedStep?.id)
        : artifact.stepId === selectedStep?.id
    ));
    const response: Record<string, unknown> = {
      ok: true,
      run,
      cursor: {
        sequenceNumber: cursor,
        ...(anchor ? {
          eventId: anchor.id,
          monotonicTimestampNs: anchor.monotonicTimestampNs,
        } : {}),
      },
      ...(selectedStep ? { step: selectedStep } : {}),
      ...(selectedObservation ? { observation: selectedObservation } : {}),
      events,
      artifacts: artifacts.map(artifactView),
      window: {
        from: events[0]?.sequenceNumber ?? cursor,
        to: events.at(-1)?.sequenceNumber ?? cursor,
        requestedBefore: before,
        requestedAfter: after,
        effectiveBefore: selectedEvents.effectiveBefore,
        effectiveAfter: selectedEvents.effectiveAfter,
        truncated: selectedEvents.truncated,
        ...(hasTimeWindow ? {
          requestedBeforeMs,
          requestedAfterMs,
          effectiveBeforeMs: anchor && events[0]
            ? Math.max(
              0,
              Number(BigInt(anchor.monotonicTimestampNs) - BigInt(events[0].monotonicTimestampNs))
                / 1_000_000,
            )
            : 0,
          effectiveAfterMs: anchor && events.at(-1)
            ? Math.max(
              0,
              Number(BigInt(events.at(-1)!.monotonicTimestampNs) - BigInt(anchor.monotonicTimestampNs))
                / 1_000_000,
            )
            : 0,
        } : {}),
      },
    };
    if (payload["include_artifact_data"] === true) {
      const visualId = selectedObservation?.visualArtifactIds[0]
        ?? artifacts.find((artifact) => artifact.mediaType?.startsWith("image/"))?.id;
      // Use this run attachment's semantic metadata, not the global CAS blob
      // metadata, because identical bytes may be attached under different roles
      // or media types in another observation/run.
      const artifact = visualId ? artifacts.find((candidate) => candidate.id === visualId) : undefined;
      if (artifact?.mediaType?.startsWith("image/") && artifact.byteLength <= MAX_IMAGE_DATA_BYTES) {
        const bytes = this.options.runStore.readArtifact(artifact.id);
        response["mediaType"] = artifact.mediaType;
        response["mediaDataUrl"] = `data:${artifact.mediaType};base64,${bytes.toString("base64")}`;
        response["artifactId"] = artifact.id;
      }
    }
    return response;
  }

  private async compare(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const leftRunId = text(payload["left_run_id"]) ?? "";
    const rightRunId = text(payload["right_run_id"]) ?? "";
    const left = this.options.runStore.getRun(leftRunId);
    const right = this.options.runStore.getRun(rightRunId);
    if (!left || !right) return { ok: false, error: `Run not found: ${!left ? leftRunId : rightRunId}` };
    const alignment = payload["alignment"] === "step_id" || payload["alignment"] === "ordinal"
      ? payload["alignment"]
      : "semantic";
    const scope = record(payload["scope"]);
    const stepIds = Array.isArray(scope["step_ids"]) ? scope["step_ids"].map(String) : undefined;
    const channels = Array.isArray(payload["channels"])
      ? payload["channels"]
        .map(String)
        .filter((channel): channel is RunComparisonChannel =>
          RUN_COMPARISON_CHANNELS.includes(channel as RunComparisonChannel))
      : undefined;
    const comparison: RunComparison = await compareRuns(this.options.runStore, left, right, alignment, {
      ...(stepIds ? { stepIds } : {}),
      ...(text(scope["surface"]) ? { surface: text(scope["surface"]) } : {}),
      ...(channels ? { channels } : {}),
    });
    return { ok: true, comparison };
  }

  private search(payload: Record<string, unknown>): Record<string, unknown> {
    const scope = record(payload["scope"]);
    const cursor = text(payload["cursor"]);
    let offset = 0;
    if (cursor) {
      try {
        const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
        if (Number.isSafeInteger(parsed) && parsed >= 0) offset = parsed;
      } catch {
        offset = 0;
      }
    }
    const status = text(scope["status"]);
    const limit = numberInRange(payload["limit"], 10, 1, 50);
    const anomaly = text(scope["anomaly"]);
    const result = this.options.runStore.searchRuns({
      query: text(payload["query"]),
      planId: text(scope["plan_id"]),
      phaseId: text(scope["phase_id"]),
      ticketId: text(scope["ticket_id"]),
      surfaceId: text(scope["surface"]),
      filePath: text(scope["file"]),
      ...(status ? { status: status as RunStatus } : {}),
      parentRunId: text(scope["parent_run_id"]),
      anomalyType: anomaly,
      startedAfter: text(scope["from"]),
      startedBefore: text(scope["to"]),
      limit,
      offset,
    });
    return {
      ok: true,
      runs: result.runs.map((run) => ({
        id: run.id,
        status: run.status,
        title: run.title ?? run.summary?.title ?? run.sequenceId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        target: run.target,
        planId: run.planId,
        phaseId: run.phaseId,
        ticketIds: run.ticketIds,
        summary: run.summary,
      })),
      matched: result.matched,
      ...(result.nextOffset !== undefined
        ? { nextCursor: Buffer.from(String(result.nextOffset)).toString("base64url") }
        : {}),
    };
  }

  private async resume(
    payload: Record<string, unknown>,
    context: SequenceDispatchContext,
  ): Promise<Record<string, unknown>> {
    const runId = text(payload["run_id"]) ?? "";
    const run = this.options.runStore.getRun(runId);
    if (!run) return { ok: false, error: `Run not found: ${runId}` };
    if (run.status !== "partial" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "timed_out") {
      return { ok: false, error: `Run '${runId}' is ${run.status}; only incomplete terminal runs can resume.` };
    }
    const checkpointId = text(payload["from_checkpoint_id"]);
    if (checkpointId && !run.checkpointIds.includes(checkpointId)) {
      return { ok: false, error: `Checkpoint '${checkpointId}' does not belong to run '${runId}'.` };
    }
    if (checkpointId) {
      return {
        ok: false,
        error: "Stored sequence checkpoints are inspection markers; this adapter has no checkpoint restore implementation.",
        recoverability: "restart_required",
        checkpoint_capability: "marker_only",
        recommendation: "Omit from_checkpoint_id for a conservative logical replay, or provide replacement_steps that begin with all required repeatable setup actions.",
      };
    }
    const currentEnvironmentFingerprint = environmentFingerprint();
    if (run.environmentFingerprint !== currentEnvironmentFingerprint) {
      return {
        ok: false,
        error: "The runtime environment changed since the retained run; automatic resume is not safe.",
        recoverability: "restart_required",
        environment_revalidation: {
          previous: run.environmentFingerprint,
          current: currentEnvironmentFingerprint,
          changed: true,
        },
        recommendation: "Execute a new reviewed sequence in the current environment.",
      };
    }
    const currentWorkspaceFingerprint = workspaceFingerprint(this.options.workspaceRoot);
    const workspaceChanged = run.workspaceFingerprint !== currentWorkspaceFingerprint;
    const steps = this.options.runStore.getSteps(runId);
    const completedEffects = steps.flatMap((step) => step.sideEffects);
    if (completedEffects.some((effect) => !effect.reversible)) {
      return {
        ok: false,
        error: "Logical resume is unsafe because the completed prefix contains non-reversible effects.",
        recoverability: "manual_intervention",
        recommendation: "Create a narrowed replacement sequence after verifying the external/application state.",
      };
    }
    const requestedReplacement = Array.isArray(payload["replacement_steps"])
      ? payload["replacement_steps"]
      : undefined;
    const replacement = requestedReplacement && requestedReplacement.length > 0
      ? requestedReplacement
      : undefined;
    const automaticallySelected = new Set(
      steps.filter((step) => step.status !== "succeeded").map((step) => step.id),
    );
    if (!replacement) {
      const byId = new Map(steps.map((step) => [step.id, step]));
      const addDependencies = (step: RunStep): void => {
        for (const dependencyId of step.dependsOnStepIds ?? []) {
          if (automaticallySelected.has(dependencyId)) continue;
          const dependency = byId.get(dependencyId);
          if (!dependency) continue;
          automaticallySelected.add(dependencyId);
          addDependencies(dependency);
        }
      };
      for (const step of steps) {
        if (automaticallySelected.has(step.id)) addDependencies(step);
      }
      const firstBrowserTail = steps.find((step) =>
        automaticallySelected.has(step.id)
        && (step.declaredAction.adapterId ?? run.target.adapterId) === "browser");
      if (firstBrowserTail && firstBrowserTail.declaredAction.type !== "navigate") {
        const setupNavigation = [...steps]
          .reverse()
          .find((step) =>
            step.ordinal < firstBrowserTail.ordinal
            && step.status === "succeeded"
            && (step.declaredAction.adapterId ?? run.target.adapterId) === "browser"
            && step.declaredAction.type === "navigate");
        if (setupNavigation) {
          automaticallySelected.add(setupNavigation.id);
          addDependencies(setupNavigation);
        }
      }
    }
    const autoSteps = steps
      .filter((step) => automaticallySelected.has(step.id))
      .sort((left, right) => left.ordinal - right.ordinal);
    const autoStepIds = new Set(autoSteps.map((step) => step.id));
    const unfinished = replacement ?? autoSteps.map((step) => ({
      id: step.id,
      adapter: step.declaredAction.adapterId ?? run.target.adapterId,
      action: step.declaredAction.type,
      params: step.declaredAction.input,
      ...(step.dependsOnStepIds?.length
        ? { depends_on: step.dependsOnStepIds.filter((dependencyId) => autoStepIds.has(dependencyId)) }
        : {}),
      entity_refs: step.targetEntityRefs,
      ...(step.declaredAssertions?.length
        ? {
            assertions: step.declaredAssertions.map((assertion) => ({
              type: assertion.type,
              ...(assertion.input ?? {}),
            })),
          }
        : {}),
    }));
    if (unfinished.length === 0) return { ok: false, error: "There are no unfinished steps to resume." };
    const unsafe = unfinished.find((candidate) => {
      const item = record(candidate);
      const adapter = text(item["adapter"]) ?? run.target.adapterId;
      const action = text(item["action"]) ?? "";
      return !isRepeatableResumeAction(adapter, action);
    });
    if (unsafe) {
      const item = record(unsafe);
      return {
        ok: false,
        error: `The requested tail contains non-repeatable or unknown action '${text(item["adapter"]) ?? run.target.adapterId}:${text(item["action"]) ?? "(missing)"}'.`,
        recoverability: "manual_intervention",
        recommendation: "Use replacement_steps containing only repeatable reads/navigation, then execute a new supervised mutation separately.",
      };
    }
    let browserReady = false;
    for (const candidate of unfinished) {
      const item = record(candidate);
      const adapter = text(item["adapter"]) ?? run.target.adapterId;
      const action = text(item["action"]) ?? "";
      if (adapter !== "browser") continue;
      if (action === "navigate") {
        browserReady = true;
        continue;
      }
      if (!browserReady) {
        return {
          ok: false,
          error: `Browser action '${action}' cannot resume without replaying a local navigate setup step first.`,
          recoverability: "restart_required",
          recommendation: "Provide replacement_steps beginning with a loopback browser navigate action.",
        };
      }
    }
    const targetConfiguration = run.target.configuration ?? {};
    const nextPayload: Record<string, unknown> = {
      title: `${run.summary?.title ?? run.sequenceId} (resumed)`,
      target: {
        adapter: run.target.adapterId,
        ...(text(targetConfiguration["entrypoint"]) ? { entrypoint: targetConfiguration["entrypoint"] } : {}),
        workspace: run.target.workspacePath ?? "current",
      },
      steps: unfinished,
      capture_profile: "diagnostic",
      failure_policy: { mode: "stop_and_capture", retain_partial: true },
      limits: { max_steps: unfinished.length, max_duration_ms: 120_000, max_artifact_bytes: 100 * 1024 * 1024 },
      parent_run_id: run.id,
      baseline_run_id: run.baselineRunId,
      plan_id: run.planId,
      phase_id: run.phaseId,
      ticket_ids: run.ticketIds,
      retention_class: run.retentionClass,
    };
    const result = await this.execute(nextPayload, context);
    return {
      ...result,
      resume_revalidation: {
        environmentChanged: false,
        workspaceChanged,
        previousWorkspaceFingerprint: run.workspaceFingerprint,
        currentWorkspaceFingerprint,
      },
    };
  }
}
