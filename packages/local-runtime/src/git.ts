import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type { GitStatusData, GitCommit, GitDiffFile, GitBranch } from "./types.js";
import { buildDescription } from "./security.js";

const GIT_TIMEOUT_MS = 30_000;
const LOG_UNIT = "\x1f";
const LOG_RECORD = "\x1e";

function safeStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function runGitSync(cwd: string, args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; exitCode: number | null; success: boolean } {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", env, shell: false, timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("git was not found on PATH. Install git to use git tools.");
    }
    throw result.error;
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.status === "number" ? result.status : null,
    success: result.status === 0,
  };
}

function resolveCwd(rootPath: string, requested: string): string {
  const rel = String(requested || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(rootPath, rel || ".");
  const relative = path.relative(rootPath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`cwd escapes the workspace root: ${requested}`);
  }
  return resolved;
}

// --- Parsers ---

function parseGitStatus(stdout: string): GitStatusData {
  const out: GitStatusData = { branch: "", upstream: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], success: true };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { out.ahead = Number(m[1]) || 0; out.behind = Number(m[2]) || 0; }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const pathField = line.startsWith("2 ")
        ? line.split(" ").slice(9).join(" ").split("\t")[0]
        : line.split(" ").slice(8).join(" ");
      const filePath = (pathField ?? "").trim();
      if (!filePath) continue;
      if (xy[0] && xy[0] !== ".") out.staged.push({ path: filePath, status: xy[0] });
      if (xy[1] && xy[1] !== ".") out.unstaged.push({ path: filePath, status: xy[1] });
    } else if (line.startsWith("u ")) {
      const filePath = line.split(" ").slice(10).join(" ").trim();
      if (filePath) out.unstaged.push({ path: filePath, status: "U" });
    } else if (line.startsWith("? ")) {
      out.untracked.push(line.slice(2).trim());
    }
  }
  return out;
}

function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split(LOG_RECORD)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [hash, shortHash, author, date, refs, message] = trimmed.split(LOG_UNIT);
    if (!hash) continue;
    commits.push({
      hash: (hash ?? "").trim(),
      shortHash: (shortHash ?? "").trim(),
      author: (author ?? "").trim(),
      date: (date ?? "").trim(),
      refs: (refs ?? "").trim(),
      message: (message ?? "").trim(),
    });
  }
  return commits;
}

function parseGitDiff(stdout: string): { files: GitDiffFile[] } {
  const files: GitDiffFile[] = [];
  let current: GitDiffFile | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const m = line.match(/ b\/(.+)$/);
      current = { path: m ? m[1]! : "", additions: 0, deletions: 0, hunks: [] };
    } else if (!current) {
      continue;
    } else if (line.startsWith("@@")) {
      current.hunks.push(line.split("@@")[1] ? `@@${line.split("@@")[1]!}@@` : line);
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  if (current) files.push(current);
  return { files };
}

// --- Operations ---

type GitOpResult = { ok: true; data: unknown } | { ok: false; code: string; message: string } | { ok: true; requiresConfirmation: true; tier: string; description: string };

function gitStatus(cwd: string, env: NodeJS.ProcessEnv): GitOpResult {
  const res = runGitSync(cwd, ["status", "--porcelain=v2", "--branch"], env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git status failed." };
  return { ok: true, data: parseGitStatus(res.stdout) };
}

function gitDiff(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const args = ["diff", "--no-color"];
  if (payload["staged"] === true) args.push("--cached");
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env);
  if (!res.success && res.stderr) return { ok: false, code: "git_failed", message: res.stderr };
  return { ok: true, data: { ...parseGitDiff(res.stdout), raw: res.stdout.slice(0, 50_000) } };
}

function gitLog(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const limit = Math.min(Math.max(Number(payload["limit"]) || 20, 1), 200);
  const format = ["%H", "%h", "%an", "%aI", "%D", "%s"].join(LOG_UNIT) + LOG_RECORD;
  const args = ["log", `-n`, String(limit), `--format=${format}`];
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git log failed." };
  return { ok: true, data: { commits: parseGitLog(res.stdout) } };
}

/** One bounded snapshot for branch/PR work, including the repository's real base branch. */
function gitContext(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const status = gitStatus(cwd, env);
  if (!status.ok || !("data" in status)) return status;

  const requestedRemote = safeStr(payload["remote"]) || "origin";
  const remoteResult = runGitSync(cwd, ["remote", "get-url", requestedRemote], env);
  const remoteUrl = remoteResult.success ? remoteResult.stdout.trim() : "";
  const remote = parseRemoteIdentity(remoteUrl);
  const requestedBase = safeStr(payload["base"]);
  const symbolic = runGitSync(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${requestedRemote}/HEAD`], env);
  const advertisedDefault = symbolic.success
    ? symbolic.stdout.trim().replace(new RegExp(`^${escapeRegExp(requestedRemote)}/`), "")
    : "";
  const base = requestedBase || advertisedDefault || firstExistingRef(cwd, env, [
    `${requestedRemote}/main`, `${requestedRemote}/master`, "main", "master",
  ]);
  const baseRef = resolveExistingRef(cwd, env, base ? [base, `${requestedRemote}/${base}`] : []);
  const mergeBase = baseRef ? runGitSync(cwd, ["merge-base", "HEAD", baseRef], env) : undefined;
  const committedDiff = baseRef
    ? runGitSync(cwd, ["diff", "--no-color", `${baseRef}...HEAD`], env)
    : { success: true, stdout: "", stderr: "", exitCode: 0 };
  const worktreeDiff = runGitSync(cwd, ["diff", "--no-color", "HEAD"], env);
  const stagedDiff = runGitSync(cwd, ["diff", "--no-color", "--cached"], env);
  const commits = baseRef
    ? gitLogRange(cwd, env, `${baseRef}..HEAD`, Math.min(Math.max(Number(payload["limit"]) || 50, 1), 200))
    : [];

  return {
    ok: true,
    data: {
      status: status.data,
      remote: { name: requestedRemote, url: remoteUrl, ...remote },
      base: base || undefined,
      baseRef: baseRef || undefined,
      mergeBase: mergeBase?.success ? mergeBase.stdout.trim() : undefined,
      commits,
      committed: boundedDiff(committedDiff.success ? committedDiff.stdout : ""),
      staged: boundedDiff(stagedDiff.success ? stagedDiff.stdout : ""),
      worktree: boundedDiff(worktreeDiff.success ? worktreeDiff.stdout : ""),
      pullRequestTemplate: readPullRequestTemplate(cwd),
    },
  };
}

function boundedDiff(raw: string): { files: GitDiffFile[]; raw: string; truncated: boolean } {
  const limit = 75_000;
  const clipped = raw.slice(0, limit);
  return { ...parseGitDiff(clipped), raw: clipped, truncated: raw.length > limit };
}

function gitLogRange(cwd: string, env: NodeJS.ProcessEnv, range: string, limit: number): GitCommit[] {
  const format = ["%H", "%h", "%an", "%aI", "%D", "%s"].join(LOG_UNIT) + LOG_RECORD;
  const result = runGitSync(cwd, ["log", "-n", String(limit), `--format=${format}`, range], env);
  return result.success ? parseGitLog(result.stdout) : [];
}

function resolveExistingRef(cwd: string, env: NodeJS.ProcessEnv, candidates: string[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = runGitSync(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], env);
    if (result.success) return candidate;
  }
  return "";
}

function firstExistingRef(cwd: string, env: NodeJS.ProcessEnv, candidates: string[]): string {
  const resolved = resolveExistingRef(cwd, env, candidates);
  return resolved.replace(/^[^/]+\//, "");
}

function parseRemoteIdentity(remoteUrl: string): { provider?: "github" | "gitlab" | "other"; owner?: string; repo?: string; projectId?: string } {
  const normalized = remoteUrl.trim().replace(/\\/g, "/");
  const match = /(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?$/.exec(normalized);
  if (!match) return {};
  const host = match[1]!.toLowerCase();
  const projectPath = match[2]!.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = projectPath.split("/").filter(Boolean);
  const repo = parts.at(-1);
  const owner = parts.length > 1 ? parts.slice(0, -1).join("/") : undefined;
  const provider = host === "github.com" ? "github" : host.includes("gitlab") ? "gitlab" : "other";
  return { provider, owner, repo, projectId: provider === "gitlab" ? projectPath : undefined };
}

function readPullRequestTemplate(cwd: string): { path: string; body: string } | undefined {
  const candidates = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
  ];
  const templateDirectory = path.join(cwd, ".github", "PULL_REQUEST_TEMPLATE");
  try {
    const firstTemplate = fs.readdirSync(templateDirectory)
      .filter((entry) => /\.md$/i.test(entry))
      .sort((left, right) => left.localeCompare(right))[0];
    if (firstTemplate) candidates.push(`.github/PULL_REQUEST_TEMPLATE/${firstTemplate}`);
  } catch { /* the optional conventional directory does not exist or is unreadable */ }
  for (const candidate of candidates) {
    const file = path.join(cwd, candidate);
    try {
      if (!fs.statSync(file).isFile()) continue;
      return { path: candidate, body: fs.readFileSync(file, "utf8").slice(0, 20_000) };
    } catch { /* try the next conventional location */ }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gitAdd(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const all = payload["all"] === true;
  const file = safeStr(payload["path"]);
  if (!all && !file) return { ok: false, code: "path_missing", message: "A file path or all:true is required to stage." };
  const args = all ? ["add", "-A"] : ["add", "--", file];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git add failed." };
  return { ok: true, data: { success: true, path: file || "*", all } };
}

function gitRestore(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const file = safeStr(payload["path"]);
  if (!file) return { ok: false, code: "path_missing", message: "A file path is required." };
  const staged = payload["staged"] === true;
  const args = staged ? ["restore", "--staged", "--", file] : ["restore", "--", file];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git restore failed." };
  return { ok: true, data: { success: true, path: file, staged } };
}

function gitCommit(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const message = safeStr(payload["message"]);
  if (!message) return { ok: false, code: "message_missing", message: "A commit message is required." };
  const args = ["commit", "-m", message];
  if (payload["all"] === true) args.splice(1, 0, "-a");
  const author = safeStr(payload["author"]);
  if (author) args.push(`--author=${author}`);
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: true, data: { success: false, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr } };
  const head = runGitSync(cwd, ["rev-parse", "HEAD"], env);
  return { ok: true, data: { success: true, hash: head.success ? head.stdout.trim() : "", summary: res.stdout.trim() } };
}

function gitCheckout(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const branch = safeStr(payload["branch"]);
  if (!branch) return { ok: false, code: "branch_missing", message: "A branch name is required." };
  const create = payload["create"] === true;
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: true, data: { success: false, branch, created: false, stderr: res.stderr } };
  return { ok: true, data: { success: true, branch, created: create } };
}

function gitBranch(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  // Omitted action defaults to list; a *provided* but wrong one (e.g. the stash-only
  // "pop") must error rather than silently listing — an ok:true with data the caller
  // never asked for reads as success and hides that the requested operation never ran.
  const requested = safeStr(payload["action"]);
  if (requested && !(["list", "create", "delete"] as const).includes(requested as "list" | "create" | "delete")) {
    return { ok: false, code: "action_invalid", message: `Invalid branch action "${requested}" — use list, create, or delete.` };
  }
  const action = (requested || "list") as "list" | "create" | "delete";
  if (action === "create") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to create." };
    const res = runGitSync(cwd, ["branch", name], env);
    if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git branch failed." };
    return { ok: true, data: { action, created: name } };
  }
  if (action === "delete") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to delete." };
    const res = runGitSync(cwd, ["branch", "-D", name], env);
    if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git branch -D failed." };
    return { ok: true, data: { action, deleted: name } };
  }
  const res = runGitSync(cwd, [
    "branch", "--all",
    "--format=%(refname:short)%(if)%(HEAD)%(then)\t*%(end)%(if)%(upstream:short)%(then)\t%(upstream:short)%(end)",
  ], env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git branch failed." };
  const branches: GitBranch[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, ...rest] = line.split("\t");
    const current = rest.includes("*");
    const upstream = rest.find((r) => r && r !== "*") ?? "";
    branches.push({ name: (name ?? "").trim(), current, upstream: upstream.trim(), remote: (name ?? "").startsWith("remotes/") });
  }
  return { ok: true, data: { action, branches } };
}

function gitStash(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  // Same contract as gitBranch: default only when omitted, error on a wrong action.
  const requested = safeStr(payload["action"]);
  if (requested && !(["push", "pop", "list"] as const).includes(requested as "push" | "pop" | "list")) {
    return { ok: false, code: "action_invalid", message: `Invalid stash action "${requested}" — use push, pop, or list.` };
  }
  const action = (requested || "list") as "push" | "pop" | "list";
  if (action === "list") {
    const res = runGitSync(cwd, ["stash", "list"], env);
    if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git stash list failed." };
    const stashes = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, data: { action, stashes } };
  }
  const args = ["stash", action];
  if (action === "push") {
    const message = safeStr(payload["message"]);
    if (message) args.push("-m", message);
  }
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || `git stash ${action} failed.` };
  return { ok: true, data: { action, success: true, summary: res.stdout.trim() } };
}

function gitPush(cwd: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): GitOpResult {
  const args = ["push"];
  const remote = safeStr(payload["remote"]);
  const branch = safeStr(payload["branch"]);
  if (payload["force"] === true) args.push("--force");
  if (payload["setUpstream"] === true) args.push("--set-upstream");
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  if (payload["confirmed"] !== true) {
    return {
      ok: true, requiresConfirmation: true,
      tier: payload["force"] === true ? "destructive" : "network",
      description: buildDescription("git", args),
    };
  }
  const res = runGitSync(cwd, args, env);
  return {
    ok: true,
    data: { success: res.success, exitCode: res.exitCode, remote: remote || "origin", branch, stdout: res.stdout.trim(), stderr: res.stderr.trim() },
  };
}

export function handleGitOp(
  rootPath: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): GitOpResult {
  let cwd: string;
  try {
    cwd = resolveCwd(rootPath, safeStr(payload["cwd"]));
  } catch (error) {
    return { ok: false, code: "cwd_invalid", message: error instanceof Error ? error.message : String(error) };
  }

  try {
    switch (payload["op"]) {
      case "status": return gitStatus(cwd, env);
      case "diff": return gitDiff(cwd, env, payload);
      case "log": return gitLog(cwd, env, payload);
      case "context": return gitContext(cwd, env, payload);
      case "add": return gitAdd(cwd, env, payload);
      case "restore": return gitRestore(cwd, env, payload);
      case "commit": return gitCommit(cwd, env, payload);
      case "checkout": return gitCheckout(cwd, env, payload);
      case "branch": return gitBranch(cwd, env, payload);
      case "stash": return gitStash(cwd, env, payload);
      case "push": return gitPush(cwd, env, payload);
      default:
        return { ok: false, code: "git_op_unsupported", message: `Unsupported git op: ${String(payload["op"] ?? "")}` };
    }
  } catch (error) {
    return { ok: false, code: "git_error", message: error instanceof Error ? error.message : String(error) };
  }
}

export { parseGitStatus, parseGitLog, parseGitDiff };
