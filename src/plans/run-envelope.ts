/**
 * What a plan run may do without asking: the permissions the user ticks before they leave it.
 *
 * Approving each operation as it comes is how a run is supervised; it is not how a run is left
 * alone. This moves the decision to the start, while the user is still there: a few named kinds
 * of routine work the run may do on its own, each matched here against the exact command, not
 * described to a model and hoped for. A permission lasts as long as the run, and nothing else in
 * the conversation can widen it.
 *
 * Every permission is deliberately narrow:
 *
 *  - **install_dependencies** installs what the project already declares (`npm ci`, `uv sync`,
 *    `pip install -r requirements.txt`). Adding a package by name is not covered: a new
 *    dependency is exactly what an instruction planted in a web page would ask for.
 *  - **project_scripts** runs the test, build, lint, type-check and format scripts, and the
 *    standard test and build commands of the common toolchains.
 *  - **git_commit** stages and commits locally. No amend, no skipping hooks, no config overrides.
 *  - **push_run_branch** pushes the run's own branch to `origin`, without force. Only a run in an
 *    isolated copy has a branch of its own, so only such a run can use it.
 *
 * Some things no permission covers, whatever is ticked: destructive operations, external service
 * changes, recorded sequences, MCP calls, edits (which follow the approval mode), unrecognized
 * executables, inline code, scripts run through a shell, and anything reaching outside the
 * workspace.
 *
 * Pure: the gate hands in what it knows about the call, and gets back whether it is covered.
 */

import { inlineCodeSnippet, normalizeCommandName } from "@blacksite/local-runtime";
import type { ApprovalCategory } from "../approval-scope.js";
import { RUN_PERMISSION_LABELS, RUN_PERMISSION_VALUES, type RunPermissionValue } from "./plan-run-view.js";

export { RUN_PERMISSION_LABELS };

export type RunPermission = RunPermissionValue;

export const RUN_PERMISSIONS: readonly RunPermission[] = RUN_PERMISSION_VALUES;

export function normalizePermissions(value: unknown): RunPermission[] {
  if (!Array.isArray(value)) return [];
  return RUN_PERMISSIONS.filter((permission) => value.includes(permission));
}

export interface EnvelopeRequest {
  toolName: string;
  category: ApprovalCategory;
  tier: string;
  input: Record<string, unknown>;
  description: string;
  unrecognizedCommand?: boolean;
}

export interface EnvelopeContext {
  allow: readonly RunPermission[];
  /** The run's own branch, set only when it works in an isolated copy. */
  runBranch?: string;
}

export type EnvelopeMatch =
  | { covered: true; permission: RunPermission; reason: string }
  | { covered: false };

const NOT_COVERED: EnvelopeMatch = { covered: false };

/** Interpreters a command can hide another command inside. Their argument is not inspected. */
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "cmd", "powershell", "pwsh", "env", "xargs", "sudo", "doas", "su"]);

function isPlainArg(arg: string): boolean {
  // The runtime passes arguments without a shell, but a Windows .cmd shim goes through cmd.exe.
  // Anything that could be read as an operator is outside what a permission vouches for.
  return !/[&|;<>`$\n\r]/.test(arg);
}

function onlyFlagsFrom(args: readonly string[], allowed: ReadonlySet<string>): boolean {
  return args.every((arg) => allowed.has(arg));
}

function isWorkspaceRelativeFile(arg: string): boolean {
  if (!arg || arg.startsWith("-") || /^[a-zA-Z]:|^[\\/]/.test(arg)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg)) return false; // URLs and git+ssh style specs
  return !arg.split(/[\\/]/).includes("..");
}

// ── install_dependencies ─────────────────────────────────────────────────────

const NODE_INSTALL_FLAGS = new Set([
  "--frozen-lockfile", "--prefer-offline", "--offline", "--no-audit", "--no-fund", "--ignore-scripts",
  "--legacy-peer-deps", "--silent", "--quiet", "-s", "--immutable", "--no-progress", "--loglevel=error",
]);

function coversInstall(base: string, args: readonly string[]): boolean {
  const [first = "", ...rest] = args;
  switch (base) {
    case "npm":
      if (first === "ci") return onlyFlagsFrom(rest, NODE_INSTALL_FLAGS);
      return (first === "install" || first === "i") && onlyFlagsFrom(rest, NODE_INSTALL_FLAGS);
    case "pnpm":
    case "bun":
      return (first === "install" || first === "i") && onlyFlagsFrom(rest, NODE_INSTALL_FLAGS);
    case "yarn":
      if (args.length === 0) return true;
      return first === "install" && onlyFlagsFrom(rest, NODE_INSTALL_FLAGS);
    case "pip":
    case "pip3":
      return coversPipInstall(args);
    case "python":
    case "python3":
    case "py":
      return first === "-m" && (rest[0] === "pip" || rest[0] === "pip3") && coversPipInstall(rest.slice(1));
    case "uv":
      if (first === "sync") return onlyFlagsFrom(rest, new Set(["--frozen", "--locked", "--all-extras", "--dev", "--no-dev", "--all-groups"]));
      return first === "pip" && coversPipInstall(rest);
    case "poetry":
      return first === "install" && onlyFlagsFrom(rest, new Set(["--no-root", "--sync", "--no-interaction", "-n", "--all-extras"]));
    case "pipenv":
      return (first === "install" || first === "sync") && onlyFlagsFrom(rest, new Set(["--dev", "--deploy", "--ignore-pipfile"]));
    case "bundle":
      return (args.length === 0 || first === "install") && onlyFlagsFrom(args.length ? rest : [], new Set(["--quiet", "--jobs=4"]));
    case "composer":
      return first === "install" && onlyFlagsFrom(rest, new Set(["--no-interaction", "--prefer-dist", "--no-progress"]));
    case "go":
      return first === "mod" && rest[0] === "download" && rest.length === 1;
    case "cargo":
      return first === "fetch" && rest.every((arg) => arg === "--locked" || arg === "--quiet");
    case "dotnet":
      return first === "restore" && rest.every((arg) => arg.startsWith("-") ? ["--locked-mode", "--verbosity", "-v", "q", "quiet", "minimal"].includes(arg) : isWorkspaceRelativeFile(arg));
    default:
      return false;
  }
}

/** `pip install -r requirements.txt`, `pip install -e .`, `pip install .` — never a package name. */
function coversPipInstall(args: readonly string[]): boolean {
  if (args[0] !== "install") return false;
  const rest = args.slice(1);
  if (rest.length === 0) return false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-r" || arg === "--requirement") {
      const file = rest[index + 1];
      if (!file || !isWorkspaceRelativeFile(file)) return false;
      index += 1;
      continue;
    }
    if (arg === "-e" || arg === "--editable") {
      const target = rest[index + 1];
      if (target !== "." && !(target && isWorkspaceRelativeFile(target) && (target.startsWith("./") || target.startsWith(".\\")))) return false;
      index += 1;
      continue;
    }
    if (arg === ".") continue;
    if (arg === "--quiet" || arg === "-q" || arg === "--no-input" || arg === "--disable-pip-version-check") continue;
    // A package name, a URL, an index or a trusted-host override: not what the project declares.
    return false;
  }
  return true;
}

// ── project_scripts ──────────────────────────────────────────────────────────

const SCRIPT_NAME = /^(test|tests|build|lint|typecheck|type-check|check|format|fmt|compile|verify)(:[\w.-]+)?$/;

function coversScript(base: string, args: readonly string[]): boolean {
  const [first = "", second = ""] = args;
  switch (base) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (first === "test" || first === "t") return true;
      if (first === "run" || first === "run-script") return SCRIPT_NAME.test(second);
      // `yarn build`, `pnpm lint`: a script name used directly as the subcommand.
      return (base === "yarn" || base === "pnpm" || base === "bun") && SCRIPT_NAME.test(first);
    case "vitest":
    case "jest":
    case "mocha":
    case "pytest":
    case "tsc":
    case "eslint":
    case "prettier":
    case "ruff":
    case "mypy":
    case "black":
    case "flake8":
    case "rspec":
    case "phpunit":
      return true;
    case "python":
    case "python3":
    case "py":
      return first === "-m" && ["pytest", "unittest", "mypy", "ruff", "black", "flake8", "compileall"].includes(second);
    case "cargo":
      return ["test", "build", "check", "clippy", "fmt", "doc"].includes(first);
    case "go":
      return ["test", "build", "vet"].includes(first) || (first === "fmt");
    case "dotnet":
      return ["build", "test", "format"].includes(first);
    case "make":
      return args.length === 1 && ["test", "build", "lint", "check", "format"].includes(first);
    case "gradle":
    case "gradlew":
      return args.length > 0 && args.every((arg) => ["test", "build", "check", "assemble", "lint", "--quiet", "-q", "--offline"].includes(arg));
    case "mvn":
      return args.length > 0 && args.every((arg) => ["test", "verify", "compile", "package", "-q", "--quiet", "-o", "--offline", "-B", "--batch-mode"].includes(arg));
    default:
      return false;
  }
}

// ── git ──────────────────────────────────────────────────────────────────────

function coversCommit(args: readonly string[]): boolean {
  const [first = "", ...rest] = args;
  if (first === "add") return rest.every((arg) => arg === "-A" || arg === "--all" || arg === "-u" || arg === "--update" || arg === "." || isWorkspaceRelativeFile(arg));
  if (first !== "commit") return false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-m" || arg === "--message") { index += 1; continue; }
    if (arg.startsWith("--message=")) continue;
    if (arg === "-a" || arg === "--all" || arg === "-q" || arg === "--quiet") continue;
    // --amend rewrites what is there, --no-verify skips the project's own checks, -c and the
    // rest change how git itself behaves.
    return false;
  }
  return true;
}

function coversPush(args: readonly string[], runBranch: string | undefined): boolean {
  if (!runBranch || args[0] !== "push") return false;
  const rest = args.slice(1).filter((arg) => arg !== "-u" && arg !== "--set-upstream");
  return rest.length === 2 && rest[0] === "origin" && rest[1] === runBranch;
}

function coversGitOpPush(input: Record<string, unknown>, runBranch: string | undefined): boolean {
  if (!runBranch || input["op"] !== "push" || input["force"] === true) return false;
  const remote = typeof input["remote"] === "string" ? input["remote"].trim() : "";
  return (remote === "" || remote === "origin") && input["branch"] === runBranch;
}

// ── Matching ─────────────────────────────────────────────────────────────────

function commandOf(request: EnvelopeRequest): { command: string; args: string[] } | undefined {
  if (request.toolName !== "shell_run") return undefined;
  const command = typeof request.input["command"] === "string" ? request.input["command"].trim() : "";
  if (!command || /\s/.test(command) || /[\\/]/.test(command)) return undefined;
  const raw = request.input["args"];
  const args = Array.isArray(raw) ? raw.map((arg) => String(arg)) : [];
  return { command, args };
}

export function envelopeCovers(request: EnvelopeRequest, context: EnvelopeContext): EnvelopeMatch {
  if (context.allow.length === 0) return NOT_COVERED;
  // The floor. Nothing below this line is reachable for these, whatever was ticked.
  if (request.category !== "command") return NOT_COVERED;
  if (request.tier === "destructive" || request.unrecognizedCommand) return NOT_COVERED;
  if (request.description.includes("reaches outside the workspace")) return NOT_COVERED;

  const allows = (permission: RunPermission): boolean => context.allow.includes(permission);

  if (request.toolName === "git_op") {
    if (allows("push_run_branch") && coversGitOpPush(request.input, context.runBranch)) {
      return { covered: true, permission: "push_run_branch", reason: `pushes the run's own branch ${context.runBranch}` };
    }
    return NOT_COVERED;
  }

  const parsed = commandOf(request);
  if (!parsed) return NOT_COVERED;
  const base = normalizeCommandName(parsed.command);
  if (SHELLS.has(base)) return NOT_COVERED;
  if (inlineCodeSnippet(parsed.command, parsed.args) !== undefined) return NOT_COVERED;
  if (!parsed.args.every(isPlainArg)) return NOT_COVERED;

  if (allows("install_dependencies") && coversInstall(base, parsed.args)) {
    return { covered: true, permission: "install_dependencies", reason: RUN_PERMISSION_LABELS.install_dependencies };
  }
  if (allows("project_scripts") && coversScript(base, parsed.args)) {
    return { covered: true, permission: "project_scripts", reason: RUN_PERMISSION_LABELS.project_scripts };
  }
  if (base === "git" && allows("git_commit") && coversCommit(parsed.args)) {
    return { covered: true, permission: "git_commit", reason: RUN_PERMISSION_LABELS.git_commit };
  }
  if (base === "git" && allows("push_run_branch") && coversPush(parsed.args, context.runBranch)) {
    return { covered: true, permission: "push_run_branch", reason: `pushes the run's own branch ${context.runBranch}` };
  }
  return NOT_COVERED;
}
