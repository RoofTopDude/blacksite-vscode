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
  const stdout = await runGit(
    rootPath,
    [
      "-c", "core.quotePath=false",
      "log",
      "-n", String(maxCommits),
      "--no-renames",
      "--no-merges",
      "--format=commit:%ct",
      "--name-only",
    ],
    timeoutMs,
  );
  if (stdout == null) return new Map();
  const out = new Map<string, GitFileStat>();
  for (const [repoRel, stat] of parseGitLog(stdout)) {
    out.set(normalizeAbsPath(path.resolve(toplevel, repoRel)), stat);
  }
  return out;
}
