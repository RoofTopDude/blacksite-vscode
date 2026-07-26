import { spawn, type ChildProcess } from "child_process";
import type { ProcessOutputEntry, ProcessOutputPage, ProcessSummary } from "./types.js";
import { resolveWorkspaceCwd } from "./path-policy.js";
import { validateArgs, planSpawn, type CommandPolicy } from "./security.js";

const OUTPUT_MAX_ENTRIES = 400;
const OUTPUT_MAX_CHARS = 200_000;
const FINISHED_LIMIT = 24;

interface ProcessRecord {
  handleId: string;
  command: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  allowStdin: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  exitCode: number | null;
  startedAt: string;
  startedAtMs: number;
  finishedAt: string | null;
  finishedAtMs: number | null;
  cancelRequested: boolean;
  nextCursor: number;
  outputEntries: ProcessOutputEntry[];
  outputTruncated: boolean;
  child: ChildProcess;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function totalChars(entries: ProcessOutputEntry[]): number {
  return entries.reduce((sum, e) => sum + e.text.length, 0);
}

export class ProcessManager {
  private processes = new Map<string, ProcessRecord>();
  constructor(private readonly workspaceRoot: string, private policy: CommandPolicy = {}) {}

  setPolicy(policy: CommandPolicy): void {
    this.policy = policy;
  }

  buildEnv(): NodeJS.ProcessEnv {
    const source = process.env;
    const keys = process.platform === "win32"
      ? ["APPDATA", "ComSpec", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT",
         "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PYTHONIOENCODING",
         "SystemRoot", "TEMP", "TMP", "USERPROFILE"]
      : ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
    const env: NodeJS.ProcessEnv = {};
    for (const key of keys) {
      if (typeof source[key] === "string") env[key] = source[key];
    }
    env.PYTHONIOENCODING = "utf-8";
    return env;
  }

  resolveCwd(requested?: string): { ok: true; cwd: string } | { ok: false; error: string } {
    try {
      const cwd = resolveWorkspaceCwd(this.workspaceRoot, requested);
      return { ok: true, cwd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  launch(options: { command: string; args: string[]; cwd: string; allowStdin?: boolean }): ProcessRecord {
    const { command, args, cwd, allowStdin = false } = options;
    validateArgs(command, args, { workspaceRoot: this.workspaceRoot, cwd, policy: this.policy });
    const plan = planSpawn(command, args);
    const child = spawn(plan.command, plan.args, {
      cwd, env: this.buildEnv(), shell: plan.shell,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });

    const record: ProcessRecord = {
      handleId: randomId("proc"), command, args, cwd,
      displayCommand: [command, ...args].join(" "),
      allowStdin, status: "running", exitCode: null,
      startedAt: nowIso(), startedAtMs: Date.now(),
      finishedAt: null, finishedAtMs: null, cancelRequested: false,
      nextCursor: 0, outputEntries: [], outputTruncated: false, child,
    };
    this.processes.set(record.handleId, record);

    const append = (stream: "stdout" | "stderr", text: string) => {
      record.outputEntries.push({ cursor: record.nextCursor++, stream, text, timestamp: nowIso() });
      while (record.outputEntries.length > OUTPUT_MAX_ENTRIES || totalChars(record.outputEntries) > OUTPUT_MAX_CHARS) {
        record.outputEntries.shift();
        record.outputTruncated = true;
      }
    };

    const finish = (code: number | null) => {
      if (record.status !== "running") return;
      record.exitCode = code;
      record.status = record.cancelRequested ? "cancelled" : code === 0 ? "completed" : "failed";
      record.finishedAt = nowIso();
      record.finishedAtMs = Date.now();
      this.pruneFinished();
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk.toString("utf8")));
    child.on("error", (err: Error) => { append("stderr", err.message); finish(null); });
    child.on("exit", (code: number | null) => finish(code));

    return record;
  }

  get(handleId: string): ProcessRecord | null {
    return this.processes.get(handleId) ?? null;
  }

  kill(handleId: string): boolean {
    const record = this.get(handleId);
    if (!record || record.status !== "running") return false;
    record.cancelRequested = true;
    try { record.child.kill(); } catch { return false; }
    setTimeout(() => {
      if (record.status !== "running") return;
      try { record.child.kill("SIGKILL"); } catch { /* best effort */ }
    }, 1500);
    return true;
  }

  sendInput(handleId: string, input: string): { ok: boolean; error?: string } {
    const record = this.get(handleId);
    if (!record) return { ok: false, error: `Unknown process: ${handleId}` };
    if (record.status !== "running") return { ok: false, error: "Process is not running." };
    if (!record.allowStdin) return { ok: false, error: "Process does not accept stdin." };
    try {
      record.child.stdin?.write(input);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  readOutput(handleId: string, cursor?: number, limit?: number): ProcessOutputPage | null {
    const record = this.get(handleId);
    if (!record) return null;
    const safeLimit = Math.min(Math.max(Number(limit ?? 40), 1), 200);
    const requestedCursor = Math.max(0, Number(cursor ?? 0));
    const availableFrom = record.outputEntries[0]?.cursor ?? record.nextCursor;
    const sliceStart = Math.max(0, requestedCursor - availableFrom);
    const entries = record.outputEntries.slice(sliceStart, sliceStart + safeLimit);
    const nextCursor = entries.length
      ? (entries[entries.length - 1]!.cursor + 1)
      : Math.max(requestedCursor, availableFrom);
    return {
      availableFrom, entries, nextCursor,
      truncated: record.outputTruncated && requestedCursor < availableFrom,
    };
  }

  serialize(handleId: string): ProcessSummary | null {
    const record = this.get(handleId);
    if (!record) return null;
    return {
      handleId: record.handleId, command: record.command,
      args: [...record.args], cwd: record.cwd,
      displayCommand: record.displayCommand, status: record.status,
      exitCode: record.exitCode, startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? undefined,
      allowStdin: record.allowStdin, cancelled: record.cancelRequested,
    };
  }

  private pruneFinished(): void {
    const finished = Array.from(this.processes.values())
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
    for (const r of finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT))) {
      this.processes.delete(r.handleId);
    }
  }
}
