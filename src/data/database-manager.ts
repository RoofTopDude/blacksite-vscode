// One extension-host-owned database manager.
//
// Concurrency model (see plan "Concurrency Model"): a single manager owns the open
// connection, reads run freely, and every write goes through one serialized broker
// so multiple agents/flows can never open uncontrolled write paths into the embedded
// database. This module is `vscode`-free and is exercised by the migration tests
// against a real on-disk (or `:memory:`) SQLite database.

import { openSqlDriver, SqlDriverUnavailableError } from "./sql-driver.js";
import type { SqlDriver } from "./sql-driver.js";
import { runMigrations } from "./migration-runner.js";
import type { Migration, MigrationResult } from "./migration-runner.js";
import { V1_SCHEMA } from "./schema/v1.js";
import { V2_SCHEMA } from "./schema/v2.js";

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "v1-core-schema", sql: V1_SCHEMA },
  { version: 2, name: "v2-conversation-log", sql: V2_SCHEMA },
];

export interface DatabaseManagerOptions {
  /** Override the migration set (tests). Defaults to {@link MIGRATIONS}. */
  migrations?: Migration[];
  /** Driver preference; defaults to auto (node:sqlite, then better-sqlite3). */
  driver?: SqlDriver;
}

export { SqlDriverUnavailableError };

export class DatabaseManager {
  private _driver: SqlDriver | null = null;
  private _migration: MigrationResult | null = null;
  private readonly _migrations: Migration[];
  private readonly _injectedDriver?: SqlDriver;
  // Serialized write broker: the tail of a promise chain. Each write awaits the
  // previous one, guaranteeing one writer at a time regardless of caller count.
  private _writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, options: DatabaseManagerOptions = {}) {
    this._migrations = options.migrations ?? MIGRATIONS;
    this._injectedDriver = options.driver;
  }

  /**
   * Open the database, apply durability pragmas, and run migrations. Throws
   * {@link SqlDriverUnavailableError} when no SQLite binding is present so the
   * caller can disable the Data surface while keeping the rest of the extension up.
   */
  open(): MigrationResult {
    if (this._driver) return this._migration!;
    const driver = this._injectedDriver ?? openSqlDriver(this.filePath);
    // Durability + concurrency tuning. WAL allows concurrent readers with a single
    // writer; NORMAL sync is the standard WAL pairing; a busy timeout avoids spurious
    // "database is locked" under the serialized broker; foreign keys enforce cascades.
    driver.exec(
      `PRAGMA journal_mode = WAL;
       PRAGMA synchronous = NORMAL;
       PRAGMA foreign_keys = ON;
       PRAGMA busy_timeout = 5000;`,
    );
    this._migration = runMigrations(driver, this._migrations);
    this._driver = driver;
    return this._migration;
  }

  get isOpen(): boolean {
    return this._driver !== null;
  }

  get engine(): string | null {
    return this._driver?.engine ?? null;
  }

  get migrationResult(): MigrationResult | null {
    return this._migration;
  }

  /** The open driver. Throws if {@link open} has not been called. */
  get driver(): SqlDriver {
    if (!this._driver) throw new Error("DatabaseManager is not open. Call open() first.");
    return this._driver;
  }

  /** Read helpers — safe to call concurrently. */
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Parameters<SqlDriver["all"]>[1]): T[] {
    return this.driver.all(sql, params) as T[];
  }

  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Parameters<SqlDriver["get"]>[1]): T | undefined {
    return this.driver.get(sql, params) as T | undefined;
  }

  /**
   * Run a write through the single serialized broker. `fn` receives the driver and
   * may issue multiple statements / a transaction; it is guaranteed exclusive write
   * ordering relative to every other enqueued write.
   */
  enqueueWrite<T>(fn: (driver: SqlDriver) => T): Promise<T> {
    const run = this._writeChain.then(() => fn(this.driver));
    // Keep the chain alive even if this write rejects, so later writes still run.
    this._writeChain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    if (!this._driver) return;
    try {
      // Checkpoint the WAL into the main db file on a clean shutdown.
      this._driver.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch { /* best-effort */ }
    try { this._driver.close(); } catch { /* best-effort */ }
    this._driver = null;
  }
}
