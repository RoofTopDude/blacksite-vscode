import * as fs from "fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../shared/durable-file.js";
import {
  authorizeArtifact, createExchangeRecord, MAX_EXCHANGE_RECORD_BYTES, readExchangeRecord,
  validateExchangeId, type ArtifactActor, type ArtifactKind, type ExchangeDraft, type ExchangeRecord,
} from "./model.js";

export interface ArtifactExchangeOptions {
  /** Host supplies the orchestration flag. Omitted means disabled; checked on every call. */
  enabled?: () => boolean;
}

/** Immutable workspace-local records. No index, source dereferencing, or model integration. */
export class ArtifactExchangeStore {
  readonly root: string;

  constructor(workspaceRoot: string, private readonly options: ArtifactExchangeOptions = {}) {
    this.root = path.join(path.resolve(workspaceRoot), ".blacksite", "orchestration", "artifact-exchange");
  }

  private requireEnabled(): void {
    if (this.options.enabled?.() !== true) throw new Error("Artifact exchange is disabled");
  }

  put(draft: ExchangeDraft | ExchangeRecord, actor: ArtifactActor): ExchangeRecord {
    this.requireEnabled();
    // Callers that have already created an immutable record may hand it back to the
    // store. Revalidate its identity rather than treating its id/hash as draft fields.
    const record = "id" in draft || "contentHash" in draft
      ? readExchangeRecord(draft)
      : createExchangeRecord(draft);
    authorizeArtifact(record.access, actor);
    const existing = this.get(record.id, actor);
    if (existing) return existing;
    // Compact JSON keeps the serialized record within the schema's byte limit. Reuse the
    // shared temp + rename writer; there is no mutable state to restore from a backup.
    atomicWriteFile(path.join(this.root, `${record.id}.json`), `${JSON.stringify(record)}\n`, { backup: false });
    return record;
  }

  get(id: string, actor: ArtifactActor): ExchangeRecord | undefined {
    this.requireEnabled();
    validateExchangeId(id);
    // Validate the actor even when the requested record is absent.
    authorizeArtifact({ scope: "workspace" }, actor);
    const record = this.readRecord(id);
    if (record) authorizeArtifact(record.access, actor);
    return record;
  }

  /**
   * Bounded discovery. Returns up to `limit` records the actor may read: in ID order by default, or
   * newest file first with `newestFirst`. Records carry no timestamp by design, so "newest" is when
   * this host wrote the file, a host fact rather than part of the record. `relevantTo` keeps only
   * records with a source among those IDs. Records the actor may not read are skipped and counted,
   * never returned or described. A corrupt record is an error, as in `get`, because a listing that
   * quietly dropped evidence would look like a store with less in it.
   */
  list(actor: ArtifactActor, options: { kind?: ArtifactKind; limit?: number; relevantTo?: readonly string[]; newestFirst?: boolean } = {}): ArtifactListing {
    this.requireEnabled();
    authorizeArtifact({ scope: "workspace" }, actor);
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
    if (!fs.existsSync(this.root)) return { records: [], skippedDenied: 0, scanned: 0, mayHaveMore: false };
    let names = fs.readdirSync(this.root).filter((name) => RECORD_FILE.test(name)).sort();
    if (options.newestFirst) {
      const written = new Map(names.map((name) => [name, this._mtime(name)] as const));
      names = names.sort((a, b) => written.get(b)! - written.get(a)! || (a < b ? -1 : 1));
    }
    const wanted = options.relevantTo?.length ? new Set(options.relevantTo) : undefined;
    const records: ExchangeRecord[] = [];
    let skippedDenied = 0;
    let scanned = 0;
    for (const name of names.slice(0, MAX_LIST_SCAN)) {
      if (records.length >= limit) break;
      scanned += 1;
      const record = this.readRecord(name.slice(0, -".json".length));
      if (!record || (options.kind && record.kind !== options.kind)) continue;
      if (wanted && !record.sources.some((source) => wanted.has(source.id))) continue;
      try {
        authorizeArtifact(record.access, actor);
      } catch {
        skippedDenied += 1;
        continue;
      }
      records.push(record);
    }
    return { records, skippedDenied, scanned, mayHaveMore: records.length >= limit || scanned < names.length };
  }

  /**
   * Remove records this host wrote more than `retentionDays` ago, by file time. Only committed
   * records go: a temporary file may belong to a writer that is still running. Returns how many
   * were removed. Works while the flag is off, so turning the feature off does not stop housekeeping.
   */
  prune(retentionDays: number, now = Date.now()): number {
    if (!fs.existsSync(this.root)) return 0;
    const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
    let removed = 0;
    for (const name of fs.readdirSync(this.root)) {
      if (!RECORD_FILE.test(name) || this._mtime(name) >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.root, name), { force: true });
        removed += 1;
      } catch { /* housekeeping: a file that cannot be removed now is tried again next time */ }
    }
    return removed;
  }

  private _mtime(name: string): number {
    try { return fs.statSync(path.join(this.root, name)).mtimeMs; } catch { return 0; }
  }

  /** The stored record, verified, with no access decision. Callers authorize it. */
  private readRecord(id: string): ExchangeRecord | undefined {
    validateExchangeId(id);
    let bytes: Buffer;
    try {
      const file = path.join(this.root, `${id}.json`);
      if (fs.statSync(file).size > MAX_EXCHANGE_RECORD_BYTES) throw new Error("Exchange record exceeds size limit");
      bytes = fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (bytes.byteLength > MAX_EXCHANGE_RECORD_BYTES) throw new Error("Exchange record exceeds size limit");
    const record = readExchangeRecord(JSON.parse(bytes.toString("utf8")));
    if (record.id !== id) throw new Error("Exchange filename/ID mismatch");
    return record;
  }
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;
/** Files examined per listing. Bounds the work on a store that has grown large. */
export const MAX_LIST_SCAN = 200;
const RECORD_FILE = /^exchange_[a-f0-9]{64}\.json$/;

export interface ArtifactListing {
  records: ExchangeRecord[];
  skippedDenied: number;
  scanned: number;
  /** True when a later call could return more: the limit was reached or files were left unscanned. */
  mayHaveMore: boolean;
}
