import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactExchangeStore } from "../../src/orchestration/artifact-exchange/store.js";
import { createExchangeRecord, type ExchangeDraft } from "../../src/orchestration/artifact-exchange/model.js";
import { readOrchestrationFlags } from "../../src/orchestration/flags.js";
import { RunArtifactStore } from "../../src/runs/run-artifact-store.js";

// Share the same mockable module namespace as durable-file, while retaining real disk IO.
vi.mock("fs", async (original) => ({ ...await original<typeof import("fs")>() }));

const host = { kind: "host" } as const;
const alice = { kind: "session", sessionId: "alice" } as const;
const bob = { kind: "session", sessionId: "bob" } as const;
const revision = "a".repeat(64);
const decision = (): ExchangeDraft => ({
  schemaVersion: 1, kind: "decision_record", access: { scope: "workspace" },
  sources: [{ kind: "ticket", id: "BLK-17", revision }],
  payload: { decision: "Keep large payloads in Run Store", rationale: "Reuse existing evidence ownership", alternatives: ["Copy payloads"] },
});
const change = (): ExchangeDraft => ({
  schemaVersion: 1, kind: "change_receipt", access: { scope: "workspace" },
  sources: [{ kind: "work_receipt", id: "receipt-17", revision }],
  payload: { summary: "Updated the interface", workReceiptId: "receipt-17" },
});

let root: string;
let store: ArtifactExchangeStore;
const reopen = () => new ArtifactExchangeStore(root, { enabled: () => true });
const file = (id: string) => path.join(store.root, `${id}.json`);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-exchange-"));
  store = reopen();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact exchange API", () => {
  it.each([decision, change])("round-trips supported records across store restarts", (draft) => {
    const record = store.put(draft(), host);
    expect(reopen().get(record.id, alice)).toEqual(record);
    expect(store.put(draft(), host)).toEqual(record);
    expect(fs.readdirSync(store.root)).toEqual([`${record.id}.json`]);
  });

  it("has stable identity independent of property insertion order, and does not retain caller objects", () => {
    const draft = decision();
    const first = store.put(draft, host);
    const reordered = { payload: draft.payload, sources: draft.sources, access: draft.access, kind: draft.kind, schemaVersion: draft.schemaVersion };
    expect(createExchangeRecord(reordered).id).toBe(first.id);
    draft.sources[0]!.revision = "b".repeat(64);
    expect(store.put(draft, host).id).not.toBe(first.id);
    first.sources.length = 0;
    expect(reopen().get(first.id, host)!.sources).toHaveLength(1);
  });

  it("creates a new immutable ID for changed payload or scope", () => {
    const draft = decision();
    const original = store.put(draft, host);
    const privateRecord = store.put({ ...draft, access: { scope: "session", sessionId: "alice" } }, host);
    const changed = store.put({ ...decision(), kind: "decision_record",
      payload: { decision: "Use the existing store", rationale: "Updated tradeoff", alternatives: [] } }, host);
    expect(new Set([original.id, privateRecord.id, changed.id]).size).toBe(3);
    expect(store.get(original.id, host)).toEqual(original);
  });

  it("does no filesystem IO when disabled, including after the flag is switched off", () => {
    const disabled = new ArtifactExchangeStore(root);
    const id = createExchangeRecord(decision()).id;
    expect(() => disabled.put(decision(), host)).toThrow(/disabled/);
    expect(() => disabled.get(id, host)).toThrow(/disabled/);
    expect(fs.existsSync(store.root)).toBe(false);
    let flag = true;
    const gated = new ArtifactExchangeStore(root, { enabled: () => readOrchestrationFlags((key) => key === "blacksite.orchestration.artifactExchange" ? flag : undefined).artifactExchange });
    const record = gated.put(decision(), host);
    flag = false;
    const read = vi.spyOn(fs, "readFileSync");
    const stat = vi.spyOn(fs, "statSync");
    expect(() => gated.get(record.id, host)).toThrow(/disabled/);
    expect(() => gated.put(change(), host)).toThrow(/disabled/);
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    flag = true;
    expect(gated.get(record.id, host)).toEqual(record);
  });

  it("enforces session scopes on reads and writes, including idempotent writes", () => {
    const draft = { ...decision(), access: { scope: "session", sessionId: "alice" } } as ExchangeDraft;
    expect(() => store.put(draft, bob)).toThrow(/access denied/);
    expect(fs.existsSync(store.root)).toBe(false);
    const record = store.put(draft, alice);
    expect(store.get(record.id, alice)).toEqual(record);
    expect(store.get(record.id, host)).toEqual(record);
    expect(() => store.get(record.id, bob)).toThrow(/access denied/);
    expect(() => store.put(draft, bob)).toThrow(/access denied/);
    expect(() => store.get(record.id, { kind: "unknown" } as never)).toThrow(/actor/);
  });

  it("rejects path traversal and keeps workspaces isolated", () => {
    expect(() => store.get("../../outside", host)).toThrow(/ID/);
    const record = store.put(decision(), host);
    const other = new ArtifactExchangeStore(path.join(root, "other"), { enabled: () => true });
    expect(other.get(record.id, host)).toBeUndefined();
    expect(fs.existsSync(other.root)).toBe(false);
  });

  it("references existing Run Store blobs without copying or resolving them", () => {
    const blobs = new RunArtifactStore(root);
    const blob = blobs.put("large evidence ".repeat(10000));
    const draft = change();
    draft.sources.push({ kind: "run_artifact", id: blob.id, revision: blob.sha256, runId: "run-17" });
    const record = store.put(draft, host);
    expect(fs.statSync(file(record.id)).size).toBeLessThan(2000);
    blobs.remove(blob.id);
    // This is historical evidence, not a claim that a missing source is still fresh.
    expect(reopen().get(record.id, host)).toEqual(record);
  });
});

describe("schema boundaries", () => {
  it.each([
    { schemaVersion: 2 }, { kind: "investigation_finding" }, { kind: "interface_contract" },
    { kind: "verification_receipt" }, { kind: "blocker_report" }, { extra: true },
    { access: { scope: "all" } }, { sources: [{ kind: "file", id: "x", revision: "timestamp" }] },
    { payload: { decision: "yes", rationale: "why", alternatives: [], untrusted: true } },
  ])("rejects unsupported or malformed fields: %j", (override) => {
    expect(() => store.put({ ...decision(), ...override } as never, host)).toThrow();
    expect(fs.existsSync(store.root)).toBe(false);
  });

  it("requires pinned receipt sources and complete plan-step/run-artifact references", () => {
    expect(() => store.put({ ...change(), sources: [] }, host)).toThrow(/pinned/);
    for (const ref of [
      { kind: "plan_step", id: "step", revision },
      { kind: "run_artifact", id: "b".repeat(64), revision, runId: "run-1" },
    ]) expect(() => createExchangeRecord({ ...decision(), sources: [ref] })).toThrow();
    expect(() => createExchangeRecord({ ...decision(), sources: [{ kind: "plan_step", id: "step", revision, planId: "plan", phaseId: "phase" }] })).not.toThrow();
  });

  it("bounds record size and field sizes instead of accepting large copied payloads", () => {
    expect(() => createExchangeRecord({ ...decision(), payload: { decision: "x".repeat(4001), rationale: "why", alternatives: [] } })).toThrow(/text/);
    expect(() => createExchangeRecord({ ...decision(), payload: { decision: "yes", rationale: "why", alternatives: Array(32).fill("x".repeat(4000)) } })).toThrow(/size limit/);
  });
});

describe("atomic publication and crash recovery", () => {
  it("exposes nothing before rename and a complete validated record immediately after", () => {
    const expected = createExchangeRecord(decision());
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(reopen().get(expected.id, host)).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(from, "utf8"))).toEqual(expected);
      rename(from, to);
      expect(reopen().get(expected.id, host)).toEqual(expected);
    });
    expect(store.put(decision(), host)).toEqual(expected);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("leaves prior committed records intact when publication fails", () => {
    const previous = store.put(change(), host);
    const expected = createExchangeRecord(decision());
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("interrupted before rename"); });
    expect(() => store.put(decision(), host)).toThrow(/interrupted/);
    spy.mockRestore();
    expect(reopen().get(expected.id, host)).toBeUndefined();
    expect(reopen().get(previous.id, host)).toEqual(previous);
    expect(fs.readdirSync(store.root)).toEqual([`${previous.id}.json`]);
    expect(reopen().put(decision(), host)).toEqual(expected);
  });

  it("allows two writers publishing the same content to converge on one record", () => {
    const expected = createExchangeRecord(decision());
    const rename = fs.renameSync;
    let competing = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!competing) {
        competing = true;
        // Second writer wins after the first checked absence and wrote its temporary file.
        expect(reopen().put(decision(), host)).toEqual(expected);
      }
      rename(from, to);
    });
    expect(store.put(decision(), host)).toEqual(expected);
    expect(reopen().get(expected.id, host)).toEqual(expected);
    expect(fs.readdirSync(store.root)).toEqual([`${expected.id}.json`]);
  });

  it("ignores abandoned partial and complete temporary writes after restart", () => {
    const expected = createExchangeRecord(decision());
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(`${file(expected.id)}.partial.tmp`, '{"schemaVersion":');
    fs.writeFileSync(`${file(expected.id)}.complete.tmp`, JSON.stringify(expected));
    expect(reopen().get(expected.id, host)).toBeUndefined();
    expect(reopen().put(decision(), host)).toEqual(expected);
    expect(reopen().get(expected.id, host)).toEqual(expected);
    // Do not delete files that could still belong to another live writer.
    expect(fs.readdirSync(store.root).filter((name) => name.endsWith(".tmp"))).toHaveLength(2);
  });

  it("recovers a committed record after acknowledgement is lost and retries idempotently", () => {
    const expected = createExchangeRecord(decision());
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      throw new Error("interrupted after rename");
    });
    expect(() => store.put(decision(), host)).toThrow(/interrupted/);
    spy.mockRestore();
    expect(reopen().get(expected.id, host)).toEqual(expected);
    expect(reopen().put(decision(), host)).toEqual(expected);
    expect(fs.readdirSync(store.root)).toEqual([`${expected.id}.json`]);
  });

  it.each(["truncated", "hash", "version", "filename", "oversized"])("reports %s corruption and never overwrites it on retry", (mode) => {
    const record = store.put(decision(), host);
    const damaged = mode === "truncated" ? '{"schemaVersion":'
      : mode === "hash" ? JSON.stringify({ ...record, contentHash: "b".repeat(64) })
        : mode === "version" ? JSON.stringify({ ...record, schemaVersion: 2 })
          : mode === "filename" ? JSON.stringify(createExchangeRecord(change())) : "x".repeat(65537);
    fs.writeFileSync(file(record.id), damaged);
    expect(() => reopen().get(record.id, host)).toThrow();
    expect(() => reopen().put(decision(), host)).toThrow();
    expect(fs.readFileSync(file(record.id), "utf8")).toBe(damaged);
  });
});
