/**
 * Runs the verification lane (#18) for one finished piece of work.
 *
 * It reads the full receipt the host wrote, hashes the files that receipt says changed as they are
 * on disk now, and, when policy asks for one, has an independent no-tools model review the
 * evidence. {@link decideVerification} then rules. Nothing here edits a file, runs a command, grants
 * anything or touches a ticket: the caller records the verdict, and closure stays with a person.
 *
 * The reviewer is a separate model call with no tools, so it cannot write. It sees the criteria,
 * the host's facts and, labelled as an unverified claim, what the implementer said it did, which is
 * what it needs to spot a contradiction. The verdict never rests on that claim.
 */

import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "node:path";
import { extractJsonObject, type ContinuationModel } from "../continuation/continuation-model.js";
import {
  buildVerificationRequest, decideVerification, freshnessOf, type CurrentRevisions, type ReviewerOutcome, type ReviewFinding,
  type VerificationRequest, type VerificationResult,
} from "./verification-lane.js";
import type { WorkReceipt } from "./work-receipt.js";

/** The verifier's identity. Never a lane id, so an implementer can never be its own verifier. */
export const HOST_VERIFIER_SESSION = "host:verification-lane";

/** Same bounds the receipt used when it hashed these files: a file it could not hash stays unpinned. */
const MAX_HASHED_FILES = 200;
const MAX_HASHED_BYTES = 2 * 1024 * 1024;
const MAX_CLAIM_CHARS = 1200;
const MAX_FINDINGS = 20;

export interface VerificationServicePorts {
  workspaceRoot: string;
  receipt(id: string): WorkReceipt | undefined;
  /** The no-tools model for the independent review. Absent or null: no review can run. */
  reviewer?: () => ContinuationModel | null;
}

export interface VerifyWorkInput {
  taskId: string;
  acceptanceCriteria: readonly string[];
  /** The lane that did the work. */
  implementerSessionId: string;
  receiptId: string;
  reviewRequired: boolean;
}

/** SHA-256 of each changed file as it is now. A file that is gone, or too large to hash, is absent. */
export function currentRevisions(workspaceRoot: string, receipt: WorkReceipt): Map<string, string> {
  const root = path.resolve(workspaceRoot);
  const current = new Map<string, string>();
  for (const file of receipt.observed.filesChanged.slice(0, MAX_HASHED_FILES)) {
    const absolute = path.resolve(root, file.path);
    // A receipt path is workspace-relative; anything resolving outside the root is not read.
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_HASHED_BYTES) continue;
      current.set(file.path, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
    } catch {
      // Missing: absent from the map, which is what "deleted" means to the lane.
    }
  }
  return current;
}

/**
 * Whether a receipt's evidence still describes the files: none of the files it changed and hashed
 * has changed since. A verified receipt whose files another task has since rewritten no longer
 * proves anything about them, so work that waits on it should wait again (#21). A file the receipt
 * could not hash is not counted against it: nothing says it moved.
 */
export function receiptStillCurrent(workspaceRoot: string, receipt: WorkReceipt): boolean {
  return freshnessOf(receipt, currentRevisions(workspaceRoot, receipt)).stale.length === 0;
}

const FINDING_KINDS: ReadonlySet<string> = new Set(["missing_proof", "requirement_drift", "contradiction", "high_risk_assumption"]);

export function buildReviewerPrompts(request: VerificationRequest, claim: string): { system: string; user: string } {
  const system = [
    "You are an independent reviewer for finished software work in the Blacksite VS Code extension.",
    "You did not do the work. You have no tools: you cannot read files, run anything or change anything.",
    "Judge only from what you are given: the acceptance criteria, what the host observed (files changed, checks run and their results), and the implementer's own claim, which is unverified.",
    "",
    "Report problems as findings. Kinds:",
    "- missing_proof: a criterion has no evidence that it is met.",
    "- requirement_drift: the work does something other than what the criteria ask.",
    "- contradiction: the claim and the host's evidence disagree.",
    "- high_risk_assumption: the work depends on something risky that nothing checked.",
    "",
    'Return exactly one JSON object and nothing else: {"findings":[{"kind":"<kind>","detail":"<one sentence>"}]}.',
    'Return {"findings":[]} only when you found nothing wrong. Do not invent problems.',
  ].join("\n");
  const user = [
    "THE WORK, AS THE HOST OBSERVED IT:",
    JSON.stringify(request, null, 2),
    "",
    "THE IMPLEMENTER'S CLAIM (unverified; check it against the evidence above):",
    claim.trim() ? claim.trim().slice(0, MAX_CLAIM_CHARS) : "(none)",
    "",
    "Return the JSON object now.",
  ].join("\n");
  return { system, user };
}

/** Read the reviewer's reply. Anything that is not a well-formed finding list is an outage, never "clear". */
export function parseReviewerReply(raw: string): ReviewerOutcome {
  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.findings)) return { status: "unavailable", reason: "The reviewer's reply could not be read." };
  const findings: ReviewFinding[] = [];
  for (const item of parsed.findings.slice(0, MAX_FINDINGS)) {
    const entry = item as Record<string, unknown> | null;
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const detail = typeof entry?.detail === "string" ? entry.detail.trim().slice(0, 500) : "";
    if (!FINDING_KINDS.has(kind) || !detail) return { status: "unavailable", reason: "The reviewer returned a malformed finding." };
    findings.push({ kind, detail } as ReviewFinding);
  }
  // The reviewer has no tools, so it cannot have written anything.
  return { status: "completed", findings, filesWritten: [] };
}

async function review(ports: VerificationServicePorts, input: VerifyWorkInput, receipt: WorkReceipt): Promise<ReviewerOutcome> {
  const model = ports.reviewer?.() ?? null;
  if (!model) return { status: "unavailable", reason: "No reviewer model is configured." };
  const request = buildVerificationRequest({
    taskId: input.taskId,
    acceptanceCriteria: input.acceptanceCriteria,
    verifierSessionId: HOST_VERIFIER_SESSION,
    receipt,
  });
  if ("error" in request) return { status: "unavailable", reason: "The receipt could not be read." };
  const { system, user } = buildReviewerPrompts(request, receipt.selfReport.answerExcerpt);
  try {
    return parseReviewerReply(await model.decide(system, user));
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verify one piece of work. The review runs only when it could change the outcome: if the host's
 * own evidence already rules the work out, a model call would cost money and decide nothing.
 */
export async function verifyWork(ports: VerificationServicePorts, input: VerifyWorkInput): Promise<VerificationResult> {
  const receipt = ports.receipt(input.receiptId);
  const current: CurrentRevisions = receipt ? currentRevisions(ports.workspaceRoot, receipt) : new Map();
  const base = {
    taskId: input.taskId,
    acceptanceCriteria: input.acceptanceCriteria,
    implementerSessionId: input.implementerSessionId,
    verifierSessionId: HOST_VERIFIER_SESSION,
    receipt: receipt ?? null,
    current,
    reviewRequired: input.reviewRequired,
  };
  const deterministic = decideVerification(base);
  const awaitingReview = deterministic.reasons[0]?.startsWith("review_unavailable");
  if (!receipt || !input.reviewRequired || !awaitingReview) return deterministic;
  return decideVerification({ ...base, reviewer: await review(ports, input, receipt) });
}
