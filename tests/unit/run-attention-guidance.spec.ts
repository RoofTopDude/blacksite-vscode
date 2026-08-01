import { describe, expect, it } from "vitest";
import { withSequenceEvidenceGuidance } from "../../src/agent-session.js";

describe("sequence execution evidence guidance", () => {
  it("adds no prompt overhead for clean retained evidence", () => {
    const result = { ok: true, runId: "run-clean", attention: { reviewRequired: false, reasons: [] } };
    expect(withSequenceEvidenceGuidance(result)).toBe(result);
    expect(withSequenceEvidenceGuidance(result)).not.toHaveProperty("_evidence_guidance");
  });

  it("nudges inspection at the stable suggested cursor only when review is required", () => {
    const result = withSequenceEvidenceGuidance({
      ok: true,
      runId: "run-warning",
      attention: { reviewRequired: true, reasons: [{ label: "Assertion failed", sequenceNumber: 91 }] },
    });
    expect(result["_evidence_guidance"]).toMatch(/Assertion failed[\s\S]*sequence 91[\s\S]*Inspect/);
  });
});
