import { createHash, randomUUID } from "node:crypto";
import type {
  EntityRef,
  RunRetentionClass,
  SequenceAssertion,
  SequenceDefinition,
  SequenceFailurePolicy,
  SequenceStepDefinition,
} from "../runs/run-model.js";

const DEFAULT_MAX_STEPS = 40;
const HARD_MAX_STEPS = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const HARD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const HARD_MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const CAPTURE_PROFILES = new Set(["minimal", "standard", "diagnostic", "visual", "full"]);
const FAILURE_MODES = new Set(["stop_and_capture", "continue_safe", "collect_all"]);
const ASSERTION_TYPES = new Set(["result_ok", "url_contains", "text_contains", "selector_exists", "equals"]);

const ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Pointer and keyboard verbs sit alongside the original eight. They are all read-only with
  // respect to the workspace — they drive the page, they do not touch disk — so they add no new
  // approval surface; see declaredSideEffectClass.
  browser: new Set([
    "navigate", "click", "type", "type_text", "wait", "screenshot", "get_text", "evaluate",
    "mouse_path", "drag", "hover", "scroll", "key", "capture_matrix",
    "video_start", "video_stop",
  ]),
  workspace: new Set(["read_file", "list_directory", "glob", "search_files"]),
  process: new Set(["start", "status", "read_output", "stop"]),
  test: new Set(["detect", "run"]),
  desktop: new Set(["capture"]),
};

export interface CompiledSequenceStep {
  definition: SequenceStepDefinition;
  adapterId: string;
  entityRefs: EntityRef[];
  capture: boolean;
}

export interface CompiledSequence {
  definition: SequenceDefinition;
  steps: CompiledSequenceStep[];
  retentionClass: RunRetentionClass;
  laneId?: string;
  fingerprint: string;
}

export class SequenceValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "SequenceValidationError";
    this.issues = issues;
  }
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

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function failurePolicy(value: unknown): SequenceFailurePolicy {
  const mode = text(record(value)["mode"]);
  if (mode === "collect_all") return "continue";
  if (mode === "continue_safe") return "continue_safe";
  return "stop";
}

function retentionClass(value: unknown): RunRetentionClass {
  return value === "temporary" || value === "pinned" ? value : "standard";
}

function entityRefs(value: unknown): EntityRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): EntityRef[] => {
    const item = record(candidate);
    const scheme = text(item["scheme"]);
    const id = text(item["id"]);
    if (!scheme || !id) return [];
    return [{
      scheme: scheme as EntityRef["scheme"],
      id,
      ...(text(item["workspacePath"]) ? { workspacePath: text(item["workspacePath"]) } : {}),
      ...(text(item["label"]) ? { label: text(item["label"]) } : {}),
    }];
  });
}

function assertions(value: unknown): SequenceAssertion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): SequenceAssertion[] => {
    const item = record(candidate);
    const type = text(item["type"]);
    if (!type) return [];
    const input: Record<string, unknown> = {};
    for (const key of ["expected", "selector", "message"]) {
      if (item[key] !== undefined) input[key] = item[key];
    }
    return [{ type, input, severity: "error" }];
  });
}

function adapterTarget(raw: Record<string, unknown>): SequenceDefinition["target"] {
  const adapterId = text(raw["adapter"]) ?? "";
  const configuration: Record<string, unknown> = {};
  const entrypoint = text(raw["entrypoint"]);
  const workspace = text(raw["workspace"]);
  if (entrypoint) configuration["entrypoint"] = entrypoint;
  if (workspace) configuration["workspace"] = workspace;
  return {
    adapterId,
    type: adapterId === "browser" ? "application_surface" : adapterId,
    ...(entrypoint ? { id: entrypoint } : {}),
    ...(workspace ? { workspacePath: workspace === "current" ? "." : workspace } : {}),
    configuration,
  };
}

function normalizedAction(adapterId: string, action: string): string {
  if (adapterId === "browser" && action === "type") return "type_text";
  return action;
}

function isReadOnlyAction(adapterId: string, action: string): boolean {
  if (adapterId === "workspace") return true;
  if (adapterId === "test") return action === "detect";
  if (adapterId === "process") return action === "status" || action === "read_output";
  if (adapterId === "browser") {
    return action === "navigate"
      || action === "wait"
      || action === "screenshot"
      || action === "get_text";
  }
  if (adapterId === "desktop") return action === "capture";
  return false;
}

function validateLocalBrowserTarget(target: SequenceDefinition["target"], steps: CompiledSequenceStep[], issues: string[]): void {
  const urls = [
    text(target.configuration?.["entrypoint"]),
    ...steps
      .filter((step) => step.adapterId === "browser" && step.definition.action.type === "navigate")
      .map((step) => text(step.definition.action.input?.["url"])),
  ].filter((value): value is string => !!value);

  if (steps.some((step) => step.adapterId === "browser") && urls.length === 0) {
    issues.push(
      "Browser sequences require a loopback entrypoint or an explicit navigate URL "
      + "so every action can remain origin-scoped.",
    );
  }

  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      issues.push(`Browser URL '${value}' is not a valid absolute URL.`);
      continue;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const local = hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname.endsWith(".localhost");
    if (!local || (url.protocol !== "http:" && url.protocol !== "https:")) {
      issues.push(
        `Browser sequences in this MVP are limited to loopback development surfaces; '${value}' is remote. `
        + "Use the standalone browser tools for supervised remote browsing.",
      );
    }
  }
}

function validateEvaluateScript(step: CompiledSequenceStep, issues: string[]): void {
  if (step.adapterId !== "browser" || step.definition.action.type !== "evaluate") return;
  const script = String(step.definition.action.input?.["script"] ?? "");
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|document\.cookie|localStorage|sessionStorage/i.test(script)) {
    issues.push(
      `Step '${step.definition.id}' uses a browser script with network or secret-bearing APIs. `
      + "Automated external effects and credential/storage access are outside this MVP.",
    );
  }
}

function validateActionInput(step: CompiledSequenceStep, issues: string[]): void {
  const input = step.definition.action.input ?? {};
  const action = step.definition.action.type;
  const missing = (field: string) => {
    issues.push(`Step '${step.definition.id}' requires a non-empty '${field}' parameter for ${step.adapterId}:${action}.`);
  };
  if (step.adapterId === "browser") {
    if (action === "navigate" && !text(input["url"])) missing("url");
    if ((action === "click" || action === "type_text") && !text(input["selector"])) missing("selector");
    if (action === "type_text" && typeof input["text"] !== "string") {
      issues.push(`Step '${step.definition.id}' requires a string 'text' parameter for browser:type_text.`);
    }
    if (action === "evaluate" && !text(input["script"])) missing("script");
  }
  if (step.adapterId === "workspace") {
    if (action === "read_file" && !text(input["path"])) missing("path");
    if ((action === "glob" || action === "search_files") && !text(input["pattern"])) missing("pattern");
  }
  if (step.adapterId === "process") {
    if (action === "start" && !text(input["command"])) missing("command");
    if ((action === "status" || action === "read_output" || action === "stop") && !text(input["handleId"])) {
      missing("handleId");
    }
  }
  if (step.adapterId === "desktop" && action === "capture" && !text(input["binding_id"])) missing("binding_id");
  for (const assertion of step.definition.assertions ?? []) {
    if (!ASSERTION_TYPES.has(assertion.type)) {
      issues.push(`Step '${step.definition.id}' uses unsupported assertion '${assertion.type}'.`);
    }
  }
}

export function compileSequence(input: Record<string, unknown>): CompiledSequence {
  const issues: string[] = [];
  const rawTarget = record(input["target"]);
  const target = adapterTarget(rawTarget);
  const primaryAdapter = target.adapterId;
  if (!ACTIONS[primaryAdapter]) {
    issues.push(`Unsupported target adapter '${primaryAdapter || "(missing)"}'.`);
  }

  const rawSteps = Array.isArray(input["steps"]) ? input["steps"] : [];
  const captureProfile = text(input["capture_profile"]) ?? "standard";
  if (!CAPTURE_PROFILES.has(captureProfile)) {
    issues.push(`Unsupported capture_profile '${captureProfile}'.`);
  }
  const failureInput = record(input["failure_policy"]);
  const failureMode = text(failureInput["mode"]);
  if (failureMode && !FAILURE_MODES.has(failureMode)) {
    issues.push(`Unsupported failure policy '${failureMode}'.`);
  }
  if (failureInput["retain_partial"] === false) {
    issues.push("retain_partial=false is unsupported; Execution Runs always retain partial failure evidence.");
  }
  const requestedFailurePolicy = failurePolicy(input["failure_policy"]);
  const requestedLimits = record(input["limits"]);
  const maxSteps = boundedInteger(requestedLimits["max_steps"], DEFAULT_MAX_STEPS, 1, HARD_MAX_STEPS);
  if (rawSteps.length === 0) issues.push("A sequence needs at least one step.");
  if (rawSteps.length > maxSteps) {
    issues.push(`Sequence has ${rawSteps.length} steps, exceeding its max_steps limit of ${maxSteps}.`);
  }

  const seen = new Set<string>();
  const steps: CompiledSequenceStep[] = rawSteps.slice(0, HARD_MAX_STEPS).map((candidate, ordinal) => {
    const raw = record(candidate);
    let id = text(raw["id"]) ?? `step-${ordinal + 1}`;
    if (seen.has(id)) {
      issues.push(`Duplicate step id '${id}'.`);
      id = `${id}-${ordinal + 1}`;
    }
    const adapterId = text(raw["adapter"]) ?? primaryAdapter;
    const action = normalizedAction(adapterId, text(raw["action"]) ?? "");
    if (!ACTIONS[adapterId]) {
      issues.push(`Step '${id}' uses unsupported adapter '${adapterId || "(missing)"}'.`);
    } else if (!ACTIONS[adapterId]!.has(action)) {
      issues.push(`Step '${id}' uses unsupported ${adapterId} action '${action || "(missing)"}'.`);
    }
    const dependencies = Array.isArray(raw["depends_on"])
      ? raw["depends_on"].map(String).filter(Boolean)
      : [];
    for (const dependency of dependencies) {
      if (!seen.has(dependency)) {
        issues.push(`Step '${id}' depends on '${dependency}', which is not an earlier step.`);
      }
    }
    seen.add(id);
    const params = record(raw["params"]);
    const refs = entityRefs(raw["entity_refs"]);
    const managesVideoEvidence = action === "video_start" || action === "video_stop";
    const capture = raw["capture"] === true
      || (raw["capture"] !== false && adapterId === "browser" && !managesVideoEvidence && captureProfile !== "minimal");
    const definition: SequenceStepDefinition = {
      id,
      ...(text(raw["label"]) ? { title: text(raw["label"]) } : {}),
      action: { type: action, adapterId, input: params },
      ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
      ...(assertions(raw["assertions"]).length > 0 ? { assertions: assertions(raw["assertions"]) } : {}),
      ...(
        capture
          ? { captureProfile }
          : {}
      ),
      ...(raw["checkpoint"] === true ? { checkpoint: true } : {}),
    };
    return {
      definition,
      adapterId,
      entityRefs: refs,
      capture,
    };
  });

  if (requestedFailurePolicy === "continue") {
    for (const step of steps) {
      if ((step.definition.dependsOn?.length ?? 0) > 0) {
        issues.push("collect_all requires independent steps without depends_on edges.");
        break;
      }
      if (!isReadOnlyAction(step.adapterId, step.definition.action.type)) {
        issues.push(
          `collect_all is diagnostic-only; step '${step.definition.id}' is not read-only.`,
        );
        break;
      }
    }
  }

  validateLocalBrowserTarget(target, steps, issues);
  for (const step of steps) {
    validateActionInput(step, issues);
    validateEvaluateScript(step, issues);
  }

  let recording = false;
  for (const step of steps.filter((candidate) => candidate.adapterId === "browser")) {
    if (step.definition.action.type === "video_start") {
      if (recording) issues.push(`Step '${step.definition.id}' starts a nested video recording.`);
      recording = true;
    }
    if (step.definition.action.type === "video_stop") {
      if (!recording) issues.push(`Step '${step.definition.id}' stops video without an earlier video_start.`);
      recording = false;
    }
  }
  if (recording) issues.push("A browser video_start step requires a later video_stop step.");

  const planId = text(input["plan_id"]);
  const phaseId = text(input["phase_id"]);
  if ((planId && !phaseId) || (!planId && phaseId)) {
    issues.push("plan_id and phase_id must be provided together.");
  }
  if (input["retention_class"] !== undefined
    && input["retention_class"] !== "temporary"
    && input["retention_class"] !== "standard"
    && input["retention_class"] !== "pinned") {
    issues.push(`Unsupported retention_class '${String(input["retention_class"])}'.`);
  }

  if (issues.length > 0) throw new SequenceValidationError(issues);

  const title = text(input["title"]) ?? "Execution run";
  const definition: SequenceDefinition = {
    id: `seq-${randomUUID()}`,
    title,
    target,
    steps: steps.map((step) => step.definition),
    captureProfile,
    failurePolicy: requestedFailurePolicy,
    limits: {
      maxSteps,
      timeoutMs: boundedInteger(requestedLimits["max_duration_ms"], DEFAULT_TIMEOUT_MS, 1_000, HARD_TIMEOUT_MS),
      maxArtifactBytes: boundedInteger(
        requestedLimits["max_artifact_bytes"],
        DEFAULT_MAX_ARTIFACT_BYTES,
        0,
        HARD_MAX_ARTIFACT_BYTES,
      ),
    },
    ...(planId ? { planId } : {}),
    ...(phaseId ? { phaseId } : {}),
    ...(Array.isArray(input["ticket_ids"]) ? { ticketIds: input["ticket_ids"].map(String).filter(Boolean) } : {}),
    ...(text(input["parent_run_id"]) ? { parentRunId: text(input["parent_run_id"]) } : {}),
    ...(text(input["baseline_run_id"]) ? { baselineRunId: text(input["baseline_run_id"]) } : {}),
  };
  const normalizedRetentionClass = retentionClass(input["retention_class"]);
  const laneId = text(input["lane_id"]);
  const canonical = JSON.stringify({
    title,
    target,
    steps: steps.map((step) => ({
      adapterId: step.adapterId,
      definition: step.definition,
      entityRefs: step.entityRefs,
    })),
    limits: definition.limits,
    failurePolicy: definition.failurePolicy,
    captureProfile: definition.captureProfile,
    planId: definition.planId,
    phaseId: definition.phaseId,
    ticketIds: definition.ticketIds,
    parentRunId: definition.parentRunId,
    baselineRunId: definition.baselineRunId,
    retentionClass: normalizedRetentionClass,
    laneId,
  });
  return {
    definition,
    steps,
    retentionClass: normalizedRetentionClass,
    ...(laneId ? { laneId } : {}),
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}
