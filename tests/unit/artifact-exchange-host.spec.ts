import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExchangeHost, renderPacket } from "../../src/orchestration/artifact-exchange/host.js";
import { createExchangeRecord } from "../../src/orchestration/artifact-exchange/model.js";
import { ticketRevision } from "../../src/orchestration/artifact-exchange/producers.js";
import { buildReceipt, type WorkReceipt } from "../../src/orchestration/work-receipt.js";
import { redactSecretsInText } from "../../src/shared/redaction.js";
import type { Ticket } from "../../src/ticket-store.js";

const AT = "2026-10-16T10:00:00.000Z";
let root: string;
let enabled = true;
const receipts = new Map<string, WorkReceipt>();
const tickets = new Map<string, Ticket>();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-xhost-"));
  enabled = true;
  receipts.clear();
  tickets.clear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const host = () => new ExchangeHost({ workspaceRoot: root, enabled: () => enabled, receipt: (id) => receipts.get(id), ticket: (id) => tickets.get(id) });

function ticket(id: string, title = "Add tables"): Ticket {
  const value = { id, title, description: "", acceptanceCriteria: ["Parses nested tables"], territory: { files: [], areas: [] }, status: "backlog" } as unknown as Ticket;
  tickets.set(id, value);
  return value;
}

function receipt(id: string, ticketId: string, answer = "done"): WorkReceipt {
  const value = buildReceipt({
    id, contract: { id: `c-${id}`, schema: 1, enforcement: "observe" }, subject: { ticketId },
    facts: {
      ended: "ok", filesChanged: [{ path: "src/a.ts", change: "M" }], coverage: "tool_edits", outOfScope: [],
      checks: [{ kind: "check", method: "npm test", passed: ["src/a.ts"], failed: [], at: AT }],
      uncovered: [], failedFiles: [], missingOutputs: [], verificationRequired: true,
    },
    usage: { spendPartial: false, toolRounds: 1, elapsedMs: 5 }, answer, createdAt: AT,
  });
  receipts.set(id, value);
  return value;
}

describe("recording handoffs", () => {
  it("records a lane receipt pinned to the receipt and its ticket, and is idempotent", () => {
    ticket("BLK-1");
    const r = receipt("r1", "BLK-1");
    const first = host().recordLaneReceipt(r)!;
    expect(first.kind).toBe("change_receipt");
    expect(first.sources.map((s) => s.kind)).toEqual(["work_receipt", "ticket"]);
    expect(host().recordLaneReceipt(r)!.id).toBe(first.id);
    expect(fs.readdirSync(host().store.root)).toHaveLength(1);
  });

  it("records a verification verdict as its own kind", () => {
    ticket("BLK-1");
    const record = host().recordVerification({ verdict: "rework_required", reasons: ["check_failed"] }, receipt("r1", "BLK-1"))!;
    expect(record).toMatchObject({ kind: "verification_receipt", payload: { verdict: "rework_required", reasons: ["check_failed"], workReceiptId: "r1" } });
  });

  it("does nothing, and creates nothing, while the flag is off", () => {
    enabled = false;
    ticket("BLK-1");
    expect(host().recordLaneReceipt(receipt("r1", "BLK-1"))).toBeUndefined();
    expect(host().packetFor(["BLK-1"])).toBeUndefined();
    expect(fs.existsSync(host().store.root)).toBe(false);
  });
});

describe("the packet a lane is given", () => {
  it("lists prior work on the same ticket by reference, with no transcript", () => {
    ticket("BLK-1");
    host().recordLaneReceipt(receipt("r1", "BLK-1", "SECRET TRANSCRIPT TEXT"));
    const packet = host().packetFor(["BLK-1"])!;
    expect(packet).toMatch(/Prior work on this, by reference/);
    expect(packet).toMatch(/change receipt exchange_/);
    expect(packet).not.toContain("SECRET TRANSCRIPT TEXT");
  });

  it("returns nothing for unrelated work or no ids", () => {
    ticket("BLK-1");
    host().recordLaneReceipt(receipt("r1", "BLK-1"));
    expect(host().packetFor(["BLK-9"])).toBeUndefined();
    expect(host().packetFor([])).toBeUndefined();
  });

  it("marks an item stale once its ticket's request changes, but not when only its status does", () => {
    const t = ticket("BLK-1");
    host().recordLaneReceipt(receipt("r1", "BLK-1"));
    tickets.set("BLK-1", { ...t, status: "review" } as Ticket);
    expect(host().packetFor(["BLK-1"])).not.toMatch(/\[stale/);
    tickets.set("BLK-1", { ...t, acceptanceCriteria: ["Something else"] } as Ticket);
    expect(host().packetFor(["BLK-1"])).toMatch(/\[stale: BLK-1 changed or went missing since\]/);
  });

  it("marks an item unavailable when its receipt is gone", () => {
    ticket("BLK-1");
    host().recordLaneReceipt(receipt("r1", "BLK-1"));
    receipts.delete("r1");
    expect(host().packetFor(["BLK-1"])).toMatch(/\[unavailable: r1/);
  });

  it("masks credentials in a summary before it reaches another lane", () => {
    const record = createExchangeRecord({
      schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
      sources: [{ kind: "ticket", id: "BLK-1", revision: ticketRevision(ticket("BLK-1")) }],
      payload: { decision: "Use key sk-abcdefghijklmnop123", rationale: "password: hunter2", alternatives: [] },
    });
    host().store.put(record, { kind: "host" });
    const packet = host().packetFor(["BLK-1"])!;
    expect(packet).not.toContain("sk-abcdefghijklmnop123");
    expect(packet).not.toContain("hunter2");
    expect(redactSecretsInText("Bearer abc.def")).toBe("Bearer [redacted]");
  });
});

describe("the resolver and pruning", () => {
  it("judges files by content and refuses paths outside the workspace", () => {
    fs.writeFileSync(path.join(root, "a.ts"), "v1");
    const resolve = host().resolver();
    const sha = createHash("sha256").update("v1").digest("hex");
    expect(resolve({ kind: "file", id: "a.ts", revision: sha })).toEqual({ state: "current", revision: sha });
    expect(resolve({ kind: "file", id: "../x", revision: sha })).toEqual({ state: "denied" });
    expect(resolve({ kind: "file", id: "gone.ts", revision: sha })).toEqual({ state: "missing" });
    expect(resolve({ kind: "map_node", id: "n", revision: sha })).toEqual({ state: "missing" });
  });

  it("prunes old records by file time and leaves recent ones", () => {
    ticket("BLK-1");
    const record = host().recordLaneReceipt(receipt("r1", "BLK-1"))!;
    const file = path.join(host().store.root, `${record.id}.json`);
    expect(host().store.prune(30)).toBe(0);
    const old = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(file, old, old);
    expect(host().store.prune(30)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("renders omitted counts", () => {
    expect(renderPacket({ items: [], omitted: 3 })).toMatch(/3 more not shown/);
  });
});
