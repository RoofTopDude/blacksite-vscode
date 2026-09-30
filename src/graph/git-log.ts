/* Git history signal for the Codebase Map: per-file churn (how many recent
   commits touched it) and recency (epoch seconds of its most recent commit).
   The parser is pure and unit-tested; collectGitStats() shells out to git and
   degrades to an empty map on any failure (no repo, git absent, timeout, huge
   output) so the map never depends on git being present. */

import { execFile } from "child_process";
import * as path from "path";

export interface GitFileStat {
  /** Commits in the scanned window that touched this file. */
  churn: number;
  /** Epoch seconds of the most recent commit that touched it. */
  lastAt: number;
}

/** Commit marker line emitted by our `--format`; `:%ct` is the author epoch.
    A real file path can't match this (no repo-relative path is "commit:<int>"
    — `:` is illegal in Windows paths and git prints POSIX-relative names). */
const COMMIT_LINE = /^commit:(\d+)$/;

/** Parse `git log --format=commit:%ct --name-only` output into per-file stats.
    Tolerant of the blank lines git interleaves between the format line and the
    file list; a file line before any commit marker is ignored. */
export function parseGitLog(stdout: string): Map<string, GitFileStat> {
  const out = new Map<string, GitFileStat>();
  let currentAt = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const marker = COMMIT_LINE.exec(line);
    if (marker) {
      currentAt = Number(marker[1]);
      continue;
    }
    if (currentAt === 0) continue; /* file path before the first commit marker */
    const existing = out.get(line);
    if (existing) {
      existing.churn += 1;
      if (currentAt > existing.lastAt) existing.lastAt = currentAt;
    } else {
      out.set(line, { churn: 1, lastAt: currentAt });
    }
  }
  return out;
}

/** Per-commit file lists from the same `git log` output, newest first (as git
    prints them). Commits touching more than `maxFilesPerCommit` files are
    skipped: formatting sweeps, renames, and vendoring say nothing about which
    files belong together. Single-file commits carry no pair either. Used by
    co-change analysis (graph/cochange.ts). */
export function parseGitCommits(stdout: string, maxFilesPerCommit = 40): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current && current.length > 1 && current.length <= maxFilesPerCommit) commits.push(current);
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    if (COMMIT_LINE.test(line)) {
      flush();
      current = [];
      continue;
    }
    if (current && !current.includes(line)) current.push(line);
  }
  flush();
  return commits;
}

/** Windows path comparison is case-insensitive and git may hand back a
    different-cased drive letter than vscode; normalize both sides identically
    before matching git paths to map node absolute paths. */
export function normalizeAbsPath(p: string): string {
  const forward = p.replace(/\\/g, "/");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

const LOG_ARGS = (maxCommits: number): string[] => [
  "-c", "core.quotePath=false",
  "log",
  "-n", String(maxCommits),
  "--no-renames",
  "--no-merges",
  "--format=commit:%ct",
  "--name-only",
];

export interface GitHistory {
  /** Normalized absolute repo toplevel. */
  toplevel: string;
  /** Per-file stats keyed by normalized absolute path. */
  stats: Map<string, GitFileStat>;
  /** Commits as lists of normalized absolute paths (bulk commits dropped). */
  commits: string[][];
}

/** One `git log` for a whole repository: churn/recency per file plus the
    per-commit file sets co-change needs. Callers group workspace roots by
    toplevel first (graph/git-discovery.ts) so N roots in one monorepo cost one
    process, not N. Null when the root is not in a repo or git fails. */
export async function collectGitHistory(
  rootPath: string,
  maxCommits = 4000,
  timeoutMs = 8000,
): Promise<GitHistory | null> {
  const toplevelRaw = await runGit(rootPath, ["rev-parse", "--show-toplevel"], timeoutMs);
  const toplevel = toplevelRaw?.split("\n")[0]?.trim();
  if (!toplevel) return null;
  const stdout = await runGit(toplevel, LOG_ARGS(maxCommits), timeoutMs);
  if (stdout == null) return null;
  const toAbs = (repoRel: string): string => normalizeAbsPath(path.resolve(toplevel, repoRel));
  const stats = new Map<string, GitFileStat>();
  for (const [repoRel, stat] of parseGitLog(stdout)) stats.set(toAbs(repoRel), stat);
  const commits = parseGitCommits(stdout).map((files) => files.map(toAbs));
  return { toplevel: normalizeAbsPath(toplevel), stats, commits };
}

/** Churn + recency per file for one workspace root, keyed by normalized
    absolute path (so a root nested inside a larger repo still matches). Returns
    an empty map when the root isn't in a git repo or git isn't available. */
export async function collectGitStats(
  rootPath: string,
  maxCommits = 4000,
  timeoutMs = 8000,
): Promise<Map<string, GitFileStat>> {
  const toplevelRaw = await runGit(rootPath, ["rev-parse", "--show-toplevel"], timeoutMs);
  const toplevel = toplevelRaw?.split("\n")[0]?.trim();
  if (!toplevel) return new Map();
  const stdout = await runGit(rootPath, LOG_ARGS(maxCommits), timeoutMs);
  if (stdout == null) return new Map();
  const out = new Map<string, GitFileStat>();
  for (const [repoRel, stat] of parseGitLog(stdout)) {
    out.set(normalizeAbsPath(path.resolve(toplevel, repoRel)), stat);
  }
  return out;
}
