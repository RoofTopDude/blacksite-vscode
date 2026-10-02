/* Which chat requests changed which files — written by the harness, not the agent.

   ── Why this exists ─────────────────────────────────────────────────────────
   The agent used to be required to leave a Codebase Map note on every file it edited, and the
   notes mostly said what the diff already said ("changed X to Y"). That cost about one extra tool
   call per edited file and filled the map with narration. The harness already knows which files a
   request changed and by how much, so it records that itself; a map note is left for what the
   code does not show (a constraint, a gotcha, a reason).

   Shown in the Map inspector's Activity tab next to the Execution Runs that touched a file.

   ── Shape and bounds ────────────────────────────────────────────────────────
   Keyed by map id. Each file keeps its last MAX_RECORDS_PER_FILE records, newest last; a request
   that edits one file many times is one record, with its line counts summed. At most MAX_FILES
   files are kept, dropping the ones changed longest ago, so a long-lived workspace cannot grow
   the document without limit. */

import { atomicWriteJson, readJsonFile } from "../shared/durable-file.js";

const MAX_RECORDS_PER_FILE = 20;
const MAX_FILES = 5_000;
const MAX_REQUEST_CHARS = 120;

export interface ChangeRecord {
  /** When the request finished, ms since epoch. */
  at: number;
  sessionId: string;
  /** The user's request, first line, trimmed — the "why" a reader of the map is after. */
  request: string;
  additions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface ChangeTouch extends ChangeRecord {
  path: string;
}

type ChangeDocument = Record<string, ChangeRecord[]>;

/** The first line of a request, short enough to label a row. */
export function requestTitle(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "";
  return line.length > MAX_REQUEST_CHARS ? `${line.slice(0, MAX_REQUEST_CHARS - 1)}…` : line;
}

export class ChangeLog {
  private _document: ChangeDocument | null = null;

  constructor(
    private readonly _filePath: string,
    /** Map id for a path as a tool reported it; null leaves the path as given. */
    private readonly _toId: (path: string) => string | null = () => null,
  ) {}

  private _load(): ChangeDocument {
    if (this._document) return this._document;
    const raw = readJsonFile(this._filePath);
    const document: ChangeDocument = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, records] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(records)) continue;
        const valid = records.filter((record): record is ChangeRecord => !!record && typeof record === "object"
          && typeof (record as ChangeRecord).at === "number" && typeof (record as ChangeRecord).request === "string");
        if (valid.length > 0) document[id] = valid;
      }
    }
    this._document = document;
    return document;
  }

  /** Record one finished request's changes. Files with no line changes are skipped. */
  record(entry: { sessionId: string; request: string; files: readonly FileChange[]; at?: number }): void {
    const files = entry.files.filter((file) => file.path && (file.additions > 0 || file.deletions > 0));
    if (files.length === 0) return;
    const document = this._load();
    const at = entry.at ?? Date.now();
    const request = requestTitle(entry.request);
    for (const file of files) {
      const id = this._toId(file.path) ?? file.path.replace(/\\/g, "/");
      const records = document[id] ?? [];
      const last = records[records.length - 1];
      if (last && last.sessionId === entry.sessionId && last.request === request) {
        last.additions += file.additions;
        last.deletions += file.deletions;
        last.at = at;
      } else {
        records.push({ at, sessionId: entry.sessionId, request, additions: file.additions, deletions: file.deletions });
      }
      document[id] = records.slice(-MAX_RECORDS_PER_FILE);
    }
    const ids = Object.keys(document);
    if (ids.length > MAX_FILES) {
      const newest = (id: string): number => document[id]![document[id]!.length - 1]!.at;
      for (const id of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - MAX_FILES)) delete document[id];
    }
    try { atomicWriteJson(this._filePath, document); } catch { /* the log is an enrichment; never fail a turn over it */ }
  }

  /** The most recent changes to files matching `matches`, newest first. */
  changesTouching(matches: (id: string) => boolean, limit: number): ChangeTouch[] {
    const rows: ChangeTouch[] = [];
    for (const [id, records] of Object.entries(this._load())) {
      if (!matches(id)) continue;
      for (const record of records) rows.push({ path: id, ...record });
    }
    return rows.sort((a, b) => b.at - a.at).slice(0, limit);
  }
}
