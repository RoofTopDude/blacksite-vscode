/**
 * Work receipts: what the host observed when a piece of contracted work ended.
 *
 * The status is derived from host-observed facts only — files the edit journal or a snapshot saw
 * change, checks the verification ledger recorded, gates the approval path settled, how the lane
 * ended. The lane's own account of its work is kept in `selfReport` and never read by
 * {@link deriveReceiptStatus}. "All tests pass" with no check on record is
 * `succeeded_unverified`, not `verified`: the absence of evidence never counts as success.
 *
 * Pure. See docs/orchestration-p0-implementation-plan.md §3.3.
 */

import { migrateVersioned, type Migration, type WorkContract } from "./work-contract.js";

export const WORK_RECEIPT_SCHEMA = 1;

export type ReceiptStatus =
  | "verified"
  | "succeeded_unverified"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled"
  | "abandoned";

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  "verified", "succeeded_unverified", "partial", "blocked", "failed", "cancelled", "abandoned",
];

export type ObservationCoverage = "tool_edits" | "tool_edits+snapshot" | "none";

export interface ObservedChange {
  path: string;
  change: "A" | "M" | "D" | "R";
  /** Content hash at receipt time, so a later reader can tell the file has moved on since. */
  sha256?: string;
  sizeBytes?: number;
}

export interface CheckEvidence {
  kind: "check";
  method: string;
  passed: string[];
  failed: string[];
  at: string;
}

export type ReceiptEvidence =
  | CheckEvidence
  | { kind: "diagnostics"; errors: number; warnings: number }
  | { kind: "run"; runId: string }
  | { kind: "artifact"; sha256: string; label?: string };

export type ReceiptFailureKind =
  | "timeout" | "no_answer" | "error" | "verification_failed" | "scope_violation" | "contract_invalid";

export interface ReceiptSubject {
  laneId?: string;
  subRequestId?: string;
  loopId?: string;
  iterationSeq?: number;
  planRunId?: string;
  ticketId?: string;
  planId?: string;
  phaseId?: string;
  stepId?: string;
}

export interface WorkReceipt {
  schema: typeof WORK_RECEIPT_SCHEMA;
  id: string;
  contractId: string;
  contractSchema: number;
  enforcement: WorkContract["enforcement"];
  subject: ReceiptSubject;
  status: ReceiptStatus;
  /** Machine-readable reasons for the status, in the order they were decided. */
  basis: string[];
  observed: {
    filesChanged: ObservedChange[];
    coverage: ObservationCoverage;
    /** Observed writes outside the contract's writable territory that no approval covered. */
    outOfScope: string[];
    /** Paths outside the territory that an approval let the lane write. */
    granted: string[];
    /** Calls stopped before they ran. */
    refused: Array<{ toolName: string; reason: string }>;
  };
  evidence: ReceiptEvidence[];
  verification: {
    required: boolean;
    result: "passed" | "failed" | "not_run" | "not_applicable";
    uncovered: string[];
  };
  usage: {
    usd?: number;
    spendPartial: boolean;
    toolRounds: number;
    elapsedMs: number;
    budgetHit?: "rounds" | "runtime" | "idle" | "usd";
  };
  blocked?: { gate: string; detail: string; whatWouldUnblock?: string };
  failure?: { kind: ReceiptFailureKind; detail: string };
  /** The lane's own words. Recorded for the reader; never used to decide anything. */
  selfReport: { answerExcerpt: string };
  next: { guidance: string; retryable: boolean };
  createdAt: string;
}

/** How the work ended, as the host saw it. */
export type LaneEnd = "ok" | "error" | "no_answer" | "timeout" | "cancelled" | "abandoned";

export interface ReceiptFacts {
  ended: LaneEnd;
  /** The error text or stop reason, when the lane did not end ok. */
  endDetail?: string;
  gate?: { gate: string; detail: string; whatWouldUnblock?: string };
  filesChanged: ObservedChange[];
  coverage: ObservationCoverage;
  outOfScope: string[];
  granted?: string[];
  refused?: Array<{ toolName: string; reason: string }>;
  checks: CheckEvidence[];
  /** Changed files that owe a check and no passing check covered. */
  uncovered: string[];
  /** Changed files whose most recent covering check failed. */
  failedFiles: string[];
  /** Declared outputs that were not produced. */
  missingOutputs: string[];
  /** The lane left something usable (a partial answer) even though it did not finish. */
  partialAnswer?: boolean;
  verificationRequired: boolean;
  /**
   * Out-of-territory changes are recorded but do not fail the work. True for an observing contract:
   * nothing gated those writes, so they say what enforcement would have asked about, not that
   * anything slipped past it.
   */
  scopeAdvisory?: boolean;
}

export interface DerivedStatus {
  status: ReceiptStatus;
  basis: string[];
  failure?: { kind: ReceiptFailureKind; detail: string };
  verification: WorkReceipt["verification"];
  next: WorkReceipt["next"];
}

/** The status table of plan §3.3, top row first. Only host facts reach this function. */
export function deriveReceiptStatus(facts: ReceiptFacts): DerivedStatus {
  const changed = facts.filesChanged.length > 0;
  const failedCheck = facts.failedFiles.length > 0;
  const passingChecks = facts.checks.filter((check) => check.passed.length > 0);
  const needsVerification = facts.verificationRequired && changed;
  const verification: WorkReceipt["verification"] = {
    required: needsVerification,
    result: !needsVerification
      ? "not_applicable"
      : failedCheck ? "failed"
        : facts.uncovered.length === 0 && passingChecks.length > 0 ? "passed" : "not_run",
    uncovered: [...facts.uncovered],
  };
  const detail = facts.endDetail ?? "";

  if (facts.ended === "cancelled") {
    return { status: "cancelled", basis: ["cancelled"], verification, next: { guidance: "Stopped before it finished; nothing about the work failed.", retryable: true } };
  }
  if (facts.ended === "abandoned") {
    return {
      status: "abandoned",
      basis: ["host_restarted"],
      verification,
      next: { guidance: "The extension host restarted while this ran. Any changes it made are on disk; review them before running it again.", retryable: true },
    };
  }
  if (facts.gate) {
    return {
      status: "blocked",
      basis: [`gate:${facts.gate.gate}`],
      verification,
      next: { guidance: facts.gate.whatWouldUnblock || "Answer the blocked approval, then run it again.", retryable: true },
    };
  }
  if (facts.outOfScope.length > 0 && !facts.scopeAdvisory) {
    return {
      status: "failed",
      basis: ["changes_outside_territory"],
      failure: { kind: "scope_violation", detail: `Changed outside its territory: ${facts.outOfScope.slice(0, 8).join(", ")}` },
      verification,
      next: { guidance: "Review the changes outside the contract's territory before retrying; widen the territory if they were intended.", retryable: false },
    };
  }
  if (failedCheck) {
    return {
      status: "failed",
      basis: ["covering_check_failed"],
      failure: { kind: "verification_failed", detail: `A check failed on ${facts.failedFiles.slice(0, 8).join(", ")}` },
      verification,
      next: { guidance: "Fix what the failing check reports before this goes to review.", retryable: true },
    };
  }
  if (facts.ended !== "ok") {
    const kind: ReceiptFailureKind = facts.ended === "timeout" ? "timeout" : facts.ended === "no_answer" ? "no_answer" : "error";
    if (changed || facts.partialAnswer) {
      return {
        status: "partial",
        basis: [`ended:${facts.ended}`, changed ? "changes_made" : "partial_answer"],
        failure: { kind, detail },
        verification,
        next: { guidance: "Continue from what is already done rather than starting over.", retryable: true },
      };
    }
    return {
      status: "failed",
      basis: [`ended:${facts.ended}`, "no_changes"],
      failure: { kind, detail },
      verification,
      next: { guidance: kind === "timeout" ? "Retry with a larger budget or a narrower task." : "Retry with a different approach.", retryable: true },
    };
  }
  if (facts.missingOutputs.length > 0) {
    return {
      status: "partial",
      basis: ["ended:ok", "outputs_missing"],
      verification,
      next: { guidance: `Not produced: ${facts.missingOutputs.slice(0, 8).join(", ")}`, retryable: true },
    };
  }
  if (verification.result === "passed") {
    return {
      status: "verified",
      basis: ["ended:ok", "checks_cover_all_changes"],
      verification,
      next: { guidance: "Verified by the checks on record. Ready for review.", retryable: false },
    };
  }
  const basis = ["ended:ok"];
  if (needsVerification) basis.push(facts.uncovered.length ? "changes_unchecked" : "no_check_on_record");
  else basis.push(changed ? "nothing_checkable" : "no_changes");
  return {
    status: "succeeded_unverified",
    basis,
    verification,
    next: {
      guidance: needsVerification
        ? `Not verified: no passing check covered ${facts.uncovered.slice(0, 8).join(", ") || "the changes"}.`
        : "Finished; nothing the host could check. Review the answer.",
      retryable: false,
    },
  };
}

export interface BuildReceiptInput {
  id: string;
  contract: Pick<WorkContract, "id" | "schema" | "enforcement">;
  subject: ReceiptSubject;
  facts: ReceiptFacts;
  evidence?: ReceiptEvidence[];
  usage: WorkReceipt["usage"];
  answer?: string;
  createdAt: string;
}

const MAX_FILES = 200;
const MAX_EXCERPT = 600;

export function buildReceipt(input: BuildReceiptInput): WorkReceipt {
  const derived = deriveReceiptStatus({
    ...input.facts,
    scopeAdvisory: input.facts.scopeAdvisory ?? input.contract.enforcement === "observe",
  });
  return {
    schema: WORK_RECEIPT_SCHEMA,
    id: input.id,
    contractId: input.contract.id,
    contractSchema: input.contract.schema,
    enforcement: input.contract.enforcement,
    subject: input.subject,
    status: derived.status,
    basis: derived.basis,
    observed: {
      filesChanged: input.facts.filesChanged.slice(0, MAX_FILES),
      coverage: input.facts.coverage,
      outOfScope: input.facts.outOfScope.slice(0, MAX_FILES),
      granted: (input.facts.granted ?? []).slice(0, MAX_FILES),
      refused: (input.facts.refused ?? []).slice(0, 50),
    },
    evidence: [...input.facts.checks.slice(-20), ...(input.evidence ?? [])],
    verification: derived.verification,
    usage: input.usage,
    ...(input.facts.gate ? { blocked: input.facts.gate } : {}),
    ...(derived.failure ? { failure: derived.failure } : {}),
    selfReport: { answerExcerpt: (input.answer ?? "").slice(0, MAX_EXCERPT) },
    next: derived.next,
    createdAt: input.createdAt,
  };
}

/** What the parent model and the loop see of a receipt: enough to act on, nothing more. */
export interface ReceiptSummary {
  id: string;
  contractId: string;
  enforcement: WorkContract["enforcement"];
  status: ReceiptStatus;
  filesChanged: number;
  uncovered: string[];
  outOfScope: string[];
  next: string;
}

export function summarizeReceipt(receipt: WorkReceipt): ReceiptSummary {
  return {
    id: receipt.id,
    contractId: receipt.contractId,
    enforcement: receipt.enforcement,
    status: receipt.status,
    filesChanged: receipt.observed.filesChanged.length,
    uncovered: receipt.verification.uncovered.slice(0, 10),
    outOfScope: receipt.observed.outOfScope.slice(0, 10),
    next: receipt.next.guidance,
  };
}

/** One line for a ticket note or a step note. */
export function describeReceipt(receipt: WorkReceipt): string {
  return describeReceiptSummary(summarizeReceipt(receipt));
}

export function describeReceiptSummary(summary: Pick<ReceiptSummary, "id" | "status" | "filesChanged" | "next">): string {
  switch (summary.status) {
    case "verified":
      return `Verified (receipt ${summary.id}): checks covered all ${summary.filesChanged} changed file(s).`;
    case "succeeded_unverified":
      return `Not verified (receipt ${summary.id}): ${summary.next}`;
    default:
      return `Receipt ${summary.id}: ${summary.status.replace(/_/g, " ")}. ${summary.next}`;
  }
}

export const RECEIPT_MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type ReadReceiptResult =
  | { ok: true; receipt: WorkReceipt }
  /** A record this build cannot interpret. Kept and shown, never counted as verified. */
  | { ok: false; opaque: true; id?: string; error: string };

/**
 * Read a stored receipt. Receipts are records rather than authorizations, so a newer schema is
 * not an error to hide — it is returned as opaque, which every consumer treats as "unknown",
 * never as verified.
 */
export function readWorkReceipt(raw: unknown, migrations: Readonly<Record<number, Migration>> = RECEIPT_MIGRATIONS): ReadReceiptResult {
  const id = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string"
    ? (raw as Record<string, unknown>).id as string
    : undefined;
  const migrated = migrateVersioned(raw, WORK_RECEIPT_SCHEMA, migrations);
  if (!migrated.ok) return { ok: false, opaque: true, ...(id ? { id } : {}), error: migrated.error };
  const value = migrated.value;
  const status = value.status as ReceiptStatus;
  const observed = value.observed as WorkReceipt["observed"] | undefined;
  const verification = value.verification as WorkReceipt["verification"] | undefined;
  if (
    typeof value.id !== "string" || typeof value.contractId !== "string" || !RECEIPT_STATUSES.includes(status)
    || !observed || !Array.isArray(observed.filesChanged) || !verification
  ) {
    return { ok: false, opaque: true, ...(id ? { id } : {}), error: "malformed receipt" };
  }
  // A "verified" status must be backed by its own verification record; anything else is not trusted.
  if (status === "verified" && verification.result !== "passed") {
    return { ok: false, opaque: true, id: value.id, error: "verified status without a passing verification" };
  }
  return { ok: true, receipt: value as unknown as WorkReceipt };
}
