/**
 * Typed orchestration signals: something the host noticed that may change what should happen next.
 *
 * A signal is a hint, never a command. Consumers respond by re-reading current state and working
 * out what should be true now; they never act on what a signal says alone. That one rule is what
 * makes duplicates, late arrivals and a replay after a restart harmless: each only causes one more
 * look at the present (docs/orchestration-p1-implementation-plan.md D2).
 *
 * Every signal says where it came from. Only what the host observed, or what a person did, may
 * change whether work is ready. What an agent claimed can only flag something for a second look.
 *
 * Pure. No vscode import.
 */

import { createHash } from "crypto";

export type SignalKind =
  | "dependency_discovered"
  | "contract_conflict"
  | "verification_failed"
  | "scope_expanded"
  | "progress_stalled"
  | "integration_ready"
  | "work_completed";

export const SIGNAL_KINDS: readonly SignalKind[] = [
  "dependency_discovered", "contract_conflict", "verification_failed", "scope_expanded",
  "progress_stalled", "integration_ready", "work_completed",
];

/** host: observed by the host. user: a person did it. reviewer: the auto reviewer ruled. model: an agent said so. */
export type SignalProvenanceSource = "host" | "user" | "reviewer" | "model";

export interface SignalProvenance {
  source: SignalProvenanceSource;
  /** What saw it: "receipt", "ticket.event", "tripwire", "watchdog", "claims", "shell_delta", … */
  observer: string;
}

export interface SignalEvidence {
  kind: "receipt" | "file" | "check" | "tool_call" | "snapshot" | "ticket_event";
  ref: string;
  sha256?: string;
}

export interface SignalScope {
  loopId?: string;
  planRunId?: string;
  laneId?: string;
  contractId?: string;
}

export interface OrchestrationSignal {
  v: 1;
  /** Deterministic: the same fact always gets the same id, so a repeat is recognisable. */
  id: string;
  kind: SignalKind;
  /** A work-graph node id: ticket:BLK-12, step:<plan>/<phase>/<step>, lane:<laneId>. */
  taskId: string;
  /** What caused it: a receipt id, a ticket event id, loop:<id>#<seq>, planrun:<id>@<n>, a tool call id. */
  causeId: string;
  at: string;
  /** Assigned by the journal: a total order of everything this host recorded. 0 until journaled. */
  seq: number;
  provenance: SignalProvenance;
  scope?: SignalScope;
  evidence?: SignalEvidence[];
  /** One sentence for a person. */
  detail: string;
  data?: Record<string, unknown>;
}

/** A signal as a source produces it, before it has an id or a place in the journal. */
export type SignalDraft = Omit<OrchestrationSignal, "v" | "id" | "seq" | "at"> & { at?: string };

export interface SignalSink {
  emit(signal: SignalDraft): void;
}

/** For hosts and tests with signals off: accepts everything, keeps nothing. */
export const NULL_SINK: SignalSink = Object.freeze({ emit: () => undefined });

/** Changes a consumer made carry this cause prefix, and sources ignore them: no feedback loops. */
export const RECONCILE_CAUSE_PREFIX = "reconcile:";

export function signalId(kind: SignalKind, taskId: string, causeId: string): string {
  return `sig_${createHash("sha1").update(`${kind}\u0000${taskId}\u0000${causeId}`).digest("hex").slice(0, 20)}`;
}

/** Give a draft its id and time. The journal assigns `seq`. */
export function finalizeSignal(draft: SignalDraft, now: () => number): OrchestrationSignal {
  return {
    v: 1,
    id: signalId(draft.kind, draft.taskId, draft.causeId),
    kind: draft.kind,
    taskId: draft.taskId,
    causeId: draft.causeId,
    at: draft.at ?? new Date(now()).toISOString(),
    seq: 0,
    provenance: { source: draft.provenance.source, observer: draft.provenance.observer },
    ...(draft.scope && Object.keys(draft.scope).length ? { scope: { ...draft.scope } } : {}),
    ...(draft.evidence?.length ? { evidence: draft.evidence.map((entry) => ({ ...entry })) } : {}),
    detail: draft.detail.slice(0, 400),
    ...(draft.data && Object.keys(draft.data).length ? { data: { ...draft.data } } : {}),
  };
}

const PROVENANCE: ReadonlySet<string> = new Set<SignalProvenanceSource>(["host", "user", "reviewer", "model"]);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["receipt", "file", "check", "tool_call", "snapshot", "ticket_event"]);

/** A stored signal, or null with nothing salvaged: a malformed line is skipped, never guessed at. */
export function readSignal(value: unknown): OrchestrationSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const str = (key: string): string | null => (typeof raw[key] === "string" && (raw[key] as string).length > 0 ? raw[key] as string : null);
  const kind = str("kind");
  const taskId = str("taskId");
  const causeId = str("causeId");
  const at = str("at");
  const id = str("id");
  if (raw.v !== 1 || !kind || !SIGNAL_KINDS.includes(kind as SignalKind) || !taskId || !causeId || !at || !id) return null;
  if (id !== signalId(kind as SignalKind, taskId, causeId)) return null;
  const provenance = raw.provenance as Record<string, unknown> | undefined;
  if (!provenance || !PROVENANCE.has(String(provenance.source)) || typeof provenance.observer !== "string") return null;
  const seq = typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null;
  if (seq === null || typeof raw.detail !== "string") return null;
  const evidence = Array.isArray(raw.evidence)
    ? (raw.evidence as unknown[]).filter((entry): entry is SignalEvidence => !!entry && typeof entry === "object"
      && EVIDENCE_KINDS.has(String((entry as Record<string, unknown>).kind)) && typeof (entry as Record<string, unknown>).ref === "string")
    : undefined;
  return {
    v: 1,
    id,
    kind: kind as SignalKind,
    taskId,
    causeId,
    at,
    seq,
    provenance: { source: provenance.source as SignalProvenanceSource, observer: provenance.observer },
    ...(raw.scope && typeof raw.scope === "object" ? { scope: raw.scope as SignalScope } : {}),
    ...(evidence?.length ? { evidence } : {}),
    detail: raw.detail,
    ...(raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? { data: raw.data as Record<string, unknown> } : {}),
  };
}

/** Whether a signal may change ready or blocked state (D3), as opposed to only raising a flag. */
export function mayChangeState(signal: Pick<OrchestrationSignal, "provenance" | "data">): boolean {
  if (signal.data?.evidenceMissing === true) return false;
  return signal.provenance.source === "host" || signal.provenance.source === "user";
}

export function ticketTaskId(ticketId: string): string {
  return `ticket:${ticketId}`;
}

export function stepTaskId(planId: string, phaseId: string, stepId: string): string {
  return `step:${planId}/${phaseId}/${stepId}`;
}

/** The ticket id inside a ticket task id, or undefined for anything else. */
export function ticketOfTask(taskId: string): string | undefined {
  return taskId.startsWith("ticket:") ? taskId.slice("ticket:".length) : undefined;
}
