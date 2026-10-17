import { createHash } from "node:crypto";

export const ARTIFACT_EXCHANGE_SCHEMA = 1;
export const MAX_EXCHANGE_RECORD_BYTES = 64 * 1024;
export type ArtifactKind = "investigation_finding" | "interface_contract" | "change_receipt"
  | "verification_receipt" | "blocker_report" | "decision_record";
export type ArtifactAccess = { scope: "workspace" } | { scope: "session"; sessionId: string };
/** Trusted host context, never a model-provided authorization claim. */
export type ArtifactActor = { kind: "host" } | { kind: "session"; sessionId: string };

interface RevisionRef { id: string; revision: string }
export type ArtifactSource = RevisionRef & (
  | { kind: "ticket" | "plan" | "plan_doc" | "map_node" | "file" | "work_receipt" | "run" }
  | { kind: "plan_step"; planId: string; phaseId: string }
  | { kind: "run_artifact"; runId: string }
);

interface Envelope {
  schemaVersion: typeof ARTIFACT_EXCHANGE_SCHEMA;
  access: ArtifactAccess;
  sources: ArtifactSource[];
}
export type VerificationReceiptVerdict = "verified" | "rework_required" | "insufficient_evidence" | "blocked";
export type ExchangeDraft = Envelope & (
  | { kind: "change_receipt"; payload: { summary: string; workReceiptId: string } }
  | { kind: "decision_record"; payload: { decision: string; rationale: string; alternatives: string[] } }
  /** The verification lane's verdict on a WorkReceipt (#18). The WorkReceipt stays the evidence. */
  | { kind: "verification_receipt"; payload: { verdict: VerificationReceiptVerdict; reasons: string[]; workReceiptId: string } }
);
const VERDICTS: ReadonlySet<string> = new Set(["verified", "rework_required", "insufficient_evidence", "blocked"]);
export type ExchangeRecord = ExchangeDraft & { id: string; contentHash: string };

const HASH = /^[a-f0-9]{64}$/;
const ID = /^exchange_[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected a plain exchange object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid exchange fields; expected ${expected.join(", ")}`);
  }
}
function text(value: unknown, max = 4000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid exchange text");
}
function array(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid exchange array");
}
function source(value: unknown): void {
  const ref = object(value);
  const extra = ref.kind === "plan_step" ? ["planId", "phaseId"] : ref.kind === "run_artifact" ? ["runId"] : [];
  keys(ref, ["kind", "id", "revision", ...extra]);
  if (!["ticket", "plan", "plan_doc", "map_node", "file", "work_receipt", "run", "plan_step", "run_artifact"].includes(String(ref.kind))) {
    throw new Error("Unsupported exchange source kind");
  }
  text(ref.id, 512);
  if (typeof ref.revision !== "string" || !HASH.test(ref.revision)) throw new Error("Invalid source revision hash");
  for (const key of extra) text(ref[key], 512);
  if (ref.kind === "run_artifact" && ref.id !== ref.revision) throw new Error("Run artifact identity must match its revision hash");
}

function pinsReceipt(sources: unknown[], workReceiptId: unknown): boolean {
  return sources.some((item) => {
    const ref = item as ArtifactSource;
    return ref.kind === "work_receipt" && ref.id === workReceiptId;
  });
}

/** Strict v1 boundary. Only the implemented kinds are accepted. */
export function validateExchangeDraft(value: unknown): ExchangeDraft {
  const draft = object(value);
  keys(draft, ["schemaVersion", "kind", "access", "sources", "payload"]);
  if (draft.schemaVersion !== ARTIFACT_EXCHANGE_SCHEMA) throw new Error("Unsupported exchange schema version");
  const access = object(draft.access);
  if (access.scope === "workspace") keys(access, ["scope"]);
  else if (access.scope === "session") {
    keys(access, ["scope", "sessionId"]);
    text(access.sessionId, 120);
  } else throw new Error("Invalid exchange access scope");
  array(draft.sources, 128);
  draft.sources.forEach(source);
  const payload = object(draft.payload);
  if (draft.kind === "change_receipt") {
    keys(payload, ["summary", "workReceiptId"]);
    text(payload.summary);
    text(payload.workReceiptId, 512);
    if (!pinsReceipt(draft.sources, payload.workReceiptId)) throw new Error("Change receipt requires a pinned WorkReceipt source");
  } else if (draft.kind === "decision_record") {
    keys(payload, ["decision", "rationale", "alternatives"]);
    text(payload.decision);
    text(payload.rationale);
    array(payload.alternatives, 32);
    payload.alternatives.forEach((item) => text(item));
  } else if (draft.kind === "verification_receipt") {
    keys(payload, ["verdict", "reasons", "workReceiptId"]);
    if (typeof payload.verdict !== "string" || !VERDICTS.has(payload.verdict)) throw new Error("Invalid verification verdict");
    array(payload.reasons, 8);
    payload.reasons.forEach((item) => text(item, 300));
    text(payload.workReceiptId, 512);
    if (!pinsReceipt(draft.sources, payload.workReceiptId)) throw new Error("Verification receipt requires a pinned WorkReceipt source");
  } else throw new Error("Unsupported exchange artifact kind");
  return draft as unknown as ExchangeDraft;
}

/** Canonical JSON for already validated, JSON-only exchange data. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of a JSON-only snapshot, in the canonical form records use. Producers call this to pin
 * a source (`work_receipt`, `ticket`, ...) to the exact snapshot they read. Undefined properties
 * are dropped first, as JSON would drop them, so an absent field and an undefined one agree.
 */
export function revisionOf(snapshot: unknown): string {
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(snapshot)))).digest("hex");
}

export function createExchangeRecord(value: unknown): ExchangeRecord {
  const draft = validateExchangeDraft(value);
  const serialized = canonical(draft);
  if (Buffer.byteLength(serialized) + 256 > MAX_EXCHANGE_RECORD_BYTES) throw new Error("Exchange record exceeds size limit");
  const contentHash = createHash("sha256").update(serialized).digest("hex");
  return { ...JSON.parse(serialized) as ExchangeDraft, id: `exchange_${contentHash}`, contentHash };
}

export function validateExchangeId(id: string): void {
  if (!ID.test(id)) throw new Error("Invalid exchange ID");
}

export function readExchangeRecord(value: unknown): ExchangeRecord {
  const record = object(value);
  keys(record, ["schemaVersion", "kind", "access", "sources", "payload", "id", "contentHash"]);
  const { id, contentHash, ...draft } = record;
  const verified = createExchangeRecord(draft);
  if (id !== verified.id || contentHash !== verified.contentHash) throw new Error("Exchange content hash mismatch");
  return verified;
}

export function authorizeArtifact(access: ArtifactAccess, actor: ArtifactActor): void {
  const value = object(actor);
  if (value.kind === "host") { keys(value, ["kind"]); return; }
  if (value.kind !== "session") throw new Error("Invalid exchange actor");
  keys(value, ["kind", "sessionId"]);
  text(value.sessionId, 120);
  if (access.scope === "session" && access.sessionId !== value.sessionId) throw new Error("Exchange access denied");
}
