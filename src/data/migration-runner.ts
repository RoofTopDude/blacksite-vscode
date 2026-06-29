// Versioned migration runner.
//
// Migrations are an ordered list keyed by integer `version`. The applied version is
// tracked with SQLite's `PRAGMA user_version`, so there is no bootstrap table to
// migrate and the scheme works identically on a brand-new and an existing database.
// Each pending migration runs inside its own transaction; a failure rolls that
// migration back and aborts the run, leaving `user_version` at the last good value.

import type { SqlDriver } from "./sql-driver.js";

export interface Migration {
  version: number;
  name: string;
  /** DDL/DML applied for this version. May contain multiple statements. */
  sql: string;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: Array<{ version: number; name: string }>;
}

/** Sort migrations by version and assert versions are unique and positive. */
export function normalizeMigrations(migrations: Migration[]): Migration[] {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Migration "${migration.name}" has an invalid version: ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return [...migrations].sort((a, b) => a.version - b.version);
}

export function getSchemaVersion(driver: SqlDriver): number {
  return driver.pragma("user_version");
}

/**
 * Apply every migration whose version is greater than the database's current
 * `user_version`, in ascending order. Returns what changed. Idempotent: running it
 * again with no new migrations is a no-op.
 */
export function runMigrations(driver: SqlDriver, migrations: Migration[]): MigrationResult {
  const ordered = normalizeMigrations(migrations);
  const fromVersion = getSchemaVersion(driver);
  const applied: Array<{ version: number; name: string }> = [];

  let currentVersion = fromVersion;
  for (const migration of ordered) {
    if (migration.version <= currentVersion) continue;
    driver.transaction(() => {
      driver.exec(migration.sql);
      // PRAGMA user_version does not accept bound params — interpolate the integer
      // we already validated as a safe positive integer above.
      driver.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push({ version: migration.version, name: migration.name });
    currentVersion = migration.version;
  }

  return { fromVersion, toVersion: currentVersion, applied };
}
