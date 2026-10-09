/**
 * Restore points for a plan run: the working tree of each project, captured after every step.
 *
 * The edit journal only knows about edits the agent made through its own tools, and keeps the last
 * few hundred. A shell command that generates files, a formatter that rewrites a directory, a
 * codegen step — none of that is in it, and none of it can be undone from it. This captures the
 * files themselves.
 *
 * It does that with git, but never the user's git. Each project gets a private bare repository in
 * the extension's storage folder, used with `--git-dir` and `--work-tree`. The user's own index,
 * refs, stash and hooks are never read or written: a snapshot is `add -A` and `write-tree` against
 * the private repository, and a restore is `read-tree` and `checkout-index` from it. Their
 * `.gitignore` files still apply (the work tree is theirs), so ignored build output is not
 * captured, and a small fixed list of folders that are never worth keeping is excluded as well.
 *
 * Honest about limits: a repository nested inside a project is recorded as a single entry, not
 * its files, and the capture says so; a project too large to capture inside the time box is
 * skipped with the reason. The edit journal remains the fallback either way.
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type GitRun = (args: string[], options: { cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<GitResult>;

export interface SnapshotCapture {
  /** Tree id per project root. */
  projects: Record<string, string>;
  /** Why some or all of the capture was skipped. Shown to the user, never hidden. */
  skipped?: string;
}

export interface RestorePlan {
  root: string;
  tree: string;
  /** Files to write back (changed, or deleted since). */
  restore: string[];
  /** Files created since, to remove. */
  remove: string[];
  /** The state just before the restore, so it can be undone. */
  safetyTree: string;
}

export interface StepSnapshotterOptions {
  /** Folder for the private repositories. */
  storageDir: string;
  run?: GitRun;
  /** Time box for adding a whole project the first time. */
  captureTimeoutMs?: number;
  /** Time box for everything else. */
  quickTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const NEVER_WORTH_KEEPING = [".git/", ".blacksite/", "node_modules/", "__pycache__/", ".venv/", "venv/", ".DS_Store", "Thumbs.db"];

const BASE_CONFIG = [
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.longpaths=true",
  "core.quotepath=false",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "gc.auto=0",
  "advice.addEmbeddedRepo=false",
];

export function defaultGitRun(env: NodeJS.ProcessEnv): GitRun {
  return (args, options) => new Promise<GitResult>((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd: options.cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const abort = (): void => { child.kill(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.on("error", () => { /* git exited before reading its input */ });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function projectKey(root: string): string {
  const normal = path.resolve(root);
  const key = process.platform === "win32" ? normal.toLowerCase() : normal;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  const parts = output.split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const file = parts[i + 1]!;
    if (status && file) entries.push({ status: status[0]!, path: file });
  }
  return entries;
}

export class StepSnapshotter {
  private readonly _run: GitRun;
  private readonly _captureTimeout: number;
  private readonly _quickTimeout: number;

  constructor(private readonly _options: StepSnapshotterOptions, env: NodeJS.ProcessEnv = {}) {
    this._run = _options.run ?? defaultGitRun(_options.env ?? env);
    this._captureTimeout = _options.captureTimeoutMs ?? 120_000;
    this._quickTimeout = _options.quickTimeoutMs ?? 30_000;
  }

  gitDir(root: string): string {
    return path.join(this._options.storageDir, "snapshots", `${projectKey(root)}.git`);
  }

  private _args(root: string, rest: string[]): string[] {
    return ["--git-dir", this.gitDir(root), "--work-tree", root, ...BASE_CONFIG.flatMap((entry) => ["-c", entry]), ...rest];
  }

  private async _ensureRepo(root: string, signal?: AbortSignal): Promise<string | undefined> {
    const dir = this.gitDir(root);
    if (fs.existsSync(path.join(dir, "HEAD"))) return undefined;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const result = await this._run(["init", "--bare", "-q", dir], { cwd: path.dirname(dir), timeoutMs: this._quickTimeout, signal });
    if (result.code !== 0) return result.stderr.trim() || "git could not create the snapshot store";
    try {
      fs.mkdirSync(path.join(dir, "info"), { recursive: true });
      fs.writeFileSync(path.join(dir, "info", "exclude"), `${NEVER_WORTH_KEEPING.join("\n")}\n`);
    } catch { /* the project's own .gitignore still applies */ }
    return undefined;
  }

  /** Capture the working tree of each root. A root that cannot be captured is skipped with a reason. */
  async capture(roots: readonly string[], signal?: AbortSignal): Promise<SnapshotCapture> {
    const projects: Record<string, string> = {};
    const notes: string[] = [];
    for (const root of new Set(roots.map((entry) => path.resolve(entry)))) {
      const outcome = await this._captureOne(root, signal);
      if (outcome.tree) projects[root] = outcome.tree;
      if (outcome.note) notes.push(`${path.basename(root) || root}: ${outcome.note}`);
    }
    return { projects, ...(notes.length ? { skipped: notes.join("; ") } : {}) };
  }

  private async _captureOne(root: string, signal?: AbortSignal): Promise<{ tree?: string; note?: string }> {
    try {
      if (!fs.statSync(root).isDirectory()) return { note: "not a folder" };
    } catch {
      return { note: "folder not found" };
    }
    const failed = await this._ensureRepo(root, signal);
    if (failed) return { note: failed.split("\n")[0]!.slice(0, 160) };

    const add = await this._run(this._args(root, ["add", "-A", "--ignore-errors"]), { cwd: root, timeoutMs: this._captureTimeout, signal });
    if (add.timedOut) return { note: `too large to capture within ${Math.round(this._captureTimeout / 1000)}s` };
    if (add.code === null) return { note: add.stderr.trim().split("\n")[0]?.slice(0, 160) || "git is not available" };

    const tree = await this._run(this._args(root, ["write-tree"]), { cwd: root, timeoutMs: this._quickTimeout, signal });
    const id = tree.stdout.trim();
    if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) return { note: tree.stderr.trim().split("\n")[0]?.slice(0, 160) || "could not record the files" };

    // A repository inside the project is one entry here, not its files.
    const staged = await this._run(this._args(root, ["ls-files", "--stage", "-z"]), { cwd: root, timeoutMs: this._quickTimeout, signal });
    const nested = staged.stdout.split("\0").filter((entry) => entry.startsWith("160000 ")).length;
    const partial = add.code !== 0 ? "some files could not be read" : "";
    const notes = [nested ? `${nested} nested ${nested === 1 ? "repository is" : "repositories are"} not captured` : "", partial].filter(Boolean);
    return { tree: id, ...(notes.length ? { note: notes.join(", ") } : {}) };
  }

  /** What putting `root` back to `tree` would change, without changing anything. */
  async plan(root: string, tree: string, signal?: AbortSignal): Promise<RestorePlan | { error: string }> {
    const resolved = path.resolve(root);
    const now = await this._captureOne(resolved, signal);
    if (!now.tree) return { error: now.note ?? "The current files could not be recorded, so a restore could not be planned." };
    const diff = await this._run(this._args(resolved, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", now.tree, tree]), { cwd: resolved, timeoutMs: this._quickTimeout, signal });
    if (diff.code !== 0) return { error: diff.stderr.trim().split("\n")[0] || "git could not compare the two states" };
    const restore: string[] = [];
    const remove: string[] = [];
    for (const entry of parseNameStatus(diff.stdout)) {
      // Read from the current state toward the target: "added" is present only in the target.
      if (entry.status === "D") remove.push(entry.path);
      else restore.push(entry.path);
    }
    return { root: resolved, tree, restore, remove, safetyTree: now.tree };
  }

  /** Put the files back. The caller has shown the plan and been told to go ahead. */
  async apply(plan: RestorePlan, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    const read = await this._run(this._args(plan.root, ["read-tree", plan.tree]), { cwd: plan.root, timeoutMs: this._quickTimeout, signal });
    if (read.code !== 0) return { ok: false, error: read.stderr.trim().split("\n")[0] || "git could not read the saved state" };
    if (plan.restore.length) {
      const checkout = await this._run(this._args(plan.root, ["checkout-index", "-f", "-z", "--stdin"]), {
        cwd: plan.root,
        input: `${plan.restore.join("\0")}\0`,
        timeoutMs: this._captureTimeout,
        signal,
      });
      if (checkout.code !== 0) return { ok: false, error: checkout.stderr.trim().split("\n")[0] || "git could not write the files back" };
    }
    for (const file of plan.remove) {
      const target = path.resolve(plan.root, file);
      // The paths come from git and are relative, but nothing outside the project is ever removed.
      if (target !== plan.root && !target.startsWith(plan.root + path.sep)) continue;
      try { fs.rmSync(target, { force: true }); } catch { /* left in place; the user is told what was not removed */ }
      let dir = path.dirname(target);
      while (dir.startsWith(plan.root + path.sep)) {
        try {
          if (fs.readdirSync(dir).length > 0) break;
          fs.rmdirSync(dir);
        } catch { break; }
        dir = path.dirname(dir);
      }
    }
    return { ok: true };
  }

  /** Files that differ between two captured states, for a "review all changes" view. */
  async changedFiles(root: string, fromTree: string, toTree: string, signal?: AbortSignal): Promise<Array<{ status: string; path: string }>> {
    const resolved = path.resolve(root);
    const diff = await this._run(this._args(resolved, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", fromTree, toTree]), { cwd: resolved, timeoutMs: this._quickTimeout, signal });
    return diff.code === 0 ? parseNameStatus(diff.stdout) : [];
  }

  /** A file's content in a captured state, or undefined if it was not there. */
  async fileAt(root: string, tree: string, file: string, signal?: AbortSignal): Promise<string | undefined> {
    const resolved = path.resolve(root);
    const shown = await this._run(this._args(resolved, ["cat-file", "blob", `${tree}:${file.replace(/\\/g, "/")}`]), { cwd: resolved, timeoutMs: this._quickTimeout, signal });
    return shown.code === 0 ? shown.stdout : undefined;
  }

  /** Delete private repositories nobody has touched in `maxAgeDays`. Returns how many went. */
  prune(maxAgeDays: number, now = Date.now()): number {
    const base = path.join(this._options.storageDir, "snapshots");
    let removed = 0;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
      const dir = path.join(base, entry.name);
      try {
        const age = now - fs.statSync(dir).mtimeMs;
        if (age < maxAgeDays * 24 * 60 * 60 * 1000) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* try again next time */ }
    }
    return removed;
  }
}
