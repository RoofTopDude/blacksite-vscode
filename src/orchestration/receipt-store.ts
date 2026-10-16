/**
 * Contracts and receipts on disk, under `.blacksite/orchestration/`.
 *
 *   contracts/<id>.json   written when a contract is issued, so a crash still leaves a record of
 *                         what was authorized
 *   receipts/<id>.json    one per finished piece of contracted work
 *   receipts/index.json   id, contract, subject, status, time — rebuilt from the files when absent
 *
 * Receipts point at their subjects (ticket, plan step, lane). No other store copies them; they
 * hold at most the id. Everything is written with atomicWriteJson. No vscode import: the replay
 * suite and the work graph use this directly.
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteJson, ensureDir, readJsonFile } from "../shared/durable-file.js";
import { readWorkContract, type WorkContract } from "./work-contract.js";
import { readWorkReceipt, type ReceiptStatus, type ReceiptSubject, type WorkReceipt } from "./work-receipt.js";

export const ORCHESTRATION_DIR = path.join(".blacksite", "orchestration");
export const MAX_RECEIPTS = 2_000;
const INDEX_VERSION = 1;

export interface ReceiptIndexEntry {
  id: string;
  contractId: string;
  subject: ReceiptSubject;
  status: ReceiptStatus;
  createdAt: string;
}

interface ReceiptIndexDocument {
  version: number;
  receipts: ReceiptIndexEntry[];
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,120}$/;

function indexEntry(receipt: WorkReceipt): ReceiptIndexEntry {
  return { id: receipt.id, contractId: receipt.contractId, subject: receipt.subject, status: receipt.status, createdAt: receipt.createdAt };
}

export class ReceiptStore {
  private readonly _listeners = new Set<(entry: ReceiptIndexEntry) => void>();
  private _index: ReceiptIndexEntry[] | null = null;

  constructor(private readonly _workspaceRoot: string, private readonly _now: () => number = () => Date.now()) {}

  get root(): string {
    return path.join(this._workspaceRoot, ORCHESTRATION_DIR);
  }

  private _contractPath(id: string): string {
    return path.join(this.root, "contracts", `${id}.json`);
  }

  private _receiptPath(id: string): string {
    return path.join(this.root, "receipts", `${id}.json`);
  }

  private _indexPath(): string {
    return path.join(this.root, "receipts", "index.json");
  }

  onDidPut(listener: (entry: ReceiptIndexEntry) => void): { dispose(): void } {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  putContract(contract: WorkContract): void {
    if (!SAFE_ID.test(contract.id)) throw new Error(`Unsafe contract id: ${contract.id}`);
    ensureDir(path.dirname(this._contractPath(contract.id)));
    atomicWriteJson(this._contractPath(contract.id), contract, { backup: false });
  }

  getContract(id: string): WorkContract | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    const raw = readJsonFile(this._contractPath(id));
    if (raw === null) return undefined;
    const read = readWorkContract(raw);
    return read.ok ? read.contract : undefined;
  }

  putReceipt(receipt: WorkReceipt): void {
    if (!SAFE_ID.test(receipt.id)) throw new Error(`Unsafe receipt id: ${receipt.id}`);
    ensureDir(path.dirname(this._receiptPath(receipt.id)));
    atomicWriteJson(this._receiptPath(receipt.id), receipt, { backup: false });
    const index = this.index().filter((entry) => entry.id !== receipt.id);
    const entry = indexEntry(receipt);
    index.push(entry);
    this._writeIndex(index);
    for (const listener of this._listeners) {
      try { listener(entry); } catch { /* a broken subscriber must not lose the receipt */ }
    }
  }

  getReceipt(id: string): WorkReceipt | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    const raw = readJsonFile(this._receiptPath(id));
    if (raw === null) return undefined;
    const read = readWorkReceipt(raw);
    return read.ok ? read.receipt : undefined;
  }

  /** Every receipt this store knows about, oldest first. Rebuilt from the files if the index is lost. */
  index(): ReceiptIndexEntry[] {
    if (this._index) return [...this._index];
    const raw = readJsonFile(this._indexPath()) as ReceiptIndexDocument | null;
    if (raw && raw.version === INDEX_VERSION && Array.isArray(raw.receipts)) {
      this._index = raw.receipts.filter((entry) => entry && typeof entry.id === "string");
      return [...this._index];
    }
    this._index = this._rebuildIndex();
    if (this._index.length) this._writeIndex(this._index);
    return [...this._index];
  }

  find(filter: Partial<ReceiptSubject> & { contractId?: string }): ReceiptIndexEntry[] {
    return this.index().filter((entry) => {
      if (filter.contractId && entry.contractId !== filter.contractId) return false;
      for (const [key, value] of Object.entries(filter)) {
        if (key === "contractId" || value === undefined) continue;
        if ((entry.subject as Record<string, unknown>)[key] !== value) return false;
      }
      return true;
    });
  }

  /**
   * Drop receipts older than `retentionDays` and anything past {@link MAX_RECEIPTS}, oldest first,
   * except those `keep` names (still referenced by an open loop or plan run).
   */
  prune(retentionDays: number, keep: ReadonlySet<string> = new Set()): number {
    const cutoff = this._now() - retentionDays * 24 * 60 * 60 * 1000;
    const index = this.index().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = Math.max(0, index.length - MAX_RECEIPTS);
    const removed = new Set<string>();
    for (const [position, entry] of index.entries()) {
      if (keep.has(entry.id)) continue;
      const old = Date.parse(entry.createdAt) < cutoff;
      if (old || position < excess) removed.add(entry.id);
    }
    if (!removed.size) return 0;
    for (const id of removed) {
      const receipt = this.getReceipt(id);
      try { fs.rmSync(this._receiptPath(id), { force: true }); } catch { /* best effort */ }
      if (receipt && !index.some((entry) => !removed.has(entry.id) && entry.contractId === receipt.contractId)) {
        try { fs.rmSync(this._contractPath(receipt.contractId), { force: true }); } catch { /* best effort */ }
      }
    }
    this._writeIndex(index.filter((entry) => !removed.has(entry.id)));
    return removed.size;
  }

  private _writeIndex(entries: ReceiptIndexEntry[]): void {
    this._index = entries;
    ensureDir(path.dirname(this._indexPath()));
    atomicWriteJson(this._indexPath(), { version: INDEX_VERSION, receipts: entries } satisfies ReceiptIndexDocument, { backup: false });
  }

  private _rebuildIndex(): ReceiptIndexEntry[] {
    const dir = path.dirname(this._indexPath());
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const entries: ReceiptIndexEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      const read = readWorkReceipt(readJsonFile(path.join(dir, name)));
      if (read.ok) entries.push(indexEntry(read.receipt));
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
