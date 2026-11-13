/* The pure half of the Codebase Map's git support: parsing `git log` and `git ls-files` output,
   grouping workspace roots by repository, and mapping repository paths back to absolute ones.
   Nothing here runs git. The runners — git-log.ts (history) and git-discovery.ts (file lists,
   ignore checks) — shell out and hand their output to these functions. */

import { normalizeAbsolutePath } from "./workspace-roots.js";

export interface GitFileStat {
  /** Commits in the scanned window that touched this file. */
  churn: number;
  /** Epoch seconds of the most recent commit that touched it. */
  lastAt: number;
}

export interface GitHistory {
  /** Normalized absolute repo toplevel. */
  toplevel: string;
  /** Per-file stats keyed by normalized absolute path. */
  stats: Map<string, GitFileStat>;
  /** Commits as lists of normalized absolute paths (bulk commits dropped). */
  commits: string[][];
}

export interface RepoGroup {
  /** Absolute repo toplevel, forward slashes. */
  toplevel: string;
  /** Absolute workspace-root paths (forward slashes) that live in this repo. */
  roots: string[];
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

/** Split `git ... -z` output into entries (NUL-terminated, final entry may be empty). */
export function parseNulList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Pathspec for `root` relative to its repo toplevel, or "" when the root is
    the toplevel itself. Case-insensitive prefix (Windows drive letters and
    folder casing routinely differ between git and VS Code). */
export function rootPathspec(toplevel: string, rootPath: string): string | null {
  const top = normalizeAbsolutePath(toplevel);
  const root = normalizeAbsolutePath(rootPath);
  if (top.toLowerCase() === root.toLowerCase()) return "";
  if (!root.toLowerCase().startsWith(`${top.toLowerCase()}/`)) return null;
  return root.slice(top.length + 1);
}

/** Group workspace roots by the repository that contains them, so two roots
    inside one monorepo cost one `git` process rather than two. Roots whose
    toplevel could not be determined are returned separately for the
    enumerator fallback. */
export function groupRootsByRepo(
  roots: readonly string[],
  toplevels: ReadonlyMap<string, string | null>,
): { groups: RepoGroup[]; ungrouped: string[] } {
  const byTop = new Map<string, RepoGroup>();
  const ungrouped: string[] = [];
  for (const root of roots) {
    const top = toplevels.get(root);
    if (!top) {
      ungrouped.push(root);
      continue;
    }
    const key = normalizeAbsolutePath(top).toLowerCase();
    const group = byTop.get(key) ?? { toplevel: normalizeAbsolutePath(top), roots: [] };
    group.roots.push(root);
    byTop.set(key, group);
  }
  return { groups: [...byTop.values()], ungrouped };
}

/** Absolute paths for `ls-files` entries (repo-relative, forward slashes). */
export function absoluteFromRepo(toplevel: string, entries: readonly string[]): string[] {
  const top = normalizeAbsolutePath(toplevel);
  return entries.map((entry) => `${top}/${entry}`);
}
