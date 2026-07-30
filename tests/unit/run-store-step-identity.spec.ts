import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSqliteAvailable,
  openSqlDriver,
} from "../../src/data/sql-driver";
import type {
  ExecutionRun,
  RunStep,
} from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";

function run(id: string): ExecutionRun {
  return {
    id,
    title: `Run ${id}`,
    sequenceId: `sequence-${id}`,
    sequenceVersion: 1,
    status: "created",
    target: { adapterId: "workspace", type: "workspace", workspacePath: "." },
    adapterIds: ["workspace"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: ["read-config"],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

function step(runId: string): RunStep {
  return {
    id: "read-config",
    runId,
    ordinal: 0,
    declaredAction: {
      adapterId: "workspace",
      type: "read_file",
      input: { path: "config.json" },
    },
    targetEntityRefs: [{
      scheme: "workspace-file",
      id: "config.json",
      workspacePath: "config.json",
    }],
    status: "pending",
    assertionResults: [],
    sideEffects: [],
  };
}

describe.skipIf(!isSqliteAvailable())("RunStore SQLite semantic step identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates the v1 key and retains identical step IDs across runs and reload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-step-key-"));
    roots.push(root);
    const runsRoot = path.join(root, ".blacksite", "runs");
    fs.mkdirSync(runsRoot, { recursive: true });
    const indexPath = path.join(runsRoot, "index.sqlite");
    const legacyRun = run("run-legacy");
    const legacyStep = step(legacyRun.id);
    const createdAt = "2026-07-30T00:00:00.000Z";

    const legacy = openSqlDriver(indexPath);
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        retention_class TEXT NOT NULL,
        plan_id TEXT,
        phase_id TEXT,
        parent_run_id TEXT,
        started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_sequence INTEGER NOT NULL,
        last_monotonic_ns TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX run_steps_run_idx ON run_steps(run_id, ordinal);
      PRAGMA user_version = 1;
    `);
    legacy.run(
      `INSERT INTO runs (
        id, status, retention_class, plan_id, phase_id, parent_run_id,
        started_at, created_at, updated_at, next_sequence, last_monotonic_ns,
        event_count, warning_count, error_count, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        legacyRun.id,
        legacyRun.status,
        legacyRun.retentionClass,
        null,
        null,
        null,
        null,
        createdAt,
        createdAt,
        1,
        "0",
        0,
        0,
        0,
        JSON.stringify(legacyRun),
      ],
    );
    legacy.run(
      `INSERT INTO run_steps (id, run_id, ordinal, status, data_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        legacyStep.id,
        legacyStep.runId,
        legacyStep.ordinal,
        legacyStep.status,
        JSON.stringify(legacyStep),
      ],
    );
    legacy.close();

    let store = new RunStore(root).open();
    expect(store.metadataEngine).toBe("sqlite");
    expect(store.getSteps(legacyRun.id)).toMatchObject([{
      id: "read-config",
      runId: "run-legacy",
    }]);

    const secondRun = run("run-current");
    store.createRun(secondRun);
    store.putSteps(secondRun.id, [step(secondRun.id)]);
    store.dispose();

    store = new RunStore(root).open();
    try {
      expect(store.getSteps("run-legacy")).toMatchObject([{
        id: "read-config",
        runId: "run-legacy",
      }]);
      expect(store.getSteps("run-current")).toMatchObject([{
        id: "read-config",
        runId: "run-current",
      }]);
    } finally {
      store.dispose();
    }

    const migrated = openSqlDriver(indexPath);
    try {
      const primaryKey = migrated
        .all("PRAGMA table_info(run_steps)")
        .filter((row) => Number(row["pk"] ?? 0) > 0)
        .sort((left, right) => Number(left["pk"] ?? 0) - Number(right["pk"] ?? 0))
        .map((row) => String(row["name"] ?? ""));
      expect(primaryKey).toEqual(["run_id", "id"]);
      expect(migrated.pragma("user_version")).toBe(2);
      expect(migrated.all("SELECT run_id, id FROM run_steps ORDER BY run_id"))
        .toMatchObject([
          { run_id: "run-current", id: "read-config" },
          { run_id: "run-legacy", id: "read-config" },
        ]);
    } finally {
      migrated.close();
    }
  });
});
