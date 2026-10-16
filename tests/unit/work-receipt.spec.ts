import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORK_RECEIPT_SCHEMA,
  buildReceipt,
  deriveReceiptStatus,
  describeReceipt,
  readWorkReceipt,
  type ReceiptFacts,
} from "../../src/orchestration/work-receipt.js";
import { ReceiptStore } from "../../src/orchestration/receipt-store.js";
import { contractFromSpawn } from "../../src/orchestration/contract-mapping.js";
import { mutationTargets, outOfScope } from "../../src/orchestration/contract-scope.js";

const CHANGED = [{ path: "src/a.ts", change: "M" as const }];
const PASS = { kind: "check" as const, method: "npm test", passed: ["src/a.ts"], failed: [], at: "t" };

function facts(overrides: Partial<ReceiptFacts> = {}): ReceiptFacts {
  return {
    ended: "ok", filesChanged: CHANGED, coverage: "tool_edits", outOfScope: [], checks: [PASS],
    uncovered: [], failedFiles: [], missingOutputs: [], verificationRequired: true, ...overrides,
  };
}

describe("receipt status (plan §3.3, first matching row wins)", () => {
  it.each([
    ["cancelled", facts({ ended: "cancelled" }), "cancelled"],
    ["host restart", facts({ ended: "abandoned" }), "abandoned"],
    ["a refused gate", facts({ gate: { gate: "write", detail: "denied" } }), "blocked"],
    ["writes outside the territory", facts({ outOfScope: ["docs/x.md"] }), "failed"],
    ["a failing covering check", facts({ failedFiles: ["src/a.ts"] }), "failed"],
    ["a timeout with changes", facts({ ended: "timeout" }), "partial"],
    ["an error with only a partial answer", facts({ ended: "error", filesChanged: [], checks: [], partialAnswer: true }), "partial"],
    ["an error with nothing to show", facts({ ended: "error", filesChanged: [], checks: [] }), "failed"],
    ["a missing declared output", facts({ missingOutputs: ["docs/api.md"] }), "partial"],
    ["checks covering every change", facts(), "verified"],
    ["changes no check covered", facts({ checks: [], uncovered: ["src/a.ts"] }), "succeeded_unverified"],
    ["a research answer with no changes", facts({ filesChanged: [], checks: [] }), "succeeded_unverified"],
  ])("%s → %s", (_label, input, status) => {
    expect(deriveReceiptStatus(input).status).toBe(status);
  });

  it("never reads the lane's own claim: 'all tests pass' with no check on record is unverified", () => {
    const receipt = buildReceipt({
      id: "r1", contract: { id: "wc", schema: 1, enforcement: "observe" }, subject: {},
      facts: facts({ checks: [], uncovered: ["src/a.ts"] }),
      usage: { spendPartial: false, toolRounds: 3, elapsedMs: 10 },
      answer: "Done. All tests pass and everything is verified.", createdAt: "2026-10-16T00:00:00.000Z",
    });
    expect(receipt.status).toBe("succeeded_unverified");
    expect(receipt.verification.result).toBe("not_run");
    expect(receipt.selfReport.answerExcerpt).toContain("All tests pass");
    expect(describeReceipt(receipt)).toContain("Not verified");
  });

  it("does not count a passing check that covered none of the changes", () => {
    expect(deriveReceiptStatus(facts({ checks: [{ ...PASS, passed: [] }], uncovered: ["src/a.ts"] })).status).toBe("succeeded_unverified");
  });

  it("marks a scope violation as not retryable and a timeout as retryable", () => {
    expect(deriveReceiptStatus(facts({ outOfScope: ["x"] })).next.retryable).toBe(false);
    expect(deriveReceiptStatus(facts({ ended: "timeout", filesChanged: [] })).failure?.kind).toBe("timeout");
  });
});

describe("reading receipts", () => {
  const good = () => buildReceipt({
    id: "r1", contract: { id: "wc", schema: 1, enforcement: "observe" }, subject: { ticketId: "BLK-1" },
    facts: facts(), usage: { spendPartial: false, toolRounds: 1, elapsedMs: 1 }, createdAt: "2026-10-16T00:00:00.000Z",
  });

  it("reads its own receipts", () => {
    expect(readWorkReceipt(JSON.parse(JSON.stringify(good())))).toMatchObject({ ok: true });
  });

  it("returns a newer schema as opaque, never as verified", () => {
    const result = readWorkReceipt({ ...good(), schema: WORK_RECEIPT_SCHEMA + 1 });
    expect(result).toMatchObject({ ok: false, opaque: true, id: "r1" });
  });

  it("refuses a verified status with no passing verification behind it", () => {
    const forged = { ...good(), verification: { required: true, result: "not_run", uncovered: [] } };
    expect(readWorkReceipt(forged)).toMatchObject({ ok: false, opaque: true });
  });
});

describe("scope", () => {
  const contract = { territory: { writable: { files: ["src/a.ts"], areas: ["lib"] }, readable: "workspace" as const, source: "declared" as const } };
  const context = {
    toRelative: (file: string) => (file.startsWith("/ws/") ? file.slice(4) : file.startsWith("/") ? null : file),
    isScratch: (file: string) => file.startsWith(".blacksite-scratch/"),
  };

  it("reads targets from every file-mutating tool's arguments", () => {
    expect(mutationTargets("file_move", { source: "a", destination: "b" })).toEqual(["a", "b"]);
    expect(mutationTargets("file_edit_batch", { edits: [{ path: "x" }, { path: "y" }] })).toEqual(["x", "y"]);
    expect(mutationTargets("code_replace_batch", { edits: [{ target: { path: "z" } }] })).toEqual(["z"]);
    expect(mutationTargets("file_copy", { source: "a", destination: "c" })).toEqual(["c"]);
    expect(mutationTargets("shell_run", { command: "rm" })).toBeNull();
    expect(mutationTargets("code_rename", { target: { path: "a" } })).toBeNull();
  });

  it("reports only what the territory, an approval, scratch and lockfiles do not cover", () => {
    const granted = new Set(["docs/granted.md"]);
    expect(outOfScope(contract, ["src/a.ts", "/ws/lib/q.ts", "docs/granted.md", ".blacksite-scratch/t.py", "package-lock.json", "src/b.ts", "/etc/hosts"], granted, context))
      .toEqual(["src/b.ts", "/etc/hosts"]);
    expect(outOfScope({ territory: { ...contract.territory, writable: "workspace" } }, ["src/b.ts"], new Set(), context)).toEqual([]);
  });
});

describe("receipt store", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  function store(now = Date.parse("2026-10-16T00:00:00.000Z")) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-"));
    dirs.push(dir);
    return { dir, store: new ReceiptStore(dir, () => now) };
  }

  function receipt(id: string, createdAt: string, ticketId = "BLK-1") {
    return buildReceipt({
      id, contract: { id: `wc_${id}`, schema: 1, enforcement: "observe" }, subject: { ticketId },
      facts: facts(), usage: { spendPartial: false, toolRounds: 1, elapsedMs: 1 }, createdAt,
    });
  }

  it("stores contracts and receipts, indexes them, and finds by subject", () => {
    const { store: s } = store();
    const contract = contractFromSpawn("x", { id: "wc_1", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "observe", budget: { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 } });
    s.putContract(contract);
    expect(s.getContract("wc_1")).toEqual(contract);
    const seen: string[] = [];
    s.onDidPut((entry) => seen.push(entry.id));
    s.putReceipt(receipt("r1", "2026-10-15T00:00:00.000Z"));
    s.putReceipt(receipt("r2", "2026-10-15T01:00:00.000Z", "BLK-2"));
    expect(seen).toEqual(["r1", "r2"]);
    expect(s.find({ ticketId: "BLK-2" }).map((entry) => entry.id)).toEqual(["r2"]);
    expect(s.getReceipt("r1")?.status).toBe("verified");
    expect(s.getReceipt("../escape")).toBeUndefined();
  });

  it("rebuilds a lost index from the receipt files", () => {
    const { dir, store: s } = store();
    s.putReceipt(receipt("r1", "2026-10-15T00:00:00.000Z"));
    fs.rmSync(path.join(dir, ".blacksite", "orchestration", "receipts", "index.json"));
    expect(new ReceiptStore(dir).index().map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("prunes old receipts but keeps those still referenced", () => {
    const { store: s } = store();
    s.putReceipt(receipt("old", "2026-01-01T00:00:00.000Z"));
    s.putReceipt(receipt("kept", "2026-01-02T00:00:00.000Z"));
    s.putReceipt(receipt("new", "2026-10-15T00:00:00.000Z"));
    expect(s.prune(30, new Set(["kept"]))).toBe(1);
    expect(s.index().map((entry) => entry.id)).toEqual(["kept", "new"]);
  });
});
