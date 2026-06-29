// SQL driver abstraction — the locked Milestone 0 binding decision.
//
// The canonical embedded store is SQLite. Rather than hard-coupling to one native
// module (which carries the per-Electron-ABI rebuild + per-platform prebuild risk
// the BLA-80 research note flagged), the rest of the extension talks to this thin
// `SqlDriver` interface. Two concrete drivers satisfy it:
//
//   1. `node:sqlite` (Node's built-in `DatabaseSync`) — preferred. Zero native deps,
//      no rebuild story, available in Node >= 22.5. Used by the test runner today and
//      by the extension host once VS Code ships an Electron on Node >= 22.5.
//   2. `better-sqlite3` — fallback for older hosts where `node:sqlite` is absent.
//      Lazy-required so it is never a hard dependency; if it is not installed the
//      driver simply reports unavailable and the Data surface degrades cleanly.
//
// Keeping this module free of any `vscode` import is deliberate: the migration
// runner, catalog store, query service, and vector provider can all be unit-tested
// against a real on-disk SQLite database with no editor host present.

import { createRequire } from "node:module";
import * as path from "node:path";

// A CJS-style require that resolves correctly in both the esbuild CJS bundle and the
// vitest ESM runner, used to lazily load optional/experimental SQLite bindings so
// esbuild never statically resolves them. In the CJS bundle the module-scoped
// `require` exists, so the `createRequire` branch is never evaluated — this avoids
// touching `import.meta.url` (empty under cjs output) at load time.
const nodeRequire: (id: string) => unknown =
  typeof require === "function"
    ? (require as unknown as (id: string) => unknown)
    : (createRequire(path.join(process.cwd(), "index.js")) as unknown as (id: string) => unknown);

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** Positional params bind to `?`; a record binds to `:name` style placeholders. */
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlDriver {
  /** Identifies which binding backs this driver — surfaced in the UI and spike notes. */
  readonly engine: "node:sqlite" | "better-sqlite3";
  /** Run one or more semicolon-separated statements with no bound params (DDL/pragmas). */
  exec(sql: string): void;
  /** Run a single write/DDL statement, returning row-count and last insert id. */
  run(sql: string, params?: SqlParams): SqlRunResult;
  /** Run a query and return all rows. */
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[];
  /** Run a query and return the first row, or undefined. */
  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined;
  /** Read a numeric PRAGMA (e.g. `user_version`). */
  pragma(name: string): number;
  /** Run `fn` inside a single transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Thrown by {@link openSqlDriver} when no SQLite binding can be loaded. */
export class SqlDriverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlDriverUnavailableError";
  }
}

function toRunResult(raw: { changes?: number | bigint; lastInsertRowid?: number | bigint }): SqlRunResult {
  return {
    changes: Number(raw.changes ?? 0),
    lastInsertRowid: Number(raw.lastInsertRowid ?? 0),
  };
}

// ── node:sqlite driver ───────────────────────────────────────────────────────

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): SqlRow[];
  get(...params: unknown[]): SqlRow | undefined;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

/** Normalize our `SqlParams` into the argument list `node:sqlite`/`better-sqlite3` expect. */
function bindArgs(params?: SqlParams): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params;
  return [params];
}

class NodeSqliteDriver implements SqlDriver {
  readonly engine = "node:sqlite" as const;

  constructor(private readonly db: NodeSqliteDatabase) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: SqlParams): SqlRunResult {
    return toRunResult(this.db.prepare(sql).run(...bindArgs(params)));
  }

  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[] {
    return this.db.prepare(sql).all(...bindArgs(params)) as T[];
  }

  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined {
    return this.db.prepare(sql).get(...bindArgs(params)) as T | undefined;
  }

  pragma(name: string): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
    if (!row) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* best-effort */ }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── better-sqlite3 driver ────────────────────────────────────────────────────

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): SqlRow[];
  get(...params: unknown[]): SqlRow | undefined;
}

interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

class BetterSqliteDriver implements SqlDriver {
  readonly engine = "better-sqlite3" as const;

  constructor(private readonly db: BetterSqliteDatabase) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: SqlParams): SqlRunResult {
    return toRunResult(this.db.prepare(sql).run(...bindArgs(params)));
  }

  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T[] {
    return this.db.prepare(sql).all(...bindArgs(params)) as T[];
  }

  get<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): T | undefined {
    return this.db.prepare(sql).get(...bindArgs(params)) as T | undefined;
  }

  pragma(name: string): number {
    const value = this.db.pragma(name, { simple: true });
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* best-effort */ }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

type DriverPreference = "auto" | "node:sqlite" | "better-sqlite3";

function tryNodeSqlite(filePath: string): SqlDriver | null {
  try {
    // `node:sqlite` is experimental and absent before Node 22.5 — load it lazily so
    // hosts without it fall through to the next binding instead of crashing.
    const mod = nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => NodeSqliteDatabase };
    if (!mod?.DatabaseSync) return null;
    return new NodeSqliteDriver(new mod.DatabaseSync(filePath));
  } catch {
    return null;
  }
}

function tryBetterSqlite(filePath: string): SqlDriver | null {
  try {
    const Database = nodeRequire("better-sqlite3") as new (path: string) => BetterSqliteDatabase;
    return new BetterSqliteDriver(new Database(filePath));
  } catch {
    return null;
  }
}

/**
 * Open a SQLite database file (or `:memory:`) and return a driver.
 * Throws {@link SqlDriverUnavailableError} when no binding is loadable so callers
 * can degrade the Data surface without crashing the rest of the extension.
 */
export function openSqlDriver(filePath: string, preference: DriverPreference = "auto"): SqlDriver {
  const order: Array<() => SqlDriver | null> =
    preference === "node:sqlite"      ? [() => tryNodeSqlite(filePath)]
    : preference === "better-sqlite3" ? [() => tryBetterSqlite(filePath)]
    : [() => tryNodeSqlite(filePath), () => tryBetterSqlite(filePath)];

  for (const attempt of order) {
    const driver = attempt();
    if (driver) return driver;
  }
  throw new SqlDriverUnavailableError(
    "No SQLite binding available. Expected Node >= 22.5 (node:sqlite) or an installed better-sqlite3.",
  );
}

/** Probe whether any SQLite binding is loadable, without opening a file. */
export function isSqliteAvailable(): boolean {
  try {
    const driver = openSqlDriver(":memory:");
    driver.close();
    return true;
  } catch {
    return false;
  }
}
