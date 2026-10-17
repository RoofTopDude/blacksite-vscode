import { describe, expect, it } from "vitest";
import {
  buildVerificationRequest, decideVerification, type ReviewerOutcome, type VerificationInput,
} from "../../src/orchestration/verification-lane.js";
import { buildReceipt, type ReceiptFacts, type WorkReceipt } from "../../src/orchestration/work-receipt.js";

const sha = (char: string) => char.repeat(64);
const AT = "2026-10-16T10:00:00.000Z";

function receipt(facts: Partial<ReceiptFacts> = {}, answer = ""): WorkReceipt {
  return buildReceipt({
    id: "receipt-18",
    contract: { id: "contract-18", schema: 1, enforcement: "enforce" },
    subject: { ticketId: "BLK-18" },
    facts: {
      ended: "ok",
      filesChanged: [{ path: "src/a.ts", change: "M", sha256: sha("c") }],
      coverage: "tool_edits+snapshot",
      outOfScope: [],
      checks: [{ kind: "check", method: "npm test", passed: ["src/a.ts"], failed: [], at: AT }],
      uncovered: [],
      failedFiles: [],
      missingOutputs: [],
      verificationRequired: true,
      ...facts,
    },
    usage: { spendPartial: false, toolRounds: 4, elapsedMs: 2000 },
    answer,
    createdAt: AT,
  });
}

const current = new Map([["src/a.ts", sha("c")]]);
const clear: ReviewerOutcome = { status: "completed", findings: [], filesWritten: [] };
const base = (overrides: Partial<VerificationInput> = {}): VerificationInput => ({
  taskId: "BLK-18",
  acceptanceCriteria: ["Parser accepts nested tables"],
  implementerSessionId: "impl",
  verifierSessionId: "verify",
  receipt: receipt(),
  current,
  reviewRequired: false,
  ...overrides,
});

describe("verification verdicts", () => {
  it("verifies only when checks cover every change, and never closes the ticket", () => {
    const result = decideVerification(base());
    expect(result).toMatchObject({ verdict: "verified", reasons: ["checks_cover_changes"], closure: "human" });
    expect(result.evidence).toMatchObject({ receiptId: "receipt-18", checks: ["npm test: 1 passed, 0 failed"] });
  });

  it("refuses an implementer verifying its own work, whatever the receipt says", () => {
    expect(decideVerification(base({ verifierSessionId: "impl" }))).toMatchObject({ verdict: "blocked", reasons: ["self_verification"] });
  });

  it("does not believe a self-report that no check supports", () => {
    const unchecked = receipt({ checks: [], uncovered: ["src/a.ts"] }, "All tests pass, verified end to end");
    const result = decideVerification(base({ receipt: unchecked }));
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.reasons).toEqual(["uncovered_changes"]);
    expect(JSON.stringify(result)).not.toContain("end to end");
  });

  it("refuses a receipt it cannot read, including a verified status without a passing check", () => {
    const forged = { ...receipt(), status: "verified", verification: { required: true, result: "not_run", uncovered: [] } };
    expect(decideVerification(base({ receipt: forged }))).toMatchObject({ verdict: "insufficient_evidence", reasons: ["receipt_unreadable"] });
    expect(decideVerification(base({ receipt: { nonsense: true } }))).toMatchObject({ reasons: ["receipt_unreadable"] });
  });

  it("reports tasks without acceptance criteria as insufficient evidence, however clean the checks", () => {
    expect(decideVerification(base({ acceptanceCriteria: ["  ", ""] }))).toMatchObject({ verdict: "insufficient_evidence", reasons: ["no_acceptance_criteria"] });
  });
});

describe("failing checks", () => {
  it("sends a failed check back for rework even when the reviewer finds nothing wrong", () => {
    const failing = receipt({ failedFiles: ["src/a.ts"], checks: [{ kind: "check", method: "npm test", passed: [], failed: ["src/a.ts"], at: AT }] });
    const result = decideVerification(base({ receipt: failing, reviewRequired: true, reviewer: clear }));
    expect(result).toMatchObject({ verdict: "rework_required", reasons: ["check_failed"] });
  });

  it("does not let a passing check outweigh a failing one on the same receipt", () => {
    const mixed = receipt({
      checks: [
        { kind: "check", method: "unit", passed: ["src/a.ts"], failed: [], at: AT },
        { kind: "check", method: "contract", passed: [], failed: ["src/a.ts"], at: AT },
      ],
      failedFiles: ["src/a.ts"],
    });
    expect(decideVerification(base({ receipt: mixed })).verdict).toBe("rework_required");
  });

  it("maps a failed or blocked receipt status to its verdict without treating a partial one as done", () => {
    expect(decideVerification(base({ receipt: receipt({ ended: "error", endDetail: "boom" }) }))).toMatchObject({ verdict: "insufficient_evidence", reasons: ["work_incomplete"] });
    expect(decideVerification(base({ receipt: receipt({ gate: { gate: "approval", detail: "waiting" } }) }))).toMatchObject({ verdict: "blocked", reasons: ["receipt_blocked"] });
  });
});

describe("stale and partial evidence", () => {
  it("does not verify a file that changed after its check ran", () => {
    const result = decideVerification(base({ current: new Map([["src/a.ts", sha("d")]]) }));
    expect(result).toMatchObject({ verdict: "insufficient_evidence", reasons: ["changed_since_receipt"] });
    expect(result.evidence.stale).toEqual(["src/a.ts"]);
  });

  it("treats a deleted-after-receipt file that was reported as changed as stale", () => {
    const tracked = receipt({ filesChanged: [{ path: "src/gone.ts", change: "D" }], checks: [{ kind: "check", method: "npm test", passed: ["src/gone.ts"], failed: [], at: AT }] });
    expect(decideVerification(base({ receipt: tracked, current: new Map([["src/gone.ts", sha("e")]]) })).reasons).toEqual(["changed_since_receipt"]);
    expect(decideVerification(base({ receipt: tracked, current: new Map() })).verdict).toBe("verified");
  });

  it("holds a change whose receipt recorded no hash, because nothing can say it still matches", () => {
    const unpinned = receipt({ filesChanged: [{ path: "src/big.ts", change: "M" }] });
    expect(decideVerification(base({ receipt: unpinned, current: new Map() }))).toMatchObject({ reasons: ["unpinned_change"] });
  });

  it("keeps partially checked changes out of verified", () => {
    const partial = receipt({
      filesChanged: [{ path: "src/a.ts", change: "M", sha256: sha("c") }, { path: "src/b.ts", change: "M", sha256: sha("b") }],
      uncovered: ["src/b.ts"],
    });
    const result = decideVerification(base({ receipt: partial, current: new Map([["src/a.ts", sha("c")], ["src/b.ts", sha("b")]]) }));
    expect(result).toMatchObject({ verdict: "insufficient_evidence", reasons: ["uncovered_changes"] });
    expect(result.evidence.uncovered).toEqual(["src/b.ts"]);
  });

  it("does not verify when no check ran on a change that owes one", () => {
    expect(decideVerification(base({ receipt: receipt({ checks: [] }) })).reasons).toEqual(["no_passing_check"]);
  });
});

describe("independent review", () => {
  it("is outage-safe: a required review that did not run holds the work, and an optional one is ignored", () => {
    expect(decideVerification(base({ reviewRequired: true }))).toMatchObject({ verdict: "insufficient_evidence" });
    expect(decideVerification(base({ reviewRequired: true, reviewer: { status: "unavailable", reason: "provider timeout" } })).reasons[0])
      .toBe("review_unavailable: provider timeout");
    expect(decideVerification(base({ reviewRequired: false, reviewer: { status: "unavailable", reason: "timeout" } })).verdict).toBe("verified");
  });

  it("lets a reviewer send work back or hold it, but never promote a failed or stale result", () => {
    const cases: Array<[string, string]> = [
      ["contradiction", "rework_required"], ["requirement_drift", "rework_required"],
      ["missing_proof", "insufficient_evidence"], ["high_risk_assumption", "insufficient_evidence"],
    ];
    for (const [kind, verdict] of cases) {
      const reviewer: ReviewerOutcome = { status: "completed", findings: [{ kind, detail: "see criteria" } as never], filesWritten: [] };
      const result = decideVerification(base({ reviewRequired: true, reviewer }));
      expect(result.verdict).toBe(verdict);
      expect(result.evidence.findings).toEqual([`${kind}: see criteria`]);
    }
    const approving: ReviewerOutcome = { status: "completed", findings: [], filesWritten: [] };
    const failing = receipt({ failedFiles: ["src/a.ts"], checks: [{ kind: "check", method: "npm test", passed: [], failed: ["src/a.ts"], at: AT }] });
    expect(decideVerification(base({ receipt: failing, reviewRequired: true, reviewer: approving })).verdict).toBe("rework_required");
    expect(decideVerification(base({ reviewRequired: true, reviewer: approving, current: new Map() })).reasons).toEqual(["changed_since_receipt"]);
  });

  it("blocks when the reviewer touched the workspace, and ignores that reviewer's findings", () => {
    const mutated: ReviewerOutcome = { status: "completed", findings: [], filesWritten: ["src/a.ts"] };
    expect(decideVerification(base({ reviewRequired: true, reviewer: mutated }))).toMatchObject({ verdict: "blocked", reasons: ["reviewer_wrote_files"] });
  });

  it("verifies work with no changed file when a review is required and comes back clear", () => {
    const nothing = receipt({ filesChanged: [], checks: [], verificationRequired: false });
    expect(decideVerification(base({ receipt: nothing, reviewRequired: true, reviewer: clear, current: new Map() }))).toMatchObject({ verdict: "verified", reasons: ["review_clear"] });
    expect(decideVerification(base({ receipt: nothing, reviewRequired: false, current: new Map() }))).toMatchObject({ verdict: "insufficient_evidence", reasons: ["nothing_checkable"] });
  });
});

describe("verification request packet", () => {
  it("is read-only, carries criteria, hashes and check results, and omits the implementer's account", () => {
    const packet = buildVerificationRequest(base({ receipt: receipt({}, "I fixed it and everything is green") }));
    expect(packet).toMatchObject({
      access: "read_only",
      acceptanceCriteria: ["Parser accepts nested tables"],
      changedFiles: [{ path: "src/a.ts", change: "M", sha256: sha("c") }],
      checks: [{ method: "npm test", passed: 1, failed: [] }],
    });
    expect(JSON.stringify(packet)).not.toContain("everything is green");
  });

  it("refuses to build a packet for an unreadable receipt", () => {
    expect(buildVerificationRequest(base({ receipt: {} }))).toEqual({ error: "receipt_unreadable" });
  });
});
