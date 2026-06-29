// Raw SQL execution + saved query persistence.
//
// Read-only SQL runs directly (capped at `maxRows`). Writes are classified by the
// query guard: a write is never executed unless the caller passes `confirmed: true`,
// and the service returns the classification so the UI/agent can show the user what
// they are about to run. This is the safety boundary the assistant relies on.

import type { DatabaseManager } from "./database-manager.js";
import type { SqlValue } from "./sql-driver.js";
import { classifyQuery, describeForConfirmation, type QueryClassification } from "./query-guard.js";

export interface ReadQueryResult {
  ok: true;
  kind: "read";
  columns: string[];
  rows: Array<Record<string, SqlValue>>;
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface WriteQueryResult {
  ok: true;
  kind: "write";
  changes: number;
  lastInsertRowid: number;
  elapsedMs: number;
}

export interface BlockedQueryResult {
  ok: false;
  kind: "blocked";
  classification: QueryClassification;
  message: string;
  /** When true, the statement could run if the caller re-issues with confirmation. */
  needsConfirmation: boolean;
}

export type QueryResult = ReadQueryResult | WriteQueryResult | BlockedQueryResult;

export interface RunQueryOptions {
  maxRows?: number;
  /** Allow non-read statements to execute. Defaults to false. */
  confirmed?: boolean;
  params?: SqlValue[];
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  backend: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

interface SavedQueryRow extends Record<string, unknown> {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  backend: string;
  run_count: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function columnsOf(rows: Array<Record<string, SqlValue>>): string[] {
  return rows.length > 0 ? Object.keys(rows[0]!) : [];
}

export class QueryService {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Run arbitrary SQL with the safety guard applied. Read statements return rows;
   * write statements require `confirmed`; multi-statement scripts are rejected so a
   * benign-looking SELECT cannot smuggle a trailing DELETE.
   */
  async run(sql: string, options: RunQueryOptions = {}): Promise<QueryResult> {
    const classification = classifyQuery(sql);

    if (classification.multiple) {
      return {
        ok: false,
        kind: "blocked",
        classification,
        message: "Multiple statements are not allowed in one run. Execute them one at a time.",
        needsConfirmation: false,
      };
    }

    const started = Date.now();

    if (classification.readOnly) {
      const maxRows = Math.min(Math.max(1, options.maxRows ?? 500), 10_000);
      const rows = this.db.all<Record<string, SqlValue>>(sql, options.params);
      const truncated = rows.length > maxRows;
      const limited = truncated ? rows.slice(0, maxRows) : rows;
      return {
        ok: true,
        kind: "read",
        columns: columnsOf(limited),
        rows: limited,
        rowCount: limited.length,
        truncated,
        elapsedMs: Date.now() - started,
      };
    }

    if (!options.confirmed) {
      return {
        ok: false,
        kind: "blocked",
        classification,
        message: describeForConfirmation(classification),
        needsConfirmation: true,
      };
    }

    const result = await this.db.enqueueWrite((driver) => driver.run(sql, options.params));
    return {
      ok: true,
      kind: "write",
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Classify SQL without running it — backs `db.preview_write_query` and the UI's
   * "what will this do?" affordance.
   */
  preview(sql: string): { classification: QueryClassification; message: string } {
    const classification = classifyQuery(sql);
    return { classification, message: describeForConfirmation(classification) };
  }

  // ── Saved queries ──────────────────────────────────────────────────────────

  listSavedQueries(): SavedQuery[] {
    return this.db
      .all<SavedQueryRow>("SELECT * FROM core_saved_queries ORDER BY updated_at DESC")
      .map(mapSavedQuery);
  }

  getSavedQuery(id: string): SavedQuery | undefined {
    const row = this.db.get<SavedQueryRow>("SELECT * FROM core_saved_queries WHERE id = ?", [id]);
    return row ? mapSavedQuery(row) : undefined;
  }

  async saveQuery(input: { id?: string; name: string; sql: string; description?: string }): Promise<SavedQuery> {
    const name = input.name.trim() || "Untitled query";
    const sql = input.sql.trim();
    if (!sql) throw new Error("Cannot save an empty query.");
    const description = input.description?.trim() || null;

    const id = input.id ?? newId("sq");
    await this.db.enqueueWrite((driver) => {
      driver.run(
        `INSERT INTO core_saved_queries (id, name, sql, description, backend, updated_at)
         VALUES (:id, :name, :sql, :description, 'embedded', datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           sql = excluded.sql,
           description = excluded.description,
           updated_at = datetime('now')`,
        { id, name, sql, description },
      );
    });
    return this.getSavedQuery(id)!;
  }

  async deleteSavedQuery(id: string): Promise<boolean> {
    return this.db.enqueueWrite((driver) => {
      const result = driver.run("DELETE FROM core_saved_queries WHERE id = ?", [id]);
      return result.changes > 0;
    });
  }

  async markSavedQueryRun(id: string): Promise<void> {
    await this.db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_saved_queries SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?",
        [id],
      );
    });
  }
}

function mapSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    sql: row.sql,
    description: row.description,
    backend: row.backend,
    runCount: Number(row.run_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
  };
}
