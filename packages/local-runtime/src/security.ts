import fs from "fs";
import path from "path";
import type { OperationClassification, OperationTier } from "./types.js";
import { isWithinWorkspace, normalizeWorkspaceRoot, resolveReadPath } from "./path-policy.js";
import { isInsideDirectory } from "./toolchain-roots.js";

/**
 * Flags that run a code snippet given on the command line. These are allowed, but always shown
 * to the user in an approval prompt with the snippet, even for a binary they always allow — the
 * snippet is the code being run, and nothing else in the prompt would show it.
 *
 * They used to be refused outright. That did not stop arbitrary code (`python script.py` runs
 * without a prompt once `python` is always allowed); it only sent the agent to write a scratch
 * file and run that instead, which hid the code from the prompt and left a file behind.
 */
const EVAL_FLAGS: Record<string, string[]> = {
  // `-p`/`--print` evaluates exactly like `-e`.
  node: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  bun: ["-e", "--eval", "-p", "--print"],
  python: ["-c"], py: ["-c"], python3: ["-c"],
  ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"],
  lua: ["-e"], rscript: ["-e"], r: ["-e"],
};

/** Arguments that make a trusted binary launch some other program, or load code from somewhere a
 *  prompt cannot show. Refused outright. */
const ARG_BLOCKLIST: Record<string, string[]> = {
  git: ["--upload-pack", "--receive-pack", "--exec-path", "--ext-diff", "--ssh-command"],
  // `--import`/`--loader` accept a `data:` URL.
  node: ["-r", "--require", "--import", "--loader", "--experimental-loader"],
  npm: ["--script-shell", "--userconfig", "--call"],
  pnpm: ["--script-shell", "--userconfig"],
  npx: ["--userconfig", "-c", "--call"],
  yarn: ["--script-shell"],
  // Both launch an arbitrary program, and both binaries skip the code-execution prompt.
  rg: ["--pre", "--hostname-bin"],
  sort: ["--compress-program"],
  find: ["-exec", "-execdir"],
};

/** Binaries whose long options go through GNU getopt_long / git parse-options, both of which
 *  accept any unambiguous prefix: `sort --compress=prog` IS `--compress-program=prog`. */
const ABBREVIATING_LONG_OPTIONS = new Set(["sort", "git"]);

/**
 * True when `arg` invokes the blocked `flag`. Beyond the exact spelling this covers the other
 * ways a command line carries the same flag: an inline `--flag=value`, a single-letter flag
 * with its value attached (`python -cprint(1)`, `perl -e'…'`), a single-letter flag ending a
 * bundled cluster (`python -Ic "…"` is `-I -c "…"`, `node -pe` is `-p -e`; a value-taking flag
 * must end its cluster), and — for getopt-style binaries — an abbreviated long option
 * (`--compress-prog=…`).
 */
function argInvokesFlag(arg: string, flag: string, abbreviates: boolean): boolean {
  if (arg === flag) return true;
  if (flag.startsWith("--")) {
    const name = arg.split("=", 1)[0]!;
    if (name === flag) return true;
    return abbreviates && name.length > 3 && name.startsWith("--") && flag.startsWith(name);
  }
  if (/^-[A-Za-z]$/.test(flag) && !arg.startsWith("--")) {
    return arg.startsWith(flag) || (/^-[A-Za-z]+$/.test(arg) && arg.endsWith(flag[1]!));
  }
  return false;
}

export function normalizeCommandName(command: string): string {
  return path.basename(String(command || "")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}

function hasExecutablePath(command: string): boolean {
  const raw = String(command ?? "").trim();
  return path.isAbsolute(raw) || /[/\\]/.test(raw);
}

function looksLikeUrlOrRemote(arg: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg) || /^[\w.-]+@[\w.-]+:/.test(arg);
}

/**
 * An explicit executable path is normally treated as unrecognized code (a repository can ship
 * its own `git.exe`). One that sits directly in a PATH directory outside the workspace
 * (`executableDirs`, see toolchain-roots.ts) is the same installed tool its bare name would find —
 * `C:\…\Python312\python.exe` is `python` — so it is identified by that name.
 */
function isTrustedExecutablePath(command: string, executableDirs: readonly string[] | undefined): boolean {
  if (!executableDirs?.length || !hasExecutablePath(command)) return false;
  let directory: string;
  try { directory = path.dirname(fs.realpathSync.native(path.resolve(String(command).trim()))); }
  catch { return false; }
  return executableDirs.some((trusted) => isInsideDirectory(trusted, directory) && isInsideDirectory(directory, trusted));
}

/**
 * User-configurable command permissions, layered on top of the built-in safety gates.
 * Surfaced to the end user through the `blacksite.permissions.*` settings.
 *
 * - `allowedCommands` extends the built-in allowlist with extra binaries.
 * - `deniedCommands` hard-blocks binaries; it wins over every allow source.
 * - `autoApprove` runs a binary's network/destructive operations without a prompt.
 * - `allowEvalFlags` runs inline-eval snippets without the approval prompt they otherwise always
 *   get, and opts out of the argument blocklist (advanced, unsafe).
 * - `readToolchains` (default on) lets tools read installed toolchains outside the workspace.
 * - `readableRoots` adds directories outside the workspace that tools may read without asking.
 */
export interface CommandPolicy {
  allowedCommands?: string[];
  deniedCommands?: string[];
  autoApprove?: string[];
  allowEvalFlags?: boolean;
  readToolchains?: boolean;
  readableRoots?: string[];
}

function normalizeList(values?: string[]): string[] {
  return (values ?? []).map(normalizeCommandName).filter(Boolean);
}

/** Longest snippet shown in an approval prompt; past it the rest is counted, not shown. */
const MAX_SNIPPET_CHARS = 2_000;

/**
 * The code an inline-eval flag runs (`python -c "…"`, `node -e "…"`), or undefined when the
 * command has none. Reads the snippet from the argument after the flag, or from the flag itself
 * when its value is attached (`--eval=…`, `-cprint(1)`).
 */
export function inlineCodeSnippet(command: string, args: readonly string[]): string | undefined {
  const flags = EVAL_FLAGS[normalizeCommandName(command)];
  if (!flags) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    for (const flag of flags) {
      if (!argInvokesFlag(arg, flag, false)) continue;
      if (arg === flag || (/^-[A-Za-z]+$/.test(arg) && arg.endsWith(flag.slice(1)))) return String(args[index + 1] ?? "");
      if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      return arg.slice(flag.length);
    }
  }
  return undefined;
}

function describeInlineCode(command: string, snippet: string): string {
  const shown = snippet.length > MAX_SNIPPET_CHARS
    ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n… (${snippet.length - MAX_SNIPPET_CHARS} more characters)`
    : snippet;
  return `Run inline ${normalizeCommandName(command)} code:\n${shown}`;
}

/**
 * Refuse the flags that make a trusted binary launch another program or load hidden code — a
 * safety floor that only the explicit `allowEvalFlags` opt-in disables. Inline-eval flags are not
 * refused here: they prompt (see {@link resolveShellConfirmation}). Where an argument *points* is
 * a separate question, answered by {@link externalPathArgs}.
 */
export function validateArgs(
  command: string,
  args: string[],
  options?: { policy?: CommandPolicy },
): void {
  const base = normalizeCommandName(command);
  const blocked = options?.policy?.allowEvalFlags ? [] : (ARG_BLOCKLIST[base] ?? []);
  const abbreviates = ABBREVIATING_LONG_OPTIONS.has(base);
  for (const rawArg of args) {
    const arg = String(rawArg);
    for (const flag of blocked) {
      if (argInvokesFlag(arg, flag, abbreviates)) {
        throw new Error(
          `Argument "${flag}" is not allowed for "${base}" for security reasons: it makes "${base}" run another program or load code the approval prompt cannot show. ` +
          `Run what you need directly instead. Do not retry this same flag.`,
        );
      }
    }
  }
}

/** Where a command reaches, and which directories hold installed executables — computed by the
 *  runtime from its workspace and PATH (see externalPathArgs and toolchain-roots.ts). */
export interface CommandAccess {
  externalPaths?: readonly ExternalPathArg[];
  executableDirs?: readonly string[];
}

/** A command argument that names a path outside the workspace. */
export interface ExternalPathArg {
  arg: string;
  /** Where it leads once links are followed. */
  path: string;
  /** Inside an installed toolchain (see toolchain-roots.ts) rather than arbitrary outside data. */
  toolchain: boolean;
}

/**
 * On Windows a leading `/` also reads as a root-relative path (`/t` is `C:\t`), so switch
 * arguments were refused as paths outside the workspace: `timeout /t 5`, `cmd /c …` and
 * `where /q python` all failed. A single-segment `/word` is a switch when it carries a `:value`
 * (`/p:Configuration=Release`, `/grant:r` — never a path) or when the program is a native
 * Windows one: a cmd.exe builtin, or an executable under the Windows directory. Programs that
 * take POSIX-style paths are not given this — `rg secret /Users` really does search C:\Users.
 */
function isWindowsSwitch(arg: string, base: string, resolvedCommand: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!/^\/[^/\\]+$/.test(arg)) return false;
  if (arg.includes(":")) return true;
  if (base === "cmd" || WINDOWS_SHELL_BUILTINS.has(base)) return true;
  const windowsDir = String(env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "").trim();
  if (!windowsDir || !resolvedCommand || !path.isAbsolute(resolvedCommand)) return false;
  return isInsideDirectory(windowsDir, resolvedCommand);
}

/**
 * The arguments of a command that name a path outside the workspace, judged where they
 * physically lead — a workspace link into `~/.ssh` counts as outside. These no longer fail the
 * command outright: {@link resolveShellConfirmation} runs it once the user approves, and lets a
 * read-only inspection of an installed toolchain (`cat`, `rg` over site-packages) through
 * without asking. A bare `..` counts too — it has no separator but is the most direct escape of
 * all (`rg secret ..`).
 */
export function externalPathArgs(
  command: string,
  args: string[],
  options: {
    workspaceRoot: string;
    cwd: string;
    readableRoots?: readonly string[];
    /** The executable the command resolves to, for recognizing native Windows programs. */
    resolvedCommand?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  },
): ExternalPathArg[] {
  const base = normalizeCommandName(command);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const root = normalizeWorkspaceRoot(options.workspaceRoot);
  const cwd = path.resolve(options.cwd || root);
  const external: ExternalPathArg[] = [];
  for (const rawArg of args) {
    const arg = String(rawArg);
    if (!arg || arg.startsWith("-") || !(/[/\\]/.test(arg) || arg === "..") || looksLikeUrlOrRemote(arg)) continue;
    if (platform === "win32" && isWindowsSwitch(arg, base, options.resolvedCommand, env)) continue;
    const resolution = resolveReadPath(root, path.isAbsolute(arg) ? arg : path.resolve(cwd, arg), {
      readableRoots: options.readableRoots,
    });
    if (resolution.location === "workspace") continue;
    external.push({ arg, path: resolution.physical, toolchain: resolution.location === "toolchain" });
  }
  return external;
}

const DESTRUCTIVE_BINARIES = new Set(["rm", "rmdir", "del", "rd", "erase", "dd", "shred", "truncate"]);
const NETWORK_BINARIES = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat"]);
/** Harmless, side-effect-free utilities that never warrant an approval prompt. `timeout` is
 *  deliberately absent — see {@link isPureTimeoutWait}. */
const READ_BINARIES = new Set(["sleep", "true", "false", "which", "where", "echo", "pwd"]);

/**
 * `timeout` names two different programs. On Windows it only waits (`timeout /t 5`), but the
 * GNU/BSD `timeout DURATION COMMAND…` *runs COMMAND* — `timeout 5 bash -c "…"` is an arbitrary
 * command. Treating the binary as a harmless wait let exactly that skip every prompt and the
 * inline-eval blocklist on Linux and macOS. Only an invocation made purely of wait syntax
 * (switches and durations, no command operand) is side-effect-free.
 */
function isPureTimeoutWait(args: string[]): boolean {
  return args.every((arg) => /^(?:\/t|\/nobreak|\d+(?:\.\d+)?[smhd]?)$/i.test(arg));
}

const NETWORK_SUBCOMMANDS: Record<string, Set<string>> = {
  pip: new Set(["install", "download", "wheel"]),
  pip3: new Set(["install", "download", "wheel"]),
  poetry: new Set(["add", "install", "update", "publish"]),
  uv: new Set(["add", "pip", "sync", "install"]),
  cargo: new Set(["add", "install", "publish", "update"]),
  go: new Set(["get", "install"]),
  yarn: new Set(["add", "install"]),
  npm: new Set(["install", "add", "ci"]),
  pnpm: new Set(["install", "add", "ci"]),
  docker: new Set(["pull", "push"]),
  helm: new Set(["install", "upgrade", "pull"]),
};

const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set(["rm", "rmi", "prune", "system"]),
  kubectl: new Set(["delete"]),
  terraform: new Set(["destroy", "apply"]),
};

export function classifyOperation(command: string, args: string[]): OperationClassification {
  const base = normalizeCommandName(command);
  const list = args.map((a) => String(a));
  const first = list[0] ?? "";
  const flags = list.filter((a) => a.startsWith("-"));
  const hasForce = flags.some((f) => f === "--force" || f === "-f" || f.startsWith("--force-with-lease"));
  const hasHard = flags.includes("--hard");

  if (DESTRUCTIVE_BINARIES.has(base)) return { tier: "destructive" };
  if (NETWORK_BINARIES.has(base)) return { tier: "network" };
  if (READ_BINARIES.has(base)) return { tier: "read" };
  if (base === "timeout") return { tier: isPureTimeoutWait(list) ? "read" : "write" };

  if (base === "git") {
    if (first === "push") return { tier: hasForce ? "destructive" : "network" };
    if (["fetch", "pull", "clone"].includes(first)) return { tier: "network" };
    if (first === "remote" && (list[1] === "add" || list[1] === "set-url")) return { tier: "network" };
    if (first === "reset" && hasHard) return { tier: "destructive" };
    if (first === "clean") return { tier: "destructive" };
    if (first === "branch" && (flags.includes("-D") || flags.includes("--delete"))) return { tier: "destructive" };
    if (["status", "log", "diff", "show", "branch", "stash", "remote"].includes(first)) return { tier: "read" };
    return { tier: "write" };
  }
  if (base === "npm" || base === "pnpm") {
    if (["install", "i", "add", "ci"].includes(first)) return { tier: "network" };
    if (["list", "ls"].includes(first)) return { tier: "read" };
    return { tier: "write" };
  }
  if (base === "npx") return { tier: "network" };
  if (["node", "python", "python3", "py", "pytest"].includes(base)) {
    if (flags.includes("--version") || flags.includes("-V")) return { tier: "read" };
    return { tier: "write" };
  }

  if (DESTRUCTIVE_SUBCOMMANDS[base]?.has(first)) return { tier: "destructive" };
  if (NETWORK_SUBCOMMANDS[base]?.has(first)) return { tier: "network" };

  return { tier: "write" };
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

export function buildDescription(
  command: string,
  args: string[],
  unrecognized = false,
  access: CommandAccess = {},
): string {
  const base = normalizeCommandName(command);
  const list = args.map((a) => String(a));
  const displayCommand = hasExecutablePath(command) ? String(command).trim() : base;
  const display = [displayCommand, ...list.map(quoteArg)].join(" ");
  const { tier } = classifyOperation(command, list);
  const first = list[0] ?? "";
  const hasForce = list.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"));

  let effect = "";
  if (base === "git") {
    if (first === "push") effect = hasForce ? "force-pushes commits to remote, overwriting history" : "pushes local commits to the remote";
    else if (first === "fetch") effect = "downloads objects and refs from the remote";
    else if (first === "pull") effect = "fetches and integrates remote changes";
    else if (first === "clone") effect = "clones a remote repository";
    else if (first === "reset") effect = "resets the working tree, discarding changes";
    else if (first === "clean") effect = "permanently deletes untracked files";
  } else if (["npm", "pnpm"].includes(base) && ["install", "i", "add", "ci"].includes(first)) {
    effect = "installs dependencies from the network";
  } else if (base === "npx") {
    effect = "downloads and executes a package from the network";
  } else if (DESTRUCTIVE_BINARIES.has(base)) {
    effect = "permanently deletes or overwrites files";
  }

  if (requiresCodeExecutionConfirmation(command, list, access.executableDirs)) {
    effect = effect
      ? `${effect}; may execute project, plugin, hook, or nested command code`
      : "may execute project, plugin, hook, or nested command code";
  }

  // Name every outside location, marking arbitrary data apart from installed toolchains, so the
  // prompt says exactly what the command can reach beyond the project.
  const external = access.externalPaths ?? [];
  if (external.length > 0) {
    const shown = external.slice(0, 4).map((entry) => `${entry.path}${entry.toolchain ? " (installed toolchain)" : ""}`);
    const more = external.length > shown.length ? ` and ${external.length - shown.length} more` : "";
    effect = `${effect ? `${effect}; ` : ""}reaches outside the workspace: ${shown.join(", ")}${more}`;
  }

  // Prefix (never replace) so an unrecognized binary that also matches a known
  // destructive/network pattern (e.g. "rm", which isn't on the default allowlist)
  // still surfaces both facts instead of losing the "unrecognized" framing.
  if (unrecognized) {
    effect = effect
      ? `unrecognized binary, not on the allowed list; ${effect}`
      : "unrecognized binary, not on the built-in or configured allowed list";
  }

  return `Run \`${display}\`${effect ? ` — ${effect}` : ""} (${tier} operation)`;
}

/** Full VS Code–tier allowed-commands set (broader than the Chrome agent lane). */
export const DEFAULT_ALLOWED_COMMANDS = new Set<string>([
  "git", "gh", "hg", "svn",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno",
  "tsc", "tsx", "ts-node", "vite", "webpack", "rollup", "esbuild", "parcel",
  "eslint", "prettier", "jest", "vitest", "mocha", "playwright", "cypress",
  "python", "python3", "py", "pip", "pip3", "pipx", "pytest", "poetry", "uv",
  "ruff", "black", "mypy", "flake8", "isort", "tox", "hatch", "conda",
  "cargo", "rustc", "rustup", "rustfmt",
  "go", "gofmt", "golangci-lint",
  "java", "javac", "kotlin", "kotlinc", "mvn", "gradle", "gradlew",
  "dotnet", "nuget",
  "ruby", "gem", "bundle", "rake", "rails", "rspec",
  "php", "composer",
  "gcc", "g++", "clang", "clang++", "make", "cmake", "ninja",
  "swift", "swiftc", "dart", "flutter", "elixir", "mix",
  "docker", "docker-compose", "podman", "kubectl", "helm", "terraform",
  "curl", "wget", "ssh", "scp", "sftp", "rsync",
  "ls", "dir", "cat", "echo", "pwd", "mkdir", "cp", "mv", "touch",
  "find", "grep", "rg", "ag", "sed", "awk", "sort", "uniq", "head", "tail",
  "diff", "tar", "zip", "unzip", "gzip", "stat", "du", "df",
  "chmod", "ln", "which", "where", "env", "sleep", "timeout", "true", "false",
  "bash", "sh", "zsh", "cmd", "powershell", "pwsh",
  // Read-only text/inspection utilities the agent reaches for constantly. Their
  // absence produced a steady stream of "not in the allowed list" failures in the
  // execution logs (e.g. `wc -l`). All are side-effect-free.
  "wc", "cut", "tr", "nl", "tee", "xargs", "comm", "paste", "column", "fold",
  "basename", "dirname", "realpath", "readlink", "jq", "yq",
  "seq", "printf", "expr", "date", "cal", "test", "tac", "rev", "split", "csplit",
  "tree", "file",
]);

export type CommandClassification = "allowed" | "denied" | "unrecognized";

/**
 * Tri-state permission check. Distinguishes an explicit deny (hard block, never
 * prompts — wins over every allow source) from a binary that simply isn't on any
 * allowlist ("unrecognized"), which callers should route to an approval prompt
 * instead of failing instantly.
 */
export function classifyCommandPermission(
  command: string,
  extraAllowed?: string[],
  allowedSet: Set<string> = DEFAULT_ALLOWED_COMMANDS,
  policy?: CommandPolicy,
  executableDirs?: readonly string[],
): CommandClassification {
  const base = normalizeCommandName(command);
  if (normalizeList(policy?.deniedCommands).includes(base)) return "denied";
  // An allowlist entry describes a tool identity, not any workspace executable that happens to
  // share its basename. Explicit paths are executable code and need a one-shot approval —
  // except one sitting directly in a PATH directory, which is the installed tool itself.
  if (hasExecutablePath(command) && !isTrustedExecutablePath(command, executableDirs)) return "unrecognized";
  if (allowedSet.has(base)) return "allowed";
  const extras = [...(extraAllowed ?? []), ...(policy?.allowedCommands ?? [])];
  return normalizeList(extras).includes(base) ? "allowed" : "unrecognized";
}

/** Boolean facade over {@link classifyCommandPermission} for existing call sites. */
export function isAllowedCommand(
  command: string,
  extraAllowed?: string[],
  allowedSet: Set<string> = DEFAULT_ALLOWED_COMMANDS,
  policy?: CommandPolicy,
): boolean {
  return classifyCommandPermission(command, extraAllowed, allowedSet, policy) === "allowed";
}

export function requiresTierConfirmation(tier: OperationTier): boolean {
  return tier === "network" || tier === "destructive";
}

/** Direct file operations whose write-tier behavior does not execute project or nested code. */
const DIRECT_WRITE_BINARIES = new Set([
  "mkdir", "cp", "mv", "touch", "chmod", "ln",
]);

const SIMPLE_INSPECTION_BINARIES = new Set([
  "sleep", "true", "false", "which", "where", "echo", "pwd",
  "ls", "dir", "cat", "grep", "rg", "ag", "sort", "uniq", "head", "tail", "diff",
  "stat", "du", "df", "wc", "cut", "tr", "nl", "comm", "paste", "column", "fold",
  "basename", "dirname", "realpath", "readlink", "jq", "yq", "seq", "printf", "expr",
  "date", "cal", "test", "tac", "rev", "tree", "file",
]);

/**
 * Inspection binaries that cannot write anywhere whatever their arguments — the only ones that
 * may look into an installed toolchain without asking. Deliberately narrower than
 * SIMPLE_INSPECTION_BINARIES: `sort -o`, `uniq IN OUT`, `tree -o`, `yq -i` and `date -s` all
 * write, and a no-prompt write into a Python install's `site.py` would run on every later
 * `python`.
 */
const READ_ONLY_INSPECTION_BINARIES = new Set([
  "which", "where", "echo", "pwd", "ls", "dir", "cat", "grep", "rg", "ag", "head", "tail", "diff",
  "stat", "du", "df", "wc", "cut", "tr", "nl", "comm", "paste", "column", "fold", "basename",
  "dirname", "realpath", "readlink", "jq", "seq", "printf", "expr", "cal", "test", "tac", "rev",
]);

function isVersionProbe(args: string[]): boolean {
  return args.length > 0 && args.every((arg) => ["--version", "-version", "-V", "-v"].includes(arg));
}

/** git subcommands that only read the repository. `stash`, `branch`, `remote`, `reflog` and friends
 *  are absent on purpose: each has a mutating form spelled with the same subcommand. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse", "describe",
  "shortlog", "grep", "cat-file", "merge-base",
]);

/**
 * True only for a command that cannot change anything, whatever else is true of it: an inspection
 * binary from the no-write set, a bare version probe, or a read-only git subcommand without an
 * output-file flag. Deliberately stricter than the approval tiers, which answer a different
 * question ("does this need a prompt?") and rate plenty of writers as silent. Plan mode relies on it.
 */
export function isReadOnlyCommand(command: string, args: string[]): boolean {
  if (hasExecutablePath(command)) return false;
  const base = normalizeCommandName(command);
  const list = args.map(String);
  if (READ_ONLY_INSPECTION_BINARIES.has(base)) return true;
  if (isVersionProbe(list)) return true;
  if (base === "git") {
    const sub = list[0] ?? "";
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    // `--output=<file>` makes diff/log/show write a file; `-c`/`--exec-path` style options only
    // appear before the subcommand, which the check above already rejects.
    return !list.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff");
  }
  return false;
}

/**
 * Development commands can load scripts, plugins, hooks, repository configuration, or an entire
 * nested shell even when their nominal subcommand looks read-only (`git status` may launch a
 * configured fsmonitor, `rg --pre` launches a preprocessor, and so on). Their real effects cannot
 * be inferred from the outer executable name, so only a deliberately small set of direct utilities
 * and version probes bypass the code-execution gate.
 */
export function requiresCodeExecutionConfirmation(
  command: string,
  args: string[],
  executableDirs?: readonly string[],
): boolean {
  if (hasExecutablePath(command) && !isTrustedExecutablePath(command, executableDirs)) return true;
  const base = normalizeCommandName(command);
  if (base === "timeout") return !isPureTimeoutWait(args);
  if (DIRECT_WRITE_BINARIES.has(base) || SIMPLE_INSPECTION_BINARIES.has(base)) return false;
  if (NETWORK_BINARIES.has(base) || DESTRUCTIVE_BINARIES.has(base)) return false;
  if (isVersionProbe(args)) return false;
  return true;
}

/**
 * Decide whether a command needs an approval prompt. A network/destructive operation
 * normally prompts, unless the binary is on the user's `autoApprove` list (the persisted
 * "always allow for this project" choice).
 */
export function resolveConfirmation(
  command: string,
  args: string[],
  policy?: CommandPolicy,
): { tier: OperationTier; needsConfirmation: boolean } {
  const { tier } = classifyOperation(command, args);
  if (!requiresTierConfirmation(tier)) return { tier, needsConfirmation: false };
  const base = normalizeCommandName(command);
  const autoApproved = normalizeList(policy?.autoApprove).includes(base);
  return { tier, needsConfirmation: !autoApproved };
}

export type ShellConfirmationOutcome =
  | { kind: "denied"; error: string }
  | { kind: "confirm"; tier: OperationTier; description: string; unrecognizedCommand: boolean }
  | { kind: "proceed"; tier: OperationTier };

/**
 * Single source of truth for "should this command run, prompt, or hard-fail" —
 * shared by shell.ts (`system.shell`) and runtime.ts (`system.process.start`) so the
 * two call sites can't drift apart on denied/unrecognized/confirmation handling.
 * Explicit denies hard-block (`kind: "denied"`); an unrecognized binary always forces
 * a confirmation prompt regardless of its guessed tier, since tier classification for
 * an unknown binary is itself a low-confidence guess.
 *
 * `access` carries where the command reaches (see {@link externalPathArgs}) and which
 * directories hold installed executables. A command that reaches arbitrary data outside the
 * workspace always asks first. One that reaches only installed toolchains runs without asking
 * when it is a read-only inspector (`cat`, `rg`, `ls` over a Python install or global
 * `node_modules` — exactly the access the file tools grant) or a binary the user always allows.
 */
export function resolveShellConfirmation(
  command: string,
  args: string[],
  confirmed: boolean,
  extraAllowed: string[] | undefined,
  policy: CommandPolicy | undefined,
  access: CommandAccess = {},
): ShellConfirmationOutcome {
  const classification = classifyCommandPermission(command, extraAllowed, undefined, policy, access.executableDirs);
  if (classification === "denied") {
    return {
      kind: "denied",
      error: `Command "${normalizeCommandName(command)}" is explicitly denied by policy `
        + `(blacksite.permissions.deniedCommands). Use a dedicated tool instead `
        + `(file_read / file_search / file_list for inspecting files), or a different binary. `
        + `Do not retry this same command.`,
    };
  }
  const unrecognizedCommand = classification === "unrecognized";
  const { tier, needsConfirmation } = resolveConfirmation(command, args, policy);
  // `autoApprove` is the user's persisted "always allow this binary" choice (the approval modal
  // writes to blacksite.permissions.autoApprove). Honour it here too, or the code-execution gate
  // would silently turn that button into a no-op for exactly the binaries users put on the list
  // — git, npm, node — since their tier is usually "write" and never reaches resolveConfirmation's
  // auto-approve branch. It deliberately does NOT cover `extraAllowed`, which the *model* supplies
  // in the tool payload, nor an explicit executable path, which stays `unrecognized` and prompts.
  const base = normalizeCommandName(command);
  const autoApproved = normalizeList(policy?.autoApprove).includes(base);
  const codeExecution = !autoApproved && requiresCodeExecutionConfirmation(command, args, access.executableDirs);
  // Arbitrary data outside the workspace always asks — "always allow git" is about the binary,
  // not about reaching into ~/.ssh or another project. An installed toolchain asks only when
  // the binary could write into it and is not one the user always allows.
  const external = access.externalPaths ?? [];
  const reachesOutside = external.some((entry) => !entry.toolchain)
    || (external.length > 0 && !autoApproved && !READ_ONLY_INSPECTION_BINARIES.has(base));
  // Inline code always asks, with the code in the prompt — "always allow python" is about the
  // binary, not about whatever snippet comes with it. Only allowEvalFlags skips this.
  const snippet = policy?.allowEvalFlags ? undefined : inlineCodeSnippet(command, args);
  if (snippet !== undefined && !confirmed) {
    return { kind: "confirm", tier, description: describeInlineCode(command, snippet), unrecognizedCommand };
  }
  if ((needsConfirmation || unrecognizedCommand || codeExecution || reachesOutside) && !confirmed) {
    return { kind: "confirm", tier, description: buildDescription(command, args, unrecognizedCommand, access), unrecognizedCommand };
  }
  return { kind: "proceed", tier };
}

/**
 * Characters that cmd.exe treats as ordinary text wherever they appear. Anything outside this
 * set gets quoted.
 *
 * This is deliberately an allowlist. The previous rule quoted only tokens containing
 * whitespace or a double quote, which let a token like `build&calc` reach the command line
 * bare — and cmd.exe reads that `&` as a command separator, so `npm run build&calc` runs
 * `npm run build` *and then* `calc`. Because the approval gate classifies the tier from the
 * named binary (`npm`, recognized and benign), the smuggled second command was never
 * classified and never prompted, which inverts the whole point of this module. An allowlist
 * fails closed: a metacharacter nobody thought of gets quoted rather than interpreted.
 */
const CMD_INERT_CHARS = /^[A-Za-z0-9_\-.:@+~/\\]+$/;

/**
 * Quote a single token for cmd.exe so that spaces, embedded quotes, and shell
 * metacharacters (`&`, `|`, `<`, `>`, `^`, `(`, `)`, …) all survive as literal argument text
 * rather than being read as syntax — both on cmd.exe's own pass over the line and on the
 * second pass a `.cmd` shim makes when it forwards `%*` (npm, npx, every node_modules/.bin
 * shim).
 *
 * Two cmd.exe rules shape this, and the C-runtime `\"` escape honours neither:
 *
 * - cmd.exe toggles its quote state on *every* `"`; it has no escape for one inside quotes.
 *   A `\"` therefore closes the quoted region, and `a"&calc&"b` quoted as `"a\"&calc&\"b"`
 *   exposes `&calc&` as a command separator — a second command that the approval gate never
 *   classified, reachable even through no-prompt builtins like `echo`. An embedded quote is
 *   written `""` instead: two toggles that leave the quote state unchanged, and which the C
 *   runtime (and so every target program) reads back as one literal `"`.
 * - `%VAR%` is expanded before operators are parsed, inside quotes or not, so an expansion is
 *   both a disclosure and a way to smuggle syntax. Each `%` becomes `%%cd:~,%`: the
 *   `%cd:~,%` part is a zero-length substring of the always-defined `cd` variable, which
 *   expands to nothing, and it separates the `%` from whatever follows so no variable name
 *   can form.
 *
 * Backslashes follow the C-runtime rule: a run that precedes a `"` (including the closing
 * one) is doubled, every other backslash is literal. This is the scheme Rust's std adopted
 * for batch files after BatBadBut (CVE-2024-24576).
 */
function quoteForCmd(value: string): string {
  const arg = String(value);
  if (arg === "") return '""';
  if (CMD_INERT_CHARS.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      quoted += char;
      continue;
    }
    if (char === '"') quoted += `${"\\".repeat(backslashes)}""`;
    else if (char === "%") quoted += "%%cd:~,%";
    else quoted += char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes)}"`;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Decide how to invoke spawn so Windows `.cmd`/`.bat` shims (npm, npx, vite, tsc, …)
 * actually run. Node refuses to spawn a batch shim without a shell, throwing `spawn
 * EINVAL` (the CVE-2024-27980 hardening), and bare shim names also fail to resolve
 * without PATHEXT. On Windows we therefore route non-`.exe` commands through the shell
 * with cmd-quoted arguments; explicit executables and every non-Windows platform spawn
 * directly with `shell: false`.
 *
 * Argument validation (see {@link validateArgs}) runs before this, independent of shell
 * choice, so the security blocklist is unaffected.
 */
export function planSpawn(command: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  if (platform !== "win32") {
    return { command, args, shell: false };
  }
  if (/\.(exe|com)$/i.test(path.basename(command))) {
    return { command, args, shell: false };
  }
  // Build a single, fully-quoted command line and pass no separate args. Passing an
  // args array together with shell:true is deprecated (Node DEP0190) precisely because
  // the runtime concatenates without escaping — by quoting here and joining ourselves we
  // keep escaping authoritative and sidestep the deprecation.
  return {
    command: [command, ...args].map(quoteForCmd).join(" "),
    args: [],
    shell: true, // security-scan: allow-shell — command and every argument are cmd-quoted above.
  };
}

const WINDOWS_SHELL_BUILTINS = new Set([
  "cd", "chdir", "cls", "copy", "date", "del", "dir", "echo", "erase", "md", "mkdir",
  "move", "path", "pause", "popd", "prompt", "pushd", "rd", "ren", "rename", "rmdir",
  "set", "start", "time", "title", "type", "ver", "verify", "vol",
]);

/**
 * Resolve bare commands from trusted PATH entries before spawning them. In particular, cmd.exe
 * searches the current directory before PATH; without this step a repository-local `git.cmd`
 * silently impersonates the allowlisted system Git binary. Workspace PATH entries and relative
 * PATH entries are ignored. Explicit command paths are preserved and already force approval.
 */
export function resolveCommandForSpawn(
  command: string,
  cwd: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const raw = String(command ?? "").trim();
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.isAbsolute(raw)) return pathApi.normalize(raw);
  if (/[/\\]/.test(raw)) return pathApi.resolve(cwd, raw);

  const base = normalizeCommandName(raw);
  if (platform === "win32" && WINDOWS_SHELL_BUILTINS.has(base)) return raw;

  const separator = platform === "win32" ? ";" : ":";
  const entries = String(env.PATH ?? env.Path ?? "").split(separator).filter(Boolean);
  const extensions = platform === "win32"
    ? (pathApi.extname(raw)
        ? [""]
        : String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))
    : [""];

  for (const entry of entries) {
    const directory = entry.replace(/^"|"$/g, "").trim();
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    if (isWithinWorkspace(workspaceRoot, directory)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${raw}${extension}`);
      try {
        fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* try the next PATH candidate */ }
    }
  }
  return raw;
}
