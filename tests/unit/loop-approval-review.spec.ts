import { describe, expect, it } from "vitest";
import {
  buildLoopApprovalReviewUserPrompt,
  parseLoopApprovalVerdict,
  reviewLoopApproval,
  type LoopApprovalReviewBrief,
} from "../../src/continuation/approval-review.js";

const brief: LoopApprovalReviewBrief = {
  loopId: "loop-1",
  ticketId: "BLK-7",
  ticketTitle: "Add request throttling",
  ticketDescription: "Implement the limiter and tests.",
  acceptanceCriteria: ["Returns 429 after the configured limit"],
  territory: ["src/limiter.ts", "tests/limiter.spec.ts"],
  userPrompts: ["Work through these tickets, but do not deploy anything."],
  tier: "write",
  toolName: "file_write",
  description: "Create tests/limiter.spec.ts",
};

describe("loop continuation approval review", () => {
  it("carries ticket intent, territory, and the original request into the review", () => {
    const prompt = buildLoopApprovalReviewUserPrompt(brief);
    expect(prompt).toContain("BLK-7");
    expect(prompt).toContain("tests/limiter.spec.ts");
    expect(prompt).toContain("do not deploy anything");
    expect(prompt).toContain("Create tests/limiter.spec.ts");
  });

  it("accepts a scoped reversible edit", () => {
    expect(parseLoopApprovalVerdict('{"action":"allow","risk":"low","reason":"Scoped and reversible."}'))
      .toEqual({ action: "allow", risk: "low", reason: "Scoped and reversible." });
  });

  it("preserves a safety block and its unblock guidance", () => {
    expect(parseLoopApprovalVerdict('{"action":"block","category":"irrecoverable","reason":"Publishes a release.","whatWouldUnblock":"Publish manually."}'))
      .toMatchObject({ action: "block", category: "irrecoverable", reason: "Publishes a release." });
  });

  it("fails closed on malformed output or a provider outage", async () => {
    expect(parseLoopApprovalVerdict("sure").action).toBe("block");
    const verdict = await reviewLoopApproval({ decide: async () => { throw new Error("offline"); } }, brief);
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") expect(verdict.reason).toContain("offline");
  });
});
