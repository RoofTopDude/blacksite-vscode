import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactExchangeStore } from "../../src/orchestration/artifact-exchange/store.js";
import { assessRecord, type SourceResolver } from "../../src/orchestration/artifact-exchange/freshness.js";
import { buildArtifactPacket, MAX_PACKET_ITEMS } from "../../src/orchestration/artifact-exchange/packet.js";
import { changeReceiptDraft } from "../../src/orchestration/artifact-exchange/producers.js";
import {
  createExchangeRecord, revisionOf, type ArtifactSource, type ExchangeDraft, type ExchangeRecord,
} from "../../src/orchestration/artifact-exchange/model.js";
import { buildReceipt, type ReceiptFacts, type WorkReceipt } from "../../src/orchestration/work-receipt.js";

const host = { kind: "host" } as const;
const alice = { kind: "session", sessionId: "alice" } as const;
const bob = { kind: "session", sessionId: "bob" } as const;
const hash = (char: string) => char.repeat(64);

function receipt(id: string, facts: Partial<ReceiptFacts> = {}, answer = "All tests pass"): WorkReceipt {
  return buildReceipt({
    id,
    contract: { id: `contract-${id}`, schema: 1, enforcement: "enforce" },
    subject: { ticketId: "BLK-17" },
    facts: {
      ended: "ok",
      filesChanged: [{ path: "src/a.ts", change: "M", sha256: hash("c") }],
      coverage: "tool_edits",
      outOfScope: [],
      checks: [{ kind: "check", method: "npm test", passed: ["src/a.ts"], failed: [], at: "2026-10-16T10:00:00.000Z" }],
      uncovered: [],
      failedFiles: [],
      missingOutputs: [],
      verificationRequired: true,
      ...facts,
    },
    usage: { spendPartial: false, toolRounds: 3, elapsedMs: 1000 },
    answer,
    createdAt: "2026-10-16T10:00:00.000Z",
  });
}

const decision = (ticketId: string, decisionText: string): ExchangeDraft => ({
  schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
  sources: [{ kind: "ticket", id: ticketId, revision: hash("a") }],
  payload: { decision: decisionText, rationale: "Reuses the existing owner", alternatives: [] },
});

/** Resolver where every source is current, unless overridden. */
const current: SourceResolver = (source: ArtifactSource) => ({ state: "current", revision: source.revision });
const withOverrides = (overrides: Record<string, ReturnType<SourceResolver>>): SourceResolver =>
  (source) => overrides[source.id] ?? current(source);

let root: string;
let store: ArtifactExchangeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-exchange-read-"));
  store = new ArtifactExchangeStore(root, { enabled: () => true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded discovery", () => {
  it("lists readable records in ID order, filtered by kind and capped by limit", () => {
    const records = ["one", "two", "three"].map((name) => store.put(decision("BLK-1", name), host));
    store.put(changeReceiptDraft(receipt("r1"), { scope: "workspace" }), host);
    const all = store.list(host, { limit: 50 });
    expect(all.records.map((record) => record.id)).toEqual([...all.records.map((r) => r.id)].sort());
    expect(all.records).toHaveLength(4);
    expect(all.mayHaveMore).toBe(false);
    expect(store.list(host, { kind: "change_receipt" }).records.map((r) => r.kind)).toEqual(["change_receipt"]);
    const capped = store.list(host, { limit: 2 });
    expect(capped.records).toHaveLength(2);
    expect(capped.mayHaveMore).toBe(true);
    expect(store.list(host, { limit: 0 }).records).toHaveLength(1);
    expect(records.every((record) => all.records.some((listed) => listed.id === record.id))).toBe(true);
  });

  it("skips session records another session may not read, and counts them without describing them", () => {
    store.put({ ...decision("BLK-1", "shared"), access: { scope: "session", sessionId: "alice" } }, host);
    const shared = store.put(decision("BLK-2", "workspace"), host);
    const forBob = store.list(bob);
    expect(forBob.records.map((record) => record.id)).toEqual([shared.id]);
    expect(forBob.skippedDenied).toBe(1);
    expect(store.list(alice).records).toHaveLength(2);
  });

  it("rejects an invalid actor and a corrupt record instead of listing around it", () => {
    store.put(decision("BLK-1", "fine"), host);
    expect(() => store.list({ kind: "unknown" } as never)).toThrow(/actor/);
    const corrupt = path.join(store.root, `exchange_${hash("e")}.json`);
    fs.writeFileSync(corrupt, '{"schemaVersion":');
    expect(() => store.list(host)).toThrow();
  });

  it("returns an empty listing and creates nothing when no record exists yet", () => {
    const listing = store.list(host);
    expect(listing).toEqual({ records: [], skippedDenied: 0, scanned: 0, mayHaveMore: false });
    expect(fs.existsSync(store.root)).toBe(false);
  });

  it("refuses to list while disabled", () => {
    const disabled = new ArtifactExchangeStore(root);
    expect(() => disabled.list(host)).toThrow(/disabled/);
    expect(fs.existsSync(disabled.root)).toBe(false);
  });
});

describe("source freshness", () => {
  const record = (): ExchangeRecord => createExchangeRecord({
    schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
    sources: [
      { kind: "ticket", id: "BLK-1", revision: hash("a") },
      { kind: "file", id: "src/a.ts", revision: hash("b") },
    ],
    payload: { decision: "Keep", rationale: "Because", alternatives: [] },
  });

  it("is fresh and usable when every pinned revision is still in force", () => {
    const assessed = assessRecord(record(), current);
    expect(assessed.freshness).toBe("fresh");
    expect(assessed.usable).toBe(true);
  });

  it("reports a moved revision as stale with the current revision, and never usable", () => {
    const assessed = assessRecord(record(), withOverrides({ "src/a.ts": { state: "current", revision: hash("d") } }));
    expect(assessed.freshness).toBe("stale");
    expect(assessed.usable).toBe(false);
    expect(assessed.sources.find((source) => source.id === "src/a.ts")).toEqual({
      kind: "file", id: "src/a.ts", freshness: "stale", currentRevision: hash("d"),
    });
  });

  it("treats a missing source as unavailable and an invisible one as denied; the worst decides", () => {
    expect(assessRecord(record(), withOverrides({ "src/a.ts": { state: "missing" } })).freshness).toBe("unavailable");
    expect(assessRecord(record(), withOverrides({ "src/a.ts": { state: "missing" }, "BLK-1": { state: "denied" } })).freshness).toBe("denied");
    expect(assessRecord(record(), withOverrides({ "src/a.ts": { state: "current", revision: hash("d") }, "BLK-1": { state: "denied" } })).freshness).toBe("denied");
  });

  it("never reads a resolver failure as fresh", () => {
    const throwing: SourceResolver = () => { throw new Error("index unavailable"); };
    expect(assessRecord(record(), throwing)).toMatchObject({ freshness: "unavailable", usable: false });
  });

  it("treats a record with no sources as fresh, because nothing it relies on can have moved", () => {
    const bare = createExchangeRecord({ ...decision("BLK-1", "no sources"), sources: [] });
    expect(assessRecord(bare, current)).toMatchObject({ freshness: "fresh", usable: true, sources: [] });
  });
});

describe("change receipts as exchange records", () => {
  it("pins the WorkReceipt by its snapshot revision and carries no selfReport or file list", () => {
    const work = receipt("receipt-1", {}, "Everything is verified and perfect");
    const draft = changeReceiptDraft(work, { scope: "workspace" });
    const stored = store.put(draft, host);
    expect(stored.sources).toEqual([{ kind: "work_receipt", id: "receipt-1", revision: revisionOf(work) }]);
    expect(stored.kind === "change_receipt" && stored.payload.summary).toBe("verified: 1 file(s) changed; verification passed.");
    expect(JSON.stringify(stored)).not.toContain("perfect");
    expect(JSON.stringify(stored)).not.toContain("src/a.ts");
  });

  it("changes the pinned revision when the receipt it points at changes", () => {
    const before = changeReceiptDraft(receipt("receipt-2"), { scope: "workspace" }).sources[0]!.revision;
    const after = changeReceiptDraft(receipt("receipt-2", { uncovered: ["src/a.ts"] }), { scope: "workspace" }).sources[0]!.revision;
    expect(after).not.toBe(before);
  });
});

describe("revisionOf", () => {
  it("ignores property order and undefined properties, but not values or array order", () => {
    expect(revisionOf({ a: 1, b: [1, 2], c: undefined })).toBe(revisionOf({ b: [1, 2], a: 1 }));
    expect(revisionOf({ b: [1, 2] })).not.toBe(revisionOf({ b: [2, 1] }));
    expect(revisionOf({ a: "x" })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("relevance-ranked packets", () => {
  const ticketA = { kind: "ticket" as const, id: "BLK-A", revision: hash("a") };
  const ticketB = { kind: "ticket" as const, id: "BLK-B", revision: hash("b") };
  const both = (text: string) => createExchangeRecord({
    schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
    sources: [ticketA, ticketB], payload: { decision: text, rationale: "r", alternatives: [] },
  });
  const onlyB = (text: string) => createExchangeRecord({
    schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
    sources: [ticketB], payload: { decision: text, rationale: "r", alternatives: [] },
  });
  const unrelated = createExchangeRecord({
    schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
    sources: [{ kind: "ticket", id: "BLK-Z", revision: hash("f") }], payload: { decision: "unrelated", rationale: "r", alternatives: [] },
  });

  it("returns only overlapping records, most overlap first, and says which sources are not fresh", () => {
    const packet = buildArtifactPacket({
      records: [unrelated, onlyB("only b"), both("both")],
      resolve: withOverrides({ "BLK-A": { state: "current", revision: hash("f") } }),
      relevantTo: ["BLK-A", "BLK-B"],
    });
    expect(packet.items.map((item) => item.summary)).toEqual(["both. r", "only b. r"]);
    expect(packet.items[0]).toMatchObject({ overlap: 2, usable: false, freshness: "stale", notFresh: ["BLK-A"] });
    expect(packet.items[1]).toMatchObject({ overlap: 1, usable: true, notFresh: [] });
    expect(packet.omitted).toBe(0);
  });

  it("bounds the item count and the serialized size, and counts what it left out", () => {
    const many = Array.from({ length: 20 }, (_, index) => onlyB(`decision ${index} ${"x".repeat(250)}`));
    const byItems = buildArtifactPacket({ records: many, resolve: current, maxItems: 99, maxBytes: 16384 });
    expect(byItems.items).toHaveLength(MAX_PACKET_ITEMS);
    expect(byItems.omitted).toBe(8);
    const bySize = buildArtifactPacket({ records: many, resolve: current, maxItems: 12, maxBytes: 1024 });
    expect(JSON.stringify(bySize.items).length).toBeLessThanOrEqual(1024);
    expect(bySize.items.length).toBeGreaterThan(0);
    expect(bySize.omitted + bySize.items.length).toBe(20);
  });

  it("clips summaries and never includes the payload in full", () => {
    const long = onlyB("y".repeat(3000));
    const [item] = buildArtifactPacket({ records: [long], resolve: current }).items;
    expect(item!.summary.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(item)).not.toContain("y".repeat(400));
  });

  it("is deterministic regardless of input order", () => {
    const forward = buildArtifactPacket({ records: [both("a"), onlyB("b")], resolve: current, relevantTo: ["BLK-B"] });
    const reversed = buildArtifactPacket({ records: [onlyB("b"), both("a")], resolve: current, relevantTo: ["BLK-B"] });
    expect(reversed).toEqual(forward);
  });
});

describe("an integration worker reads two prior outputs by reference", () => {
  it("gets both receipts as fresh references, and sees a moved receipt as stale", () => {
    const first = store.put(changeReceiptDraft(receipt("receipt-A"), { scope: "workspace" }, [{ kind: "ticket", id: "BLK-17", revision: hash("a") }]), host);
    const second = store.put(changeReceiptDraft(receipt("receipt-B"), { scope: "workspace" }, [{ kind: "ticket", id: "BLK-17", revision: hash("a") }]), host);
    const listing = store.list(host, { kind: "change_receipt" });
    // Everything in force is what the records pinned, so the packet is fresh.
    const fresh = buildArtifactPacket({ records: listing.records, resolve: current, relevantTo: ["BLK-17"] });
    expect(fresh.items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(fresh.items.every((item) => item.usable)).toBe(true);

    const moved = buildArtifactPacket({
      records: listing.records,
      resolve: withOverrides({ "receipt-B": { state: "current", revision: hash("9") } }),
      relevantTo: ["BLK-17"],
    });
    const stale = moved.items.find((item) => item.id === second.id);
    expect(stale).toMatchObject({ usable: false, freshness: "stale", notFresh: ["receipt-B"] });
    expect(moved.items.find((item) => item.id === first.id)?.usable).toBe(true);
  });
});
