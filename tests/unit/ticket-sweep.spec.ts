import { describe, expect, it } from "vitest";
import { dedupeProposals, markerProposals, parseMarkers, summarizeDiagnostics, summarizeTestFailures } from "../../src/ticket-sweep.js";

describe("ticket triage sweeps", () => {
  it("finds actionable marker comments with stable identities", () => {
    const hits = parseMarkers("src/retry.ts", "// TODO: bound retry delay\n// NOTE: explain this\n// FIXME - handle timeout");
    const proposals = markerProposals(hits);
    expect(proposals.map((proposal) => proposal.title)).toEqual([
      "TODO: bound retry delay",
      "FIXME: handle timeout",
    ]);
    expect(proposals[0]?.key).toBe("src/retry.ts::bound retry delay");
  });

  it("groups diagnostics by file instead of flooding the queue", () => {
    const proposals = summarizeDiagnostics([
      { file: "src/a.ts", message: "missing name", severity: "error", line: 4 },
      { file: "src/a.ts", message: "unused value", severity: "warning", line: 8 },
      { file: "src/b.ts", message: "deprecated API", severity: "warning" },
    ]);
    expect(proposals).toHaveLength(2);
    expect(proposals.find((proposal) => proposal.file === "src/a.ts")?.title).toContain("+1 more");
  });

  it("turns explicit failing-test locations into high-priority proposals without running tests", () => {
    const proposals = summarizeTestFailures([
      { file: "tests/unit/retry.spec.ts", message: "expected 2 retries, received 3", severity: "error", source: "vitest", line: 24 },
    ]);
    expect(proposals[0]).toMatchObject({ source: "test", priority: "high", file: "tests/unit/retry.spec.ts", line: 24 });
    expect(proposals[0]?.title).toContain("Fix failing test retry.spec.ts");
  });

  it("does not re-propose work that was already accepted from a sweep", () => {
    const proposal = markerProposals(parseMarkers("src/a.ts", "// TODO: repair cache"))[0]!;
    expect(dedupeProposals([proposal], [{
      id: "BLK-1", title: proposal.title, status: "triage", statusSource: "manual", priority: "normal",
      labels: [], territory: { files: ["src/a.ts"], areas: [] }, blockedBy: [], relatedTo: [], origin: "diagnostic",
      originRef: `sweep:${proposal.key}`, events: [], createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    }])).toEqual([]);
  });
});
