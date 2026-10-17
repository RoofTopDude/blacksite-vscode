import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReviewerPrompts, currentRevisions, HOST_VERIFIER_SESSION, parseReviewerReply, verifyWork,
} from "../../src/orchestration/verification-service.js";
import { buildVerificationRequest } from "../../src/orchestration/verification-lane.js";
import { buildReceipt, type ReceiptFacts, type WorkReceipt } from "../../src/orchestration/work-receipt.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const AT = "2026-10-16T10:00:00.000Z";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-verify-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function receipt(facts: Partial<ReceiptFacts> = {}, answer = "Done, all tests pass."): WorkReceipt {
  return buildReceipt({
    id: "receipt-v",
    contract: { id: "contract-v", schema: 1, enforcement: "enforce" },
    subject: { ticketId: "BLK-1" },
    facts: {
      ended: "ok",
      filesChanged: [{ path: "src/a.ts", change: "M", sha256: sha("export const a = 1;\n") }],
      coverage: "tool_edits+snapshot", outOfScope: [],
      checks: [{ kind: "check", method: "npm test", passed: ["src/a.ts"], failed: [], at: AT }],
      uncovered: [], failedFiles: [], missingOutputs: [], verificationRequired: true,
      ...facts,
    },
    usage: { spendPartial: false, toolRounds: 2, elapsedMs: 1000 },
    answer,
    createdAt: AT,
  });
}

const input = (overrides: Partial<Parameters<typeof verifyWork>[1]> = {}) => ({
  taskId: "BLK-1", acceptanceCriteria: ["a is exported"], implementerSessionId: "lane-1", receiptId: "receipt-v", reviewRequired: false,
  ...overrides,
});

describe("current revisions", () => {
  it("hashes changed files as they are on disk now, and leaves gone files absent", () => {
    const work = receipt({ filesChanged: [{ path: "src/a.ts", change: "M" }, { path: "src/gone.ts", change: "M" }] });
    expect(currentRevisions(root, work)).toEqual(new Map([["src/a.ts", sha("export const a = 1;\n")]]));
  });

  it("never reads outside the workspace, whatever the receipt says", () => {
    fs.writeFileSync(path.join(os.tmpdir(), "bls-outside.txt"), "secret");
    const work = receipt({ filesChanged: [{ path: "../bls-outside.txt", change: "M" }] });
    expect(currentRevisions(root, work).size).toBe(0);
    fs.rmSync(path.join(os.tmpdir(), "bls-outside.txt"), { force: true });
  });
});

describe("verifyWork", () => {
  it("verifies from host evidence alone, and the verifier is never the implementer", async () => {
    const result = await verifyWork({ workspaceRoot: root, receipt: () => receipt() }, input());
    expect(result).toMatchObject({ verdict: "verified", closure: "human" });
    expect(HOST_VERIFIER_SESSION).not.toBe("lane-1");
  });

  it("sees a file changed after the receipt as stale", async () => {
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    expect((await verifyWork({ workspaceRoot: root, receipt: () => receipt() }, input())).reasons).toEqual(["changed_since_receipt"]);
  });

  it("reports a missing receipt as insufficient evidence", async () => {
    expect(await verifyWork({ workspaceRoot: root, receipt: () => undefined }, input())).toMatchObject({ verdict: "insufficient_evidence", reasons: ["receipt_unreadable"] });
  });

  it("asks the reviewer only when the host's evidence passed, and lets it send work back", async () => {
    const decide = vi.fn(async () => '{"findings":[{"kind":"contradiction","detail":"Claims tests pass for b.ts, which no check ran."}]}');
    const result = await verifyWork({ workspaceRoot: root, receipt: () => receipt(), reviewer: () => ({ decide }) }, input({ reviewRequired: true }));
    expect(decide).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ verdict: "rework_required", reasons: ["review_contradiction"] });
  });

  it("does not spend a review on work the host already ruled out", async () => {
    const decide = vi.fn(async () => '{"findings":[]}');
    const failing = receipt({ failedFiles: ["src/a.ts"], checks: [{ kind: "check", method: "npm test", passed: [], failed: ["src/a.ts"], at: AT }] });
    const result = await verifyWork({ workspaceRoot: root, receipt: () => failing, reviewer: () => ({ decide }) }, input({ reviewRequired: true }));
    expect(result.verdict).toBe("rework_required");
    expect(decide).not.toHaveBeenCalled();
  });

  it("treats a reviewer outage or an unreadable reply as insufficient evidence, never a pass", async () => {
    const down = await verifyWork({ workspaceRoot: root, receipt: () => receipt(), reviewer: () => ({ decide: async () => { throw new Error("timeout"); } }) }, input({ reviewRequired: true }));
    expect(down).toMatchObject({ verdict: "insufficient_evidence" });
    expect(down.reasons[0]).toBe("review_unavailable: timeout");
    const garbled = await verifyWork({ workspaceRoot: root, receipt: () => receipt(), reviewer: () => ({ decide: async () => "looks fine to me" }) }, input({ reviewRequired: true }));
    expect(garbled.verdict).toBe("insufficient_evidence");
    const none = await verifyWork({ workspaceRoot: root, receipt: () => receipt(), reviewer: () => null }, input({ reviewRequired: true }));
    expect(none.reasons[0]).toMatch(/^review_unavailable: No reviewer model/);
  });
});

describe("the reviewer's prompt and reply", () => {
  it("labels the implementer's claim as unverified and gives the reviewer no write access", () => {
    const request = buildVerificationRequest({ taskId: "BLK-1", acceptanceCriteria: ["a is exported"], verifierSessionId: HOST_VERIFIER_SESSION, receipt: receipt() });
    if ("error" in request) throw new Error("unreadable");
    const { system, user } = buildReviewerPrompts(request, "Everything is green.");
    expect(system).toMatch(/You have no tools/);
    expect(user).toMatch(/THE IMPLEMENTER'S CLAIM \(unverified/);
    expect(user).toContain('"access": "read_only"');
  });

  it("accepts only well-formed findings", () => {
    expect(parseReviewerReply('{"findings":[]}')).toEqual({ status: "completed", findings: [], filesWritten: [] });
    expect(parseReviewerReply('{"findings":[{"kind":"approve","detail":"ship it"}]}').status).toBe("unavailable");
    expect(parseReviewerReply('{"findings":[{"kind":"missing_proof","detail":""}]}').status).toBe("unavailable");
    expect(parseReviewerReply('{"verdict":"verified"}').status).toBe("unavailable");
  });
});
