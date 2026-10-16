/**
 * What a shell command changed, cheaply: `git status` before and after it, compared.
 *
 * Each entry is a changed file with a signature built from git's status letters and the file's
 * size and modification time, so a file that was already modified and is modified again still
 * shows up as changed. Files git ignores are invisible here, and that is stated on the receipt.
 *
 * Bounded: a status that takes longer than {@link STATUS_BUDGET_MS} (a very large tree) is
 * abandoned and the receipt says shell writes were not covered, rather than slowing every
 * command a lane runs.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { WorkingTreeState } from "./session-claims.js";

export const STATUS_BUDGET_MS = 2_000;

/** Parse `git status --porcelain=v1 -z` into repository-relative path → status letters. */
export function parsePorcelainZ(output: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    out.set(entry.slice(3), status);
    // A rename or copy is followed by its original path as a separate field.
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return out;
}

function run(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["-c", "core.longpaths=true", "-c", "core.quotepath=false", ...args], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : stdout);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * A reader of the workspace's changed files, keyed workspace-relative with forward slashes.
 * Returns undefined when the workspace is not in a git repository or git is too slow.
 */
export function gitWorkingTree(workspaceRoot: string, budgetMs = STATUS_BUDGET_MS): () => Promise<WorkingTreeState | undefined> {
  let top: string | null | undefined;
  return async () => {
    if (top === undefined) {
      const found = await run(workspaceRoot, ["rev-parse", "--show-toplevel"], budgetMs);
      top = found ? found.trim() : null;
    }
    if (!top) return undefined;
    const output = await run(workspaceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], budgetMs);
    if (output === undefined) return undefined;
    const state: WorkingTreeState = new Map();
    for (const [repoPath, status] of parsePorcelainZ(output)) {
      const absolute = path.join(top, repoPath);
      const relative = path.relative(workspaceRoot, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      let stamp = "gone";
      try {
        const stat = fs.statSync(absolute);
        stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      } catch { /* deleted */ }
      state.set(relative.replace(/\\/g, "/"), `${status}|${stamp}`);
    }
    return state;
  };
}
