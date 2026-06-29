// Catalog introspection + structured reads.
//
// Builds the Explorer tree (schemas → tables / views / vector collections / saved
// queries / jobs), inspects object schemas, and serves paginated, parameter-bound
// preview reads. Preview reads NEVER interpolate user values into SQL — identifiers
// are validated against the live catalog and row values bind through `?` params.

import type { DatabaseManager } from "./database-manager.js";
import type { SqlValue } from "./sql-driver.js";

export type CatalogObjectType = "table" | "view" | "vector_collection" | "saved_query" | "job";

export interface CatalogColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface CatalogObject {
  name: string;
  type: CatalogObjectType;
  /** Approximate or exact row count where cheaply available. */
  rowCount?: number;
  /** Extra context for non-relational nodes (e.g. collection model/dims). */
  detail?: string;
}

export interface CatalogGroup {
  id: string;
  label: string;
  type: CatalogObjectType;
  objects: CatalogObject[];
}

export interface CatalogTree {
  engine: string | null;
  schemaVersion: number;
  groups: CatalogGroup[];
}

export interface ObjectDescription {
  name: string;
  type: CatalogObjectType;
  columns: CatalogColumn[];
  rowCount: number;
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
  createSql: string | null;
}

export interface PreviewOptions {
  limit?: number;
  offset?: number;
  /** Free-text filter applied as a case-insensitive LIKE across text columns. */
  filter?: string;
  orderBy?: string;
  orderDir?: "asc" | "desc";
}

export interface PreviewResult {
  object: string;
  columns: string[];
  rows: Array<Record<string, SqlValue>>;
  totalRows: number;
  limit: number;
  offset: number;
}

interface MasterRow extends Record<string, unknown> {
  name: string;
  type: string;
  sql: string | null;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject anything that is not a bare SQL identifier — defends preview reads. */
export function isSafeIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

export class CatalogStore {
  constructor(private readonly db: DatabaseManager) {}

  private listMaster(type: "table" | "view"): MasterRow[] {
    return this.db.all<MasterRow>(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type = ? AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      [type],
    );
  }

  private safeRowCount(table: string): number | undefined {
    if (!isSafeIdentifier(table)) return undefined;
    try {
      const row = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
      return row ? Number(row.n) : 0;
    } catch {
      return undefined;
    }
  }

  /** Build the full Explorer tree the webview renders. */
  getCatalogTree(): CatalogTree {
    const tables = this.listMaster("table").map<CatalogObject>((row) => ({
      name: row.name,
      type: "table",
      rowCount: this.safeRowCount(row.name),
    }));
    const views = this.listMaster("view").map<CatalogObject>((row) => ({
      name: row.name,
      type: "view",
    }));

    const collections = this.db
      .all<{ collection: string; count: number; dims: number; model: string | null }>(
        `SELECT collection, COUNT(*) AS count, MAX(dims) AS dims, MAX(model) AS model
         FROM core_embeddings GROUP BY collection ORDER BY collection`,
      )
      .map<CatalogObject>((row) => ({
        name: row.collection,
        type: "vector_collection",
        rowCount: Number(row.count),
        detail: `${Number(row.dims)} dims${row.model ? ` · ${row.model}` : ""}`,
      }));

    const savedQueries = this.db
      .all<{ id: string; name: string }>("SELECT id, name FROM core_saved_queries ORDER BY updated_at DESC")
      .map<CatalogObject>((row) => ({ name: row.name, type: "saved_query", detail: row.id }));

    const jobs = this.db
      .all<{ id: string; kind: string; status: string }>(
        "SELECT id, kind, status FROM core_jobs ORDER BY created_at DESC LIMIT 50",
      )
      .map<CatalogObject>((row) => ({ name: `${row.kind} · ${row.id}`, type: "job", detail: row.status }));

    const groups: CatalogGroup[] = [
      { id: "tables", label: "Tables", type: "table", objects: tables },
      { id: "views", label: "Views", type: "view", objects: views },
      { id: "vectors", label: "Vector Collections", type: "vector_collection", objects: collections },
      { id: "saved", label: "Saved Queries", type: "saved_query", objects: savedQueries },
      { id: "jobs", label: "Jobs", type: "job", objects: jobs },
    ];

    return {
      engine: this.db.engine,
      schemaVersion: this.db.migrationResult?.toVersion ?? 0,
      groups,
    };
  }

  /** Inspect a table or view: columns, indexes, row count, and DDL. */
  describeObject(name: string): ObjectDescription {
    if (!isSafeIdentifier(name)) {
      throw new Error(`Invalid object name: ${name}`);
    }
    const master = this.db.get<MasterRow>(
      "SELECT name, type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
      [name],
    );
    if (!master) throw new Error(`Object not found: ${name}`);

    const columns = this.db
      .all<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>(
        `PRAGMA table_info("${name}")`,
      )
      .map<CatalogColumn>((col) => ({
        name: col.name,
        type: col.type,
        notNull: Number(col.notnull) === 1,
        primaryKey: Number(col.pk) > 0,
        defaultValue: col.dflt_value,
      }));

    const indexes = this.db
      .all<{ name: string; unique: number }>(`PRAGMA index_list("${name}")`)
      .map((idx) => ({
        name: idx.name,
        unique: Number(idx.unique) === 1,
        columns: this.db
          .all<{ name: string }>(`PRAGMA index_info("${idx.name}")`)
          .map((c) => c.name),
      }));

    return {
      name,
      type: master.type === "view" ? "view" : "table",
      columns,
      rowCount: this.safeRowCount(name) ?? 0,
      indexes,
      createSql: master.sql,
    };
  }

  /** Paginated, filterable preview of a table or view. */
  previewRows(name: string, options: PreviewOptions = {}): PreviewResult {
    if (!isSafeIdentifier(name)) {
      throw new Error(`Invalid object name: ${name}`);
    }
    const description = this.describeObject(name);
    const columnNames = description.columns.map((c) => c.name);
    const limit = Math.min(Math.max(1, options.limit ?? 50), 1000);
    const offset = Math.max(0, options.offset ?? 0);

    const params: SqlValue[] = [];
    let whereClause = "";
    const filter = options.filter?.trim();
    if (filter) {
      const textColumns = description.columns
        .filter((c) => /char|text|clob|TEXT/i.test(c.type) || c.type === "")
        .map((c) => c.name);
      const cols = textColumns.length > 0 ? textColumns : columnNames;
      const likeTerms = cols.map((col) => `CAST("${col}" AS TEXT) LIKE ? COLLATE NOCASE`);
      whereClause = ` WHERE ${likeTerms.join(" OR ")}`;
      for (let i = 0; i < cols.length; i++) params.push(`%${filter}%`);
    }

    let orderClause = "";
    if (options.orderBy && columnNames.includes(options.orderBy)) {
      const dir = options.orderDir === "desc" ? "DESC" : "ASC";
      orderClause = ` ORDER BY "${options.orderBy}" ${dir}`;
    }

    const totalRow = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${name}"${whereClause}`,
      params,
    );
    const totalRows = totalRow ? Number(totalRow.n) : 0;

    const rows = this.db.all<Record<string, SqlValue>>(
      `SELECT * FROM "${name}"${whereClause}${orderClause} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return { object: name, columns: columnNames, rows, totalRows, limit, offset };
  }
}
