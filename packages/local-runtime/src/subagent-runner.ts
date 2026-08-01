import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

export interface WorktreeInfo {
  id: string;
  worktreePath: string;
  branch: string;
  createdAt: string;
}

const WORKTREE_DIR = ".blacksite/worktrees";

// ── Create ─────────────────────────────────────────────────────────────────────

export function createWorktree(repoRoot: string, taskId: string): WorktreeInfo | { ok: false; error: string } {
  const safe = taskId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "task";
  const branch = `blacksite/subagent-${safe}-${Date.now().toString(36)}`;
  const worktreePath = path.join(repoRoot, WORKTREE_DIR, safe);

  // Ensure parent dir
  fs.mkdirSync(path.join(repoRoot, WORKTREE_DIR), { recursive: true });

  // Create the worktree on a new branch based on HEAD
  const res = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    cwd: repoRoot, encoding: "utf8", timeout: 30_000,
  });

  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree add failed").trim() };
  }

  return { id: safe, worktreePath, branch, createdAt: new Date().toISOString() };
}

// ── Remove ─────────────────────────────────────────────────────────────────────

export function resolveManagedWorktreePath(repoRoot: string, worktreePath: string): string {
  const managedRoot = path.resolve(repoRoot, WORKTREE_DIR);
  const candidate = path.resolve(repoRoot, worktreePath);
  const relative = path.relative(managedRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a worktree outside ${managedRoot}.`);
  }
  return candidate;
}

export function removeWorktree(repoRoot: string, worktreePath: string): { ok: boolean; error?: string } {
  let managedPath: string;
  try { managedPath = resolveManagedWorktreePath(repoRoot, worktreePath); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

  const listed = listWorktrees(repoRoot);
  const registered = Array.isArray(listed)
    ? listed.find((entry) => path.resolve(entry.worktreePath) === managedPath)
    : undefined;
  if (!registered) return { ok: false, error: "The requested path is not a registered Blacksite worktree." };

  const res = spawnSync("git", ["worktree", "remove", "--force", managedPath], {
    cwd: repoRoot, encoding: "utf8", timeout: 30_000,
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree remove failed").trim() };
  }
  // Also try to clean up the branch that was created for this worktree
  if (registered.branch.startsWith("blacksite/subagent-")) {
    spawnSync("git", ["branch", "-D", registered.branch], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
  }
  return { ok: true };
}

// ── List ───────────────────────────────────────────────────────────────────────

export interface WorktreeListEntry {
  worktreePath: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export function listWorktrees(repoRoot: string): WorktreeListEntry[] | { ok: false; error: string } {
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot, encoding: "utf8", timeout: 10_000,
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree list failed").trim() };
  }

  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> = {};
  let isFirst = true;

  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.worktreePath) entries.push(current as WorktreeListEntry);
      current = { worktreePath: line.slice(9).trim(), branch: "", head: "", isMain: isFirst };
      isFirst = false;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice(18).trim();
    } else if (line.trim() === "detached") {
      current.branch = "(detached)";
    }
  }
  if (current.worktreePath) entries.push(current as WorktreeListEntry);

  return entries;
}

// ── Runtime handler ────────────────────────────────────────────────────────────

export function handleWorktreeOp(
  repoRoot: string,
  payload: Record<string, unknown>,
): WorktreeInfo | WorktreeListEntry[] | { ok: boolean; error?: string; requiresConfirmation?: true; tier?: "destructive"; description?: string } {
  const op = String(payload["op"] ?? "");
  switch (op) {
    case "create": {
      const taskId = String(payload["taskId"] ?? `task_${Date.now()}`);
      return createWorktree(repoRoot, taskId);
    }
    case "remove": {
      const worktreePath = String(payload["path"] ?? "");
      if (!worktreePath) return { ok: false, error: "Missing path." };
      let managedPath: string;
      try { managedPath = resolveManagedWorktreePath(repoRoot, worktreePath); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      if (payload["confirmed"] !== true) {
        return {
          ok: true,
          requiresConfirmation: true,
          tier: "destructive",
          description: `Force-remove Blacksite worktree: ${managedPath}`,
        };
      }
      return removeWorktree(repoRoot, managedPath);
    }
    case "list":
      return listWorktrees(repoRoot);
    default:
      return { ok: false, error: `Unknown worktree op: ${op}` };
  }
}
