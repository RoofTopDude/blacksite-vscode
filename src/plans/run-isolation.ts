/**
 * Running a plan in an isolated copy: a git worktree on a branch of its own, opened in its own
 * VS Code window.
 *
 * Snapshots make a run in place recoverable. A copy makes it contained: the user's checkout, its
 * branch and its uncommitted work are never touched, the user can keep working while the run goes,
 * and what comes back is a branch to review and merge, or to throw away.
 *
 * The copy opens in a new window rather than being driven from this one because every part of the
 * extension — the runtime, the language servers, diagnostics, the Map — is rooted at the window's
 * folder. A copy opened as its own folder gets all of them, working, for free. The window that
 * created it hands the run over through a small file the new window reads once and deletes.
 *
 * Honest limits, stated in the preflight: the copy starts from the last commit (uncommitted
 * changes stay where they are), has no installed dependencies, and does not check out submodules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { GitRun } from "./step-snapshots.js";

export const RUN_BRANCH_PREFIX = "blacksite/run-";
const HANDOFF_FILE = path.join(".blacksite", "run-handoff.json");
const HANDOFF_MAX_AGE_MS = 30 * 60_000;
const QUICK_MS = 15_000;
const CHECKOUT_MS = 180_000;
/** Long paths on Windows: git refuses past MAX_PATH without this, even where the OS allows it. */
const GIT_CONFIG = ["-c", "core.longpaths=true"];

export interface IsolationProbe {
  available: boolean;
  /** Why a copy cannot be made, in plain words. */
  reason?: string;
  repoRoot?: string;
  /** Where the workspace folder sits inside the repository; empty at the repository root. */
  subpath?: string;
  branch?: string;
  /** Short commit id the copy would start from. */
  head?: string;
  /** Files with uncommitted changes. They stay here; the copy does not have them. */
  dirtyFiles: number;
  /** Other things the user should know before choosing a copy. */
  notes: string[];
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** Can this folder be run in an isolated copy, and what would the copy start from. */
export async function probeIsolation(root: string, git: GitRun): Promise<IsolationProbe> {
  const unavailable = (reason: string): IsolationProbe => ({ available: false, reason, dirtyFiles: 0, notes: [] });
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: root, timeoutMs: QUICK_MS });
  if (top.code === null) return unavailable("Git is not available, so an isolated copy cannot be made.");
  if (top.code !== 0) return unavailable("This folder is not in a git repository, so an isolated copy cannot be made.");
  const repoRoot = path.resolve(top.stdout.trim());
  const head = await git(["rev-parse", "--short", "HEAD"], { cwd: root, timeoutMs: QUICK_MS });
  if (head.code !== 0 || !head.stdout.trim()) return unavailable("The repository has no commits yet, so there is nothing to copy from.");
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: QUICK_MS });
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: root, timeoutMs: QUICK_MS * 2 });
  let dirtyFiles = 0;
  if (status.code === 0) {
    const fields = status.stdout.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index]!;
      if (entry.length < 4) continue;
      dirtyFiles += 1;
      // A rename or copy carries its original path in the next field.
      if (entry[0] === "R" || entry[0] === "C") index += 1;
    }
  }
  const notes: string[] = [];
  if (fs.existsSync(path.join(repoRoot, ".gitmodules"))) notes.push("Submodules are not checked out in the copy.");
  const nested = nestedRepositories(path.resolve(root));
  if (nested.length) {
    notes.push(`${nested.length === NESTED_SCAN_LIMIT ? `${nested.length}+` : nested.length} nested repositor${nested.length === 1 ? "y" : "ies"} (${nested.slice(0, 3).join(", ")}${nested.length > 3 ? ", …" : ""}) ${nested.length === 1 ? "is" : "are"} not part of the copy; only this repository's own files are.`);
  }
  const relative = path.relative(repoRoot, path.resolve(root));
  const subpath = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : "";
  return {
    available: true,
    repoRoot,
    subpath,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    head: head.stdout.trim(),
    dirtyFiles,
    notes,
  };
}

const NESTED_SCAN_LIMIT = 50;
const NESTED_SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "venv", "dist", "out", "build", "target", ".blacksite"]);

/**
 * Repositories nested inside the folder, two levels down at most. A workspace that holds many
 * codebases in one root is normal; the copy only carries the outer repository, and the user
 * should know that before choosing it. Bounded: this runs every time the preflight opens.
 */
function nestedRepositories(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= NESTED_SCAN_LIMIT || depth > 2) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= NESTED_SCAN_LIMIT) return;
      if (!entry.isDirectory() || NESTED_SCAN_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (fs.existsSync(path.join(child, ".git"))) {
        found.push(path.relative(root, child).replace(/\\/g, "/"));
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 1);
  return found;
}

function slug(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "plan";
}

export function runBranchName(planTitle: string, suffix: string): string {
  return `${RUN_BRANCH_PREFIX}${slug(planTitle, 28)}-${suffix}`;
}

/** Short and outside every workspace, so the original window's search and indexers never see it. */
export function copyLocation(home: string, repoRoot: string, suffix: string): string {
  return path.join(home, ".blacksite", "worktrees", `${slug(path.basename(repoRoot), 32)}-${suffix}`);
}

export interface IsolatedCopy {
  worktreePath: string;
  /** The folder to open: the worktree, or the same subfolder the workspace was. */
  copyRoot: string;
  branch: string;
  head: string;
  baseBranch?: string;
}

export async function createIsolatedCopy(input: {
  probe: IsolationProbe;
  planTitle: string;
  home: string;
  suffix: string;
  git: GitRun;
}): Promise<{ ok: true; copy: IsolatedCopy } | { ok: false; error: string }> {
  const { probe, git } = input;
  if (!probe.available || !probe.repoRoot || !probe.head) return { ok: false, error: probe.reason ?? "An isolated copy cannot be made here." };
  const worktreePath = copyLocation(input.home, probe.repoRoot, input.suffix);
  if (fs.existsSync(worktreePath)) return { ok: false, error: `${worktreePath} already exists.` };
  const branch = runBranchName(input.planTitle, input.suffix);
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (error) {
    return { ok: false, error: `Could not create ${path.dirname(worktreePath)}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const added = await git([...GIT_CONFIG, "worktree", "add", "-b", branch, worktreePath, probe.head], { cwd: probe.repoRoot, timeoutMs: CHECKOUT_MS });
  if (added.timedOut) return { ok: false, error: "Creating the copy took too long. The repository may be very large; run here instead." };
  if (added.code !== 0) return { ok: false, error: firstLine(added.stderr) || "git could not create the copy." };
  const copyRoot = probe.subpath ? path.join(worktreePath, probe.subpath) : worktreePath;
  return {
    ok: true,
    copy: { worktreePath, copyRoot, branch, head: probe.head, baseBranch: probe.branch && probe.branch !== "HEAD" ? probe.branch : undefined },
  };
}

/** Files a run needs that git does not carry: the plan itself, and the agent's project notes. */
const SEED_FILES = [
  path.join(".blacksite", "planning.json"),
  path.join(".blacksite", "base-context.json"),
  path.join(".blacksite", "context.md"),
  path.join(".blacksite", "memory.md"),
  path.join(".blacksite", "ui-preferences.json"),
  path.join(".vscode", "settings.json"),
];
const SEED_DIRS = [path.join(".blacksite", "plans")];

/** Copy what the run needs into the copy, never overwriting what git already put there. */
export function seedIsolatedCopy(sourceRoot: string, copyRoot: string): string[] {
  const copied: string[] = [];
  for (const file of SEED_FILES) {
    const from = path.join(sourceRoot, file);
    const to = path.join(copyRoot, file);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(file);
    } catch { /* a missing note is not a reason to fail the copy */ }
  }
  for (const dir of SEED_DIRS) {
    const from = path.join(sourceRoot, dir);
    const to = path.join(copyRoot, dir);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
      copied.push(dir);
    } catch { /* see above */ }
  }
  return copied;
}

/** What the new window needs to start the run the user already agreed to. */
export interface IsolatedRunHandoff {
  schema: 1;
  planId: string;
  charter: Record<string, unknown>;
  createdAt: number;
  branch: string;
  base: { root: string; branch?: string; head: string };
  worktreePath: string;
}

export function writeRunHandoff(copyRoot: string, handoff: IsolatedRunHandoff): void {
  const file = path.join(copyRoot, HANDOFF_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(handoff, null, 2));
}

/**
 * Read the handoff and delete it, whatever it says. A reload of the new window must not start
 * the run twice, and a stale handoff (the window was opened days later) is not a go-ahead.
 */
export function takeRunHandoff(root: string, now: number): IsolatedRunHandoff | undefined {
  const file = path.join(root, HANDOFF_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try { fs.rmSync(file, { force: true }); } catch { /* read once either way */ }
  try {
    const value = JSON.parse(raw) as Partial<IsolatedRunHandoff>;
    if (value.schema !== 1 || typeof value.planId !== "string" || typeof value.branch !== "string") return undefined;
    if (typeof value.createdAt !== "number" || now - value.createdAt > HANDOFF_MAX_AGE_MS || value.createdAt > now + 60_000) return undefined;
    if (!value.base || typeof value.base.head !== "string" || typeof value.base.root !== "string") return undefined;
    return {
      schema: 1,
      planId: value.planId,
      charter: value.charter && typeof value.charter === "object" ? value.charter : {},
      createdAt: value.createdAt,
      branch: value.branch,
      base: { root: value.base.root, branch: typeof value.base.branch === "string" ? value.base.branch : undefined, head: value.base.head },
      worktreePath: typeof value.worktreePath === "string" ? value.worktreePath : root,
    };
  } catch {
    return undefined;
  }
}

export interface RunCopyEntry {
  path: string;
  branch: string;
  head: string;
}

/** The isolated copies made from this repository: worktrees on a run branch. */
export async function listRunCopies(root: string, git: GitRun): Promise<RunCopyEntry[]> {
  const listed = await git(["worktree", "list", "--porcelain"], { cwd: root, timeoutMs: QUICK_MS });
  if (listed.code !== 0) return [];
  const entries: RunCopyEntry[] = [];
  let current: Partial<RunCopyEntry> = {};
  const flush = (): void => {
    if (current.path && current.branch?.startsWith(RUN_BRANCH_PREFIX)) entries.push({ path: current.path, branch: current.branch, head: current.head ?? "" });
    current = {};
  };
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { flush(); current.path = path.resolve(line.slice("worktree ".length).trim()); }
    else if (line.startsWith("HEAD ")) current.head = line.slice(5).trim().slice(0, 9);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
  }
  flush();
  return entries;
}

/** Uncommitted files in a copy, so removing it never silently throws work away. */
export async function copyDirtyFiles(copyPath: string, git: GitRun): Promise<number | undefined> {
  const status = await git(["status", "--porcelain=v1"], { cwd: copyPath, timeoutMs: QUICK_MS * 2 });
  if (status.code !== 0) return undefined;
  return status.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
}

/** Remove a copy. Its branch is kept: commits on it may be the very thing worth keeping. */
export async function removeRunCopy(root: string, copyPath: string, git: GitRun, force: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const copies = await listRunCopies(root, git);
  const target = path.resolve(copyPath);
  const sameFolder = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!copies.some((copy) => sameFolder(copy.path, target))) return { ok: false, error: "That folder is not an isolated run copy of this repository." };
  const removed = await git([...GIT_CONFIG, "worktree", "remove", ...(force ? ["--force"] : []), target], { cwd: root, timeoutMs: CHECKOUT_MS });
  if (removed.code !== 0) return { ok: false, error: firstLine(removed.stderr) || "git could not remove the copy." };
  return { ok: true };
}
