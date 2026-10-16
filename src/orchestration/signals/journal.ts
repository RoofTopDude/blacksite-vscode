/**
 * The signal journal: `.blacksite/orchestration/signals/journal.jsonl`, append-only.
 *
 * Two kinds of line: a signal (`type: "signal"`) and a reconciliation record (`type: "reconcile"`)
 * saying what a consumer did — or, with signals in observe mode, would have done — and why. Together
 * they are the audit trail of every state change the host made on its own.
 *
 * `cursors.json` holds, per consumer, the last signal seq it reconciled. After a restart each
 * consumer is handed what it had not yet seen. Because consumers re-read state rather than trusting
 * a signal, seeing one twice (a crash between the append and the cursor save) costs one extra look.
 *
 * The file rotates at {@link MAX_JOURNAL_BYTES}: the current file becomes `journal.1.jsonl`, and the
 * one before that is dropped. No vscode import.
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteJson, ensureDir, readJsonFile } from "../../shared/durable-file.js";
import { ORCHESTRATION_DIR } from "../receipt-store.js";
import { readSignal, type OrchestrationSignal } from "./model.js";

export const MAX_JOURNAL_BYTES = 4_000_000;
/** Ids remembered for dedup. A repeat older than this is journaled again, which is harmless. */
const SEEN_LIMIT = 20_000;

export interface ReconcileRecord {
  at: string;
  consumer: string;
  signalIds: string[];
  action: string;
  target: string;
  /** False when signals only observe: the record says what would have been done. */
  applied: boolean;
  detail: string;
}

type JournalLine =
  | ({ type: "signal" } & OrchestrationSignal)
  | ({ type: "reconcile" } & ReconcileRecord);

export class SignalJournal {
  private _loaded = false;
  private _seq = 0;
  private readonly _seen = new Map<string, true>();
  private _cursors: Record<string, number> = {};
  private _bytes = 0;

  constructor(private readonly _workspaceRoot: string) {}

  get dir(): string {
    return path.join(this._workspaceRoot, ORCHESTRATION_DIR, "signals");
  }

  private get _file(): string {
    return path.join(this.dir, "journal.jsonl");
  }

  private get _previous(): string {
    return path.join(this.dir, "journal.1.jsonl");
  }

  private get _cursorFile(): string {
    return path.join(this.dir, "cursors.json");
  }

  private _readLines(file: string): JournalLine[] {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: JournalLine[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.type === "signal") {
          const signal = readSignal(value);
          if (signal) out.push({ type: "signal", ...signal });
        } else if (value.type === "reconcile" && typeof value.consumer === "string") {
          out.push(value as unknown as JournalLine);
        }
      } catch { /* a torn last line from a crash mid-append: skipped */ }
    }
    return out;
  }

  private _load(): void {
    if (this._loaded) return;
    this._loaded = true;
    for (const line of [...this._readLines(this._previous), ...this._readLines(this._file)]) {
      if (line.type !== "signal") continue;
      this._seq = Math.max(this._seq, line.seq);
      this._remember(line.id);
    }
    try {
      this._bytes = fs.statSync(this._file).size;
    } catch {
      this._bytes = 0;
    }
    const raw = readJsonFile(this._cursorFile);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [consumer, seq] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) this._cursors[consumer] = seq;
      }
    }
  }

  private _remember(id: string): void {
    this._seen.delete(id);
    this._seen.set(id, true);
    if (this._seen.size > SEEN_LIMIT) {
      const oldest = this._seen.keys().next().value;
      if (oldest !== undefined) this._seen.delete(oldest);
    }
  }

  has(id: string): boolean {
    this._load();
    return this._seen.has(id);
  }

  /** Append a signal not seen before and give it its seq. Returns null for a repeat. */
  append(signal: OrchestrationSignal): OrchestrationSignal | null {
    this._load();
    if (this._seen.has(signal.id)) return null;
    const stored = { ...signal, seq: this._seq + 1 };
    this._write({ type: "signal", ...stored });
    this._seq = stored.seq;
    this._remember(stored.id);
    return stored;
  }

  record(records: readonly ReconcileRecord[]): void {
    if (!records.length) return;
    this._load();
    for (const record of records) this._write({ type: "reconcile", ...record });
  }

  private _write(line: JournalLine): void {
    const text = `${JSON.stringify(line)}\n`;
    ensureDir(this.dir);
    if (this._bytes + text.length > MAX_JOURNAL_BYTES && this._bytes > 0) {
      try {
        fs.rmSync(this._previous, { force: true });
        fs.renameSync(this._file, this._previous);
      } catch { /* rotation is housekeeping; appending matters more */ }
      this._bytes = 0;
    }
    fs.appendFileSync(this._file, text, "utf8");
    this._bytes += Buffer.byteLength(text);
  }

  cursor(consumer: string): number {
    this._load();
    return this._cursors[consumer] ?? 0;
  }

  setCursor(consumer: string, seq: number): void {
    this._load();
    if ((this._cursors[consumer] ?? 0) >= seq) return;
    this._cursors[consumer] = seq;
    ensureDir(this.dir);
    atomicWriteJson(this._cursorFile, this._cursors, { backup: false });
  }

  /** Signals after `seq`, oldest first, from the current file and the one before it. */
  signalsAfter(seq: number): OrchestrationSignal[] {
    this._load();
    return [...this._readLines(this._previous), ...this._readLines(this._file)]
      .filter((line): line is { type: "signal" } & OrchestrationSignal => line.type === "signal" && line.seq > seq)
      .map(({ type: _type, ...signal }) => signal)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Everything recorded, for inspection and tests. */
  lines(): JournalLine[] {
    return [...this._readLines(this._previous), ...this._readLines(this._file)];
  }

  /** Drop everything older than `days`. Run once after activation, with the receipts. */
  prune(days: number, now: number): void {
    const cutoff = now - days * 86_400_000;
    for (const file of [this._previous, this._file]) {
      const lines = this._readLines(file);
      if (!lines.length) continue;
      const kept = lines.filter((line) => Date.parse(line.at) >= cutoff);
      if (kept.length === lines.length) continue;
      try {
        if (kept.length === 0) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, kept.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
      } catch { /* housekeeping */ }
    }
    try {
      this._bytes = fs.statSync(this._file).size;
    } catch {
      this._bytes = 0;
    }
  }
}
