/**
 * The independent verification lane (#18): decides whether a finished piece of work has earned
 * "verified", from what the host observed and, when policy asks for one, an independent read-only
 * review.
 *
 * Order of authority. The host's facts come first: a check that failed means rework, whatever a
 * reviewer thinks. Then the evidence has to still describe the files as they are now. Then a
 * reviewer may add doubt (missing proof, drift, contradiction) but can never remove a failure or a
 * gap. The implementer's own account of its work (`selfReport`) is never read.
 *
 * The lane never closes a ticket. Its result always says `closure: "human"`, which is the default
 * Ticket Loop policy. Pure: the host reads current file hashes and runs the reviewer, then passes
 * both in.
 */

import { readWorkReceipt, summarizeReceipt, type ReceiptSummary, type WorkReceipt } from "./work-receipt.js";

export type VerificationVerdict = "verified" | "rework_required" | "insufficient_evidence" | "blocked";

export type ReviewFinding =
  | { kind: "missing_proof"; detail: string }
  | { kind: "requirement_drift"; detail: string }
  | { kind: "contradiction"; detail: string }
  | { kind: "high_risk_assumption"; detail: string };

export type ReviewerOutcome =
  | { status: "completed"; findings: ReviewFinding[]; filesWritten: string[] }
  | { status: "unavailable"; reason: string };

/** Content hashes the host read itself, keyed by path. An absent path means the file does not exist. */
export type CurrentRevisions = ReadonlyMap<string, string>;

export interface VerificationInput {
  taskId: string;
  acceptanceCriteria: readonly string[];
  implementerSessionId: string;
  verifierSessionId: string;
  /** The stored receipt, read through `readWorkReceipt`: an opaque or inconsistent one is refused. */
  receipt: unknown;
  current: CurrentRevisions;
  /** Whether policy requires an independent review on top of the checks. */
  reviewRequired: boolean;
  /** Absent when no review ran. When one was required, that is an outage. */
  reviewer?: ReviewerOutcome;
}

export interface VerificationResult {
  taskId: string;
  verdict: VerificationVerdict;
  /** Machine-readable reasons. The first one is the decisive one. */
  reasons: string[];
  evidence: {
    receiptId?: string;
    checks: string[];
    uncovered: string[];
    stale: string[];
    findings: string[];
  };
  /** The lane never closes a ticket. Closure stays with a person by default. */
  closure: "human";
}

/** What an independent reviewer is given. Read-only by construction, and it carries no self-report. */
export interface VerificationRequest {
  taskId: string;
  verifierSessionId: string;
  access: "read_only";
  acceptanceCriteria: string[];
  receipt: ReceiptSummary;
  changedFiles: Array<{ path: string; change: string; sha256?: string }>;
  checks: Array<{ method: string; passed: number; failed: string[] }>;
}

const MAX_LISTED = 50;

function criteriaOf(criteria: readonly string[]): string[] {
  return criteria.map((item) => item.trim()).filter((item) => item.length > 0);
}

function checksOf(receipt: WorkReceipt): string[] {
  return receipt.evidence.flatMap((item) => (item.kind === "check"
    ? [`${item.method}: ${item.passed.length} passed, ${item.failed.length} failed`]
    : []));
}

/**
 * Stale: the file changed after the receipt, or was removed when the receipt says it changed.
 * Unpinned: the receipt did not record a hash, so nothing can say whether it still matches.
 */
export function freshnessOf(receipt: WorkReceipt, current: CurrentRevisions): { stale: string[]; unpinned: string[] } {
  const stale: string[] = [];
  const unpinned: string[] = [];
  for (const file of receipt.observed.filesChanged) {
    if (file.change === "D") {
      if (current.has(file.path)) stale.push(file.path);
      continue;
    }
    if (file.sha256 === undefined) unpinned.push(file.path);
    else if (current.get(file.path) !== file.sha256) stale.push(file.path);
  }
  return { stale, unpinned };
}

export function decideVerification(input: VerificationInput): VerificationResult {
  const evidence: VerificationResult["evidence"] = { checks: [], uncovered: [], stale: [], findings: [] };
  const finish = (verdict: VerificationVerdict, reasons: string[]): VerificationResult => ({
    taskId: input.taskId, verdict, reasons, evidence, closure: "human",
  });

  // Nothing the implementer does can make it verify its own work.
  if (input.implementerSessionId === input.verifierSessionId) return finish("blocked", ["self_verification"]);

  const read = readWorkReceipt(input.receipt);
  if (!read.ok) return finish("insufficient_evidence", ["receipt_unreadable"]);
  const receipt = read.receipt;
  evidence.receiptId = receipt.id;
  evidence.checks = checksOf(receipt);
  evidence.uncovered = receipt.verification.uncovered.slice(0, MAX_LISTED);

  const reviewer = input.reviewer;
  const reviewed = reviewer?.status === "completed" ? reviewer : undefined;

  if (criteriaOf(input.acceptanceCriteria).length === 0) return finish("insufficient_evidence", ["no_acceptance_criteria"]);

  if (receipt.verification.result === "failed" || receipt.evidence.some((item) => item.kind === "check" && item.failed.length > 0)) {
    return finish("rework_required", ["check_failed"]);
  }
  if (receipt.status === "failed") return finish("rework_required", ["receipt_failed"]);
  if (receipt.status === "blocked") return finish("blocked", ["receipt_blocked"]);
  if (receipt.status === "partial" || receipt.status === "cancelled" || receipt.status === "abandoned") {
    return finish("insufficient_evidence", ["work_incomplete"]);
  }

  // A reviewer that wrote to the workspace has broken the one rule it was given. Its findings no
  // longer count for anything.
  if (reviewed && reviewed.filesWritten.length > 0) return finish("blocked", ["reviewer_wrote_files"]);

  const { stale, unpinned } = freshnessOf(receipt, input.current);
  evidence.stale = [...stale, ...unpinned].slice(0, MAX_LISTED);
  if (stale.length > 0) return finish("insufficient_evidence", ["changed_since_receipt"]);
  if (unpinned.length > 0) return finish("insufficient_evidence", ["unpinned_change"]);

  if (evidence.uncovered.length > 0) return finish("insufficient_evidence", ["uncovered_changes"]);
  if (receipt.verification.required && receipt.verification.result !== "passed") {
    return finish("insufficient_evidence", ["no_passing_check"]);
  }
  if (!receipt.verification.required && !input.reviewRequired) return finish("insufficient_evidence", ["nothing_checkable"]);

  if (input.reviewRequired && !reviewed) {
    const reason = reviewer?.status === "unavailable" ? reviewer.reason : "no review ran";
    return finish("insufficient_evidence", [`review_unavailable: ${reason.slice(0, 200)}`]);
  }

  if (reviewed) {
    evidence.findings = reviewed.findings.slice(0, MAX_LISTED).map((finding) => `${finding.kind}: ${finding.detail.slice(0, 300)}`);
    const kinds = new Set(reviewed.findings.map((finding) => finding.kind));
    // Doubt about the work sends it back. Doubt about the evidence holds it until more arrives.
    if (kinds.has("contradiction")) return finish("rework_required", ["review_contradiction"]);
    if (kinds.has("requirement_drift")) return finish("rework_required", ["review_requirement_drift"]);
    if (kinds.has("missing_proof")) return finish("insufficient_evidence", ["review_missing_proof"]);
    if (kinds.has("high_risk_assumption")) return finish("insufficient_evidence", ["review_high_risk_assumption"]);
  }

  return finish("verified", [receipt.verification.required ? "checks_cover_changes" : "review_clear"]);
}

/**
 * The packet a reviewer receives. It names the criteria, the host's summary of the receipt, the
 * changed files with their pinned hashes, and the check results. It never carries the lane's
 * self-report, and it grants no write access.
 */
export function buildVerificationRequest(input: Pick<VerificationInput, "taskId" | "acceptanceCriteria" | "verifierSessionId" | "receipt">): VerificationRequest | { error: "receipt_unreadable" } {
  const read = readWorkReceipt(input.receipt);
  if (!read.ok) return { error: "receipt_unreadable" };
  const receipt = read.receipt;
  return {
    taskId: input.taskId,
    verifierSessionId: input.verifierSessionId,
    access: "read_only",
    acceptanceCriteria: criteriaOf(input.acceptanceCriteria),
    receipt: summarizeReceipt(receipt),
    changedFiles: receipt.observed.filesChanged.slice(0, MAX_LISTED).map((file) => ({
      path: file.path, change: file.change, ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })),
    checks: receipt.evidence.flatMap((item) => (item.kind === "check"
      ? [{ method: item.method, passed: item.passed.length, failed: item.failed.slice(0, MAX_LISTED) }]
      : [])),
  };
}
