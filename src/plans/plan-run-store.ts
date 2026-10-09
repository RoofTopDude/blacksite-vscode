/**
 * Durable storage for plan runs: `.blacksite/plan-runs/<runId>/run.json` plus an append-only
 * `events.jsonl`.
 *
 * `run.json` is the ledger as it stands and is rewritten (atomically) at every boundary — a turn
 * start or end, a step transition, a status change — never per streamed token. `events.jsonl` is
 * the narrative: one line per event, so a run can be replayed or inspected without trusting the
 * summary. The folder is gitignored; a run is local bookkeeping, not part of the project.
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteJson, ensureDir, readJsonDocument } from "../shared/durable-file.js";
import { PLAN_RUN_SCHEMA_VERSION, isTerminalRunStatus, type PlanRun, type PlanRunEvent } from "./plan-run-model.js";

export const PLAN_RUNS_DIR = ".blacksite/plan-runs";
const RUN_FILE = "run.json";
const EVENTS_FILE = "events.jsonl";
/** Stops a pathological run from growing the event log without bound. */
const MAX_EVENTS_BYTES = 4_000_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Accept a stored run, tolerating fields added or missing since it was written. */
export function normalizePlanRun(value: unknown): PlanRun | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id || typeof value.planId !== "string") return null;
  const num = (input: unknown, fallback = 0): number => (typeof input === "number" && Number.isFinite(input) ? input : fallback);
  const startedAt = num(value.startedAt, Date.now());
  const run: PlanRun = {
    ...(value as unknown as PlanRun),
    schema: PLAN_RUN_SCHEMA_VERSION,
    planTitle: typeof value.planTitle === "string" ? value.planTitle : "Plan",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    charter: isRecord(value.charter) ? value.charter as unknown as PlanRun["charter"] : { providerWaitMinutes: 30, notifications: "attention" },
    status: typeof value.status === "string" ? value.status as PlanRun["status"] : "interrupted",
    startedAt,
    clock: value.clock === "user" || value.clock === "provider" || value.clock === "stopped" ? value.clock : "active",
    clockSince: num(value.clockSince, startedAt),
    activeMs: num(value.activeMs),
    waitingUserMs: num(value.waitingUserMs),
    waitingProviderMs: num(value.waitingProviderMs),
    spentUsd: num(value.spentUsd),
    spendPartial: value.spendPartial === true,
    steps: Array.isArray(value.steps) ? value.steps as PlanRun["steps"] : [],
    turns: Array.isArray(value.turns) ? value.turns as PlanRun["turns"] : [],
    conductorDecisions: Array.isArray(value.conductorDecisions) ? value.conductorDecisions as PlanRun["conductorDecisions"] : [],
    retries: num(value.retries),
    compactions: num(value.compactions),
    gatesAnswered: num(value.gatesAnswered),
    turnsWithoutProgress: num(value.turnsWithoutProgress),
  };
  return run;
}

export class PlanRunStore {
  constructor(private readonly _workspaceRoot: string) {}

  rootDir(): string {
    return path.join(this._workspaceRoot, PLAN_RUNS_DIR);
  }

  runDir(runId: string): string {
    // Run ids are generated here; refuse anything that could walk out of the folder.
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid plan run id: ${runId}`);
    return path.join(this.rootDir(), runId);
  }

  private _ensureIgnored(): void {
    const marker = path.join(this.rootDir(), ".gitignore");
    try {
      if (fs.existsSync(marker)) return;
      ensureDir(this.rootDir());
      fs.writeFileSync(marker, "# Local bookkeeping for Blacksite plan runs. Not part of the project.\n*\n");
    } catch { /* best effort: a read-only checkout just shows the files */ }
  }

  save(run: PlanRun): void {
    this._ensureIgnored();
    atomicWriteJson(path.join(this.runDir(run.id), RUN_FILE), run, { backup: false });
  }

  appendEvent(runId: string, event: PlanRunEvent): void {
    try {
      const file = path.join(this.runDir(runId), EVENTS_FILE);
      ensureDir(path.dirname(file));
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* first event */ }
      if (size > MAX_EVENTS_BYTES) return;
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch {
      // The narrative is best effort; the ledger in run.json is what the UI reads.
    }
  }

  readEvents(runId: string, limit = 2000): PlanRunEvent[] {
    try {
      const text = fs.readFileSync(path.join(this.runDir(runId), EVENTS_FILE), "utf8");
      const lines = text.split("\n").filter(Boolean);
      const events: PlanRunEvent[] = [];
      for (const line of lines.slice(-limit)) {
        try { events.push(JSON.parse(line) as PlanRunEvent); } catch { /* a torn last line */ }
      }
      return events;
    } catch {
      return [];
    }
  }

  read(runId: string): PlanRun | null {
    try {
      return normalizePlanRun(readJsonDocument(path.join(this.runDir(runId), RUN_FILE)));
    } catch {
      return null;
    }
  }

  list(): PlanRun[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.rootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    const runs: PlanRun[] = [];
    for (const name of names) {
      const run = this.read(name);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** The most recent run that had not ended when the host last wrote it. */
  latestUnfinished(): PlanRun | null {
    return this.list().find((run) => !isTerminalRunStatus(run.status)) ?? null;
  }

  /** Delete finished runs older than the retention window. Returns how many were removed. */
  prune(retentionDays: number, now = Date.now(), keepIds: readonly string[] = []): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * MS_PER_DAY;
    let removed = 0;
    for (const run of this.list()) {
      if (!isTerminalRunStatus(run.status)) continue;
      if (keepIds.includes(run.id)) continue;
      if ((run.endedAt ?? run.startedAt) >= cutoff) continue;
      try {
        fs.rmSync(this.runDir(run.id), { recursive: true, force: true });
        removed += 1;
      } catch { /* leave it for the next pass */ }
    }
    return removed;
  }
}
