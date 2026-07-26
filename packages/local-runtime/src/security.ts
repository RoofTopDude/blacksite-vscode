import path from "path";
import type { OperationClassification, OperationTier } from "./types.js";
import { isWithinWorkspace, normalizeWorkspaceRoot } from "./path-policy.js";

const ARG_BLOCKLIST: Record<string, string[]> = {
  git: ["--upload-pack", "--exec-path", "--ext-diff", "--ssh-command"],
  node: ["-e", "--eval", "-r", "--require"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  python: ["-c"], py: ["-c"], python3: ["-c"],
  ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"],
  lua: ["-e"], rscript: ["-e"], r: ["-e"],
  npm: ["--script-shell", "--userconfig"],
  pnpm: ["--script-shell", "--userconfig"],
  npx: ["--userconfig"],
  yarn: ["--script-shell"],
};

export function normalizeCommandName(command: string): string {
  return path.basename(String(command || "")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}

function looksLikeUrlOrRemote(arg: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg) || /^[\w.-]+@[\w.-]+:/.test(arg);
}

function resolvesOutsideWorkspace(rootPath: string, cwd: string, arg: string): boolean {
  const candidate = path.isAbsolute(arg) ? path.resolve(arg) : path.resolve(cwd, arg);
  return !isWithinWorkspace(rootPath, candidate);
}

/**
 * User-configurable command permissions, layered on top of the built-in safety gates.
 * Surfaced to the end user through the `blacksite.permissions.*` settings.
 *
 * - `allowedCommands` extends the built-in allowlist with extra binaries.
 * - `deniedCommands` hard-blocks binaries; it wins over every allow source.
 * - `autoApprove` runs a binary's network/destructive operations without a prompt.
 * - `allowEvalFlags` opts out of the inline-eval argument blocklist (advanced, unsafe).
 */
export interface CommandPolicy {
  allowedCommands?: string[];
  deniedCommands?: string[];
  autoApprove?: string[];
  allowEvalFlags?: boolean;
}

function normalizeList(values?: string[]): string[] {
  return (values ?? []).map(normalizeCommandName).filter(Boolean);
}

export function validateArgs(
  command: string,
  args: string[],
  options?: { workspaceRoot?: string; cwd?: string; policy?: CommandPolicy },
): void {
  const base = normalizeCommandName(command);
  // The inline-eval/script-shell blocklist is a safety floor; only the explicit
  // `allowEvalFlags` opt-in disables it. Path-traversal checks always apply.
  const blocked = options?.policy?.allowEvalFlags ? [] : (ARG_BLOCKLIST[base] ?? []);
  const workspaceRoot = options?.workspaceRoot ? normalizeWorkspaceRoot(options.workspaceRoot) : undefined;
  const cwd = options?.cwd
    ? path.resolve(options.cwd)
    : workspaceRoot;
  for (const rawArg of args) {
    const arg = String(rawArg);
    for (const flag of blocked) {
      if (arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))) {
        throw new Error(
          `Argument "${flag}" is not allowed for "${base}" for security reasons. ` +
          `Write the snippet to a file and run that file instead ` +
          `(e.g. write a .cjs/.mjs/.py file with file_write, then run it). Do not retry this same flag.`,
        );
      }
    }
    if (
      arg && !arg.startsWith("-") && /[/\\]/.test(arg)
      && !looksLikeUrlOrRemote(arg) && workspaceRoot && cwd && resolvesOutsideWorkspace(workspaceRoot, cwd, arg)
    ) {
      throw new Error(`Argument "${arg}" resolves outside the workspace root.`);
    }
  }
}

const DESTRUCTIVE_BINARIES = new Set(["rm", "rmdir", "del", "rd", "erase", "dd", "shred", "truncate"]);
const NETWORK_BINARIES = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat"]);
/** Harmless, side-effect-free utilities that never warrant an approval prompt. */
const READ_BINARIES = new Set(["sleep", "timeout", "true", "false", "which", "where", "echo", "pwd"]);

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

export function buildDescription(command: string, args: string[], unrecognized = false): string {
  const base = normalizeCommandName(command);
  const list = args.map((a) => String(a));
  const display = [base, ...list.map(quoteArg)].join(" ");
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
): CommandClassification {
  const base = normalizeCommandName(command);
  if (normalizeList(policy?.deniedCommands).includes(base)) return "denied";
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
 */
export function resolveShellConfirmation(
  command: string,
  args: string[],
  confirmed: boolean,
  extraAllowed: string[] | undefined,
  policy: CommandPolicy | undefined,
): ShellConfirmationOutcome {
  const classification = classifyCommandPermission(command, extraAllowed, undefined, policy);
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
  if ((needsConfirmation || unrecognizedCommand) && !confirmed) {
    return { kind: "confirm", tier, description: buildDescription(command, args, unrecognizedCommand), unrecognizedCommand };
  }
  return { kind: "proceed", tier };
}

/**
 * Quote a single token for cmd.exe so spaces and embedded quotes (the realistic cases
 * for file-path arguments) survive intact. Tokens with no whitespace or quotes are left
 * untouched.
 */
function quoteForCmd(value: string): string {
  const arg = String(value);
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  // Escape backslashes that precede a quote, escape the quote, double trailing
  // backslashes, then wrap the whole token in quotes.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
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
  // Models frequently spell out a `.cmd`/`.bat` shim suffix (e.g. "npx.cmd") that they
  // should not need to. Spawning that explicit shim has been observed to throw `spawn
  // EINVAL` on Windows; routing the *bare* name through cmd.exe lets PATHEXT resolve the
  // shim canonically. Strip the redundant suffix so the shell does the resolution.
  const shimBase = command.replace(/\.(cmd|bat|ps1)$/i, "");
  // Build a single, fully-quoted command line and pass no separate args. Passing an
  // args array together with shell:true is deprecated (Node DEP0190) precisely because
  // the runtime concatenates without escaping — by quoting here and joining ourselves we
  // keep escaping authoritative and sidestep the deprecation.
  return {
    command: [shimBase, ...args].map(quoteForCmd).join(" "),
    args: [],
    shell: true,
  };
}
