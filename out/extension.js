"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode22 = __toESM(require("vscode"));
var path26 = __toESM(require("path"));

// ../../packages/local-runtime/src/runtime.ts
var import_os2 = __toESM(require("os"), 1);

// ../../packages/local-runtime/src/shell.ts
var import_child_process2 = require("child_process");

// ../../packages/local-runtime/src/security.ts
var import_path2 = __toESM(require("path"), 1);

// ../../packages/local-runtime/src/path-policy.ts
var import_path = __toESM(require("path"), 1);
function normalizeRoot(rootPath) {
  const raw = String(rootPath ?? "").trim();
  return import_path.default.resolve(raw || ".");
}
function isWithinWorkspace(rootPath, candidatePath) {
  const root = normalizeRoot(rootPath);
  const candidate = import_path.default.resolve(candidatePath);
  const relative8 = import_path.default.relative(root, candidate);
  return relative8 === "" || !relative8.startsWith(`..${import_path.default.sep}`) && relative8 !== ".." && !import_path.default.isAbsolute(relative8);
}
function resolveWorkspacePath(rootPath, target, options = {}) {
  const root = normalizeRoot(rootPath);
  const raw = String(target ?? "").trim();
  if (!raw) {
    if (options.defaultToRoot) return root;
    throw new Error(`Missing ${options.label ?? "path"}.`);
  }
  const resolved = import_path.default.resolve(import_path.default.isAbsolute(raw) ? raw : import_path.default.join(root, raw));
  if (!isWithinWorkspace(root, resolved)) {
    throw new Error(`${options.label ?? "path"} escapes the workspace root: ${raw}`);
  }
  return resolved;
}
function resolveWorkspaceCwd(rootPath, requested) {
  const raw = String(requested ?? "").trim();
  return raw ? resolveWorkspacePath(rootPath, raw, { label: "cwd" }) : normalizeRoot(rootPath);
}
function normalizeWorkspaceRoot(rootPath) {
  return normalizeRoot(rootPath);
}

// ../../packages/local-runtime/src/security.ts
var ARG_BLOCKLIST = {
  git: ["--upload-pack", "--exec-path", "--ext-diff", "--ssh-command"],
  node: ["-e", "--eval", "-r", "--require"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  python: ["-c"],
  py: ["-c"],
  python3: ["-c"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r"],
  lua: ["-e"],
  rscript: ["-e"],
  r: ["-e"],
  npm: ["--script-shell", "--userconfig"],
  pnpm: ["--script-shell", "--userconfig"],
  npx: ["--userconfig"],
  yarn: ["--script-shell"]
};
function normalizeCommandName(command) {
  return import_path2.default.basename(String(command || "")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}
function looksLikeUrlOrRemote(arg) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg) || /^[\w.-]+@[\w.-]+:/.test(arg);
}
function resolvesOutsideWorkspace(rootPath, cwd, arg) {
  const candidate = import_path2.default.isAbsolute(arg) ? import_path2.default.resolve(arg) : import_path2.default.resolve(cwd, arg);
  return !isWithinWorkspace(rootPath, candidate);
}
function normalizeList(values) {
  return (values ?? []).map(normalizeCommandName).filter(Boolean);
}
function validateArgs(command, args, options) {
  const base = normalizeCommandName(command);
  const blocked = options?.policy?.allowEvalFlags ? [] : ARG_BLOCKLIST[base] ?? [];
  const workspaceRoot = options?.workspaceRoot ? normalizeWorkspaceRoot(options.workspaceRoot) : void 0;
  const cwd = options?.cwd ? import_path2.default.resolve(options.cwd) : workspaceRoot;
  for (const rawArg of args) {
    const arg = String(rawArg);
    for (const flag of blocked) {
      if (arg === flag || flag.startsWith("--") && arg.startsWith(`${flag}=`)) {
        throw new Error(
          `Argument "${flag}" is not allowed for "${base}" for security reasons. Write the snippet to a file and run that file instead (e.g. write a .cjs/.mjs/.py file with file_write, then run it). Do not retry this same flag.`
        );
      }
    }
    if (arg && !arg.startsWith("-") && /[/\\]/.test(arg) && !looksLikeUrlOrRemote(arg) && workspaceRoot && cwd && resolvesOutsideWorkspace(workspaceRoot, cwd, arg)) {
      throw new Error(`Argument "${arg}" resolves outside the workspace root.`);
    }
  }
}
var DESTRUCTIVE_BINARIES = /* @__PURE__ */ new Set(["rm", "rmdir", "del", "rd", "erase", "dd", "shred", "truncate"]);
var NETWORK_BINARIES = /* @__PURE__ */ new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat"]);
var READ_BINARIES = /* @__PURE__ */ new Set(["sleep", "timeout", "true", "false", "which", "where", "echo", "pwd"]);
var NETWORK_SUBCOMMANDS = {
  pip: /* @__PURE__ */ new Set(["install", "download", "wheel"]),
  pip3: /* @__PURE__ */ new Set(["install", "download", "wheel"]),
  poetry: /* @__PURE__ */ new Set(["add", "install", "update", "publish"]),
  uv: /* @__PURE__ */ new Set(["add", "pip", "sync", "install"]),
  cargo: /* @__PURE__ */ new Set(["add", "install", "publish", "update"]),
  go: /* @__PURE__ */ new Set(["get", "install"]),
  yarn: /* @__PURE__ */ new Set(["add", "install"]),
  npm: /* @__PURE__ */ new Set(["install", "add", "ci"]),
  pnpm: /* @__PURE__ */ new Set(["install", "add", "ci"]),
  docker: /* @__PURE__ */ new Set(["pull", "push"]),
  helm: /* @__PURE__ */ new Set(["install", "upgrade", "pull"])
};
var DESTRUCTIVE_SUBCOMMANDS = {
  docker: /* @__PURE__ */ new Set(["rm", "rmi", "prune", "system"]),
  kubectl: /* @__PURE__ */ new Set(["delete"]),
  terraform: /* @__PURE__ */ new Set(["destroy", "apply"])
};
function classifyOperation(command, args) {
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
function quoteArg(arg) {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}
function buildDescription(command, args, unrecognized = false) {
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
  if (unrecognized) {
    effect = effect ? `unrecognized binary, not on the allowed list; ${effect}` : "unrecognized binary, not on the built-in or configured allowed list";
  }
  return `Run \`${display}\`${effect ? ` \u2014 ${effect}` : ""} (${tier} operation)`;
}
var DEFAULT_ALLOWED_COMMANDS = /* @__PURE__ */ new Set([
  "git",
  "gh",
  "hg",
  "svn",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsc",
  "tsx",
  "ts-node",
  "vite",
  "webpack",
  "rollup",
  "esbuild",
  "parcel",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "mocha",
  "playwright",
  "cypress",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "pipx",
  "pytest",
  "poetry",
  "uv",
  "ruff",
  "black",
  "mypy",
  "flake8",
  "isort",
  "tox",
  "hatch",
  "conda",
  "cargo",
  "rustc",
  "rustup",
  "rustfmt",
  "go",
  "gofmt",
  "golangci-lint",
  "java",
  "javac",
  "kotlin",
  "kotlinc",
  "mvn",
  "gradle",
  "gradlew",
  "dotnet",
  "nuget",
  "ruby",
  "gem",
  "bundle",
  "rake",
  "rails",
  "rspec",
  "php",
  "composer",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "make",
  "cmake",
  "ninja",
  "swift",
  "swiftc",
  "dart",
  "flutter",
  "elixir",
  "mix",
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ls",
  "dir",
  "cat",
  "echo",
  "pwd",
  "mkdir",
  "cp",
  "mv",
  "touch",
  "find",
  "grep",
  "rg",
  "ag",
  "sed",
  "awk",
  "sort",
  "uniq",
  "head",
  "tail",
  "diff",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "stat",
  "du",
  "df",
  "chmod",
  "ln",
  "which",
  "where",
  "env",
  "sleep",
  "timeout",
  "true",
  "false",
  "bash",
  "sh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  // Read-only text/inspection utilities the agent reaches for constantly. Their
  // absence produced a steady stream of "not in the allowed list" failures in the
  // execution logs (e.g. `wc -l`). All are side-effect-free.
  "wc",
  "cut",
  "tr",
  "nl",
  "tee",
  "xargs",
  "comm",
  "paste",
  "column",
  "fold",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "yq",
  "seq",
  "printf",
  "expr",
  "date",
  "cal",
  "test",
  "tac",
  "rev",
  "split",
  "csplit",
  "tree",
  "file"
]);
function classifyCommandPermission(command, extraAllowed, allowedSet = DEFAULT_ALLOWED_COMMANDS, policy) {
  const base = normalizeCommandName(command);
  if (normalizeList(policy?.deniedCommands).includes(base)) return "denied";
  if (allowedSet.has(base)) return "allowed";
  const extras = [...extraAllowed ?? [], ...policy?.allowedCommands ?? []];
  return normalizeList(extras).includes(base) ? "allowed" : "unrecognized";
}
function requiresTierConfirmation(tier) {
  return tier === "network" || tier === "destructive";
}
function resolveConfirmation(command, args, policy) {
  const { tier } = classifyOperation(command, args);
  if (!requiresTierConfirmation(tier)) return { tier, needsConfirmation: false };
  const base = normalizeCommandName(command);
  const autoApproved = normalizeList(policy?.autoApprove).includes(base);
  return { tier, needsConfirmation: !autoApproved };
}
function resolveShellConfirmation(command, args, confirmed, extraAllowed, policy) {
  const classification = classifyCommandPermission(command, extraAllowed, void 0, policy);
  if (classification === "denied") {
    return {
      kind: "denied",
      error: `Command "${normalizeCommandName(command)}" is explicitly denied by policy (blacksite.permissions.deniedCommands). Use a dedicated tool instead (file_read / file_search / file_list for inspecting files), or a different binary. Do not retry this same command.`
    };
  }
  const unrecognizedCommand = classification === "unrecognized";
  const { tier, needsConfirmation } = resolveConfirmation(command, args, policy);
  if ((needsConfirmation || unrecognizedCommand) && !confirmed) {
    return { kind: "confirm", tier, description: buildDescription(command, args, unrecognizedCommand), unrecognizedCommand };
  }
  return { kind: "proceed", tier };
}
function quoteForCmd(value) {
  const arg = String(value);
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}
function planSpawn(command, args, platform = process.platform) {
  if (platform !== "win32") {
    return { command, args, shell: false };
  }
  if (/\.(exe|com)$/i.test(import_path2.default.basename(command))) {
    return { command, args, shell: false };
  }
  const shimBase = command.replace(/\.(cmd|bat|ps1)$/i, "");
  return {
    command: [shimBase, ...args].map(quoteForCmd).join(" "),
    args: [],
    shell: true
  };
}

// ../../packages/local-runtime/src/process-manager.ts
var import_child_process = require("child_process");
var OUTPUT_MAX_ENTRIES = 400;
var OUTPUT_MAX_CHARS = 2e5;
var FINISHED_LIMIT = 24;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function randomId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function totalChars(entries) {
  return entries.reduce((sum, e) => sum + e.text.length, 0);
}
var ProcessManager = class {
  constructor(workspaceRoot, policy = {}) {
    this.workspaceRoot = workspaceRoot;
    this.policy = policy;
  }
  processes = /* @__PURE__ */ new Map();
  setPolicy(policy) {
    this.policy = policy;
  }
  buildEnv() {
    const source = process.env;
    const keys = process.platform === "win32" ? [
      "APPDATA",
      "ComSpec",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "PATH",
      "PATHEXT",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "PYTHONIOENCODING",
      "SystemRoot",
      "TEMP",
      "TMP",
      "USERPROFILE"
    ] : ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
    const env2 = {};
    for (const key of keys) {
      if (typeof source[key] === "string") env2[key] = source[key];
    }
    env2.PYTHONIOENCODING = "utf-8";
    return env2;
  }
  resolveCwd(requested) {
    try {
      const cwd = resolveWorkspaceCwd(this.workspaceRoot, requested);
      return { ok: true, cwd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  launch(options) {
    const { command, args, cwd, allowStdin = false } = options;
    validateArgs(command, args, { workspaceRoot: this.workspaceRoot, cwd, policy: this.policy });
    const plan = planSpawn(command, args);
    const child = (0, import_child_process.spawn)(plan.command, plan.args, {
      cwd,
      env: this.buildEnv(),
      shell: plan.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const record = {
      handleId: randomId("proc"),
      command,
      args,
      cwd,
      displayCommand: [command, ...args].join(" "),
      allowStdin,
      status: "running",
      exitCode: null,
      startedAt: nowIso(),
      startedAtMs: Date.now(),
      finishedAt: null,
      finishedAtMs: null,
      cancelRequested: false,
      nextCursor: 0,
      outputEntries: [],
      outputTruncated: false,
      child
    };
    this.processes.set(record.handleId, record);
    const append = (stream, text) => {
      record.outputEntries.push({ cursor: record.nextCursor++, stream, text, timestamp: nowIso() });
      while (record.outputEntries.length > OUTPUT_MAX_ENTRIES || totalChars(record.outputEntries) > OUTPUT_MAX_CHARS) {
        record.outputEntries.shift();
        record.outputTruncated = true;
      }
    };
    const finish = (code) => {
      if (record.status !== "running") return;
      record.exitCode = code;
      record.status = record.cancelRequested ? "cancelled" : code === 0 ? "completed" : "failed";
      record.finishedAt = nowIso();
      record.finishedAtMs = Date.now();
      this.pruneFinished();
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => append("stderr", chunk.toString("utf8")));
    child.on("error", (err) => {
      append("stderr", err.message);
      finish(null);
    });
    child.on("exit", (code) => finish(code));
    return record;
  }
  get(handleId) {
    return this.processes.get(handleId) ?? null;
  }
  kill(handleId) {
    const record = this.get(handleId);
    if (!record || record.status !== "running") return false;
    record.cancelRequested = true;
    try {
      record.child.kill();
    } catch {
      return false;
    }
    setTimeout(() => {
      if (record.status !== "running") return;
      try {
        record.child.kill("SIGKILL");
      } catch {
      }
    }, 1500);
    return true;
  }
  sendInput(handleId, input) {
    const record = this.get(handleId);
    if (!record) return { ok: false, error: `Unknown process: ${handleId}` };
    if (record.status !== "running") return { ok: false, error: "Process is not running." };
    if (!record.allowStdin) return { ok: false, error: "Process does not accept stdin." };
    try {
      record.child.stdin?.write(input);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  readOutput(handleId, cursor, limit) {
    const record = this.get(handleId);
    if (!record) return null;
    const safeLimit = Math.min(Math.max(Number(limit ?? 40), 1), 200);
    const requestedCursor = Math.max(0, Number(cursor ?? 0));
    const availableFrom = record.outputEntries[0]?.cursor ?? record.nextCursor;
    const sliceStart = Math.max(0, requestedCursor - availableFrom);
    const entries = record.outputEntries.slice(sliceStart, sliceStart + safeLimit);
    const nextCursor = entries.length ? entries[entries.length - 1].cursor + 1 : Math.max(requestedCursor, availableFrom);
    return {
      availableFrom,
      entries,
      nextCursor,
      truncated: record.outputTruncated && requestedCursor < availableFrom
    };
  }
  serialize(handleId) {
    const record = this.get(handleId);
    if (!record) return null;
    return {
      handleId: record.handleId,
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      displayCommand: record.displayCommand,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? void 0,
      allowStdin: record.allowStdin,
      cancelled: record.cancelRequested
    };
  }
  pruneFinished() {
    const finished = Array.from(this.processes.values()).filter((r) => r.status !== "running").sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
    for (const r of finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT))) {
      this.processes.delete(r.handleId);
    }
  }
};

// ../../packages/local-runtime/src/shell.ts
var SHELL_TIMEOUT_MS = 6e4;
var STDOUT_MAX = 128 * 1024;
var STDERR_MAX = 32 * 1024;
function buildEnv() {
  const src = process.env;
  const keys = process.platform === "win32" ? [
    "APPDATA",
    "ComSpec",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PYTHONIOENCODING",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE"
  ] : ["HOME", "LANG", "LC_ALL", "PATH", "PYTHONIOENCODING", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
  const env2 = {};
  for (const key of keys) {
    if (typeof src[key] === "string") env2[key] = src[key];
  }
  env2.PYTHONIOENCODING = "utf-8";
  return env2;
}
function handleShell(payload, workspaceRoot, policy = {}) {
  const command = String(payload.command || "").trim();
  const args = Array.isArray(payload.args) ? payload.args.map((a) => String(a)).filter(Boolean) : [];
  const confirmed = payload.confirmed === true;
  const timeoutMs = Math.min(Math.max(Number(payload.timeout) || SHELL_TIMEOUT_MS, 1e3), 10 * 60 * 1e3);
  if (!command) return { ok: false, error: "Missing command." };
  const outcome = resolveShellConfirmation(command, args, confirmed, payload.allowedBinaries, policy);
  if (outcome.kind === "denied") return { ok: false, error: outcome.error };
  let cwd;
  try {
    cwd = resolveWorkspaceCwd(workspaceRoot, payload.cwd);
    validateArgs(command, args, { workspaceRoot, cwd, policy });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.kind === "confirm") {
    return { ok: true, requiresConfirmation: true, tier: outcome.tier, description: outcome.description, unrecognizedCommand: outcome.unrecognizedCommand };
  }
  const plan = planSpawn(command, args);
  const result = (0, import_child_process2.spawnSync)(plan.command, plan.args, {
    cwd,
    env: buildEnv(),
    shell: plan.shell,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    ok: true,
    exitCode: typeof result.status === "number" ? result.status : null,
    stdout: (result.stdout || "").slice(0, STDOUT_MAX),
    stderr: (result.stderr || "").slice(0, STDERR_MAX),
    timedOut: result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT",
    tier: outcome.tier,
    cwd
  };
}

// ../../packages/local-runtime/src/file-ops.ts
var import_fs = __toESM(require("fs"), 1);
var import_path3 = __toESM(require("path"), 1);
var READ_MAX_BYTES = 256 * 1024;
var EXCLUDED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "out", ".next", "__pycache__", ".venv", "venv"]);
function listDirectory(workspaceRoot, target, limit = 500) {
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const raw = import_fs.default.readdirSync(resolved, { withFileTypes: true });
    const entries = raw.slice(0, limit).map((entry) => {
      let sizeBytes = null;
      let modifiedAt = null;
      try {
        const stat = import_fs.default.statSync(import_path3.default.join(resolved, entry.name));
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch {
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        sizeBytes,
        modifiedAt
      };
    });
    return { ok: true, path: resolved, entries, truncated: raw.length > limit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function readFile(workspaceRoot, target) {
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const stat = import_fs.default.statSync(resolved);
    if (stat.size > READ_MAX_BYTES) return { ok: false, error: `File too large (${stat.size} bytes, max ${READ_MAX_BYTES}).` };
    const content = import_fs.default.readFileSync(resolved, "utf8");
    return { ok: true, path: resolved, content, sizeBytes: stat.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function writeFile(workspaceRoot, target, content, confirmed) {
  if (typeof content !== "string") return { ok: false, error: "content must be a string." };
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!confirmed) return { ok: false, requiresConfirmation: true, tier: "write", description: `Write file: ${resolved}`, error: "Confirmation required." };
  try {
    import_fs.default.mkdirSync(import_path3.default.dirname(resolved), { recursive: true });
    import_fs.default.writeFileSync(resolved, content, "utf8");
    return { ok: true, path: resolved, bytesWritten: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function deletePath(workspaceRoot, target, confirmed) {
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!confirmed) return { ok: false, requiresConfirmation: true, tier: "destructive", description: `Delete path: ${resolved}`, error: "Confirmation required." };
  try {
    const stat = import_fs.default.statSync(resolved);
    if (stat.isDirectory()) {
      import_fs.default.rmSync(resolved, { recursive: true, force: true });
    } else {
      import_fs.default.unlinkSync(resolved);
    }
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function createDirectory(workspaceRoot, target) {
  let projectPath;
  try {
    projectPath = resolveWorkspacePath(workspaceRoot, target, { label: "path" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    import_fs.default.mkdirSync(projectPath, { recursive: true });
    return { ok: true, path: projectPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function glob(workspaceRoot, searchPath, pattern, maxResults = 200) {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, searchPath, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const limit = Math.min(maxResults, 1e3);
  function globToRegex(glob2) {
    const normalized = glob2.replace(/\\/g, "/");
    let re = "";
    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      if (c === "*" && normalized[i + 1] === "*") {
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "[") {
        const end = normalized.indexOf("]", i);
        if (end > i) {
          re += normalized.slice(i, end + 1);
          i = end;
        } else re += "\\[";
      } else if ("^$+.(){}|\\".includes(c)) re += "\\" + c;
      else re += c;
    }
    return new RegExp("^" + re + "$", process.platform === "win32" ? "i" : "");
  }
  let regex;
  try {
    regex = globToRegex(pattern);
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
  const results = [];
  function walk(dir, depth) {
    if (depth > 12 || results.length >= limit) return;
    let entries;
    try {
      entries = import_fs.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const childPath = import_path3.default.join(dir, entry.name);
      const relPath = import_path3.default.relative(resolved, childPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (regex.test(relPath)) results.push(relPath + "/");
        walk(childPath, depth + 1);
      } else if (entry.isFile() && regex.test(relPath)) {
        results.push(relPath);
      }
    }
  }
  try {
    let stat;
    try {
      stat = import_fs.default.statSync(resolved);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!stat.isDirectory()) resolved = import_path3.default.dirname(resolved);
    walk(resolved, 0);
    return { ok: true, path: resolved, pattern, results, truncated: results.length >= limit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
var SEARCH_MAX_FILE_BYTES = 512 * 1024;
function searchFiles(workspaceRoot, searchPath, pattern, options = {}) {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  let resolved;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, searchPath, { label: "path", defaultToRoot: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const limit = Math.min(options.maxResults ?? 100, 500);
  let regex;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "" : "i");
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
  const results = [];
  const scanFile = (filePath, relBase) => {
    let stat2;
    try {
      stat2 = import_fs.default.statSync(filePath);
    } catch {
      return;
    }
    if (stat2.size > SEARCH_MAX_FILE_BYTES) return;
    let text;
    try {
      text = import_fs.default.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      if (regex.test(lines[i])) {
        results.push({ file: import_path3.default.relative(relBase, filePath).replace(/\\/g, "/"), line: i + 1, text: lines[i].slice(0, 300) });
      }
    }
  };
  function walk(dir, depth) {
    if (depth > 8 || results.length >= limit) return;
    let entries;
    try {
      entries = import_fs.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(import_path3.default.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const filePath = import_path3.default.join(dir, entry.name);
        if (options.include && !entry.name.includes(options.include) && !filePath.includes(options.include)) continue;
        scanFile(filePath, resolved);
      }
    }
  }
  let stat;
  try {
    stat = import_fs.default.statSync(resolved);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isFile()) {
    scanFile(resolved, import_path3.default.dirname(resolved));
    return { ok: true, path: resolved, pattern, results, truncated: results.length >= limit };
  }
  walk(resolved, 0);
  return { ok: true, path: resolved, pattern, results, truncated: results.length >= limit };
}

// ../../packages/local-runtime/src/git.ts
var import_child_process3 = require("child_process");
var import_path4 = __toESM(require("path"), 1);
var GIT_TIMEOUT_MS = 3e4;
var LOG_UNIT = "";
var LOG_RECORD = "";
function safeStr(value) {
  return typeof value === "string" ? value.trim() : "";
}
function runGitSync(cwd, args, env2) {
  const result = (0, import_child_process3.spawnSync)("git", args, {
    cwd,
    encoding: "utf8",
    env: env2,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error("git was not found on PATH. Install git to use git tools.");
    }
    throw result.error;
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.status === "number" ? result.status : null,
    success: result.status === 0
  };
}
function resolveCwd(rootPath, requested) {
  const rel2 = String(requested || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = import_path4.default.resolve(rootPath, rel2 || ".");
  const relative8 = import_path4.default.relative(rootPath, resolved);
  if (relative8 === ".." || relative8.startsWith(`..${import_path4.default.sep}`) || import_path4.default.isAbsolute(relative8)) {
    throw new Error(`cwd escapes the workspace root: ${requested}`);
  }
  return resolved;
}
function parseGitStatus(stdout) {
  const out = { branch: "", upstream: "", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], success: true };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        out.ahead = Number(m[1]) || 0;
        out.behind = Number(m[2]) || 0;
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const pathField = line.startsWith("2 ") ? line.split(" ").slice(9).join(" ").split("	")[0] : line.split(" ").slice(8).join(" ");
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
function parseGitLog(stdout) {
  const commits = [];
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
      message: (message ?? "").trim()
    });
  }
  return commits;
}
function parseGitDiff(stdout) {
  const files = [];
  let current = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const m = line.match(/ b\/(.+)$/);
      current = { path: m ? m[1] : "", additions: 0, deletions: 0, hunks: [] };
    } else if (!current) {
      continue;
    } else if (line.startsWith("@@")) {
      current.hunks.push(line.split("@@")[1] ? `@@${line.split("@@")[1]}@@` : line);
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
function gitStatus(cwd, env2) {
  const res = runGitSync(cwd, ["status", "--porcelain=v2", "--branch"], env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git status failed." };
  return { ok: true, data: parseGitStatus(res.stdout) };
}
function gitDiff(cwd, env2, payload) {
  const args = ["diff", "--no-color"];
  if (payload["staged"] === true) args.push("--cached");
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env2);
  if (!res.success && res.stderr) return { ok: false, code: "git_failed", message: res.stderr };
  return { ok: true, data: { ...parseGitDiff(res.stdout), raw: res.stdout.slice(0, 5e4) } };
}
function gitLog(cwd, env2, payload) {
  const limit = Math.min(Math.max(Number(payload["limit"]) || 20, 1), 200);
  const format = ["%H", "%h", "%an", "%aI", "%D", "%s"].join(LOG_UNIT) + LOG_RECORD;
  const args = ["log", `-n`, String(limit), `--format=${format}`];
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git log failed." };
  return { ok: true, data: { commits: parseGitLog(res.stdout) } };
}
function gitAdd(cwd, env2, payload) {
  const all = payload["all"] === true;
  const file = safeStr(payload["path"]);
  if (!all && !file) return { ok: false, code: "path_missing", message: "A file path or all:true is required to stage." };
  const args = all ? ["add", "-A"] : ["add", "--", file];
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git add failed." };
  return { ok: true, data: { success: true, path: file || "*", all } };
}
function gitRestore(cwd, env2, payload) {
  const file = safeStr(payload["path"]);
  if (!file) return { ok: false, code: "path_missing", message: "A file path is required." };
  const staged = payload["staged"] === true;
  const args = staged ? ["restore", "--staged", "--", file] : ["restore", "--", file];
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git restore failed." };
  return { ok: true, data: { success: true, path: file, staged } };
}
function gitCommit(cwd, env2, payload) {
  const message = safeStr(payload["message"]);
  if (!message) return { ok: false, code: "message_missing", message: "A commit message is required." };
  const args = ["commit", "-m", message];
  if (payload["all"] === true) args.splice(1, 0, "-a");
  const author = safeStr(payload["author"]);
  if (author) args.push(`--author=${author}`);
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: true, data: { success: false, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr } };
  const head = runGitSync(cwd, ["rev-parse", "HEAD"], env2);
  return { ok: true, data: { success: true, hash: head.success ? head.stdout.trim() : "", summary: res.stdout.trim() } };
}
function gitCheckout(cwd, env2, payload) {
  const branch = safeStr(payload["branch"]);
  if (!branch) return { ok: false, code: "branch_missing", message: "A branch name is required." };
  const create = payload["create"] === true;
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: true, data: { success: false, branch, created: false, stderr: res.stderr } };
  return { ok: true, data: { success: true, branch, created: create } };
}
function gitBranch(cwd, env2, payload) {
  const action = ["list", "create", "delete"].includes(payload["action"]) ? payload["action"] : "list";
  if (action === "create") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to create." };
    const res2 = runGitSync(cwd, ["branch", name], env2);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git branch failed." };
    return { ok: true, data: { action, created: name } };
  }
  if (action === "delete") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to delete." };
    const res2 = runGitSync(cwd, ["branch", "-D", name], env2);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git branch -D failed." };
    return { ok: true, data: { action, deleted: name } };
  }
  const res = runGitSync(cwd, [
    "branch",
    "--all",
    "--format=%(refname:short)%(if)%(HEAD)%(then)	*%(end)%(if)%(upstream:short)%(then)	%(upstream:short)%(end)"
  ], env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git branch failed." };
  const branches = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, ...rest] = line.split("	");
    const current = rest.includes("*");
    const upstream = rest.find((r) => r && r !== "*") ?? "";
    branches.push({ name: (name ?? "").trim(), current, upstream: upstream.trim(), remote: (name ?? "").startsWith("remotes/") });
  }
  return { ok: true, data: { action, branches } };
}
function gitStash(cwd, env2, payload) {
  const action = ["push", "pop", "list"].includes(payload["action"]) ? payload["action"] : "list";
  if (action === "list") {
    const res2 = runGitSync(cwd, ["stash", "list"], env2);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git stash list failed." };
    const stashes = res2.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, data: { action, stashes } };
  }
  const args = ["stash", action];
  if (action === "push") {
    const message = safeStr(payload["message"]);
    if (message) args.push("-m", message);
  }
  const res = runGitSync(cwd, args, env2);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || `git stash ${action} failed.` };
  return { ok: true, data: { action, success: true, summary: res.stdout.trim() } };
}
function gitPush(cwd, env2, payload) {
  const args = ["push"];
  const remote = safeStr(payload["remote"]);
  const branch = safeStr(payload["branch"]);
  if (payload["force"] === true) args.push("--force");
  if (payload["setUpstream"] === true) args.push("--set-upstream");
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  if (payload["confirmed"] !== true) {
    return {
      ok: true,
      requiresConfirmation: true,
      tier: payload["force"] === true ? "destructive" : "network",
      description: buildDescription("git", args)
    };
  }
  const res = runGitSync(cwd, args, env2);
  return {
    ok: true,
    data: { success: res.success, exitCode: res.exitCode, remote: remote || "origin", branch, stdout: res.stdout.trim(), stderr: res.stderr.trim() }
  };
}
function handleGitOp(rootPath, payload, env2) {
  let cwd;
  try {
    cwd = resolveCwd(rootPath, safeStr(payload["cwd"]));
  } catch (error) {
    return { ok: false, code: "cwd_invalid", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    switch (payload["op"]) {
      case "status":
        return gitStatus(cwd, env2);
      case "diff":
        return gitDiff(cwd, env2, payload);
      case "log":
        return gitLog(cwd, env2, payload);
      case "add":
        return gitAdd(cwd, env2, payload);
      case "restore":
        return gitRestore(cwd, env2, payload);
      case "commit":
        return gitCommit(cwd, env2, payload);
      case "checkout":
        return gitCheckout(cwd, env2, payload);
      case "branch":
        return gitBranch(cwd, env2, payload);
      case "stash":
        return gitStash(cwd, env2, payload);
      case "push":
        return gitPush(cwd, env2, payload);
      default:
        return { ok: false, code: "git_op_unsupported", message: `Unsupported git op: ${String(payload["op"] ?? "")}` };
    }
  } catch (error) {
    return { ok: false, code: "git_error", message: error instanceof Error ? error.message : String(error) };
  }
}

// ../../packages/local-runtime/src/mcp-client.ts
var import_child_process4 = require("child_process");
var RPC_TIMEOUT_MS = 3e4;
function buildHeaders(apiKey, extraHeaders) {
  const headers = { ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json, text/event-stream";
  return headers;
}
function normalizeServer(server) {
  return {
    url: typeof server.url === "string" ? server.url.trim() : "",
    apiKey: typeof server.apiKey === "string" ? server.apiKey : "",
    headers: server.headers && typeof server.headers === "object" ? server.headers : {}
  };
}
function parseSseLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const key = line.slice(0, colonIdx).trim();
  let value = line.slice(colonIdx + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { key, value };
}
function parseSseJsonRpcResponse(text) {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      return JSON.parse(data);
    } catch {
      continue;
    }
  }
  return null;
}
function parseJsonRpcResponse(text, contentType) {
  try {
    return JSON.parse(text);
  } catch {
    const isEventStream = contentType.toLowerCase().includes("text/event-stream") || /^event:|^data:/m.test(text);
    if (isEventStream) {
      const parsed = parseSseJsonRpcResponse(text);
      if (parsed) return parsed;
    }
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}
async function trySseCall(urlStr, method, params, headers) {
  const url = new URL(urlStr);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetch(urlStr, {
      method: "GET",
      headers: { ...headers, Accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`SSE GET failed with HTTP ${response.status}`);
    const ct = response.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/event-stream")) throw new Error("Response is not an event stream");
    if (!response.body) throw new Error("No response body in SSE stream");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";
    let postSent = false;
    const requestId = 1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const cleanLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (cleanLine === "") {
          if (currentData) {
            if (currentEvent === "endpoint" && !postSent) {
              const endpointUrl = new URL(currentData.trim(), url);
              if (endpointUrl.origin !== url.origin) throw new Error(`Endpoint origin mismatch: ${endpointUrl.origin}`);
              postSent = true;
              const postResponse = await fetch(endpointUrl.href, {
                method: "POST",
                headers,
                body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
                signal: controller.signal
              });
              if (!postResponse.ok) {
                const errorText = await postResponse.text().catch(() => "");
                throw new Error(`POST to endpoint failed with HTTP ${postResponse.status}: ${errorText}`);
              }
              const postCt = postResponse.headers.get("content-type") ?? "";
              if (postCt.toLowerCase().includes("application/json")) {
                const jsonText = await postResponse.text();
                try {
                  const parsed2 = JSON.parse(jsonText);
                  if (parsed2 && typeof parsed2 === "object" && parsed2["id"] === requestId) return parsed2;
                } catch {
                }
              } else {
                await postResponse.body?.cancel();
              }
            } else if (currentEvent === "message" || !currentEvent) {
              try {
                const parsed2 = JSON.parse(currentData.trim());
                if (parsed2 && typeof parsed2 === "object" && parsed2["id"] === requestId) return parsed2;
              } catch {
              }
            }
          }
          currentEvent = "";
          currentData = "";
          continue;
        }
        const parsed = parseSseLine(cleanLine);
        if (!parsed) continue;
        if (parsed.key === "event") currentEvent = parsed.value;
        else if (parsed.key === "data") currentData = currentData ? `${currentData}
${parsed.value}` : parsed.value;
      }
    }
    throw new Error("SSE connection closed before response was received");
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
    }
  }
}
async function rpcDirectPostCall(url, method, params, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(url.replace(/\/+$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = parseJsonRpcResponse(text, response.headers.get("content-type") ?? "");
    if (!response.ok) throw new Error(parsed?.["error"]?.["message"] ?? `HTTP ${response.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
async function rpcHttpCall(url, method, params, headers) {
  try {
    return await trySseCall(url, method, params, headers);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return await rpcDirectPostCall(url, method, params, headers);
  }
}
function parseCommandLine(cmdString) {
  const args = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < cmdString.length; i++) {
    const char = cmdString[i];
    if (inQuotes) {
      if (char === quoteChar) inQuotes = false;
      else current += char;
    } else {
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
      } else if (/\s/.test(char)) {
        if (current) {
          args.push(current);
          current = "";
        }
      } else current += char;
    }
  }
  if (current) args.push(current);
  return args;
}
function executeLocalStdioMcp(command, args, method, params) {
  return new Promise((resolve3, reject) => {
    const child = (0, import_child_process4.spawn)(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: true });
    let stdoutBuffer = "";
    let stderr = "";
    const requestId = 1;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Local stdio MCP server timed out."));
    }, RPC_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBuffer += chunk.toString("utf8");
      let nlIdx;
      while ((nlIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && parsed["id"] === requestId) {
            settled = true;
            clearTimeout(timer);
            child.kill();
            resolve3(parsed);
            return;
          }
        } catch {
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const line = stdoutBuffer.trim();
      if (line) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && parsed["id"] === requestId) {
            resolve3(parsed);
            return;
          }
        } catch {
        }
      }
      reject(new Error(`Local stdio MCP exited (${code}) without a valid response. Stderr: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    child.stdin.end();
  });
}
async function listMcpTools(server) {
  const s = normalizeServer(server);
  if (!s.url) throw new Error("Missing MCP URL or command.");
  if (/^https?:\/\//i.test(s.url)) {
    return rpcHttpCall(s.url, "tools/list", {}, buildHeaders(s.apiKey, s.headers));
  }
  const tokens = parseCommandLine(s.url);
  return executeLocalStdioMcp(tokens[0], tokens.slice(1), "tools/list", {});
}
async function callMcpTool(server, toolName, args) {
  const s = normalizeServer(server);
  if (!s.url) throw new Error("Missing MCP URL or command.");
  const params = { name: toolName, arguments: args };
  if (/^https?:\/\//i.test(s.url)) {
    return rpcHttpCall(s.url, "tools/call", params, buildHeaders(s.apiKey, s.headers));
  }
  const tokens = parseCommandLine(s.url);
  return executeLocalStdioMcp(tokens[0], tokens.slice(1), "tools/call", params);
}

// ../../packages/local-runtime/src/test-harness.ts
var import_child_process5 = require("child_process");
var import_fs2 = __toESM(require("fs"), 1);
var import_os = __toESM(require("os"), 1);
var import_path5 = __toESM(require("path"), 1);
function extractReporterJson(stdout) {
  for (let i = stdout.indexOf("{"); i >= 0; i = stdout.indexOf("{", i + 1)) {
    const candidate = sliceBalancedObject(stdout, i);
    if (candidate) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
      }
    }
  }
  return "";
}
function sliceBalancedObject(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}
function detectFramework(root) {
  const has = (f) => import_fs2.default.existsSync(import_path5.default.join(root, f));
  if (has("go.mod")) return "go";
  if (has("pytest.ini") || has("setup.cfg")) return "pytest";
  if (has("pyproject.toml")) {
    try {
      const txt = import_fs2.default.readFileSync(import_path5.default.join(root, "pyproject.toml"), "utf8");
      if (txt.includes("[tool.pytest") || txt.includes("[tool.pytest.ini_options]")) return "pytest";
    } catch {
    }
  }
  for (const f of ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"]) {
    if (has(f)) return "vitest";
  }
  for (const f of ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"]) {
    if (has(f)) return "jest";
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(import_fs2.default.readFileSync(import_path5.default.join(root, "package.json"), "utf8"));
      if (pkg.jest) return "jest";
      const test = pkg.scripts?.["test"] ?? "";
      if (test.includes("jest")) return "jest";
      if (test.includes("vitest")) return "vitest";
    } catch {
    }
  }
  return "unknown";
}
function runTests(root, opts = {}) {
  const framework = detectFramework(root);
  const cwd = opts.cwd ? import_path5.default.resolve(root, opts.cwd) : root;
  const timeoutMs = opts.timeoutMs ?? 12e4;
  const start = Date.now();
  switch (framework) {
    case "jest":
      return _runJest(cwd, framework, opts.filter, timeoutMs, start);
    case "vitest":
      return _runVitest(cwd, framework, opts.filter, timeoutMs, start);
    case "pytest":
      return _runPytest(cwd, framework, opts.filter, timeoutMs, start);
    case "go":
      return _runGo(cwd, framework, opts.filter, timeoutMs, start);
    default:
      return _unknownFramework(root, start);
  }
}
function _runJest(cwd, fw, filter, timeout, start) {
  const args = ["jest", "--json", "--passWithNoTests", "--no-coverage"];
  if (filter) args.push("--testPathPattern", filter);
  const res = (0, import_child_process5.spawnSync)("npx", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");
  const jsonStr = extractReporterJson(res.stdout ?? "") || (res.stdout ?? "");
  try {
    const j = JSON.parse(jsonStr);
    const failures = [];
    for (const suite of j.testResults ?? []) {
      for (const t of suite.testResults ?? []) {
        if (t.status === "failed") {
          failures.push({
            test: t.fullName ?? "(unknown)",
            message: (t.failureMessages ?? []).join("\n").slice(0, 2e3),
            location: suite.testFilePath
          });
        }
      }
    }
    return {
      ok: (j.numFailedTests ?? 0) === 0,
      framework: fw,
      passed: j.numPassedTests ?? 0,
      failed: j.numFailedTests ?? 0,
      skipped: j.numPendingTests ?? 0,
      failures,
      rawOutput: raw.slice(0, 32e3),
      durationMs: Date.now() - start
    };
  } catch {
    return _failedRun(fw, raw, start);
  }
}
function _runVitest(cwd, fw, filter, timeout, start) {
  const outFile = import_path5.default.join(import_os.default.tmpdir(), `bs-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`, "--reporter=default"];
  if (filter) args.push(filter);
  const res = (0, import_child_process5.spawnSync)("npx", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");
  let jsonStr = "";
  try {
    jsonStr = import_fs2.default.readFileSync(outFile, "utf8");
  } catch {
  } finally {
    try {
      import_fs2.default.unlinkSync(outFile);
    } catch {
    }
  }
  if (!jsonStr.trim()) jsonStr = extractReporterJson(res.stdout ?? "");
  try {
    const j = JSON.parse(jsonStr);
    const failures = [];
    for (const suite of j.testResults ?? []) {
      for (const t of suite.assertionResults ?? []) {
        if (t.status === "failed") {
          failures.push({
            test: t.fullName ?? "(unknown)",
            message: (t.failureMessages ?? []).join("\n").slice(0, 2e3),
            location: suite.name
          });
        }
      }
    }
    return {
      ok: (j.numFailedTests ?? 0) === 0,
      framework: fw,
      passed: j.numPassedTests ?? 0,
      failed: j.numFailedTests ?? 0,
      skipped: j.numPendingTests ?? 0,
      failures,
      rawOutput: raw.slice(0, 32e3),
      durationMs: Date.now() - start
    };
  } catch {
    return _failedRun(fw, raw, start);
  }
}
function _runPytest(cwd, fw, filter, timeout, start) {
  const args = ["-m", "pytest", "--tb=short", "-q"];
  if (filter) args.push("-k", filter);
  const res = (0, import_child_process5.spawnSync)("python", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 32e3);
  return _parsePytest(raw, fw, start);
}
function _parsePytest(raw, fw, start) {
  const summary = raw.match(/(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+skipped/g) ?? [];
  let passed = 0, failed = 0, skipped = 0;
  for (const m2 of summary) {
    const n = parseInt(m2);
    if (m2.includes("passed")) passed = n;
    if (m2.includes("failed")) failed = n;
    if (m2.includes("skipped")) skipped = n;
  }
  const failures = [];
  const failRe = /^FAILED (.+?) - (.+)$/gm;
  let m;
  while ((m = failRe.exec(raw)) !== null) {
    failures.push({ test: m[1] ?? "", message: m[2] ?? "" });
  }
  return { ok: failed === 0, framework: fw, passed, failed, skipped, failures, rawOutput: raw, durationMs: Date.now() - start };
}
function _runGo(cwd, fw, filter, timeout, start) {
  const args = ["test", "./...", "-v", "-count=1"];
  if (filter) args.push("-run", filter);
  const res = (0, import_child_process5.spawnSync)("go", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = ((res.stdout ?? "") + (res.stderr ?? "")).slice(0, 32e3);
  return _parseGo(raw, fw, start);
}
function _parseGo(raw, fw, start) {
  let passed = 0, failed = 0, skipped = 0;
  const failures = [];
  for (const line of raw.split("\n")) {
    if (/^--- PASS:/.test(line)) passed++;
    if (/^--- SKIP:/.test(line)) skipped++;
    if (/^--- FAIL:/.test(line)) {
      failed++;
      const m = line.match(/^--- FAIL: (\S+)/);
      failures.push({ test: m?.[1] ?? line, message: "" });
    }
  }
  const failBlocks = raw.match(/--- FAIL:[\s\S]+?(?=--- (?:PASS|FAIL|SKIP)|^FAIL\t|\z)/gm) ?? [];
  for (let i = 0; i < failures.length && i < failBlocks.length; i++) {
    const f = failures[i];
    if (f) f.message = (failBlocks[i] ?? "").slice(0, 2e3);
  }
  return { ok: failed === 0, framework: fw, passed, failed, skipped, failures, rawOutput: raw, durationMs: Date.now() - start };
}
function _failedRun(fw, raw, start) {
  const summary = raw.match(/Tests\s+(?:(\d+)\s+failed[^\n]*?)?\b(\d+)\s+passed/i);
  if (summary) {
    const failed = Number(summary[1] ?? 0);
    const passed = Number(summary[2] ?? 0);
    const skipped = Number(raw.match(/(\d+)\s+skipped/i)?.[1] ?? 0);
    return {
      ok: failed === 0,
      framework: fw,
      passed,
      failed,
      skipped,
      failures: failed > 0 ? [{ test: "(summary)", message: "Structured output was unreadable; see rawOutput for failing tests." }] : [],
      rawOutput: raw.slice(0, 32e3),
      durationMs: Date.now() - start
    };
  }
  return {
    ok: false,
    framework: fw,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [{ test: "(runner)", message: "Could not parse structured test output; see rawOutput for the full run." }],
    rawOutput: raw.slice(0, 32e3),
    durationMs: Date.now() - start
  };
}
function _unknownFramework(root, start) {
  return {
    ok: false,
    framework: "unknown",
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [{ test: "(detection)", message: `No known test framework detected in ${root}. Add jest.config.*, vitest.config.*, pytest.ini, or go.mod.` }],
    rawOutput: "",
    durationMs: Date.now() - start
  };
}

// ../../packages/local-runtime/src/subagent-runner.ts
var import_child_process6 = require("child_process");
var import_fs3 = __toESM(require("fs"), 1);
var import_path6 = __toESM(require("path"), 1);
var WORKTREE_DIR = ".blacksite/worktrees";
function createWorktree(repoRoot, taskId) {
  const safe = taskId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const branch = `blacksite/subagent-${safe}-${Date.now().toString(36)}`;
  const worktreePath = import_path6.default.join(repoRoot, WORKTREE_DIR, safe);
  import_fs3.default.mkdirSync(import_path6.default.join(repoRoot, WORKTREE_DIR), { recursive: true });
  const res = (0, import_child_process6.spawnSync)("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 3e4
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree add failed").trim() };
  }
  return { id: safe, worktreePath, branch, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function removeWorktree(repoRoot, worktreePath) {
  const res = (0, import_child_process6.spawnSync)("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 3e4
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree remove failed").trim() };
  }
  const listRes = (0, import_child_process6.spawnSync)("git", ["branch", "--list", "blacksite/subagent-*"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 1e4
  });
  const branchName = import_path6.default.basename(worktreePath);
  const branches = (listRes.stdout ?? "").split("\n").map((b) => b.trim().replace(/^\* /, ""));
  const toBranch = branches.find((b) => b.includes(branchName));
  if (toBranch) {
    (0, import_child_process6.spawnSync)("git", ["branch", "-D", toBranch], { cwd: repoRoot, encoding: "utf8", timeout: 1e4 });
  }
  return { ok: true };
}
function listWorktrees(repoRoot) {
  const res = (0, import_child_process6.spawnSync)("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 1e4
  });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr ?? "git worktree list failed").trim() };
  }
  const entries = [];
  let current = {};
  let isFirst = true;
  for (const line of (res.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.worktreePath) entries.push(current);
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
  if (current.worktreePath) entries.push(current);
  return entries;
}
function handleWorktreeOp(repoRoot, payload) {
  const op = String(payload["op"] ?? "");
  switch (op) {
    case "create": {
      const taskId = String(payload["taskId"] ?? `task_${Date.now()}`);
      return createWorktree(repoRoot, taskId);
    }
    case "remove": {
      const worktreePath = String(payload["path"] ?? "");
      if (!worktreePath) return { ok: false, error: "Missing path." };
      return removeWorktree(repoRoot, worktreePath);
    }
    case "list":
      return listWorktrees(repoRoot);
    default:
      return { ok: false, error: `Unknown worktree op: ${op}` };
  }
}

// ../../packages/local-runtime/src/service-tools.ts
var import_https = __toESM(require("https"), 1);
var import_http = __toESM(require("http"), 1);
function httpRequest(url, method, headers, body) {
  return new Promise((resolve3, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const mod = u.protocol === "https:" ? import_https.default : import_http.default;
    const opts = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : u.protocol === "https:" ? 443 : 80,
      path: u.pathname + u.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...headers,
        ...body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}
      }
    };
    const req = mod.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => resolve3({ statusCode: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { rawBody: text };
  }
}
async function apiCall(url, method, headers, body) {
  const { statusCode, body: rawBody } = await httpRequest(
    url,
    method,
    headers,
    body ? JSON.stringify(body) : void 0
  );
  const data = parseJson(rawBody);
  return { ok: statusCode >= 200 && statusCode < 300, statusCode, data };
}
var GITHUB_BASE = "https://api.github.com";
function ghHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "User-Agent": "Blacksite-Agent/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}
async function handleGithub(token, payload) {
  const op = String(payload["op"] ?? "");
  const owner = String(payload["owner"] ?? "");
  const repo = String(payload["repo"] ?? "");
  const h = ghHeaders(token);
  switch (op) {
    case "list_issues": {
      const state = String(payload["state"] ?? "open");
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues/${number}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues`, "POST", h, {
        title: payload["title"],
        body: payload["body"],
        labels: payload["labels"] ?? []
      });
    }
    case "list_prs": {
      const state = String(payload["state"] ?? "open");
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_pr": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls/${number}`, "GET", h);
    }
    case "create_pr": {
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/pulls`, "POST", h, {
        title: payload["title"],
        body: payload["body"],
        head: payload["head"],
        base: payload["base"] ?? "main"
      });
    }
    case "list_branches": {
      const limit = Math.min(Number(payload["limit"] ?? 30), 100);
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/branches?per_page=${limit}`, "GET", h);
    }
    case "get_file": {
      const filePath = String(payload["path"] ?? "");
      const ref = payload["ref"] ? `?ref=${String(payload["ref"])}` : "";
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/contents/${filePath}${ref}`, "GET", h);
    }
    case "search_code": {
      const q = encodeURIComponent(String(payload["query"] ?? ""));
      return apiCall(`${GITHUB_BASE}/search/code?q=${q}&per_page=20`, "GET", h);
    }
    case "add_comment": {
      const number = String(payload["number"] ?? "");
      return apiCall(`${GITHUB_BASE}/repos/${owner}/${repo}/issues/${number}/comments`, "POST", h, {
        body: payload["body"]
      });
    }
    default:
      return { ok: false, error: `Unknown GitHub op: ${op}` };
  }
}
function glHeaders(token) {
  return { "PRIVATE-TOKEN": token, "User-Agent": "Blacksite-Agent/1.0" };
}
async function handleGitlab(token, payload) {
  const op = String(payload["op"] ?? "");
  const host = String(payload["host"] ?? "https://gitlab.com");
  const projectId = encodeURIComponent(String(payload["projectId"] ?? ""));
  const base = `${host}/api/v4/projects/${projectId}`;
  const h = glHeaders(token);
  switch (op) {
    case "list_issues": {
      const state = String(payload["state"] ?? "opened");
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      return apiCall(`${base}/issues?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_issue": {
      return apiCall(`${base}/issues/${String(payload["iid"] ?? "")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${base}/issues`, "POST", h, {
        title: payload["title"],
        description: payload["description"],
        labels: payload["labels"]
      });
    }
    case "list_mrs": {
      const state = String(payload["state"] ?? "opened");
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      return apiCall(`${base}/merge_requests?state=${state}&per_page=${limit}`, "GET", h);
    }
    case "get_mr": {
      return apiCall(`${base}/merge_requests/${String(payload["iid"] ?? "")}`, "GET", h);
    }
    case "create_mr": {
      return apiCall(`${base}/merge_requests`, "POST", h, {
        title: payload["title"],
        description: payload["description"],
        source_branch: payload["sourceBranch"],
        target_branch: payload["targetBranch"] ?? "main"
      });
    }
    case "list_branches": {
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      return apiCall(`${base}/repository/branches?per_page=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown GitLab op: ${op}` };
  }
}
function jiraHeaders(email, token) {
  const creds = Buffer.from(`${email}:${token}`).toString("base64");
  return { "Authorization": `Basic ${creds}`, "User-Agent": "Blacksite-Agent/1.0" };
}
async function handleJira(email, token, payload) {
  const op = String(payload["op"] ?? "");
  const host = String(payload["host"] ?? "").replace(/\/$/, "");
  const base = `${host}/rest/api/3`;
  const h = jiraHeaders(email, token);
  switch (op) {
    case "list_issues": {
      const jql = String(payload["jql"] ?? "");
      const limit = Math.min(Number(payload["limit"] ?? 20), 100);
      const fields = ["summary", "status", "assignee", "priority", "issuetype", "description"];
      return apiCall(`${base}/search`, "POST", h, { jql, maxResults: limit, fields });
    }
    case "get_issue": {
      return apiCall(`${base}/issue/${String(payload["key"] ?? "")}`, "GET", h);
    }
    case "create_issue": {
      return apiCall(`${base}/issue`, "POST", h, {
        fields: {
          project: { key: payload["project"] },
          summary: payload["summary"],
          description: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(payload["description"] ?? "") }] }] },
          issuetype: { name: payload["issueType"] ?? "Task" }
        }
      });
    }
    case "update_issue": {
      const key = String(payload["key"] ?? "");
      return apiCall(`${base}/issue/${key}`, "PUT", h, { fields: payload["fields"] });
    }
    case "add_comment": {
      const key = String(payload["key"] ?? "");
      return apiCall(`${base}/issue/${key}/comment`, "POST", h, {
        body: { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: String(payload["body"] ?? "") }] }] }
      });
    }
    case "list_projects": {
      const limit = Math.min(Number(payload["limit"] ?? 50), 200);
      return apiCall(`${base}/project/search?maxResults=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Jira op: ${op}` };
  }
}
async function handleConfluence(email, token, payload) {
  const op = String(payload["op"] ?? "");
  const host = String(payload["host"] ?? "").replace(/\/$/, "");
  const base = `${host}/wiki/rest/api`;
  const h = jiraHeaders(email, token);
  switch (op) {
    case "search": {
      const q = encodeURIComponent(String(payload["query"] ?? ""));
      const limit = Math.min(Number(payload["limit"] ?? 20), 50);
      return apiCall(`${base}/content/search?cql=${q}&limit=${limit}`, "GET", h);
    }
    case "get_page": {
      const pageId = String(payload["pageId"] ?? "");
      return apiCall(`${base}/content/${pageId}?expand=body.storage,version,ancestors`, "GET", h);
    }
    case "create_page": {
      return apiCall(`${base}/content`, "POST", h, {
        type: "page",
        title: payload["title"],
        space: { key: payload["spaceKey"] },
        body: { storage: { value: String(payload["body"] ?? ""), representation: "storage" } },
        ancestors: payload["parentId"] ? [{ id: payload["parentId"] }] : void 0
      });
    }
    case "update_page": {
      const pageId = String(payload["pageId"] ?? "");
      const version = Number(payload["version"] ?? 1);
      return apiCall(`${base}/content/${pageId}`, "PUT", h, {
        version: { number: version + 1 },
        title: payload["title"],
        type: "page",
        body: { storage: { value: String(payload["body"] ?? ""), representation: "storage" } }
      });
    }
    case "list_spaces": {
      const limit = Math.min(Number(payload["limit"] ?? 25), 100);
      return apiCall(`${base}/space?limit=${limit}`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Confluence op: ${op}` };
  }
}
function sfHeaders(token) {
  return { "Authorization": `Bearer ${token}`, "User-Agent": "Blacksite-Agent/1.0" };
}
async function handleSalesforce(token, payload) {
  const op = String(payload["op"] ?? "");
  const instanceUrl = String(payload["instanceUrl"] ?? "").replace(/\/$/, "");
  const base = `${instanceUrl}/services/data/v59.0`;
  const h = sfHeaders(token);
  switch (op) {
    case "query": {
      const soql = encodeURIComponent(String(payload["soql"] ?? ""));
      return apiCall(`${base}/query?q=${soql}`, "GET", h);
    }
    case "get_object": {
      const type = String(payload["objectType"] ?? "");
      const id = String(payload["id"] ?? "");
      return apiCall(`${base}/sobjects/${type}/${id}`, "GET", h);
    }
    case "create_object": {
      const type = String(payload["objectType"] ?? "");
      return apiCall(`${base}/sobjects/${type}`, "POST", h, payload["fields"]);
    }
    case "update_object": {
      const type = String(payload["objectType"] ?? "");
      const id = String(payload["id"] ?? "");
      return apiCall(`${base}/sobjects/${type}/${id}`, "PATCH", h, payload["fields"]);
    }
    case "list_objects": {
      return apiCall(`${base}/sobjects`, "GET", h);
    }
    default:
      return { ok: false, error: `Unknown Salesforce op: ${op}` };
  }
}

// ../../packages/local-runtime/src/runtime.ts
var LocalRuntime = class {
  processes;
  workspaceRoot;
  policy;
  constructor(workspaceRoot, policy = {}) {
    this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot ?? import_os2.default.homedir());
    this.policy = policy;
    this.processes = new ProcessManager(this.workspaceRoot, policy);
  }
  /** Update the user command-permission policy in place (e.g. after a settings change). */
  setPolicy(policy) {
    this.policy = policy;
    this.processes.setPolicy(policy);
  }
  async handleMessage(message) {
    const payload = message.payload ?? {};
    try {
      let result;
      switch (message.type) {
        // ── Shell ──────────────────────────────────────────────────────────────
        case "system.shell":
          result = handleShell(payload, this.workspaceRoot, this.policy);
          break;
        // ── Long-running processes ─────────────────────────────────────────────
        case "system.process.start": {
          const command = String(payload["command"] ?? "").trim();
          const args = (Array.isArray(payload["args"]) ? payload["args"] : []).map((a) => String(a));
          const allowStdin = payload["allowStdin"] === true;
          const confirmed = payload["confirmed"] === true;
          if (!command) {
            result = { ok: false, error: "Missing command." };
            break;
          }
          const outcome = resolveShellConfirmation(command, args, confirmed, payload["allowedBinaries"], this.policy);
          if (outcome.kind === "denied") {
            result = { ok: false, error: outcome.error };
            break;
          }
          const cwdResult = this.processes.resolveCwd(String(payload["cwd"] ?? ""));
          if (!cwdResult.ok) {
            result = cwdResult;
            break;
          }
          if (outcome.kind === "confirm") {
            result = { ok: true, requiresConfirmation: true, tier: outcome.tier, description: outcome.description, unrecognizedCommand: outcome.unrecognizedCommand };
            break;
          }
          let record;
          try {
            record = this.processes.launch({ command, args, cwd: cwdResult.cwd, allowStdin });
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            break;
          }
          result = { ok: true, process: this.processes.serialize(record.handleId), tier: outcome.tier };
          break;
        }
        case "system.process.status": {
          const handleId = String(payload["handleId"] ?? "").trim();
          if (!handleId) {
            result = { ok: false, error: "Missing handleId." };
            break;
          }
          const s = this.processes.serialize(handleId);
          result = s ? { ok: true, process: s } : { ok: false, error: `Unknown process: ${handleId}` };
          break;
        }
        case "system.process.read_output": {
          const handleId = String(payload["handleId"] ?? "").trim();
          if (!handleId) {
            result = { ok: false, error: "Missing handleId." };
            break;
          }
          const s = this.processes.serialize(handleId);
          if (!s) {
            result = { ok: false, error: `Unknown process: ${handleId}` };
            break;
          }
          result = {
            ok: true,
            process: s,
            output: this.processes.readOutput(handleId, payload["cursor"], payload["limit"])
          };
          break;
        }
        case "system.process.send_input": {
          const handleId = String(payload["handleId"] ?? "").trim();
          const input = typeof payload["input"] === "string" ? payload["input"] : "";
          const r = this.processes.sendInput(handleId, input);
          result = { ...r, process: this.processes.serialize(handleId) };
          break;
        }
        case "system.process.stop": {
          const handleId = String(payload["handleId"] ?? "").trim();
          const stopped = this.processes.kill(handleId);
          result = { ok: true, stopped, process: this.processes.serialize(handleId) };
          break;
        }
        // ── File ops ───────────────────────────────────────────────────────────
        case "system.list_directory":
          result = listDirectory(this.workspaceRoot, String(payload["path"] ?? ""), payload["limit"]);
          break;
        case "system.read_file":
          result = readFile(this.workspaceRoot, String(payload["path"] ?? ""));
          break;
        case "system.write_file":
          result = writeFile(
            this.workspaceRoot,
            String(payload["path"] ?? ""),
            String(payload["content"] ?? ""),
            payload["confirmed"] === true
          );
          break;
        case "system.delete_path":
          result = deletePath(this.workspaceRoot, String(payload["path"] ?? ""), payload["confirmed"] === true);
          break;
        case "system.create_project":
          result = createDirectory(this.workspaceRoot, String(payload["path"] ?? payload["name"] ?? ""));
          break;
        case "system.mount_directory": {
          const dirPath = String(payload["path"] ?? "").trim();
          if (!dirPath) {
            result = { ok: false, error: "Missing path." };
            break;
          }
          const check = listDirectory(this.workspaceRoot, dirPath, 1);
          result = check.ok ? { ok: true, path: check.path } : { ok: false, error: `Not a directory: ${dirPath}` };
          break;
        }
        case "system.glob":
          result = glob(
            this.workspaceRoot,
            String(payload["path"] ?? ""),
            String(payload["pattern"] ?? ""),
            payload["maxResults"]
          );
          break;
        case "system.search_files":
          result = searchFiles(this.workspaceRoot, String(payload["path"] ?? ""), String(payload["pattern"] ?? ""), {
            caseSensitive: payload["caseSensitive"],
            include: payload["include"],
            maxResults: payload["maxResults"]
          });
          break;
        // ── Git ────────────────────────────────────────────────────────────────
        case "workspace.git":
          result = handleGitOp(this.workspaceRoot, payload, buildEnv());
          break;
        // ── MCP ────────────────────────────────────────────────────────────────
        case "mcp.list_tools": {
          const server = payload["server"];
          if (!server?.url) {
            result = { ok: false, error: "Missing server.url." };
            break;
          }
          result = await listMcpTools(server);
          break;
        }
        case "mcp.call_tool": {
          const server = payload["server"];
          if (!server?.url) {
            result = { ok: false, error: "Missing server.url." };
            break;
          }
          const toolName = String(payload["toolName"] ?? "");
          const toolArgs = payload["args"] && typeof payload["args"] === "object" ? payload["args"] : {};
          result = await callMcpTool(server, toolName, toolArgs);
          break;
        }
        // ── Test runner ───────────────────────────────────────────────────────
        case "test.run":
          result = runTests(
            String(payload["root"] ?? this.workspaceRoot),
            {
              filter: payload["filter"] ? String(payload["filter"]) : void 0,
              timeoutMs: payload["timeoutMs"] ? Number(payload["timeoutMs"]) : void 0,
              cwd: payload["cwd"] ? String(payload["cwd"]) : void 0
            }
          );
          break;
        case "test.detect":
          result = { ok: true, framework: detectFramework(String(payload["root"] ?? this.workspaceRoot)) };
          break;
        // ── Git worktrees ──────────────────────────────────────────────────────
        case "worktree.op":
          result = handleWorktreeOp(this.workspaceRoot, payload);
          break;
        // ── Service tools (token injected by agent-session before dispatch) ───
        case "service.github":
          result = await handleGithub(String(payload["_token"] ?? ""), payload);
          break;
        case "service.gitlab":
          result = await handleGitlab(String(payload["_token"] ?? ""), payload);
          break;
        case "service.jira":
          result = await handleJira(
            String(payload["_email"] ?? ""),
            String(payload["_token"] ?? ""),
            payload
          );
          break;
        case "service.confluence":
          result = await handleConfluence(
            String(payload["_email"] ?? ""),
            String(payload["_token"] ?? ""),
            payload
          );
          break;
        case "service.salesforce":
          result = await handleSalesforce(String(payload["_token"] ?? ""), payload);
          break;
        // ── Health ─────────────────────────────────────────────────────────────
        case "health.ping":
          result = { status: "ready", version: "0.1.0", runtime: "local-runtime" };
          break;
        default:
          return { jsonrpc: "2.0", id: 1, error: { code: -32601, message: `Unsupported message type: ${String(message.type ?? "")}` } };
      }
      return { jsonrpc: "2.0", id: 1, result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: 1, error: { code: -32e3, message: msg } };
    }
  }
};

// src/chat-provider.ts
var vscode14 = __toESM(require("vscode"));
var fs12 = __toESM(require("fs"));
var path18 = __toESM(require("path"));

// src/tools/definitions.ts
var str = (description) => ({ type: "string", description });
var num = (description) => ({ type: "number", description });
var bool = (description) => ({ type: "boolean", description });
var arr = (items, description) => ({ type: "array", items, description });
var obj = (description, properties, required = []) => ({
  type: "object",
  description,
  ...properties ? { properties } : {},
  ...properties && required.length ? { required } : {}
});
var schema = (properties, required = []) => ({
  type: "object",
  properties,
  ...required.length ? { required } : {}
});
var tool = (name, runtimeType, description, properties, required = [], runtimePayload) => ({
  name,
  runtimeType,
  description,
  input_schema: schema(properties, required),
  ...runtimePayload ? { runtimePayload } : {}
});
var githubTool = (name, op, description, properties, required = []) => tool(`github_${name}`, "service.github", description, properties, required, { op });
var gitlabTool = (name, op, description, properties, required = []) => tool(`gitlab_${name}`, "service.gitlab", description, properties, required, { op });
var jiraTool = (name, op, description, properties, required = []) => tool(`jira_${name}`, "service.jira", description, properties, required, { op });
var confluenceTool = (name, op, description, properties, required = []) => tool(`confluence_${name}`, "service.confluence", description, properties, required, { op });
var salesforceTool = (name, op, description, properties, required = []) => tool(`salesforce_${name}`, "service.salesforce", description, properties, required, { op });
var SUBAGENT_SPAWN_TOOL_DESCRIPTION_HINT = "Use proactively for independent inspection, verification, broad file triage, or evidence gathering so the parent agent can preserve context and stay focused on orchestration and synthesis.";
var WORKSPACE_TOOLS = [
  tool(
    "shell_run",
    "system.shell",
    "Execute a one-shot shell command rooted in the current workspace and return stdout/stderr. Use for build, test, lint, install, and scripted tasks.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Command arguments"),
      cwd: str("Working directory absolute path or relative to the workspace root; it must stay within the workspace"),
      confirmed: bool("Set true to confirm network or destructive operations after review"),
      timeout: num("Timeout in milliseconds, max 600000"),
      allowedBinaries: arr({ type: "string" }, "Additional binaries to allow beyond defaults")
    },
    ["command"]
  ),
  tool(
    "process_start",
    "system.process.start",
    "Launch a long-running background process such as a dev server, watcher, or REPL inside the current workspace. Returns a handleId for follow-up process tools.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Arguments"),
      cwd: str("Working directory absolute path or relative to the workspace root; it must stay within the workspace"),
      allowStdin: bool("Allow sending input via process_send_input"),
      confirmed: bool("Confirm network or destructive tier"),
      allowedBinaries: arr({ type: "string" }, "Additional allowed binaries")
    },
    ["command"]
  ),
  tool(
    "process_status",
    "system.process.status",
    "Get the status of a background process by handleId.",
    { handleId: str("Handle from process_start") },
    ["handleId"]
  ),
  tool(
    "process_read_output",
    "system.process.read_output",
    "Read buffered stdout/stderr from a background process. Use cursor for incremental reads.",
    {
      handleId: str("Handle from process_start"),
      cursor: num("Starting cursor position (0 for beginning, omit for latest)"),
      limit: num("Maximum entries to return (1-200, default 40)")
    },
    ["handleId"]
  ),
  tool(
    "process_send_input",
    "system.process.send_input",
    "Send text to stdin for a running background process. Only works when allowStdin was enabled at launch.",
    {
      handleId: str("Handle from process_start"),
      input: str("Text to write to stdin; append \\n for newline")
    },
    ["handleId", "input"]
  ),
  tool(
    "process_stop",
    "system.process.stop",
    "Stop a background process by handleId.",
    { handleId: str("Handle from process_start") },
    ["handleId"]
  ),
  tool(
    "file_list",
    "system.list_directory",
    "List files and directories at a workspace path.",
    { path: str("Absolute path or path relative to the workspace root") },
    ["path"]
  ),
  tool(
    "file_read",
    "system.read_file",
    "Read the full contents of a workspace file up to 256 KB.",
    { path: str("Absolute file path or path relative to the workspace root") },
    ["path"]
  ),
  tool(
    "file_edit",
    "editor.apply_edit",
    "Make a surgical edit to an existing file by replacing an exact string. Shows the user a side-by-side diff for approval before applying. Prefer this over file_write when modifying existing files. oldString must match the file exactly (including whitespace) and be unique unless replaceAll is set.",
    {
      path: str("File path, absolute or relative to the workspace root"),
      oldString: str("Exact text to replace, copied verbatim from the file including indentation"),
      newString: str("Replacement text"),
      replaceAll: bool("Replace every occurrence instead of requiring a unique match (default false)")
    },
    ["path", "oldString", "newString"]
  ),
  tool(
    "file_edit_batch",
    "editor.apply_edit_batch",
    "Apply multiple exact-string edits across one or more existing files in a single reviewed diff. Use for coordinated refactors where several surgical replacements should land together.",
    {
      edits: arr(
        obj("", {
          path: str("File path, absolute or relative to the workspace root"),
          oldString: str("Exact text to replace, copied verbatim from the file including indentation"),
          newString: str("Replacement text"),
          replaceAll: bool("Replace every occurrence instead of requiring a unique match")
        }, ["path", "oldString", "newString"]),
        "Exact-string edits to apply together"
      )
    },
    ["edits"]
  ),
  tool(
    "file_write",
    "system.write_file",
    "Write or overwrite a whole file inside the workspace with the provided content. Use for creating new files; prefer file_edit for changing existing files. Avoid rewriting a large existing file in one call \u2014 a long write can exceed the response output-token budget and truncate mid-file; make targeted file_edit changes instead. The extension will request approval before applying the write.",
    {
      path: str("Absolute file path or path relative to the workspace root"),
      content: str("Full file content to write"),
      confirmed: bool("Optional approval flag injected by the extension after the user approves the write")
    },
    ["path", "content"]
  ),
  tool(
    "file_delete",
    "system.delete_path",
    "Delete a file or directory inside the workspace. The extension will request approval before applying this destructive operation.",
    {
      path: str("Absolute path or path relative to the workspace root"),
      confirmed: bool("Optional approval flag injected by the extension after the user approves the delete")
    },
    ["path"]
  ),
  tool(
    "file_mkdir",
    "system.create_project",
    "Create a directory inside the workspace.",
    { path: str("Directory path to create") },
    ["path"]
  ),
  tool(
    "file_glob",
    "system.glob",
    "Glob files under a directory. Supports **, *, ?, and character ranges. Excludes node_modules, .git, dist, and similar directories by default.",
    {
      path: str("Root directory to search"),
      pattern: str("Glob pattern, for example '**/*.ts' or 'src/**/*.{ts,tsx}'"),
      maxResults: num("Maximum results (default 200, max 1000)")
    },
    ["path", "pattern"]
  ),
  tool(
    "file_search",
    "system.search_files",
    "Search file contents with a regex pattern. Returns file, line number, and matching text.",
    {
      path: str("Root directory to search \u2014 must be a directory, not a single file. To inspect one file, read it instead."),
      pattern: str("Regex pattern to search for"),
      caseSensitive: bool("Case-sensitive search (default false)"),
      include: str("Optional filename filter (substring match)"),
      maxResults: num("Maximum results (default 100, max 500)")
    },
    ["path", "pattern"]
  ),
  tool(
    "mcp_list_tools",
    "mcp.list_tools",
    "List available tools from an MCP server.",
    {
      server: obj(
        "MCP server config",
        {
          url: str("HTTP URL or stdio command line"),
          apiKey: str("Bearer token for HTTP servers (optional)"),
          headers: obj("Additional HTTP headers (optional)")
        },
        ["url"]
      )
    },
    ["server"]
  ),
  tool(
    "mcp_call_tool",
    "mcp.call_tool",
    "Call a tool on an MCP server. Use mcp_list_tools first to discover the tool name and argument schema.",
    {
      server: obj(
        "MCP server config",
        {
          url: str("HTTP URL or stdio command line"),
          apiKey: str("Bearer token for HTTP servers (optional)"),
          headers: obj("Additional HTTP headers (optional)")
        },
        ["url"]
      ),
      toolName: str("Tool name from mcp_list_tools"),
      args: obj("Tool arguments matching the target tool schema")
    },
    ["server", "toolName"]
  )
];
var DIAGNOSTICS_TOOLS = [
  tool(
    "report_problems",
    "editor.report_problems",
    "Surface findings (bugs, lint issues, review notes) in VS Code's Problems panel with clickable file locations. Replaces any problems from your previous call. Pass an empty list or clear:true to remove them.",
    {
      problems: arr(
        obj("", {
          path: str("File path, absolute or relative to the workspace root"),
          line: num("1-based line number"),
          endLine: num("1-based end line (defaults to line)"),
          column: num("1-based column (optional)"),
          endColumn: num("1-based end column (optional)"),
          severity: str("error | warning | info | hint (default warning)"),
          message: str("Human-readable problem description"),
          source: str("Optional short source label, for example 'review' or 'lint'")
        }, ["path", "line", "message"]),
        "Problems to display in the Problems panel"
      ),
      clear: bool("Clear all Blacksite-reported problems")
    }
  )
];
var codeTarget = obj(
  "Where in the code to point. Provide `symbol` (preferred) or `line`.",
  {
    path: str("File path, absolute or relative to the workspace root"),
    symbol: str("Symbol to locate by name, for example 'fetchModels' or 'ChatProvider.send' (preferred targeting)"),
    kind: str("Optional kind to disambiguate a symbol: function | method | class | interface | variable | property | constant | enum"),
    line: num("1-based line number (used when symbol is omitted)"),
    column: num("1-based column (optional, with line)"),
    matchText: str("Substring occurring on `line`; the exact column is located from it (robust alternative to column)"),
    firstMatch: bool("If the symbol name matches multiple places, use the first instead of returning candidates")
  },
  ["path"]
);
var CODE_INTEL_TOOLS = [
  tool(
    "code_insert",
    "lsp.insert",
    "Insert code relative to a symbol or line using language-aware targeting, then review the diff before applying. Use this when you need to add imports, methods, branches, or new blocks without relying on brittle full-file text matches.",
    {
      target: codeTarget,
      position: str("Where to insert relative to the target: before | after | start | end"),
      text: str("Text to insert exactly as provided")
    },
    ["target", "position", "text"]
  ),
  tool(
    "code_symbols",
    "lsp.symbols",
    "List code symbols using the language server. With `path`, returns the document's symbol tree (functions, classes, methods). With `query`, searches symbols across the whole workspace. Use this to map a file or find where something is defined.",
    {
      path: str("File path for a document symbol tree (omit to search the workspace)"),
      query: str("Workspace-wide symbol name search (omit to list a single file)"),
      limit: num("Max results for workspace search (default 100, max 500)")
    }
  ),
  tool(
    "code_navigate",
    "lsp.navigate",
    "Resolve code relationships with the language server: jump to a definition, type definition, declaration, or implementation, or find all references. Far more reliable than text search for understanding code.",
    {
      target: codeTarget,
      kind: str("definition | typeDefinition | declaration | implementation | references"),
      includeBody: bool("For definition-like kinds, include the full source of the resolved symbol (default false)"),
      context: num("Lines of surrounding context to include in each snippet (0-3, default 0)"),
      limit: num("Max locations to return (default 100, max 500)")
    },
    ["target", "kind"]
  ),
  tool(
    "code_hover",
    "lsp.hover",
    "Get the language server's hover details at a symbol: inferred type, signature, and documentation. Use to understand a type or API without reading the whole file.",
    { target: codeTarget },
    ["target"]
  ),
  tool(
    "code_diagnostics",
    "lsp.diagnostics",
    "Read live diagnostics (errors, warnings) reported by the language servers for one file or the whole workspace. Use after edits to verify nothing broke, then fix what you find.",
    {
      path: str("File path to scope diagnostics (omit for the whole workspace)"),
      severity: str("Minimum severity to include: error | warning | info | hint (includes that level and more severe)"),
      limit: num("Max problems to return (default 100, max 500)")
    }
  ),
  tool(
    "code_rename",
    "lsp.rename",
    "Rename a symbol everywhere it is used, via the language server (semantically correct across the whole project, unlike find/replace). Shows a diff of all affected files for approval. The result includes diagnostics for the changed files.",
    {
      target: codeTarget,
      newName: str("The new name for the symbol")
    },
    ["target", "newName"]
  ),
  tool(
    "code_actions",
    "lsp.actions",
    "List or apply the language's own quick-fixes and refactors (add missing import, implement interface, organize imports, fix-all, etc.) for a range. Omit `apply` to list available actions; set `apply` to a returned title to apply it (shown as a diff for approval). The result includes diagnostics for the changed files.",
    {
      path: str("File path"),
      line: num("1-based line number where the action applies"),
      endLine: num("1-based end line for a multi-line range (defaults to line)"),
      only: str("Optional kind filter, for example 'quickfix', 'refactor', or 'source.organizeImports'"),
      apply: str("Title (or title prefix) of the action to apply; omit to only list actions")
    },
    ["path", "line"]
  ),
  tool(
    "code_format",
    "lsp.format",
    "Format a file (or a line range) with the configured formatter, shown as a diff for approval. Use after editing instead of hand-aligning whitespace.",
    {
      path: str("File path"),
      range: obj("Optional line range to format", { startLine: num("1-based start line"), endLine: num("1-based end line") }, ["startLine", "endLine"])
    },
    ["path"]
  )
];
var PLAN_STEP_SHAPE = {
  title: str("Step title"),
  detail: str("Optional implementation detail or verification note"),
  acceptanceCriteria: str("Optional definition-of-done for this specific step")
};
var PLAN_PHASE_SHAPE = {
  title: str("Phase title"),
  objective: str("Optional objective for this phase"),
  risks: str("Optional current risk or consideration note for this phase"),
  dependsOn: arr({ type: "string" }, "Optional phase IDs this phase assumes are already done (informational only, not enforced)"),
  acceptanceCriteria: arr({ type: "string" }, "Optional definition-of-done bullets for this phase"),
  complexity: str("Optional coarse effort hint: small | medium | large"),
  steps: arr(obj("", PLAN_STEP_SHAPE, ["title"]), "Ordered steps in this phase")
};
var PLANNING_TOOLS = [
  tool(
    "plan_create",
    "planning.create",
    "Create a persistent phased plan for the current task or project slice. Use for multi-phase work where the user should be able to see objectives, current phase, and remaining phases across conversations. For plans with more than 2-3 phases, prefer creating the plan with just the first phase or two, then extend it with plan_update's addPhases once you've made progress \u2014 early phases are usually wrong before you've seen the codebase, and authoring every phase up front commits you to guesses before you have the evidence to make them well.",
    {
      title: str("Plan title"),
      summary: str("Short summary of the overall objective"),
      status: str("Optional initial status: draft | active"),
      phases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Ordered phases for this plan")
    },
    ["title", "phases"]
  ),
  tool(
    "plan_update",
    "planning.update",
    "Update an existing plan: advance status, edit phases/steps, append notes, add/remove/reorder phases and steps, and move a step to a different phase. Prefer this over recreating a plan when scope changes. Status fields accept natural synonyms (e.g. 'in progress', 'done', 'paused') \u2014 they are normalized. Do not modify plans the user has put on hold or cancelled unless they resume them. When extending a plan phase-by-phase, add a phaseNote or stepNote explaining what you learned before adding the next phase \u2014 that reasoning is what makes incremental planning worth doing instead of just batching everything up front.",
    {
      planId: str("Plan ID returned by plan_create or plan_list"),
      title: str("Optional new plan title"),
      summary: str("Optional new plan summary"),
      status: str("Optional plan status: draft | active | on_hold | completed | blocked | cancelled"),
      note: str("Optional plan-level note to append"),
      activePhaseId: str("Optional active phase ID"),
      addPhases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Optional new phases to append to the plan"),
      insertPhaseBeforeId: str("Optional existing phase ID \u2014 when set, addPhases are inserted immediately before this phase instead of appended to the end"),
      removePhaseId: str("Optional phase ID to remove from the plan"),
      reorderPhaseIds: arr({ type: "string" }, "Optional full reordering of this plan's phase IDs \u2014 must include every existing phase ID exactly once"),
      phaseId: str("Optional target phase ID (for phase edits / addSteps / removeStepId / reorderStepIds)"),
      phaseTitle: str("Optional new phase title"),
      phaseObjective: str("Optional new phase objective"),
      phaseStatus: str("Optional phase status: pending | in_progress | completed | blocked"),
      phaseNote: str("Optional phase note to append"),
      phaseRisks: str("Optional new current risk or consideration note for the target phase"),
      phaseDependsOn: arr({ type: "string" }, "Optional replacement list of phase IDs the target phase assumes are already done"),
      phaseAcceptanceCriteria: arr({ type: "string" }, "Optional replacement definition-of-done bullets for the target phase"),
      phaseComplexity: str("Optional coarse effort hint for the target phase: small | medium | large"),
      addSteps: arr(obj("", PLAN_STEP_SHAPE, ["title"]), "Optional new steps to append to the target phase (requires phaseId)"),
      removeStepId: str("Optional step ID or exact title to remove from the target phase"),
      reorderStepIds: arr({ type: "string" }, "Optional full reordering of the target phase's (phaseId) step IDs \u2014 must include every existing step ID in that phase exactly once"),
      moveStepId: str("Optional step ID or exact title to move to a different phase (requires moveStepToPhaseId)"),
      moveStepToPhaseId: str("Optional destination phase ID for moveStepId"),
      stepId: str("Optional target step ID or exact step title within the phase"),
      stepTitle: str("Optional new step title"),
      stepDetail: str("Optional new step detail"),
      stepStatus: str("Optional step status: pending | in_progress | completed | blocked"),
      stepNote: str("Optional step note to append"),
      stepAcceptanceCriteria: str("Optional new definition-of-done for the target step")
    },
    ["planId"]
  ),
  tool(
    "plan_list",
    "planning.list",
    "List existing plans and their phase state. Use before creating a new plan so you continue the current one when appropriate.",
    {
      activeOnly: bool("Only return active/non-cancelled plans (default true)")
    }
  ),
  tool(
    "todo_create",
    "planning.todoCreate",
    "Create live task items for the current execution phase. Use when a plan phase or investigation has 3+ concrete steps to execute or verify.",
    {
      name: str("Name for this task-items run"),
      planId: str("Optional linked plan ID"),
      phaseId: str("Optional linked phase ID"),
      steps: arr(
        obj("", {
          label: str("Short step label")
        }, ["label"]),
        "Ordered task-item steps"
      )
    },
    ["steps"]
  ),
  tool(
    "todo_update",
    "planning.todoUpdate",
    "Update the status of one task-item step. Keep this current while work is actually happening so the user can see active progress.",
    {
      todoId: str("Task-items run ID"),
      stepId: str("Step ID, numeric alias, or exact step label"),
      status: str("Step status: running | done | failed"),
      result: str("Optional evidence or outcome note")
    },
    ["todoId", "stepId", "status"]
  ),
  tool(
    "todo_status",
    "planning.todoStatus",
    "Return the current status of one task-items run, or the latest active run if todoId is omitted.",
    {
      todoId: str("Optional task-items run ID")
    }
  ),
  tool(
    "todo_list",
    "planning.todoList",
    "List current task-items runs. Use before creating a new one so you continue existing tracked work when appropriate.",
    {
      activeOnly: bool("Only return active runs (default true)"),
      planId: str("Optional linked plan ID filter")
    }
  )
];
var MEMORY_TOOLS = [
  tool(
    "memory_append",
    "memory.append",
    "Append a durable, timestamped note to project memory (.blacksite/memory.md). Use for decisions, conventions, gotchas, or facts worth remembering across sessions. Memory is read back into context at the start of future conversations.",
    { note: str("A concise, self-contained fact or decision to remember.") },
    ["note"]
  ),
  tool(
    "memory_read",
    "memory.read",
    "Read the current project memory (.blacksite/memory.md) and project context (.blacksite/context.md).",
    {}
  )
];
var DATA_TOOLS = [
  tool(
    "db_list_objects",
    "data.list_objects",
    "List the local database catalog: tables, views, vector collections, saved queries, and jobs. Inspect this before proposing SQL so you use real object names.",
    {}
  ),
  tool(
    "db_describe_object",
    "data.describe_object",
    "Describe a table or view: columns, types, indexes, row count, and DDL. Use to ground SQL in the real schema.",
    { name: str("Table or view name") },
    ["name"]
  ),
  tool(
    "db_preview_rows",
    "data.preview_rows",
    "Preview rows from a table or view with pagination and an optional case-insensitive text filter. Read-only.",
    {
      name: str("Table or view name"),
      limit: num("Max rows to return (default 50, max 1000)"),
      offset: num("Row offset for pagination"),
      filter: str("Optional case-insensitive filter across text columns")
    },
    ["name"]
  ),
  tool(
    "db_run_read_query",
    "data.run_read_query",
    "Run a read-only SQL statement (SELECT / WITH / EXPLAIN / read PRAGMA) and return rows. Write or destructive statements are rejected \u2014 use db_preview_write_query for those.",
    {
      sql: str("A single read-only SQL statement"),
      maxRows: num("Maximum rows to return (default 200)")
    },
    ["sql"]
  ),
  tool(
    "db_preview_write_query",
    "data.preview_write_query",
    "Classify a write/DDL statement WITHOUT executing it, returning whether it is a write or destructive and what confirmation it needs. The agent never executes writes directly; surface this to the user for approval.",
    { sql: str("A single SQL statement to classify") },
    ["sql"]
  ),
  tool(
    "db_vector_search",
    "data.vector_search",
    "Semantic nearest-neighbour search over the local vector store. Provide query text (embedded locally) or a raw vector.",
    {
      text: str("Query text to embed and search with"),
      vector: arr({ type: "number" }, "Optional precomputed query vector (overrides text)"),
      topK: num("Number of results (default 10)"),
      collection: str("Optional collection name to scope the search")
    }
  ),
  tool(
    "db_list_saved_queries",
    "data.list_saved_queries",
    "List saved queries with their names and SQL so you can reuse or continue prior analysis.",
    {}
  )
];
var GIT_TOOLS = [
  tool(
    "git_op",
    "workspace.git",
    "Perform a structured git operation such as status, diff, log, stage, restore, commit, checkout, branch, stash, or push.",
    {
      op: str("Operation: status | diff | log | add | restore | commit | checkout | branch | stash | push"),
      cwd: str("Sub-directory within workspace root (optional)"),
      path: str("File path for diff, log, add, or restore"),
      staged: bool("For diff: show --cached. For restore: unstage instead of discard"),
      all: bool("For add: stage all. For commit: commit all"),
      message: str("Commit message or stash message"),
      author: str("Author override for commit, for example 'Name <email>'"),
      limit: num("For log: number of commits (default 20, max 200)"),
      branch: str("Branch name for checkout or push"),
      create: bool("For checkout: create new branch"),
      action: str("For branch: list | create | delete. For stash: push | pop | list"),
      name: str("For branch create/delete: branch name"),
      remote: str("For push: remote name (default origin)"),
      force: bool("For push: force push"),
      setUpstream: bool("For push: set upstream"),
      confirmed: bool("For push: confirm after review")
    },
    ["op"]
  )
];
var TEST_TOOLS = [
  tool(
    "test_detect",
    "test.detect",
    "Detect the test framework used in the workspace.",
    { root: str("Workspace root path (defaults to workspace root)") }
  ),
  tool(
    "test_run",
    "test.run",
    "Run the test suite and return pass/fail counts with failure details.",
    {
      root: str("Workspace root (defaults to workspace root)"),
      filter: str("Test name filter or framework-specific pattern"),
      timeoutMs: num("Maximum execution time in milliseconds (default 120000)"),
      cwd: str("Working directory relative to workspace root")
    }
  )
];
var WORKTREE_TOOLS = [
  tool(
    "worktree_op",
    "worktree.op",
    "Manage git worktrees for isolated subagent execution.",
    {
      op: str("Operation: create | remove | list"),
      taskId: str("For create: readable task identifier for the branch name"),
      path: str("For remove: absolute path to the worktree")
    },
    ["op"]
  )
];
var SUBAGENT_TOOLS = [
  tool(
    "subagent_spawn",
    "subagent.spawn",
    "Delegate one self-contained lane to an independent subagent so the parent can preserve context and stay focused on orchestration and synthesis. " + SUBAGENT_SPAWN_TOOL_DESCRIPTION_HINT + " The subagent runs its own conversation with fresh context and tools, then returns a synthesized answer. Include all necessary context in the task because the delegated lane cannot see the parent conversation.",
    {
      task: str(
        "Clear, self-contained subtask to delegate. Include scope boundaries, expected output, and all necessary context."
      ),
      context: str("Optional additional context such as code snippets, logs, file paths, or URLs."),
      complexity: str("Optional task complexity hint: auto | standard | complex | deep."),
      label: str("Optional short lane label for the transcript."),
      parallel: bool(
        "Whether to run this subagent in parallel with other parallel subagents in the same turn. Defaults to false."
      ),
      profileId: str(
        "Optional profile ID to specialize the subagent's focus. Builtin profiles: frontend_ui, backend_api, qa_regression, repo_ops. User-defined profile IDs are also accepted."
      )
    },
    ["task"]
  )
];
var TRANSCRIPT_TOOLS = [
  tool(
    "transcript_read",
    "transcript.read",
    "Read the full conversation transcript including messages that have been compressed for context efficiency. Use this when you need to recall something from earlier in the conversation that may have been summarised. Supports keyword search and message range retrieval.",
    {
      query: str("Optional keyword or phrase to search for across the transcript. Returns matching excerpts."),
      messageRange: obj(
        "Optional: retrieve raw messages from a specific index range.",
        {
          from: num("Message index to start from (0-based, inclusive)"),
          to: num("Message index to end at (exclusive)")
        }
      )
    },
    []
  )
];
var AGENT_MEMORY_TOOLS = [
  tool(
    "memory_search",
    "memory.semantic_search",
    "Semantically search the agent's persistent memory index \u2014 past tool calls, compressed transcript chunks, and memory notes \u2014 using natural language. Use this to recall what was done in previous sessions, find similar past actions, or locate context that was compressed away. Returns ranked results with short content excerpts and ref strings you can share with transcript_read.",
    {
      query: str("Natural language query describing what you are looking for."),
      collections: arr(
        { type: "string", enum: ["tool_calls", "transcript", "memories"] },
        "Which collections to search. Omit to search all three: tool_calls (past actions), transcript (compressed history chunks), memories (saved notes)."
      ),
      topK: num("Maximum results to return (default 5, max 20).")
    },
    ["query"]
  )
];
var RESULT_PAGING_TOOLS = [
  tool(
    "tool_output_page",
    "session.tool_output_page",
    "Continue reading a previous tool call's output that was too large and got truncated. A truncated result ends with a notice giving you the exact toolCallId and offset to pass here \u2014 copy them verbatim rather than guessing. Prefer narrowing the original call (a smaller range, a tighter filter, a more specific query) over paging through everything when that would get you the answer faster. Only works for results truncated earlier in this same conversation.",
    {
      toolCallId: str('The tool call id shown in the truncation notice, e.g. "toolu_01Ab2C\u2026".'),
      offset: num("Character offset to resume reading from (0-based). Use the offset the notice suggests, or 0 to start from the beginning."),
      limit: num("Maximum characters to return in this page (default 20,000, matching the original truncation size).")
    },
    ["toolCallId"]
  ),
  tool(
    "tool_output_search",
    "session.tool_output_search",
    "Search within a previous tool call's output that was too large to read in full. Finds matching lines with surrounding context, without paging through everything. Prefer this over tool_output_page when you know roughly what you're looking for \u2014 the truncation notice's line/keyword counts are a good hint. Only works for results truncated earlier in this same conversation.",
    {
      toolCallId: str("The tool call id shown in the truncation notice."),
      pattern: str('Case-insensitive substring to search for, e.g. "AssertionError".'),
      contextLines: num("Lines of context to include before/after each match (default 2, max 10)."),
      maxMatches: num("Maximum number of matches to return (default 20, max 50).")
    },
    ["toolCallId", "pattern"]
  )
];
var SERVICE_TOOLS = [
  githubTool(
    "list_issues",
    "list_issues",
    "List issues in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      state: str("Issue state filter: open | closed | all (default open)"),
      limit: num("Maximum results (default 30, max 100)")
    },
    ["owner", "repo"]
  ),
  githubTool(
    "get_issue",
    "get_issue",
    "Fetch a single GitHub issue.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Issue number")
    },
    ["owner", "repo", "number"]
  ),
  githubTool(
    "create_issue",
    "create_issue",
    "Create a GitHub issue.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      title: str("Issue title"),
      body: str("Issue body"),
      labels: arr({ type: "string" }, "Labels")
    },
    ["owner", "repo", "title"]
  ),
  githubTool(
    "list_prs",
    "list_prs",
    "List pull requests in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      state: str("Pull request state filter: open | closed | all (default open)"),
      limit: num("Maximum results (default 30, max 100)")
    },
    ["owner", "repo"]
  ),
  githubTool(
    "get_pr",
    "get_pr",
    "Fetch a single GitHub pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Pull request number")
    },
    ["owner", "repo", "number"]
  ),
  githubTool(
    "create_pr",
    "create_pr",
    "Create a GitHub pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      title: str("Pull request title"),
      body: str("Pull request body"),
      head: str("Head branch"),
      base: str("Base branch (default main)")
    },
    ["owner", "repo", "title", "head"]
  ),
  githubTool(
    "list_branches",
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      limit: num("Maximum results (default 30, max 100)")
    },
    ["owner", "repo"]
  ),
  githubTool(
    "get_file",
    "get_file",
    "Fetch a file from a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      path: str("File path"),
      ref: str("Branch, tag, or SHA (optional)")
    },
    ["owner", "repo", "path"]
  ),
  githubTool(
    "search_code",
    "search_code",
    "Search code with GitHub's code search API.",
    {
      query: str("Code search query")
    },
    ["query"]
  ),
  githubTool(
    "add_comment",
    "add_comment",
    "Add a comment to a GitHub issue or pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Issue or pull request number"),
      body: str("Comment body")
    },
    ["owner", "repo", "number", "body"]
  ),
  gitlabTool(
    "list_issues",
    "list_issues",
    "List issues in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      state: str("Issue state filter: opened | closed | all (default opened)"),
      limit: num("Maximum results (default 20, max 100)")
    },
    ["projectId"]
  ),
  gitlabTool(
    "get_issue",
    "get_issue",
    "Fetch a single GitLab issue.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      iid: str("Issue internal ID")
    },
    ["projectId", "iid"]
  ),
  gitlabTool(
    "create_issue",
    "create_issue",
    "Create a GitLab issue.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      title: str("Issue title"),
      description: str("Issue description"),
      labels: arr({ type: "string" }, "Labels")
    },
    ["projectId", "title"]
  ),
  gitlabTool(
    "list_mrs",
    "list_mrs",
    "List merge requests in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      state: str("Merge request state filter: opened | closed | all (default opened)"),
      limit: num("Maximum results (default 20, max 100)")
    },
    ["projectId"]
  ),
  gitlabTool(
    "get_mr",
    "get_mr",
    "Fetch a single GitLab merge request.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      iid: str("Merge request internal ID")
    },
    ["projectId", "iid"]
  ),
  gitlabTool(
    "create_mr",
    "create_mr",
    "Create a GitLab merge request.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      title: str("Merge request title"),
      description: str("Merge request description"),
      sourceBranch: str("Source branch"),
      targetBranch: str("Target branch (default main)")
    },
    ["projectId", "title", "sourceBranch"]
  ),
  gitlabTool(
    "list_branches",
    "list_branches",
    "List branches in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      limit: num("Maximum results (default 20, max 100)")
    },
    ["projectId"]
  ),
  jiraTool(
    "list_issues",
    "list_issues",
    "Search Jira issues with JQL.",
    {
      host: str("Jira host URL"),
      jql: str("JQL query"),
      limit: num("Maximum results (default 20, max 100)")
    },
    ["host", "jql"]
  ),
  jiraTool(
    "get_issue",
    "get_issue",
    "Fetch a single Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key, for example FOO-123")
    },
    ["host", "key"]
  ),
  jiraTool(
    "create_issue",
    "create_issue",
    "Create a Jira issue.",
    {
      host: str("Jira host URL"),
      project: str("Project key"),
      summary: str("Issue summary"),
      description: str("Issue description"),
      issueType: str("Issue type (default Task)")
    },
    ["host", "project", "summary"]
  ),
  jiraTool(
    "update_issue",
    "update_issue",
    "Update fields on a Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key"),
      fields: obj("Fields to update")
    },
    ["host", "key", "fields"]
  ),
  jiraTool(
    "add_comment",
    "add_comment",
    "Add a comment to a Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key"),
      body: str("Comment body")
    },
    ["host", "key", "body"]
  ),
  jiraTool(
    "list_projects",
    "list_projects",
    "List Jira projects available to the user.",
    {
      host: str("Jira host URL"),
      limit: num("Maximum results (default 50, max 200)")
    },
    ["host"]
  ),
  confluenceTool(
    "search",
    "search",
    "Search Confluence content with CQL.",
    {
      host: str("Confluence host URL"),
      query: str("CQL query"),
      limit: num("Maximum results (default 20, max 50)")
    },
    ["host", "query"]
  ),
  confluenceTool(
    "get_page",
    "get_page",
    "Fetch a Confluence page with storage body and version metadata.",
    {
      host: str("Confluence host URL"),
      pageId: str("Page ID")
    },
    ["host", "pageId"]
  ),
  confluenceTool(
    "create_page",
    "create_page",
    "Create a Confluence page.",
    {
      host: str("Confluence host URL"),
      spaceKey: str("Space key"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      parentId: str("Parent page ID (optional)")
    },
    ["host", "spaceKey", "title", "body"]
  ),
  confluenceTool(
    "update_page",
    "update_page",
    "Update a Confluence page.",
    {
      host: str("Confluence host URL"),
      pageId: str("Page ID"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      version: num("Current page version")
    },
    ["host", "pageId", "title", "body", "version"]
  ),
  confluenceTool(
    "list_spaces",
    "list_spaces",
    "List Confluence spaces.",
    {
      host: str("Confluence host URL"),
      limit: num("Maximum results (default 25, max 100)")
    },
    ["host"]
  ),
  salesforceTool(
    "query",
    "query",
    "Run a Salesforce SOQL query.",
    {
      instanceUrl: str("Salesforce instance URL"),
      soql: str("SOQL query")
    },
    ["instanceUrl", "soql"]
  ),
  salesforceTool(
    "get_object",
    "get_object",
    "Fetch a Salesforce record by object type and ID.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type, for example Account or Contact"),
      id: str("Record ID")
    },
    ["instanceUrl", "objectType", "id"]
  ),
  salesforceTool(
    "create_object",
    "create_object",
    "Create a Salesforce record.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type"),
      fields: obj("Field values")
    },
    ["instanceUrl", "objectType", "fields"]
  ),
  salesforceTool(
    "update_object",
    "update_object",
    "Update a Salesforce record.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type"),
      id: str("Record ID"),
      fields: obj("Field values")
    },
    ["instanceUrl", "objectType", "id", "fields"]
  ),
  salesforceTool(
    "list_objects",
    "list_objects",
    "List available Salesforce objects.",
    {
      instanceUrl: str("Salesforce instance URL")
    },
    ["instanceUrl"]
  )
];
var BROWSER_TOOLS = [
  tool(
    "browser_navigate",
    "browser.navigate",
    "Navigate the agent's browser page to a URL. A dedicated browser window is launched on first use and reused across calls.",
    {
      url: str("Full URL to navigate to"),
      waitFor: str("Wait condition: load | networkidle (default load)")
    },
    ["url"]
  ),
  tool(
    "browser_click",
    "browser.click",
    "Click an element in the agent's browser page by CSS selector.",
    {
      selector: str("CSS selector to click")
    },
    ["selector"]
  ),
  tool(
    "browser_type",
    "browser.type_text",
    "Type text into an input or textarea in the agent's browser page.",
    {
      selector: str("CSS selector of the input or textarea"),
      text: str("Text to type")
    },
    ["selector", "text"]
  ),
  tool(
    "browser_screenshot",
    "browser.screenshot",
    "Capture a screenshot of the agent's browser page as a base64 PNG.",
    {
      fullPage: bool("Capture the full page instead of the viewport")
    }
  ),
  tool(
    "browser_get_text",
    "browser.get_text",
    "Extract text from the agent's browser page, optionally scoped to a CSS selector.",
    {
      selector: str("CSS selector to scope extraction (omit for full-page text)")
    }
  ),
  tool(
    "browser_evaluate",
    "browser.evaluate",
    "Evaluate JavaScript in the agent's browser page and return the result.",
    {
      script: str("JavaScript expression or function body to evaluate")
    },
    ["script"]
  )
];
var UI_TOOLS = [
  tool(
    "question_card",
    "ui.question_card",
    "Present the user with a question and a set of choices. The agent pauses until the user selects an option. Use when a decision requires user input before proceeding \u2014 for example, choosing between package sources, confirming a configuration choice, or selecting a strategy.",
    {
      question: str("The question to ask the user"),
      options: arr(
        obj("", {
          key: str("Unique key returned when this option is selected"),
          label: str("Button label shown to the user"),
          description: str("Optional detail shown below the label to help the user decide"),
          preview: obj("Optional live UI preview rendered in a sandboxed iframe beside the option", {
            html: str("HTML document shell (optional); defaults to an empty white page"),
            code: str("JavaScript module code to execute in the preview; use DOM APIs to render UI into document.body"),
            height: num("Preview iframe height in pixels (optional, default 160)")
          }, ["code"])
        }, ["key", "label"]),
        "Two to four options for the user to choose from"
      ),
      context: str("Optional paragraph of context shown above the options")
    },
    ["question", "options"]
  )
];
var ALL_TOOLS = [
  ...WORKSPACE_TOOLS,
  ...CODE_INTEL_TOOLS,
  ...PLANNING_TOOLS,
  ...DIAGNOSTICS_TOOLS,
  ...MEMORY_TOOLS,
  ...DATA_TOOLS,
  ...GIT_TOOLS,
  ...TEST_TOOLS,
  ...WORKTREE_TOOLS,
  ...SUBAGENT_TOOLS,
  ...TRANSCRIPT_TOOLS,
  ...AGENT_MEMORY_TOOLS,
  ...RESULT_PAGING_TOOLS,
  ...SERVICE_TOOLS,
  ...BROWSER_TOOLS,
  ...UI_TOOLS
];
var TOOL_DEFINITION_MAP = Object.fromEntries(
  ALL_TOOLS.map((toolDef) => [toolDef.name, toolDef])
);
var LEGACY_TOOL_ROUTES = [
  { name: "github_op", runtimeType: "service.github" },
  { name: "gitlab_op", runtimeType: "service.gitlab" },
  { name: "jira_op", runtimeType: "service.jira" },
  { name: "confluence_op", runtimeType: "service.confluence" },
  { name: "salesforce_op", runtimeType: "service.salesforce" }
];
var TOOL_ROUTE_MAP = Object.fromEntries(
  [...ALL_TOOLS, ...LEGACY_TOOL_ROUTES].map((toolDef) => [
    toolDef.name,
    { runtimeType: toolDef.runtimeType, runtimePayload: toolDef.runtimePayload }
  ])
);
function resolveToolDispatch(toolName, input) {
  const route = TOOL_ROUTE_MAP[toolName];
  if (!route) return { runtimeType: toolName.replace(/_/g, "."), payload: input };
  return {
    runtimeType: route.runtimeType,
    payload: { ...input, ...route.runtimePayload ?? {} }
  };
}
function validateToolInput(toolName, input) {
  const toolDef = TOOL_DEFINITION_MAP[toolName];
  if (!toolDef) return [];
  const properties = toolDef.input_schema.properties ?? {};
  const required = toolDef.input_schema.required ?? [];
  const issues = [];
  for (const key of required) {
    const schema2 = properties[key];
    const value = input[key];
    if (value === void 0 || value === null) {
      issues.push({ path: key, kind: "missing_required", message: `${key} is required.` });
      continue;
    }
    if (schema2?.["type"] === "string" && typeof value === "string" && value.trim() === "") {
      issues.push({ path: key, kind: "missing_required", message: `${key} is required.` });
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const schema2 = properties[key];
    if (!schema2 || value === void 0 || value === null) continue;
    const expected = typeof schema2["type"] === "string" ? String(schema2["type"]) : "";
    if (!expected || matchesSchemaType(value, expected)) continue;
    issues.push({
      path: key,
      kind: "invalid_type",
      message: `${key} must be ${expected}.`
    });
  }
  return issues;
}
function matchesSchemaType(value, expected) {
  switch (expected) {
    case "string":
    case "number":
    case "boolean":
      return typeof value === expected;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

// src/tool-result-paging.ts
var DEFAULT_PAGE_CHAR_LIMIT = 2e4;
var JSON_ESCAPED_NEWLINE = "\\n";
var SIGNAL_KEYWORDS = ["error", "exception", "fail", "fatal", "warning"];
function snapToLineEnd(text, start, rawEnd, boundary = "\n", lookback = 500) {
  if (rawEnd >= text.length) return rawEnd;
  const searchFloor = Math.max(start, rawEnd - lookback);
  const lastBoundary = text.lastIndexOf(boundary, rawEnd - 1);
  return lastBoundary >= searchFloor ? lastBoundary + boundary.length : rawEnd;
}
function summarizeSignals(content, boundary = "\n") {
  let lineCount = 1;
  let searchFrom = 0;
  for (; ; ) {
    const idx = content.indexOf(boundary, searchFrom);
    if (idx === -1) break;
    lineCount += 1;
    searchFrom = idx + boundary.length;
  }
  const lower = content.toLowerCase();
  const keywordHits = {};
  for (const keyword of SIGNAL_KEYWORDS) {
    let count = 0;
    let from = 0;
    for (; ; ) {
      const idx = lower.indexOf(keyword, from);
      if (idx === -1) break;
      count += 1;
      from = idx + keyword.length;
    }
    if (count > 0) keywordHits[keyword] = count;
  }
  return { lineCount, keywordHits };
}
function capToolResult(content, toolCallId, ceiling = DEFAULT_PAGE_CHAR_LIMIT, boundary = "\n") {
  if (content.length <= ceiling) return { content, overflowed: false };
  const end = snapToLineEnd(content, 0, ceiling, boundary);
  const remaining = content.length - end;
  const { lineCount, keywordHits } = summarizeSignals(content, boundary);
  const hits = Object.entries(keywordHits);
  const signalClause = hits.length ? ` ~${lineCount.toLocaleString()} lines total; contains ${hits.map(([k, n]) => `"${k}" (${n})`).join(", ")}.` : ` ~${lineCount.toLocaleString()} lines total.`;
  const notice = `

[Output truncated at ${end.toLocaleString()} of ${content.length.toLocaleString()} characters \u2014 ${remaining.toLocaleString()} remain.${signalClause} Call tool_output_page with toolCallId "${toolCallId}" and offset ${end} to continue reading, or tool_output_search with a pattern to jump to specific content.]`;
  return { content: content.slice(0, end) + notice, overflowed: true };
}
function pageResult(fullText, offset, limit = DEFAULT_PAGE_CHAR_LIMIT, boundary = "\n") {
  const start = Math.max(0, Math.min(offset, fullText.length));
  const rawEnd = Math.min(fullText.length, start + Math.max(1, limit));
  const end = snapToLineEnd(fullText, start, rawEnd, boundary);
  const hasMore = end < fullText.length;
  return {
    content: fullText.slice(start, end),
    offset: start,
    end,
    totalLength: fullText.length,
    hasMore,
    nextOffset: hasMore ? end : null
  };
}
function searchResult(fullText, pattern, options) {
  const boundary = options?.boundary ?? "\n";
  const contextLines = Math.min(Math.max(Math.floor(options?.contextLines ?? 2), 0), 10);
  const maxMatches = Math.min(Math.max(Math.floor(options?.maxMatches ?? 20), 1), 50);
  const lines = fullText.split(boundary);
  const needle = pattern.toLowerCase();
  const matches = [];
  let totalMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    totalMatches += 1;
    if (matches.length >= maxMatches) continue;
    matches.push({
      lineNumber: i + 1,
      line: lines[i],
      contextBefore: lines.slice(Math.max(0, i - contextLines), i),
      contextAfter: lines.slice(i + 1, i + 1 + contextLines)
    });
  }
  return { totalMatches, matches, truncated: totalMatches > matches.length };
}

// src/approval-gate.ts
var vscode = __toESM(require("vscode"));
var TIER_LABELS = {
  write: "file-write",
  network: "network",
  destructive: "destructive"
};
async function requestApprovalWithDetails(toolName, description, tier) {
  const label = TIER_LABELS[tier] ?? tier;
  const detail = `Tool: ${toolName}

${description}`;
  const action = await vscode.window.showWarningMessage(
    `Blacksite wants to run a ${label} operation`,
    { modal: true, detail },
    "Allow",
    "Allow All",
    "Deny"
  );
  if (action === "Allow All") return "allow_all";
  if (action === "Allow") return "allow";
  return "deny";
}

// src/checkpoint.ts
var KEY = "blacksite.checkpoint.active";
function saveCheckpoint(ctx, cp) {
  void ctx.workspaceState.update(KEY, cp);
}
function loadCheckpoint(ctx) {
  return ctx.workspaceState.get(KEY);
}
function clearCheckpoint(ctx) {
  void ctx.workspaceState.update(KEY, void 0);
}
function hasCheckpoint(ctx) {
  return ctx.workspaceState.get(KEY) !== void 0;
}

// src/bedrock-client.ts
var import_node_crypto = require("node:crypto");

// src/embedding-models.ts
var OPENAI_MODELS = [
  { model: "text-embedding-3-small", dims: 512, label: "3-small (512d) \u2014 default, fast & cheap" },
  { model: "text-embedding-3-small", dims: 1536, label: "3-small (1536d) \u2014 full quality" },
  { model: "text-embedding-3-large", dims: 1024, label: "3-large (1024d) \u2014 higher quality" },
  { model: "text-embedding-3-large", dims: 3072, label: "3-large (3072d) \u2014 max quality" }
];
var BEDROCK_MODELS = [
  { model: "amazon.titan-embed-text-v2:0", dims: 256, label: "Titan Text v2 (256d) \u2014 compact" },
  { model: "amazon.titan-embed-text-v2:0", dims: 512, label: "Titan Text v2 (512d) \u2014 default" },
  { model: "amazon.titan-embed-text-v2:0", dims: 1024, label: "Titan Text v2 (1024d) \u2014 max quality" },
  { model: "amazon.titan-embed-text-v1", dims: 1536, label: "Titan Text v1 (1536d)" },
  { model: "cohere.embed-english-v3", dims: 1024, label: "Cohere Embed English v3 (1024d)" },
  { model: "cohere.embed-multilingual-v3", dims: 1024, label: "Cohere Embed Multilingual v3 (1024d)" }
];
var EMBEDDING_MODELS = {
  openai: OPENAI_MODELS.map((m) => ({ ...m, provider: "openai" })),
  openrouter: OPENAI_MODELS.map((m) => ({ ...m, provider: "openrouter" })),
  bedrock: BEDROCK_MODELS.map((m) => ({ ...m, provider: "bedrock" }))
};
var DEFAULT_EMBEDDING_SPEC = { model: "text-embedding-3-small", dims: 512 };
var BEDROCK_DEFAULT_SPEC = { model: "amazon.titan-embed-text-v2:0", dims: 512 };
function defaultEmbeddingForProvider(provider) {
  return provider === "bedrock" ? { ...BEDROCK_DEFAULT_SPEC } : { ...DEFAULT_EMBEDDING_SPEC };
}
function isTitanV2EmbeddingModel(modelId) {
  return modelId.startsWith("amazon.titan-embed-text-v2");
}
function isTitanEmbeddingModel(modelId) {
  return modelId.startsWith("amazon.titan-embed");
}
function isCohereEmbeddingModel(modelId) {
  return modelId.startsWith("cohere.embed");
}
var TITAN_V2_ALLOWED_DIMS = [256, 512, 1024];
function buildBedrockEmbeddingBody(modelId, text, dims) {
  const inputText = text.slice(0, 8e3);
  if (isTitanV2EmbeddingModel(modelId)) {
    const requested = dims && TITAN_V2_ALLOWED_DIMS.includes(dims) ? dims : 1024;
    return { inputText, dimensions: requested, normalize: true };
  }
  if (isTitanEmbeddingModel(modelId)) {
    return { inputText };
  }
  if (isCohereEmbeddingModel(modelId)) {
    return { texts: [inputText], input_type: "search_document", truncate: "END" };
  }
  return { inputText };
}
function parseBedrockEmbeddingResponse(_modelId, data) {
  if (!data || typeof data !== "object") return [];
  const record = data;
  if (Array.isArray(record.embedding)) return record.embedding.map(Number);
  const embs = record.embeddings;
  if (Array.isArray(embs) && Array.isArray(embs[0])) return embs[0].map(Number);
  if (embs && typeof embs === "object") {
    const byType = embs.float ?? embs.int8;
    if (Array.isArray(byType) && Array.isArray(byType[0])) return byType[0].map(Number);
  }
  return [];
}

// src/bedrock-client.ts
var ALGORITHM = "AWS4-HMAC-SHA256";
function sha256Hex(data) {
  return (0, import_node_crypto.createHash)("sha256").update(data, "utf8").digest("hex");
}
function hmac(key, data) {
  return (0, import_node_crypto.createHmac)("sha256", key).update(data, "utf8").digest();
}
function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
function getAmzDate() {
  const now = /* @__PURE__ */ new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
function canonicalizePathname(pathname) {
  if (!pathname) return "/";
  return pathname.split("/").map((segment) => encodeRfc3986(segment)).join("/") || "/";
}
function canonicalizeQuery(searchParams) {
  const entries = [];
  searchParams.forEach((value, key) => entries.push([key, value]));
  return entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) return aValue.localeCompare(bValue);
    return aKey.localeCompare(bKey);
  }).map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join("&");
}
function signBedrockRequest(creds, method, url, headers, body, service = "bedrock") {
  const { amzDate, dateStamp } = getAmzDate();
  const parsed = new URL(url);
  const signedHeadersList = ["content-type", "host", "x-amz-date"];
  if (creds.sessionToken) signedHeadersList.push("x-amz-security-token");
  signedHeadersList.sort();
  const allHeaders = {
    ...headers,
    host: parsed.host,
    "x-amz-date": amzDate
  };
  if (creds.sessionToken) allHeaders["x-amz-security-token"] = creds.sessionToken;
  const canonicalHeaders = signedHeadersList.map((h) => `${h}:${allHeaders[h]?.trim() ?? ""}`).join("\n") + "\n";
  const signedHeaders = signedHeadersList.join(";");
  const payloadHash = sha256Hex(body);
  const canonicalUri = canonicalizePathname(parsed.pathname);
  const canonicalQuery = canonicalizeQuery(parsed.searchParams);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${creds.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSigningKey(creds.secretAccessKey, dateStamp, creds.region, service);
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const result = {
    ...headers,
    "x-amz-date": amzDate,
    Authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (creds.sessionToken) result["x-amz-security-token"] = creds.sessionToken;
  return result;
}
function buildRequestBody(opts) {
  const body = {
    modelId: opts.modelId,
    messages: opts.messages,
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 4096
    }
  };
  if (!opts.thinking?.enabled) {
    body.inferenceConfig.temperature = opts.temperature ?? 0.7;
  }
  const CACHE_POINT = { cachePoint: { type: "default" } };
  if (opts.systemPrompt) {
    const systemBlocks = [
      { text: opts.systemPrompt },
      CACHE_POINT
    ];
    if (opts.compressedSummary) {
      systemBlocks.push({
        text: `---
[COMPRESSED CONVERSATION HISTORY \u2014 earlier messages summarised for context efficiency]
${opts.compressedSummary}
---`
      });
    }
    body.system = systemBlocks;
  }
  if (opts.tools?.length) {
    body.toolConfig = { tools: opts.tools };
  }
  if (opts.thinking?.enabled) {
    body.performanceConfig = {
      thinking: {
        type: "enabled",
        budgetTokens: opts.thinking.budgetTokens ?? 1e4
      }
    };
  }
  return body;
}
function bedrockEndpoint(region) {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}
function mantleEndpoint(region) {
  return `https://bedrock-mantle.${region}.api.aws`;
}
async function mantleMessage(opts, signal) {
  const url = `${mantleEndpoint(opts.credentials.region)}/anthropic/v1/messages`;
  const reqBody = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: opts.messages
  };
  if (opts.system) reqBody["system"] = opts.system;
  const body = JSON.stringify(reqBody);
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body, "bedrock-mantle");
  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  return await response.json();
}
async function readBedrockError(response) {
  const errorText = await response.text().catch(() => "");
  try {
    const ej = JSON.parse(errorText);
    return `Bedrock ${response.status}: ${ej.message ?? ej.Message ?? errorText}`;
  } catch {
    return `Bedrock ${response.status}: ${errorText}`;
  }
}
async function* streamBedrockConverse(opts, signal) {
  const url = `${bedrockEndpoint(opts.credentials.region)}/model/${encodeURIComponent(opts.modelId)}/converse-stream`;
  const body = JSON.stringify(buildRequestBody(opts));
  const headers = {
    "content-type": "application/json",
    accept: "application/vnd.amazon.eventstream"
  };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body);
  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  if (!response.body) throw new Error("No response body from Bedrock");
  yield* parseEventStream(response.body);
}
async function* parseEventStream(body) {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        if (buffer.length < totalLength) break;
        const headersLength = view.getUint32(4);
        const headerBytes = buffer.slice(12, 12 + headersLength);
        const payloadStart = 12 + headersLength;
        const payloadEnd = totalLength - 4;
        const payloadBytes = buffer.slice(payloadStart, payloadEnd);
        const eventHeaders = parseEventHeaders(headerBytes);
        const eventType = eventHeaders[":event-type"] ?? eventHeaders[":exception-type"];
        if (eventType && payloadBytes.length > 0) {
          const payloadText = decoder.decode(payloadBytes);
          try {
            const data = JSON.parse(payloadText);
            yield { eventType, data };
          } catch {
          }
        }
        buffer = buffer.slice(totalLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function parseEventHeaders(bytes) {
  const headers = {};
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset];
    offset += 1;
    const name = decoder.decode(bytes.slice(offset, offset + nameLength));
    offset += nameLength;
    const valueType = bytes[offset];
    offset += 1;
    if (valueType === 7) {
      const valueLength = bytes[offset] << 8 | bytes[offset + 1];
      offset += 2;
      headers[name] = decoder.decode(bytes.slice(offset, offset + valueLength));
      offset += valueLength;
    } else {
      break;
    }
  }
  return headers;
}
async function converseBedrock(opts, signal) {
  const url = `${bedrockEndpoint(opts.credentials.region)}/model/${encodeURIComponent(opts.modelId)}/converse`;
  const body = JSON.stringify(buildRequestBody(opts));
  const headers = { "content-type": "application/json", accept: "application/json" };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body);
  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  return await response.json();
}
async function invokeBedrockEmbedding(credentials, modelId, text, dims, signal) {
  const url = `${bedrockEndpoint(credentials.region)}/model/${encodeURIComponent(modelId)}/invoke`;
  const body = JSON.stringify(buildBedrockEmbeddingBody(modelId, text, dims));
  const headers = { "content-type": "application/json", accept: "application/json" };
  const signedHeaders = signBedrockRequest(credentials, "POST", url, headers, body);
  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  const data = await response.json();
  const embedding = parseBedrockEmbeddingResponse(modelId, data);
  if (!embedding.length) throw new Error("empty Bedrock embedding response");
  return embedding;
}

// src/agent-session.ts
var DEFAULT_MAX_TOKENS = 32768;
var DEFAULT_MAX_ITER = 40;
var MAX_INTERNAL_AUTO_CONTINUE_TURNS = 3;
var RESULT_OVERFLOW_MAX_ENTRIES = 30;
var MAX_ESCALATED_OUTPUT_TOKENS = 65536;
var MAX_SUMMARY_CHARS = 3e4;
var FULL_HISTORY_CHECKPOINT_CADENCE = 10;
var BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS = 64e3;
function resolveOutputCeiling(model, provider) {
  const id = (model ?? "").toLowerCase();
  if (provider === "bedrock" && /claude/.test(id)) return BEDROCK_CLAUDE_MAX_OUTPUT_TOKENS;
  return null;
}
var INTERNAL_AUTO_CONTINUE_PROMPT = [
  "[Internal continuation]",
  "Continue working on the current task.",
  "Do not stop yet unless the task is complete, you need user approval/input, or you are blocked by a concrete external failure.",
  "If the previous response ended right after tool work, inspect the latest result and take the next step now."
].join("\n");
var PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1/messages", authHeader: "x-api-key" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1/chat/completions", authHeader: "Bearer" },
  openai: { baseUrl: "https://api.openai.com/v1/chat/completions", authHeader: "Bearer" },
  // Bedrock signs requests per-call (SigV4) and resolves its endpoint from the
  // region; this entry only satisfies the Record type — the Bedrock path never reads it.
  bedrock: { baseUrl: "", authHeader: "x-api-key" }
};
function normalizeOpenAIStopReason(reason) {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "end_turn" || reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending" || reason === "cancelled" || reason === "error" || reason === "protocol_violation") {
    return reason;
  }
  return "protocol_violation";
}
function normalizeAnthropicStopReason(reason) {
  if (!reason || reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending" || reason === "cancelled" || reason === "error" || reason === "protocol_violation") {
    return reason;
  }
  return "protocol_violation";
}
var AgentSession = class {
  constructor(opts) {
    this.opts = opts;
    this.sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = opts.provider ?? "anthropic";
    this._signal = opts.signal;
    this._providerTurnSession = opts.providerTurnSessionFactory ? opts.providerTurnSessionFactory(this) : this._createBuiltinProviderTurnSession();
  }
  sessionId;
  messages = [];
  _iteration = 0;
  provider;
  /**
   * The abort signal is mutable because the owning BackgroundRunner creates its
   * AbortController only when a run actually starts — after this session has been
   * constructed. Reading opts.signal directly would capture `undefined` and break
   * cancellation, so the runner calls attachSignal() right before iterating.
   */
  _signal;
  /** Set once the user chooses "Allow All" — suppresses further approval prompts for this session. */
  _autoApprove = false;
  /** Accumulated JSON summary from model-based compression of older history. */
  _compressedSummary = "";
  /** Number of compressions applied this session. */
  _compressionCount = 0;
  /** Total input token count from the most recent API response (including cache tokens). */
  _lastInputTokens = 0;
  /** Whether a compression pass is currently running. */
  _isCompacting = false;
  /** Timestamp of the most recent successful compression pass. */
  _lastCompressedAt;
  /** Number of messages compacted during the most recent successful pass. */
  _lastCompressedMessageCount;
  /** Last compression failure message, if any. */
  _lastCompressionError = "";
  /** Whether the most recent compression was automatic or manual. */
  _lastCompressionTrigger;
  /** Last normalized terminal reason observed for this session. */
  _lastStopReason;
  /** Number of internal auto-continue prompts issued in the current session. */
  _autoContinueCount = 0;
  /** Set after the missing-contextLength diagnostic has been emitted once. */
  _contextLengthWarned = false;
  /** Current pending user gate, if the loop is waiting on approval or an answer. */
  _pendingGate;
  /** Timestamp when the first checkpoint was saved for this session; preserved across updates. */
  _checkpointCreatedAt;
  /** How many times _saveCheckpoint has been called; used to throttle full-history writes. */
  _checkpointCount = 0;
  /** Immutable transcript: every message ever appended, never trimmed by compression. */
  _fullHistory = [];
  /** Per-turn output-token budget override; escalates on truncation recovery, resets on success. */
  _maxTokensOverride;
  /** Set once a browser call reports the runtime missing; stops re-advertising browser tools. */
  _browserUnavailable = false;
  /**
   * Full text of tool results too large to send to the model in one piece, keyed by the
   * tool_call id the model already has from its own tool_use block — so resuming a read
   * needs no new id scheme, just the offset from the truncation notice. FIFO-evicted past
   * RESULT_OVERFLOW_MAX_ENTRIES so a long session pinning many huge outputs can't leak memory.
   */
  _resultOverflow = /* @__PURE__ */ new Map();
  /** Provider-turn session driving the next model turn. */
  _providerTurnSession;
  /** Attach (or replace) the abort signal used to cancel in-flight requests and tool calls. */
  attachSignal(signal) {
    this._signal = signal;
  }
  get iteration() {
    return this._iteration;
  }
  get history() {
    return [...this.messages];
  }
  /** Full uncompressed transcript — every message since session start, never trimmed. */
  get fullHistory() {
    return [...this._fullHistory];
  }
  get runtimeState() {
    return this._buildRuntimeState();
  }
  exportState(includeFullHistory = false) {
    const state = {
      compressedSummary: this._compressedSummary || void 0,
      compressionCount: this._compressionCount || void 0,
      lastInputTokens: this._lastInputTokens || void 0,
      lastCompressedAt: this._lastCompressedAt,
      lastCompressedMessageCount: this._lastCompressedMessageCount,
      lastCompressionError: this._lastCompressionError || void 0,
      lastCompressionTrigger: this._lastCompressionTrigger,
      contextLength: this.opts.contextLength,
      lastStopReason: this._lastStopReason,
      autoContinueCount: this._autoContinueCount || void 0,
      pendingGate: this._pendingGate,
      providerState: this._providerTurnSession.exportState?.()
    };
    if (includeFullHistory) state.fullHistory = this.fullHistory;
    return state;
  }
  restoreState(state) {
    if (state.sessionId) this.sessionId = state.sessionId;
    this.messages = [...state.messages];
    this._fullHistory = [...state.fullHistory ?? state.messages];
    this._compressedSummary = state.compressedSummary ?? "";
    this._compressionCount = state.compressionCount ?? 0;
    this._lastInputTokens = state.lastInputTokens ?? 0;
    this._lastCompressedAt = state.lastCompressedAt;
    this._lastCompressedMessageCount = state.lastCompressedMessageCount;
    this._lastCompressionError = state.lastCompressionError ?? "";
    this._lastCompressionTrigger = state.lastCompressionTrigger;
    this._lastStopReason = state.lastStopReason;
    this._autoContinueCount = state.autoContinueCount ?? 0;
    this._pendingGate = state.pendingGate;
    this._isCompacting = false;
    this._providerTurnSession.importState?.(state.providerState);
  }
  _appendUserText(text) {
    this.messages.push({ role: "user", content: text });
    this._fullHistory.push({ role: "user", content: text });
  }
  _appendAssistantTurn(result) {
    const assistantBlocks = [];
    for (const thinking of result.thinkingBlocks) assistantBlocks.push(thinking);
    if (result.text) assistantBlocks.push({ type: "text", text: result.text });
    for (const toolCall of result.toolCalls) assistantBlocks.push(toolCall);
    this.messages.push({ role: "assistant", content: assistantBlocks });
    this._fullHistory.push({ role: "assistant", content: assistantBlocks });
  }
  _appendToolResults(results) {
    this.messages.push({ role: "user", content: results });
    this._fullHistory.push({ role: "user", content: results });
  }
  _recordUsage(event) {
    this._lastInputTokens = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
  }
  _createBuiltinProviderTurnSession() {
    return {
      appendUserText: (text) => this._appendUserText(text),
      appendToolResults: (results) => this._appendToolResults(results),
      runTurn: async (sink) => {
        const thinkingBlocks = [];
        const toolCalls = [];
        let text = "";
        let stopReason;
        let usage;
        const stream = this.provider === "anthropic" ? this._streamTurnAnthropic() : this.provider === "bedrock" ? this.opts.bedrockApi === "mantle" ? this._streamTurnBedrockMantle() : this._streamTurnBedrock() : this._streamTurnOpenAI();
        for await (const event of stream) {
          sink.emit(event);
          if (event.type === "text_delta") {
            text += event.text;
          } else if (event.type === "thinking_block") {
            thinkingBlocks.push({ type: "thinking", thinking: event.text });
          } else if (event.type === "tool_use_block") {
            toolCalls.push(event.block);
          } else if (event.type === "stop_reason") {
            stopReason = event.reason;
          } else if (event.type === "usage_update") {
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens
            };
          }
        }
        let normalizedStopReason = stopReason ?? "protocol_violation";
        if (toolCalls.length > 0 && normalizedStopReason !== "tool_use") {
          normalizedStopReason = "protocol_violation";
        } else if (toolCalls.length === 0 && normalizedStopReason === "tool_use") {
          normalizedStopReason = "protocol_violation";
        }
        return {
          text,
          thinkingBlocks,
          toolCalls,
          stopReason: normalizedStopReason,
          usage,
          empty: text.trim().length === 0 && thinkingBlocks.length === 0 && toolCalls.length === 0
        };
      }
    };
  }
  _keepRecentCount() {
    return this.opts.compressionKeepRecent ?? 20;
  }
  /** Returns the output token budget for the current call, respecting any active escalation override. */
  _effectiveMaxTokens() {
    return this._clampToOutputCeiling(this._maxTokensOverride ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  }
  /** Clamp an output-token budget to what the provider/model will accept (or pass through if unknown). */
  _clampToOutputCeiling(requested) {
    const ceiling = resolveOutputCeiling(this.opts.model, this.provider);
    return ceiling != null ? Math.min(requested, ceiling) : requested;
  }
  _compressibleMessageCount() {
    const keepRecent = this._keepRecentCount();
    if (this.messages.length <= keepRecent + 4) return 0;
    return this.messages.length - keepRecent;
  }
  _buildRuntimeState() {
    const contextLength = this.opts.contextLength;
    const usagePct = contextLength && this._lastInputTokens > 0 ? Math.min(this._lastInputTokens / contextLength * 100, 100) : null;
    const activeMessageCount = this.messages.length;
    const fullMessageCount = this._fullHistory.length;
    return {
      sessionId: this.sessionId,
      contextLength,
      lastInputTokens: this._lastInputTokens,
      usagePct,
      compressionEnabled: !!this.opts.compressionProvider,
      isCompacting: this._isCompacting,
      compressionCount: this._compressionCount,
      hasCompressedHistory: !!this._compressedSummary,
      lastCompressedAt: this._lastCompressedAt,
      lastCompressedMessageCount: this._lastCompressedMessageCount,
      lastCompressionError: this._lastCompressionError || void 0,
      lastCompressionTrigger: this._lastCompressionTrigger,
      keepRecent: this._keepRecentCount(),
      activeMessageCount,
      fullMessageCount,
      compressedMessageCount: Math.max(fullMessageCount - activeMessageCount, 0),
      compressibleMessageCount: this._compressibleMessageCount(),
      lastStopReason: this._lastStopReason,
      autoContinueCount: this._autoContinueCount,
      pendingGate: this._pendingGate
    };
  }
  async manualCompact(compressionProvider) {
    const toCompress = this._compressibleMessageCount();
    if (toCompress <= 0) {
      return { ok: false, message: `Not enough history to compact yet (${this.messages.length} messages).` };
    }
    this._isCompacting = true;
    try {
      const ok = await this._compressHistory(compressionProvider, "manual");
      if (!ok) {
        return {
          ok: false,
          message: this._lastCompressionError ? `Compression failed: ${this._lastCompressionError}` : "Compression failed."
        };
      }
      return {
        ok: true,
        message: `Compression \xD7${this._compressionCount} applied. ${this.messages.length} recent messages kept.`
      };
    } finally {
      this._isCompacting = false;
    }
  }
  /**
   * Whether browser tools should be advertised this turn. We require a runner, that the runner
   * reports itself available (playwright-core actually installed), and that no earlier browser
   * call this session already reported the runtime missing. Gating advertisement — rather than
   * letting every call fail — stops the agent burning turns on a guaranteed-unavailable tool.
   */
  _browserToolsUsable() {
    const runner = this.opts.browserRunner;
    if (!runner || this._browserUnavailable) return false;
    return runner.available ? runner.available() : true;
  }
  /** Detects the "playwright-core not installed" sentinel from a browser dispatch result. */
  _isBrowserUnavailableResult(result) {
    if (!result || typeof result !== "object") return false;
    const r = result;
    return r["ok"] === false && typeof r["error"] === "string" && /playwright-core/i.test(r["error"]);
  }
  _getTools() {
    const all = [...WORKSPACE_TOOLS, ...GIT_TOOLS, ...TEST_TOOLS, ...WORKTREE_TOOLS, ...SERVICE_TOOLS, ...RESULT_PAGING_TOOLS];
    if (this.opts.subagentProvider) all.push(...SUBAGENT_TOOLS);
    if (this.opts.memoryProvider) all.push(...MEMORY_TOOLS);
    if (this.opts.planningProvider) all.push(...PLANNING_TOOLS);
    if (this.opts.dataProvider) all.push(...DATA_TOOLS);
    if (this.opts.diagnosticsProvider) all.push(...DIAGNOSTICS_TOOLS);
    if (this.opts.lspProvider) all.push(...CODE_INTEL_TOOLS);
    if (this._browserToolsUsable()) all.push(...BROWSER_TOOLS);
    if (this.opts.transcriptProvider || this._compressedSummary) all.push(...TRANSCRIPT_TOOLS);
    if (this.opts.agentMemoryIndex) all.push(...AGENT_MEMORY_TOOLS);
    const usable = this.opts.editProvider ? all : all.filter((t) => t.name !== "file_edit" && t.name !== "file_edit_batch");
    const disabled = new Set(this.opts.disabledTools ?? []);
    const filtered = disabled.size ? usable.filter((t) => !disabled.has(t.name)) : usable;
    return [...filtered, ...UI_TOOLS];
  }
  _handleTranscriptRead(payload) {
    const query = payload["query"] ? String(payload["query"]).trim() : null;
    const summarySection = this._compressedSummary ? `## Compressed History Summary
${this._compressedSummary}

` : "";
    const rangeInput = payload["messageRange"];
    if (rangeInput || query) {
      const fullHistory = this.opts.transcriptProvider?.getFullHistory() ?? [];
      if (query && !rangeInput) {
        const lq = query.toLowerCase();
        const matches = [];
        fullHistory.forEach((m, i) => {
          const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === "text" || b.type === "thinking").map((b) => b.text ?? b.thinking ?? "").join(" ") : "";
          if (text.toLowerCase().includes(lq)) {
            const idx = text.toLowerCase().indexOf(lq);
            const start = Math.max(0, idx - 100);
            const end = Math.min(text.length, idx + 200);
            matches.push(`[msg ${i}] ${m.role.toUpperCase()}: \u2026${text.slice(start, end).trim()}\u2026`);
          }
        });
        const searchResult2 = matches.length ? matches.slice(0, 20).join("\n\n") : "No matches found.";
        return { ok: true, result: `${summarySection}## Search: "${query}"
${searchResult2}` };
      }
      if (rangeInput) {
        const from = Math.max(0, Math.floor(Number(rangeInput.from ?? 0)));
        const to = Math.min(fullHistory.length, Math.ceil(Number(rangeInput.to ?? fullHistory.length)));
        const msgs = fullHistory.slice(from, to).map((m, i) => {
          const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : "";
          return `[${from + i}] ${m.role.toUpperCase()}: ${text.slice(0, 600)}${text.length > 600 ? "\u2026" : ""}`;
        });
        return { ok: true, result: `${summarySection}## Messages ${from}\u2013${to - 1}
${msgs.join("\n\n")}` };
      }
    }
    if (!summarySection) {
      return { ok: true, result: "No compressed history. All conversation history is within the active context window." };
    }
    return { ok: true, result: summarySection };
  }
  /**
   * Caps a JSON-stringified tool result before it becomes the model-facing tool_result
   * content. Results within the ceiling pass through untouched. An oversized result is
   * cut at a line boundary with a notice telling the model the toolCallId (its own
   * tool_use id — no new id scheme needed) and offset to resume from, and the original
   * is kept in `_resultOverflow` so `tool_output_page` can serve the rest on request.
   * Snaps on JSON_ESCAPED_NEWLINE (not a literal "\n") because `stringified` is
   * JSON.stringify output, where a real newline is always the two-character sequence.
   */
  _capToolResult(toolCallId, stringified) {
    const capped = capToolResult(stringified, toolCallId, DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE);
    if (capped.overflowed) {
      if (this._resultOverflow.size >= RESULT_OVERFLOW_MAX_ENTRIES) {
        const oldest = this._resultOverflow.keys().next().value;
        if (oldest !== void 0) this._resultOverflow.delete(oldest);
      }
      this._resultOverflow.set(toolCallId, stringified);
    }
    return capped.content;
  }
  /** Shared lookup for both tool_output_page and tool_output_search: resolves a toolCallId to its stored full text, or a uniform not-found error. */
  _lookupOverflow(toolCallId) {
    const fullText = this._resultOverflow.get(toolCallId);
    if (fullText === void 0) {
      return {
        ok: false,
        error: `No stored output found for toolCallId "${toolCallId}". It may never have been truncated, may already have been fully read, or may have been evicted \u2014 only the ${RESULT_OVERFLOW_MAX_ENTRIES} most recently truncated results are kept.`
      };
    }
    return { ok: true, fullText };
  }
  /** Handles the tool_output_page tool: serves a requested slice of a previously truncated result. */
  _handleToolResultPage(payload) {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };
    const lookup = this._lookupOverflow(toolCallId);
    if (!lookup.ok) return lookup;
    const offset = Math.max(0, Math.floor(Number(payload["offset"] ?? 0)) || 0);
    const limitRaw = Number(payload["limit"]);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_PAGE_CHAR_LIMIT;
    const page = pageResult(lookup.fullText, offset, limit, JSON_ESCAPED_NEWLINE);
    return {
      ok: true,
      toolCallId,
      offset: page.offset,
      totalLength: page.totalLength,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      content: page.content
    };
  }
  /** Handles the tool_output_search tool: finds matching lines with context inside a previously truncated result. */
  _handleToolResultSearch(payload) {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };
    const pattern = String(payload["pattern"] ?? "");
    if (!pattern) return { ok: false, error: "pattern is required." };
    const lookup = this._lookupOverflow(toolCallId);
    if (!lookup.ok) return lookup;
    const contextLines = Number(payload["contextLines"]);
    const maxMatches = Number(payload["maxMatches"]);
    const search = searchResult(lookup.fullText, pattern, {
      contextLines: Number.isFinite(contextLines) ? contextLines : void 0,
      maxMatches: Number.isFinite(maxMatches) ? maxMatches : void 0,
      boundary: JSON_ESCAPED_NEWLINE
    });
    return {
      ok: true,
      toolCallId,
      pattern,
      totalMatches: search.totalMatches,
      truncated: search.truncated,
      matches: search.matches
    };
  }
  async _compressHistory(compressionProvider, trigger) {
    const keepRecent = this._keepRecentCount();
    if (this.messages.length <= keepRecent + 4) return false;
    const recentStart = safeRecentStart(this.messages, keepRecent);
    if (recentStart <= 0) return false;
    const toCompress = this.messages.slice(0, recentStart);
    const recent = this.messages.slice(recentStart);
    try {
      const summary = await this._compressWithRetry(compressionProvider, toCompress);
      let chunkRef = "";
      if (this.opts.agentMemoryIndex) {
        chunkRef = await this.opts.agentMemoryIndex.indexTranscriptChunk(this.sessionId, toCompress, this._compressionCount, summary);
      }
      const passLabel = chunkRef ? `[Compression pass ${this._compressionCount + 1} \u2014 search ref:"${chunkRef}" via memory_search to retrieve full detail]` : `[Compression pass ${this._compressionCount + 1}]`;
      const newAccumulated = this._compressedSummary ? `${this._compressedSummary}

---

${passLabel}
${summary}` : `${passLabel}
${summary}`;
      if (newAccumulated.length > MAX_SUMMARY_CHARS) {
        try {
          const recondenseMessages = [{
            role: "user",
            content: `The following is an accumulated multi-pass summary of earlier conversation history that has grown large. Condense it into a single comprehensive summary that preserves all key decisions, facts, tool results, file changes, and context, while eliminating redundancy between passes.

${newAccumulated}`
          }];
          const recondensed = await this._compressWithRetry(compressionProvider, recondenseMessages, 1);
          this._compressedSummary = `[Recondensed after ${this._compressionCount + 1} passes]
${recondensed}`;
        } catch {
          this._compressedSummary = newAccumulated;
        }
      } else {
        this._compressedSummary = newAccumulated;
      }
      this.messages = recent;
      this._compressionCount++;
      this._lastCompressedAt = Date.now();
      this._lastCompressedMessageCount = toCompress.length;
      this._lastCompressionError = "";
      this._lastCompressionTrigger = trigger;
      return true;
    } catch (err) {
      this._lastCompressionError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }
  /** Run the compression provider call with a bounded backoff retry. */
  async _compressWithRetry(provider, toCompress, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await provider.compress(toCompress);
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1 && !this._signal?.aborted) {
          await new Promise((resolve3) => setTimeout(resolve3, 250 * (i + 1)));
        }
      }
    }
    throw lastErr;
  }
  /**
   * Last-resort context relief when summarisation keeps failing: shrink the
   * oldest large tool-result payloads (file reads, command output) to a stub so
   * the conversation can't grow into a fatal over-length provider 400.
   *
   * Structure-preserving by construction — it keeps every message and every
   * tool_result block (only the `content` string shrinks), so a tool_use can
   * never be orphaned from its result. Replaces messages with fresh objects
   * rather than mutating in place so `_fullHistory` (checkpoints, replay,
   * memory index) keeps the originals.
   *
   * @returns characters freed from the active message window.
   */
  _emergencyTruncateOldestToolResults(targetChars) {
    if (targetChars <= 0) return 0;
    const boundary = safeRecentStart(this.messages, this._keepRecentCount());
    const MIN_PAYLOAD = 2e3;
    let freed = 0;
    for (let i = 0; i < boundary && freed < targetChars; i++) {
      const msg = this.messages[i];
      if (!msg || msg.role !== "user" || typeof msg.content === "string") continue;
      const blocks = msg.content;
      let changed = false;
      const nextBlocks = blocks.map((block) => {
        if (block.type !== "tool_result") return block;
        const len = block.content?.length ?? 0;
        if (len <= MIN_PAYLOAD || block.content.includes('"_elided"')) return block;
        const stub = JSON.stringify({
          _elided: `tool result (${len} chars) dropped to free context after compression failed \u2014 re-run the tool if you still need this output`
        });
        freed += len - stub.length;
        changed = true;
        return { ...block, content: stub };
      });
      if (changed) this.messages[i] = { role: msg.role, content: nextBlocks };
    }
    return freed;
  }
  async _enrichServicePayload(runtimeType, input) {
    if (!this.opts.serviceKeyProvider) return input;
    const service = runtimeType.split(".")[1] ?? "";
    const raw = await this.opts.serviceKeyProvider(service);
    if (!raw) return { ...input, _serviceError: `No API key configured for ${service}. Add it in Blacksite Settings.` };
    if (service === "jira" || service === "confluence") {
      const sep = raw.indexOf(":");
      if (sep > 0) {
        return { ...input, _email: raw.slice(0, sep), _token: raw.slice(sep + 1) };
      }
    }
    return { ...input, _token: raw };
  }
  _handleMemory(op, payload) {
    const provider = this.opts.memoryProvider;
    if (!provider) return { ok: false, error: "Memory is not available in this context." };
    if (op === "append") {
      const note = String(payload["note"] ?? "").trim();
      if (!note) return { ok: false, error: "note is required." };
      provider.append(note);
      if (this.opts.agentMemoryIndex) {
        void this.opts.agentMemoryIndex.indexMemory(note);
      }
      return { ok: true, saved: note.length > 80 ? `${note.slice(0, 80)}\u2026` : note };
    }
    if (op === "read") {
      return { ok: true, memory: provider.readMemory(), context: provider.readContext() };
    }
    return { ok: false, error: `Unknown memory operation: ${op}` };
  }
  async _handleMemorySemanticSearch(payload) {
    const idx = this.opts.agentMemoryIndex;
    if (!idx) return { ok: false, error: "Agent memory index is not enabled. Enable it in Settings \u2192 Agent Memory." };
    const query = String(payload["query"] ?? "").trim();
    if (!query) return { ok: false, error: "query is required." };
    const rawCols = Array.isArray(payload["collections"]) ? payload["collections"] : [];
    const collections = rawCols.length > 0 ? rawCols : ["tool_calls", "transcript", "memories"];
    const topK = Math.min(20, Math.max(1, Number(payload["topK"] ?? 5)));
    const results = await idx.semanticSearch(query, collections, topK);
    if (!results.length) return { ok: true, results: [], message: "No matching entries found in the memory index." };
    return {
      ok: true,
      results: results.map((r) => ({
        collection: r.collection,
        content: r.content,
        ref: r.ref,
        relevance: Math.round(r.score * 100) / 100
      }))
    };
  }
  /**
   * Persist a checkpoint. On the hot path (each iteration) we only serialize the
   * active compressed message window — O(keepRecent) rather than O(totalHistory).
   * The full uncompressed _fullHistory is written every FULL_HISTORY_CHECKPOINT_CADENCE
   * iterations and always on terminal states (force=true) so resume fidelity is kept.
   */
  _saveCheckpoint(force = false) {
    const now = Date.now();
    if (!this._checkpointCreatedAt) this._checkpointCreatedAt = now;
    this._checkpointCount++;
    const includeFullHistory = force || this._checkpointCount === 1 || this._checkpointCount % FULL_HISTORY_CHECKPOINT_CADENCE === 0;
    const cp = {
      sessionId: this.sessionId,
      iteration: this._iteration,
      model: this.opts.model,
      workspaceRoot: this.opts.workspaceRoot,
      messages: this.messages,
      state: this.exportState(includeFullHistory),
      createdAt: this._checkpointCreatedAt,
      updatedAt: now
    };
    saveCheckpoint(this.opts.context, cp);
  }
  async *send(userContent) {
    this._providerTurnSession.appendUserText(userContent);
    this._lastStopReason = void 0;
    this._pendingGate = void 0;
    this._autoContinueCount = 0;
    yield { type: "runtime_state", state: this.runtimeState };
    if (!this.opts.contextLength && !this._contextLengthWarned) {
      this._contextLengthWarned = true;
      yield {
        type: "execution_diagnostic",
        level: "warn",
        message: `Context window metadata is unavailable for model "${this.opts.model}". Usage will be tracked, but percentage-based context reporting may remain unknown until model metadata is configured.`
      };
    }
    const maxIter = this.opts.maxIterations ?? DEFAULT_MAX_ITER;
    const turnStartIteration = this._iteration;
    let autoContinueCount = 0;
    let awaitingPostToolContinuation = false;
    while (this._iteration - turnStartIteration < maxIter) {
      if (this._signal?.aborted) {
        this._lastStopReason = "cancelled";
        yield { type: "execution_diagnostic", level: "warn", message: "Run cancelled before the next iteration started." };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason: "cancelled", iterations: this._iteration - turnStartIteration };
        return;
      }
      this._iteration++;
      yield { type: "iteration_start", iteration: this._iteration };
      if (this.opts.compressionProvider && this.opts.contextLength && this._lastInputTokens > 0) {
        const preTurnPct = this._lastInputTokens / this.opts.contextLength * 100;
        const threshold = this.opts.compressionTriggerPct ?? 60;
        if (preTurnPct >= threshold && this._compressibleMessageCount() > 4) {
          yield {
            type: "execution_diagnostic",
            level: "info",
            message: `Context at ${Math.round(preTurnPct)}% before model call \u2014 compressing ${this._compressibleMessageCount()} messages to free output headroom\u2026`
          };
          this._isCompacting = true;
          yield { type: "runtime_state", state: this.runtimeState };
          await this._compressHistory(this.opts.compressionProvider, "auto");
          this._isCompacting = false;
          yield { type: "runtime_state", state: this.runtimeState };
        }
      }
      let turnResult;
      try {
        const streamEvents = new ProviderTurnEventQueue();
        const turnPromise = this._providerTurnSession.runTurn({
          emit: (event) => streamEvents.push(event)
        }).then((result) => {
          streamEvents.close();
          return result;
        }).catch((err) => {
          streamEvents.fail(err);
          throw err;
        });
        for await (const ev of streamEvents) {
          if (ev.type === "text_delta") {
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "thinking_delta") {
            yield { type: "thinking_delta", text: ev.text };
          } else if (ev.type === "tool_use_block") {
            yield {
              type: "tool_call_start",
              toolCallId: ev.block.id,
              toolName: ev.block.name,
              inputPreview: JSON.stringify(ev.block.input).slice(0, 120),
              input: ev.block.input
            };
          } else if (ev.type === "usage_update") {
            this._recordUsage(ev);
            yield { type: "usage_update", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWriteTokens: ev.cacheWriteTokens };
            yield { type: "runtime_state", state: this.runtimeState };
          }
        }
        turnResult = await turnPromise;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stopReason = this._signal?.aborted ? "cancelled" : "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: stopReason === "cancelled" ? "warn" : "error",
          message: stopReason === "cancelled" ? "Cancelled during provider turn." : `Provider turn failed: ${message}`
        };
        if (stopReason === "error") yield { type: "error", message };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }
      this._appendAssistantTurn(turnResult);
      this._lastStopReason = turnResult.stopReason;
      if (turnResult.stopReason === "protocol_violation") {
        yield { type: "execution_diagnostic", level: "error", message: "Provider turn ended without a valid terminal event. Run marked as protocol_violation." };
      } else if (turnResult.stopReason === "max_tokens") {
        yield { type: "execution_diagnostic", level: "warn", message: "Output token limit reached - the model response was cut off. Increase max tokens or enable compression to avoid this." };
      } else if (turnResult.stopReason !== "end_turn" && turnResult.stopReason !== "tool_use") {
        yield { type: "execution_diagnostic", level: "warn", message: `Agent stopped early: ${turnResult.stopReason.replace(/_/g, " ")}` };
      }
      const turnWasTruncated = turnResult.stopReason === "max_tokens" || turnResult.stopReason === "protocol_violation";
      const malformedToolCalls = turnWasTruncated ? [] : findMalformedToolCalls(turnResult.toolCalls);
      if (malformedToolCalls.length > 0) {
        const callNames = [...new Set(malformedToolCalls.map(({ toolCall }) => toolCall.name))].join(", ");
        const details = malformedToolCalls.map(({ toolCall, reasons }) => `${toolCall.name}: ${reasons.join("; ")}`).join(" | ");
        if (autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
          this.messages.pop();
          this._fullHistory.pop();
          autoContinueCount++;
          this._autoContinueCount = autoContinueCount;
          this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, MAX_ESCALATED_OUTPUT_TOKENS));
          yield {
            type: "execution_diagnostic",
            level: "warn",
            message: `Malformed tool call(s) [${callNames}] \u2014 ${details}. Escalating output budget to ${this._maxTokensOverride} tokens and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})\u2026`
          };
          if (this.opts.compressionProvider && this._compressibleMessageCount() > 4) {
            this._isCompacting = true;
            yield { type: "runtime_state", state: this.runtimeState };
            await this._compressHistory(this.opts.compressionProvider, "auto");
            this._isCompacting = false;
            yield { type: "runtime_state", state: this.runtimeState };
          }
          this._providerTurnSession.appendUserText(
            `Your last response emitted malformed tool call arguments that did not satisfy the tool schema.
${details}
Please retry those tool calls with complete, valid JSON arguments. If writing large files, split the content into smaller sections across multiple tool calls.`
          );
          yield { type: "runtime_state", state: this.runtimeState };
          continue;
        }
        const stopReason = "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: "error",
          message: `Malformed tool call recovery failed after ${MAX_INTERNAL_AUTO_CONTINUE_TURNS} retries: ${details}`
        };
        yield { type: "error", message: `Model repeatedly emitted malformed tool calls: ${details}` };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }
      const _truncatedTurn = turnResult.stopReason === "max_tokens" || turnResult.stopReason === "protocol_violation";
      const _malformedCalls = _truncatedTurn ? turnResult.toolCalls.filter(
        (tc) => !tc.input || Object.keys(tc.input).length === 0
      ) : [];
      if (_malformedCalls.length > 0 && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS) {
        this.messages.pop();
        this._fullHistory.pop();
        autoContinueCount++;
        this._autoContinueCount = autoContinueCount;
        const callNames = _malformedCalls.map((tc) => tc.name).join(", ");
        this._maxTokensOverride = this._clampToOutputCeiling(Math.min(this._effectiveMaxTokens() * 2, MAX_ESCALATED_OUTPUT_TOKENS));
        yield {
          type: "execution_diagnostic",
          level: "warn",
          message: `Truncated tool call(s) [${callNames}] \u2014 response cut off before arguments were populated. Escalating output budget to ${this._maxTokensOverride} tokens and retrying (${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS})\u2026`
        };
        if (this.opts.compressionProvider && this._compressibleMessageCount() > 4) {
          this._isCompacting = true;
          yield { type: "runtime_state", state: this.runtimeState };
          await this._compressHistory(this.opts.compressionProvider, "auto");
          this._isCompacting = false;
          yield { type: "runtime_state", state: this.runtimeState };
        }
        this._providerTurnSession.appendUserText(
          `Your last response was cut off by the output token limit before the tool arguments for [${callNames}] were populated. Please retry. If writing large files, split the content into smaller sections across multiple tool calls.`
        );
        yield { type: "runtime_state", state: this.runtimeState };
        continue;
      }
      if (turnResult.toolCalls.length === 0) {
        const shouldAutoContinue = awaitingPostToolContinuation && turnResult.stopReason === "end_turn" && turnResult.empty && autoContinueCount < MAX_INTERNAL_AUTO_CONTINUE_TURNS;
        if (shouldAutoContinue) {
          autoContinueCount += 1;
          this._autoContinueCount = autoContinueCount;
          yield {
            type: "execution_diagnostic",
            level: "info",
            message: `Empty post-tool response detected - issuing internal continuation ${autoContinueCount}/${MAX_INTERNAL_AUTO_CONTINUE_TURNS}.`
          };
          this._providerTurnSession.appendUserText(INTERNAL_AUTO_CONTINUE_PROMPT);
          yield { type: "runtime_state", state: this.runtimeState };
          continue;
        }
        awaitingPostToolContinuation = false;
        this._autoContinueCount = autoContinueCount;
        if (turnResult.stopReason === "error") yield { type: "error", message: "Provider reported an error terminal state." };
        if (turnResult.stopReason === "protocol_violation") yield { type: "error", message: "Provider turn violated the normalized turn contract." };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) {
          if (turnResult.stopReason === "end_turn") clearCheckpoint(this.opts.context);
          else this._saveCheckpoint();
        }
        yield { type: "turn_complete", stopReason: turnResult.stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }
      autoContinueCount = 0;
      this._autoContinueCount = 0;
      this._maxTokensOverride = void 0;
      awaitingPostToolContinuation = true;
      try {
        const groups = [];
        for (const tc of turnResult.toolCalls) {
          const isParallel = isParallelSubagent(tc);
          const lastGroup = groups[groups.length - 1];
          if (lastGroup && lastGroup.parallel === isParallel) {
            lastGroup.toolCalls.push(tc);
          } else {
            groups.push({ parallel: isParallel, toolCalls: [tc] });
          }
        }
        const tcToIndex = /* @__PURE__ */ new Map();
        turnResult.toolCalls.forEach((tc, idx) => tcToIndex.set(tc.id, idx));
        const toolResults = new Array(turnResult.toolCalls.length);
        for (const group of groups) {
          if (this._signal?.aborted) {
            yield { type: "execution_diagnostic", level: "warn", message: "Cancelled between tool groups." };
            throw new Error("Cancelled.");
          }
          if (group.parallel) {
            const maxConcurrent = Math.max(1, this.opts.subagentMaxConcurrent ?? 4);
            const generators = [];
            for (const tc of group.toolCalls) {
              const dispatch = resolveToolDispatch(tc.name, tc.input);
              const payload = dispatch.payload;
              const subagentInput = normalizeSubagentSpawnInput(payload);
              const toolStartedAt = Date.now();
              const idx = tcToIndex.get(tc.id);
              const runSubagent = async function* (self) {
                if (!self.opts.subagentProvider) {
                  const res = { ok: false, error: "Subagents are not available in this context." };
                  const elapsedMs = Math.max(Date.now() - toolStartedAt, 0);
                  toolResults[idx] = {
                    type: "tool_result",
                    tool_use_id: tc.id,
                    content: self._capToolResult(tc.id, JSON.stringify(res))
                  };
                  yield {
                    type: "tool_call_result",
                    toolCallId: tc.id,
                    toolName: tc.name,
                    ok: false,
                    summary: "Subagents are not available in this context.",
                    result: res,
                    elapsedMs
                  };
                  return;
                }
                let finalResult = {
                  ok: false,
                  error: "Delegated lane did not return a result."
                };
                try {
                  for await (const subEvent of self.opts.subagentProvider.spawn({
                    parentSessionId: self.sessionId,
                    parentToolCallId: tc.id,
                    input: subagentInput,
                    signal: self._signal
                  })) {
                    if (subEvent.type === "subagent_tool_result") {
                      finalResult = subEvent.result;
                    } else {
                      yield subEvent;
                    }
                  }
                } catch (err) {
                  finalResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
                } finally {
                  const elapsedMs = Math.max(Date.now() - toolStartedAt, 0);
                  const ok = isOk(finalResult);
                  const summary = ok ? summarizeResult(finalResult) : String(finalResult?.["error"] ?? "Failed");
                  toolResults[idx] = {
                    type: "tool_result",
                    tool_use_id: tc.id,
                    content: self._capToolResult(tc.id, JSON.stringify(finalResult))
                  };
                  yield {
                    type: "tool_call_result",
                    toolCallId: tc.id,
                    toolName: tc.name,
                    ok,
                    summary,
                    result: finalResult,
                    elapsedMs
                  };
                }
              };
              generators.push(runSubagent(this));
            }
            for (let i = 0; i < generators.length; i += maxConcurrent) {
              const batch = generators.slice(i, i + maxConcurrent);
              for await (const event of mergeAsyncGenerators(batch)) {
                yield event;
              }
            }
          } else {
            for (const tc of group.toolCalls) {
              if (this._signal?.aborted) {
                yield { type: "execution_diagnostic", level: "warn", message: "Cancelled before tool execution." };
                throw new Error("Cancelled.");
              }
              const dispatch = resolveToolDispatch(tc.name, tc.input);
              const runtimeType = dispatch.runtimeType;
              const payload = dispatch.payload;
              let result;
              const toolStartedAt = Date.now();
              const idx = tcToIndex.get(tc.id);
              try {
                if (runtimeType === "ui.question_card") {
                  if (!this.opts.questionCardProvider) {
                    result = { ok: false, error: "No question card handler is available in this context." };
                  } else {
                    const q = payload;
                    const question = String(q.question ?? "");
                    const options = Array.isArray(q.options) ? q.options : [];
                    const context = q.context != null ? String(q.context) : void 0;
                    this._pendingGate = { kind: "question", toolCallId: tc.id, question, options, context };
                    yield { type: "runtime_state", state: this.runtimeState };
                    if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                    yield { type: "question_card_pending", toolCallId: tc.id, question, options, context };
                    try {
                      const selectedKey = await this.opts.questionCardProvider(tc.id, question, options, context);
                      const selectedLabel = options.find((o) => o.key === selectedKey)?.label ?? selectedKey;
                      yield { type: "question_card_result", toolCallId: tc.id, selectedKey };
                      result = { ok: true, selectedKey, selectedLabel };
                    } catch {
                      result = { ok: false, error: this._signal?.aborted ? "Cancelled." : "Question was cancelled." };
                    } finally {
                      this._pendingGate = void 0;
                      yield { type: "runtime_state", state: this.runtimeState };
                      if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                    }
                  }
                } else if (runtimeType === "editor.apply_edit") {
                  if (!this.opts.editProvider) {
                    result = { ok: false, error: "File editing is not available in this context." };
                  } else {
                    const r = await this.opts.editProvider.applyEdit(
                      {
                        path: String(payload["path"] ?? ""),
                        oldString: String(payload["oldString"] ?? ""),
                        newString: String(payload["newString"] ?? ""),
                        replaceAll: payload["replaceAll"] === true
                      },
                      { autoApprove: this._autoApprove }
                    );
                    if (r.ok && r.autoApproveAll) this._autoApprove = true;
                    if ("autoApproveAll" in r) delete r.autoApproveAll;
                    result = r;
                  }
                } else if (runtimeType === "editor.apply_edit_batch") {
                  if (!this.opts.editProvider) {
                    result = { ok: false, error: "File editing is not available in this context." };
                  } else {
                    const edits = Array.isArray(payload["edits"]) ? payload["edits"].map((edit) => ({
                      path: String(edit.path ?? ""),
                      oldString: String(edit.oldString ?? ""),
                      newString: String(edit.newString ?? ""),
                      replaceAll: edit.replaceAll === true
                    })) : [];
                    const r = await this.opts.editProvider.applyBatchEdits(
                      { edits },
                      { autoApprove: this._autoApprove }
                    );
                    if (r.ok && r.autoApproveAll) this._autoApprove = true;
                    if ("autoApproveAll" in r) delete r.autoApproveAll;
                    result = r;
                  }
                } else if (runtimeType === "editor.report_problems") {
                  if (!this.opts.diagnosticsProvider) {
                    result = { ok: false, error: "The Problems panel is not available in this context." };
                  } else {
                    const problems = Array.isArray(payload["problems"]) ? payload["problems"] : [];
                    result = this.opts.diagnosticsProvider.report(problems, payload["clear"] === true);
                  }
                } else if (runtimeType.startsWith("lsp.")) {
                  if (!this.opts.lspProvider) {
                    result = { ok: false, error: "Code intelligence is not available in this context." };
                  } else {
                    const r = await this.opts.lspProvider.dispatch(
                      runtimeType.slice("lsp.".length),
                      payload,
                      { autoApprove: this._autoApprove, signal: this._signal }
                    );
                    if (r.ok && r.autoApproveAll) this._autoApprove = true;
                    if ("autoApproveAll" in r) delete r.autoApproveAll;
                    result = r;
                  }
                } else if (runtimeType === "memory.semantic_search") {
                  result = await this._handleMemorySemanticSearch(payload);
                } else if (runtimeType.startsWith("memory.")) {
                  result = this._handleMemory(runtimeType.slice("memory.".length), payload);
                } else if (runtimeType === "transcript.read") {
                  result = this._handleTranscriptRead(payload);
                } else if (runtimeType === "session.tool_output_page") {
                  result = this._handleToolResultPage(payload);
                } else if (runtimeType === "session.tool_output_search") {
                  result = this._handleToolResultSearch(payload);
                } else if (runtimeType.startsWith("planning.")) {
                  if (!this.opts.planningProvider) {
                    result = { ok: false, error: "Planning is not available in this context." };
                  } else {
                    result = await this.opts.planningProvider.dispatch(
                      runtimeType.slice("planning.".length),
                      payload,
                      { sessionId: this.sessionId, requestId: void 0 }
                    );
                  }
                } else if (runtimeType.startsWith("data.")) {
                  if (!this.opts.dataProvider) {
                    result = { ok: false, error: "The local database is not available in this context." };
                  } else {
                    result = await this.opts.dataProvider.dispatch(runtimeType.slice("data.".length), payload);
                  }
                } else if (runtimeType === "subagent.spawn") {
                  if (!this.opts.subagentProvider) {
                    result = { ok: false, error: "Subagents are not available in this context." };
                  } else {
                    let finalResult = {
                      ok: false,
                      error: "Delegated lane did not return a result."
                    };
                    for await (const subEvent of this.opts.subagentProvider.spawn({
                      parentSessionId: this.sessionId,
                      parentToolCallId: tc.id,
                      input: normalizeSubagentSpawnInput(payload),
                      signal: this._signal
                    })) {
                      if (subEvent.type === "subagent_tool_result") finalResult = subEvent.result;
                      else yield subEvent;
                    }
                    result = finalResult;
                  }
                } else if (runtimeType.startsWith("browser.") && this.opts.browserRunner) {
                  result = await this.opts.browserRunner.dispatch(
                    runtimeType.slice("browser.".length),
                    // "navigate", "click", etc.
                    payload
                  );
                  if (this._isBrowserUnavailableResult(result)) this._browserUnavailable = true;
                } else if (runtimeType.startsWith("service.")) {
                  const enriched = await this._enrichServicePayload(runtimeType, payload);
                  if (enriched["_serviceError"]) {
                    result = { ok: false, error: enriched["_serviceError"] };
                  } else {
                    const resp = await this.opts.runtime.handleMessage({ type: runtimeType, payload: enriched });
                    result = resp.result;
                  }
                } else {
                  const firstResponse = await this.opts.runtime.handleMessage({ type: runtimeType, payload });
                  const firstResult = firstResponse.result;
                  if (isConfirmationRequired(firstResult)) {
                    const { tier, description, unrecognizedCommand } = firstResult;
                    let granted = this._autoApprove;
                    let decision = this._autoApprove ? "allow_all" : "deny";
                    if (!granted) {
                      this._pendingGate = { kind: "approval", toolCallId: tc.id, toolName: tc.name, description, tier, unrecognizedCommand };
                      yield { type: "runtime_state", state: this.runtimeState };
                      if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                      yield { type: "approval_pending", toolCallId: tc.id, description, tier, unrecognizedCommand };
                      try {
                        decision = this.opts.approvalProvider ? await this.opts.approvalProvider(tc.id, tc.name, description, tier) : await requestApprovalWithDetails(tc.name, description, tier);
                      } finally {
                        this._pendingGate = void 0;
                        yield { type: "runtime_state", state: this.runtimeState };
                        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
                      }
                      if (decision === "allow_all") this._autoApprove = true;
                      granted = decision !== "deny";
                    }
                    yield { type: "approval_result", toolCallId: tc.id, granted, decision };
                    if (!granted) {
                      result = { ok: false, error: "User denied the operation." };
                    } else {
                      const confirmed = await this.opts.runtime.handleMessage({ type: runtimeType, payload: { ...payload, confirmed: true } });
                      result = confirmed.result;
                    }
                  } else {
                    result = firstResult;
                  }
                }
              } catch (err) {
                result = { ok: false, error: err instanceof Error ? err.message : String(err) };
              }
              const memIdx = this.opts.agentMemoryIndex;
              if (memIdx && isOk(result)) {
                void memIdx.indexToolCall(this.sessionId, tc.name, tc.input, result, this._iteration);
                const similar = await Promise.race([
                  memIdx.similarToolCalls(tc.name, tc.input, this.sessionId),
                  new Promise((res) => setTimeout(() => res([]), 1800))
                ]).catch(() => []);
                if (similar.length > 0 && typeof result === "object" && result !== null && !Array.isArray(result)) {
                  result = {
                    ...result,
                    _related: similar.map(
                      (s) => `${s.toolName} ${s.inputSummary} \u2192 "${s.resultSummary}" [ref:${s.sessionId.slice(-6)}:t${s.turnIndex}]`
                    )
                  };
                }
              }
              const ok = isOk(result);
              const summary = ok ? summarizeResult(result) : String(result?.["error"] ?? "Failed");
              toolResults[idx] = {
                type: "tool_result",
                tool_use_id: tc.id,
                content: this._capToolResult(tc.id, JSON.stringify(result))
              };
              yield {
                type: "tool_call_result",
                toolCallId: tc.id,
                toolName: tc.name,
                ok,
                summary,
                result,
                elapsedMs: Math.max(Date.now() - toolStartedAt, 0)
              };
            }
          }
        }
        this._providerTurnSession.appendToolResults(toolResults);
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.compressionProvider && this.opts.contextLength && this._lastInputTokens > 0) {
          const usedPct = this._lastInputTokens / this.opts.contextLength * 100;
          const threshold = this.opts.compressionTriggerPct ?? 60;
          if (usedPct >= threshold) {
            const toCompress = this._compressibleMessageCount();
            if (toCompress > 4) {
              yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% \u2014 compressing ${toCompress} older messages\u2026` };
              this._isCompacting = true;
              yield { type: "runtime_state", state: this.runtimeState };
              const prevCount = this._compressionCount;
              const ok = await this._compressHistory(this.opts.compressionProvider, "auto");
              this._isCompacting = false;
              if (ok && this._compressionCount > prevCount) {
                yield { type: "execution_diagnostic", level: "info", message: `Compression \xD7${this._compressionCount} applied. ${this.messages.length} recent messages kept.` };
              } else if (!ok) {
                const reason = this._lastCompressionError ? `: ${this._lastCompressionError}` : "";
                if (usedPct >= 85) {
                  const freed = this._emergencyTruncateOldestToolResults(
                    Math.floor(this.opts.contextLength * 0.8)
                  );
                  yield freed > 0 ? { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason}. Shed ~${Math.round(freed / 1e3)}k chars of old tool output to stay under the context limit.` } : { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason} \u2014 session continues at full context.` };
                } else {
                  yield { type: "execution_diagnostic", level: "warn", message: `Compression failed${reason} \u2014 session continues at full context.` };
                }
              }
              yield { type: "runtime_state", state: this.runtimeState };
            } else {
              yield { type: "execution_diagnostic", level: "info", message: `Context at ${Math.round(usedPct)}% \u2014 not enough history to compress yet (${this.messages.length} messages).` };
            }
          }
        }
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint();
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        const stopReason = this._signal?.aborted ? "cancelled" : "error";
        this._lastStopReason = stopReason;
        yield {
          type: "execution_diagnostic",
          level: stopReason === "cancelled" ? "warn" : "error",
          message: stopReason === "cancelled" ? "Cancelled during tool execution." : `Unexpected error during tool execution: ${msg}`
        };
        if (stopReason === "error") yield { type: "error", message: msg };
        yield { type: "runtime_state", state: this.runtimeState };
        if (this.opts.checkpointingEnabled !== false) this._saveCheckpoint(true);
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        return;
      }
    }
    this._lastStopReason = "max_iterations";
    yield { type: "runtime_state", state: this.runtimeState };
    yield { type: "turn_complete", stopReason: "max_iterations", iterations: this._iteration - turnStartIteration };
  }
  // ── Anthropic native streaming ─────────────────────────────────────────────
  async *_streamTurnAnthropic() {
    const tools = this._getTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    if (tools.length > 0) tools[tools.length - 1]["cache_control"] = { type: "ephemeral" };
    const url = this.opts.baseUrl ?? PROVIDER_DEFAULTS.anthropic.baseUrl;
    let maxTok = this._effectiveMaxTokens();
    let thinking;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "enabled", budget_tokens: budget };
    }
    const body = {
      model: this.opts.model,
      max_tokens: maxTok,
      system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary),
      messages: withRollingCacheBreakpoint(normalizeForProvider(this.messages)),
      tools,
      stream: true
    };
    if (!thinking && this.opts.temperature !== void 0) body["temperature"] = this.opts.temperature;
    if (thinking) body["thinking"] = thinking;
    const anthropicHeaders = {
      "anthropic-version": "2023-06-01",
      "x-api-key": this.opts.apiKey,
      "content-type": "application/json"
    };
    if (thinking && /claude-3[-.]7/i.test(this.opts.model)) {
      anthropicHeaders["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }
    const response = await fetch(url, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify(body),
      signal: this._signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Anthropic");
    yield* this._parseAnthropicSSE(response.body);
  }
  async *_parseAnthropicSSE(body) {
    const reader = response_body_reader(body);
    const textAcc = /* @__PURE__ */ new Map();
    const thinkingAcc = /* @__PURE__ */ new Map();
    const jsonAcc = /* @__PURE__ */ new Map();
    const blockMeta = /* @__PURE__ */ new Map();
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    for await (const line of reader) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(json);
      } catch {
        continue;
      }
      const evType = String(ev["type"] ?? "");
      if (evType === "message_start") {
        const msg = ev["message"];
        const usage = msg?.["usage"];
        if (usage) {
          inputTokens = Number(usage["input_tokens"] ?? 0);
          cacheReadTokens = Number(usage["cache_read_input_tokens"] ?? 0);
          cacheWriteTokens = Number(usage["cache_creation_input_tokens"] ?? 0);
        }
      } else if (evType === "content_block_start") {
        const idx = Number(ev["index"]);
        const cb = ev["content_block"];
        const cbType = String(cb["type"] ?? "");
        blockMeta.set(idx, { type: cbType, id: String(cb["id"] ?? ""), name: String(cb["name"] ?? "") });
        if (cbType === "text") textAcc.set(idx, "");
        if (cbType === "thinking") thinkingAcc.set(idx, "");
        if (cbType === "tool_use") jsonAcc.set(idx, "");
      } else if (evType === "content_block_delta") {
        const idx = Number(ev["index"]);
        const delta = ev["delta"];
        const dType = String(delta["type"] ?? "");
        if (dType === "text_delta") {
          const text = String(delta["text"] ?? "");
          textAcc.set(idx, (textAcc.get(idx) ?? "") + text);
          yield { type: "text_delta", text };
        } else if (dType === "thinking_delta") {
          const text = String(delta["thinking"] ?? "");
          thinkingAcc.set(idx, (thinkingAcc.get(idx) ?? "") + text);
          if (text) yield { type: "thinking_delta", text };
        } else if (dType === "input_json_delta") {
          jsonAcc.set(idx, (jsonAcc.get(idx) ?? "") + String(delta["partial_json"] ?? ""));
        }
      } else if (evType === "content_block_stop") {
        const idx = Number(ev["index"]);
        const meta = blockMeta.get(idx);
        if (meta?.type === "tool_use") {
          let input = {};
          try {
            input = JSON.parse(jsonAcc.get(idx) ?? "{}");
          } catch {
          }
          yield { type: "tool_use_block", block: { type: "tool_use", id: meta.id, name: meta.name, input } };
        } else if (meta?.type === "thinking") {
          const thinkingText = thinkingAcc.get(idx) ?? "";
          if (thinkingText) yield { type: "thinking_block", text: thinkingText };
        }
      } else if (evType === "message_delta") {
        const delta = ev["delta"];
        yield { type: "stop_reason", reason: normalizeAnthropicStopReason(String(delta["stop_reason"] ?? "end_turn")) };
        const usage = ev["usage"];
        if (usage) outputTokens = Number(usage["output_tokens"] ?? 0);
      }
    }
    if (inputTokens > 0 || outputTokens > 0) {
      yield { type: "usage_update", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    }
  }
  // ── Bedrock (Converse) streaming ───────────────────────────────────────────
  async *_streamTurnBedrock() {
    const credentials = this.opts.bedrock;
    if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");
    let maxTok = this._effectiveMaxTokens();
    let thinking;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { enabled: true, budgetTokens: budget };
    }
    const stream = streamBedrockConverse({
      credentials,
      modelId: this.opts.model,
      messages: withBedrockRollingCacheBreakpoint(toBedrockMessages(normalizeForProvider(this.messages))),
      systemPrompt: this.opts.systemPrompt,
      compressedSummary: this._compressedSummary || void 0,
      maxTokens: maxTok,
      temperature: this.opts.temperature,
      tools: withBedrockToolsCacheBreakpoint(toBedrockTools(this._getTools())),
      thinking
    }, this._signal);
    let isThinking = false;
    let thinkingText = "";
    let isToolUse = false;
    let toolUseId = "";
    let toolUseName = "";
    let toolUseInput = "";
    let stopReason = "end_turn";
    let usage = null;
    for await (const { eventType, data } of stream) {
      switch (eventType) {
        case "contentBlockStart": {
          const start = data["contentBlockStart"]?.start ?? data["start"];
          if (start?.["reasoningContent"]) {
            isThinking = true;
            thinkingText = "";
          } else if (start?.["toolUse"]) {
            const tu = start["toolUse"];
            isToolUse = true;
            toolUseId = tu.toolUseId ?? "";
            toolUseName = tu.name ?? "";
            toolUseInput = "";
          }
          break;
        }
        case "contentBlockDelta": {
          const delta = data["contentBlockDelta"]?.delta ?? data["delta"];
          if (delta?.["reasoningContent"]) {
            const rc = delta["reasoningContent"];
            const text = String(rc["text"] ?? "");
            if (text) {
              thinkingText += text;
              yield { type: "thinking_delta", text };
            }
          } else if (isToolUse && delta?.["toolUse"]) {
            toolUseInput += String(delta["toolUse"].input ?? "");
          } else if (typeof delta?.["text"] === "string") {
            yield { type: "text_delta", text: delta["text"] };
          }
          break;
        }
        case "contentBlockStop": {
          if (isThinking) {
            if (thinkingText) yield { type: "thinking_block", text: thinkingText };
            isThinking = false;
            thinkingText = "";
          } else if (isToolUse) {
            let input = {};
            try {
              if (toolUseInput) input = JSON.parse(toolUseInput);
            } catch {
            }
            yield { type: "tool_use_block", block: { type: "tool_use", id: toolUseId, name: toolUseName, input } };
            isToolUse = false;
            toolUseId = "";
            toolUseName = "";
            toolUseInput = "";
          }
          break;
        }
        case "messageStop": {
          const raw = data["messageStop"]?.stopReason ?? data["stopReason"];
          stopReason = normalizeBedrockStopReason(String(raw ?? "end_turn"));
          break;
        }
        case "metadata": {
          const u = data["metadata"]?.usage ?? data["usage"];
          if (u) {
            usage = {
              inputTokens: Number(u.inputTokens ?? 0),
              outputTokens: Number(u.outputTokens ?? 0),
              cacheReadTokens: Number(u.cacheReadInputTokens ?? 0),
              cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0)
            };
          }
          break;
        }
      }
    }
    yield { type: "stop_reason", reason: stopReason };
    if (usage) {
      yield { type: "usage_update", ...usage };
    }
  }
  // ── Bedrock Mantle (Messages API) streaming ────────────────────────────────
  async *_streamTurnBedrockMantle() {
    const credentials = this.opts.bedrock;
    if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");
    const tools = this._getTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    if (tools.length > 0) tools[tools.length - 1]["cache_control"] = { type: "ephemeral" };
    let maxTok = this._effectiveMaxTokens();
    let thinking;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "adaptive" };
    }
    const url = `${mantleEndpoint(credentials.region)}/anthropic/v1/messages`;
    const reqBody = {
      model: this.opts.model,
      max_tokens: maxTok,
      // Mantle uses the Anthropic Messages wire format — reuse the same cached-blocks
      // builder so the stable system-prompt head is cache-eligible here too.
      system: buildAnthropicSystemBlocks(this.opts.systemPrompt, this._compressedSummary),
      messages: withRollingCacheBreakpoint(normalizeForProvider(this.messages)),
      tools,
      stream: true
    };
    if (!thinking && this.opts.temperature !== void 0) reqBody["temperature"] = this.opts.temperature;
    if (thinking) reqBody["thinking"] = thinking;
    const body = JSON.stringify(reqBody);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    };
    const signedHeaders = signBedrockRequest(credentials, "POST", url, headers, body, "bedrock-mantle");
    const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal: this._signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Bedrock Mantle ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Bedrock Mantle");
    yield* this._parseAnthropicSSE(response.body);
  }
  // ── OpenAI / OpenRouter streaming ──────────────────────────────────────────
  async *_streamTurnOpenAI() {
    const pd = PROVIDER_DEFAULTS[this.provider];
    const url = this.opts.baseUrl ?? pd.baseUrl;
    const effectiveSystem = this._compressedSummary ? `${this.opts.systemPrompt}

---
[COMPRESSED CONVERSATION HISTORY]
${this._compressedSummary}
---` : this.opts.systemPrompt;
    const msgs = toOpenAIMessages(normalizeForProvider(this.messages), effectiveSystem);
    const tools = this._getTools().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
    const extraHeaders = {};
    if (this.provider === "openrouter") {
      extraHeaders["HTTP-Referer"] = this.opts.httpReferer ?? "https://blacksite.dev";
      extraHeaders["X-Title"] = this.opts.xTitle ?? "Blacksite";
    }
    const reasoning = this.provider === "openai" && isOpenAIReasoningModel(this.opts.model);
    const maxTok = this._effectiveMaxTokens();
    const oaiBody = {
      model: this.opts.model,
      messages: msgs,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true }
    };
    if (reasoning) {
      oaiBody["max_completion_tokens"] = maxTok;
      if (this.opts.reasoningEffort) oaiBody["reasoning_effort"] = this.opts.reasoningEffort;
    } else {
      oaiBody["max_tokens"] = maxTok;
      if (this.opts.temperature !== void 0) oaiBody["temperature"] = this.opts.temperature;
      if (this.opts.reasoningEffort && this.provider === "openrouter") oaiBody["reasoning_effort"] = this.opts.reasoningEffort;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(oaiBody),
      signal: this._signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${this.provider} ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error(`No response body from ${this.provider}`);
    const tcArgs = /* @__PURE__ */ new Map();
    let stopReason = "stop";
    let oaiInputTokens = 0;
    let oaiOutputTokens = 0;
    let oaiCachedTokens = 0;
    for await (const line of response_body_reader(response.body)) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") break;
      let ev;
      try {
        ev = JSON.parse(json);
      } catch {
        continue;
      }
      const topUsage = ev["usage"];
      if (topUsage) {
        oaiInputTokens = Number(topUsage["prompt_tokens"] ?? 0);
        oaiOutputTokens = Number(topUsage["completion_tokens"] ?? 0);
        const details = topUsage["prompt_tokens_details"];
        oaiCachedTokens = Number(details?.["cached_tokens"] ?? topUsage["cached_tokens"] ?? 0);
      }
      const choices = ev["choices"];
      if (!choices?.length) continue;
      const choice = choices[0];
      if (!choice) continue;
      const delta = choice["delta"];
      const finishReason = choice["finish_reason"];
      if (finishReason) stopReason = String(finishReason);
      if (!delta) continue;
      const content = delta["content"];
      if (typeof content === "string" && content) yield { type: "text_delta", text: content };
      const toolCallDeltas = delta["tool_calls"];
      if (toolCallDeltas) {
        for (const tcd of toolCallDeltas) {
          const idx = Number(tcd["index"] ?? 0);
          const id = tcd["id"] ? String(tcd["id"]) : void 0;
          const fn = tcd["function"];
          const name = fn?.["name"];
          const args = fn?.["arguments"] ?? "";
          if (id && name) {
            tcArgs.set(idx, { id, name, args: "" });
          }
          if (tcArgs.has(idx)) {
            tcArgs.get(idx).args += args;
          }
        }
      }
    }
    for (const [, tc] of tcArgs) {
      let input = {};
      try {
        input = JSON.parse(tc.args);
      } catch {
      }
      yield {
        type: "tool_use_block",
        block: { type: "tool_use", id: tc.id, name: tc.name, input }
      };
    }
    yield { type: "stop_reason", reason: normalizeOpenAIStopReason(stopReason) };
    if (oaiInputTokens > 0 || oaiOutputTokens > 0) {
      const cacheRead = Math.min(oaiCachedTokens, oaiInputTokens);
      yield { type: "usage_update", inputTokens: oaiInputTokens - cacheRead, outputTokens: oaiOutputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: 0 };
    }
  }
};
var ProviderTurnEventQueue = class {
  items = [];
  waiters = [];
  closed = false;
  error;
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: void 0, done: true });
    }
  }
  fail(error) {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift(), done: false });
        }
        if (this.error !== void 0) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: void 0, done: true });
        return new Promise((resolve3, reject) => {
          this.waiters.push({ resolve: resolve3, reject });
        });
      }
    };
  }
};
async function* response_body_reader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
  }
}
function buildAnthropicSystemBlocks(systemPrompt, compressedSummary) {
  const blocks = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }
  ];
  if (compressedSummary) {
    blocks.push({
      type: "text",
      text: `---
[COMPRESSED CONVERSATION HISTORY \u2014 earlier messages summarised for context efficiency]
${compressedSummary}
---`
    });
  }
  return blocks;
}
function withRollingCacheBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.slice();
  if (blocks.length === 0) return messages;
  blocks[blocks.length - 1] = Object.assign(
    {},
    blocks[blocks.length - 1],
    { cache_control: { type: "ephemeral" } }
  );
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}
function messageCarriesToolResult(msg) {
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_result");
}
function safeRecentStart(messages, keepRecent) {
  let start = Math.max(0, messages.length - keepRecent);
  while (start > 0 && messageCarriesToolResult(messages[start])) start--;
  return start;
}
function sanitizeToolMessages(messages) {
  const satisfied = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") satisfied.add(block.tool_use_id);
      }
    }
  }
  const seenToolUse = /* @__PURE__ */ new Set();
  const out = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push(msg);
      continue;
    }
    const blocks = msg.content;
    if (msg.role === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") seenToolUse.add(block.id);
      }
      out.push(msg);
      const unanswered = blocks.filter(
        (b) => b.type === "tool_use" && !satisfied.has(b.id)
      );
      if (unanswered.length > 0) {
        out.push({
          role: "user",
          content: unanswered.map((b) => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: JSON.stringify({ ok: false, error: "Tool result unavailable (run interrupted before completion)." })
          }))
        });
        for (const b of unanswered) satisfied.add(b.id);
      }
      continue;
    }
    const kept = blocks.filter(
      (b) => b.type !== "tool_result" || seenToolUse.has(b.tool_use_id)
    );
    if (kept.length === 0 && blocks.length > 0) continue;
    out.push(kept.length === blocks.length ? msg : { ...msg, content: kept });
  }
  return out;
}
function ensureLeadingUserMessage(messages) {
  if (messages[0]?.role === "assistant") {
    return [{ role: "user", content: "[Conversation continues from summarized history above.]" }, ...messages];
  }
  return messages;
}
function normalizeForProvider(messages) {
  return ensureLeadingUserMessage(sanitizeToolMessages(messages));
}
function toOpenAIMessages(messages, systemPrompt) {
  const result = [{ role: "system", content: systemPrompt }];
  const emittedCallIds = /* @__PURE__ */ new Set();
  const answeredCallIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");
        for (const tr of toolResults) {
          if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
          answeredCallIds.add(tr.tool_use_id);
          result.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_use_id });
        }
        if (textBlocks.length) {
          result.push({ role: "user", content: textBlocks.map((t) => t.text).join("\n") });
        }
      }
    } else {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const textBlocks = msg.content.filter((b) => b.type === "text");
        const toolBlocks = msg.content.filter((b) => b.type === "tool_use");
        const content = textBlocks.map((t) => t.text).join("\n") || null;
        const tool_calls = toolBlocks.length > 0 ? toolBlocks.map((tb) => {
          emittedCallIds.add(tb.id);
          return {
            id: tb.id,
            type: "function",
            function: { name: tb.name, arguments: JSON.stringify(tb.input) }
          };
        }) : void 0;
        if (content === null && !tool_calls) continue;
        result.push({ role: "assistant", content, tool_calls });
      }
    }
  }
  return result;
}
function nonEmptyBedrockContent(blocks) {
  const filtered = blocks.filter((b) => !("text" in b) || b.text.trim().length > 0);
  return filtered.length > 0 ? filtered : [{ text: "" }];
}
function toBedrockMessages(messages) {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: nonEmptyBedrockContent([{ text: msg.content }]) };
    }
    const blocks = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        blocks.push({ text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.input } });
      } else if (block.type === "tool_result") {
        blocks.push({ toolResult: { toolUseId: block.tool_use_id, content: [{ text: block.content }] } });
      }
    }
    return { role: msg.role, content: nonEmptyBedrockContent(blocks) };
  });
}
function withBedrockRollingCacheBreakpoint(messages) {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  if (last.content.length === 0) return messages;
  out[out.length - 1] = { ...last, content: [...last.content, { cachePoint: { type: "default" } }] };
  return out;
}
function toBedrockTools(tools) {
  return tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } }
  }));
}
function withBedrockToolsCacheBreakpoint(tools) {
  if (tools.length === 0) return tools;
  return [...tools, { cachePoint: { type: "default" } }];
}
function normalizeBedrockStopReason(reason) {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    default:
      return "protocol_violation";
  }
}
function isOpenAIReasoningModel(model) {
  const id = model.toLowerCase();
  return /^o[134](-|$)/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("gpt-5");
}
function isConfirmationRequired(result) {
  return result !== null && typeof result === "object" && "requiresConfirmation" in result && result["requiresConfirmation"] === true;
}
function isOk(result) {
  return typeof result === "object" && result !== null && result["ok"] === true;
}
function summarizeResult(result) {
  if (typeof result !== "object" || result === null) return "Done";
  const r = result;
  if (typeof r["progress"] === "string") return r["progress"];
  if (typeof r["planId"] === "string") return `plan ${r["planId"]}`;
  if (typeof r["todoId"] === "string") return `task items ${r["todoId"]}`;
  if (typeof r["content"] === "string") return `${r["content"].slice(0, 80)}\u2026`;
  if (typeof r["path"] === "string") return r["path"];
  if (typeof r["exitCode"] === "number") return `exit ${r["exitCode"]}`;
  if (typeof r["planCount"] === "number") return `${r["planCount"]} plan(s)`;
  if (typeof r["runCount"] === "number") return `${r["runCount"]} task run(s)`;
  if (Array.isArray(r["results"])) return `${r["results"].length} result(s)`;
  if (Array.isArray(r["entries"])) return `${r["entries"].length} entries`;
  if (Array.isArray(r["commits"])) return `${r["commits"].length} commit(s)`;
  return "OK";
}
function normalizeSubagentSpawnInput(payload) {
  const complexity = String(payload["complexity"] ?? "").trim().toLowerCase();
  const profileId = payload["profileId"] != null ? String(payload["profileId"]).trim() : void 0;
  return {
    task: String(payload["task"] ?? ""),
    context: payload["context"] != null ? String(payload["context"]) : void 0,
    complexity: complexity === "standard" || complexity === "complex" || complexity === "deep" ? complexity : "auto",
    label: payload["label"] != null ? String(payload["label"]) : void 0,
    parallel: payload["parallel"] === true || payload["parallel"] === "true",
    profileId: profileId || void 0
  };
}
function isParallelSubagent(tc) {
  const dispatch = resolveToolDispatch(tc.name, tc.input);
  if (dispatch.runtimeType !== "subagent.spawn") return false;
  const input = normalizeSubagentSpawnInput(dispatch.payload);
  return input.parallel === true;
}
function findMalformedToolCalls(toolCalls) {
  const malformed = [];
  for (const toolCall of toolCalls) {
    const issues = validateToolInput(toolCall.name, toolCall.input);
    if (issues.length === 0) continue;
    const missing = issues.filter((issue) => issue.kind === "missing_required").map((issue) => issue.path);
    const invalid = issues.filter((issue) => issue.kind === "invalid_type").map((issue) => issue.path);
    const reasons = [];
    if (missing.length > 0) reasons.push(`missing required field(s): ${missing.join(", ")}`);
    if (invalid.length > 0) reasons.push(`invalid field type(s): ${invalid.join(", ")}`);
    malformed.push({
      toolCall,
      reasons: reasons.length > 0 ? reasons : issues.map((issue) => issue.message)
    });
  }
  return malformed;
}
async function* mergeAsyncGenerators(generators) {
  const queue = [];
  let resolveNext = null;
  let activeCount = generators.length;
  let errorOccurred = null;
  const startGenerator = async (gen) => {
    try {
      for await (const val of gen) {
        queue.push(val);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      }
    } catch (err) {
      errorOccurred = err;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    } finally {
      activeCount--;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }
  };
  generators.forEach(startGenerator);
  while (activeCount > 0 || queue.length > 0) {
    if (errorOccurred) {
      throw errorOccurred;
    }
    if (queue.length > 0) {
      yield queue.shift();
    } else {
      await new Promise((resolve3) => {
        resolveNext = resolve3;
      });
    }
  }
  if (errorOccurred) {
    throw errorOccurred;
  }
}

// src/background-runner.ts
var vscode2 = __toESM(require("vscode"));
var BackgroundRunner = class {
  statusBarItem;
  abortController = null;
  isRunning = false;
  constructor() {
    this.statusBarItem = vscode2.window.createStatusBarItem(vscode2.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "blacksite.cancelRun";
    this.statusBarItem.name = "Blacksite";
  }
  get signal() {
    return this.abortController?.signal;
  }
  get busy() {
    return this.isRunning;
  }
  cancel() {
    this.abortController?.abort();
  }
  dispose() {
    this.statusBarItem.dispose();
  }
  async runWithProgress(session, userContent, onEvent, options = {}) {
    if (this.isRunning) {
      vscode2.window.showWarningMessage("Blacksite is already running a task. Cancel it first.");
      throw new Error("Another task is already running. Cancel it first.");
    }
    this.isRunning = true;
    this.abortController = new AbortController();
    session.attachSignal(this.abortController.signal);
    const title = options.title ?? "Blacksite";
    this.statusBarItem.text = `$(loading~spin) ${title}`;
    this.statusBarItem.tooltip = "Click to cancel";
    this.statusBarItem.show();
    try {
      await vscode2.window.withProgress(
        {
          location: vscode2.ProgressLocation.Window,
          title,
          cancellable: options.cancellable !== false
        },
        async (progress, token) => {
          token.onCancellationRequested(() => this.cancel());
          let iteration = 0;
          for await (const event of session.send(userContent)) {
            onEvent(event);
            if (event.type === "iteration_start") {
              iteration = event.iteration;
              progress.report({ message: `turn ${iteration}` });
              this.statusBarItem.text = `$(loading~spin) ${title} \u2014 turn ${iteration}`;
            } else if (event.type === "tool_call_start") {
              progress.report({ message: `${event.toolName}\u2026` });
              this.statusBarItem.text = `$(loading~spin) ${title} \u2014 ${event.toolName}`;
            } else if (event.type === "question_card_pending") {
              progress.report({ message: "waiting for your response" });
              this.statusBarItem.text = `$(comment) ${title} \u2014 question`;
            } else if (event.type === "approval_pending") {
              progress.report({ message: "waiting for approval" });
              this.statusBarItem.text = `$(warning) ${title} \u2014 approval needed`;
            } else if (event.type === "subagent_lane_start") {
              progress.report({ message: `delegated lane \u2014 ${event.label}` });
              this.statusBarItem.text = `$(loading~spin) ${title} \u2014 ${event.label}`;
            } else if (event.type === "subagent_lane_complete") {
              progress.report({ message: event.ok ? "delegated lane complete" : "delegated lane failed" });
            } else if (event.type === "turn_complete") {
              progress.report({ message: "done" });
            }
          }
        }
      );
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.statusBarItem.hide();
    }
  }
};

// src/chromium-runner.ts
var fs4 = __toESM(require("fs"));
var vscode3 = __toESM(require("vscode"));
var _playwrightInstalled;
function isBrowserRuntimeAvailable() {
  if (_playwrightInstalled !== void 0) return _playwrightInstalled;
  try {
    require.resolve("playwright-core");
    _playwrightInstalled = true;
  } catch {
    _playwrightInstalled = false;
  }
  return _playwrightInstalled;
}
function findSystemChrome() {
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const candidates = win ? [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env["LOCALAPPDATA"] ? `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe` : "",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ] : mac ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ] : [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium"
  ];
  return candidates.filter(Boolean).find((p) => fs4.existsSync(p));
}
var ChromiumRunner = class {
  _browser = null;
  _context = null;
  _page = null;
  _launching = false;
  available() {
    return isBrowserRuntimeAvailable();
  }
  async _ensurePage() {
    if (this._page && !this._page.isClosed()) return this._page;
    if (this._launching) {
      await new Promise((r) => {
        const t = setInterval(() => {
          if (!this._launching) {
            clearInterval(t);
            r();
          }
        }, 50);
      });
      if (this._page && !this._page.isClosed()) return this._page;
    }
    this._launching = true;
    try {
      let chromium;
      try {
        ({ chromium } = await import("playwright-core"));
      } catch {
        throw new Error(
          "Browser tools require playwright-core. Run `npm install playwright-core` in the extension directory and reload VS Code."
        );
      }
      const executablePath = findSystemChrome();
      const cfg = vscode3.workspace.getConfiguration("blacksite");
      const headless = cfg.get("browserHeadless") ?? false;
      this._browser = await chromium.launch({
        executablePath,
        // undefined = use playwright's own Chromium
        headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled"
        ]
      });
      this._context = await this._browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        acceptDownloads: false
      });
      this._page = await this._context.newPage();
      this._browser.on("disconnected", () => {
        this._browser = null;
        this._context = null;
        this._page = null;
      });
    } finally {
      this._launching = false;
    }
    return this._page;
  }
  async dispatch(toolType, payload) {
    try {
      switch (toolType) {
        case "navigate":
          return await this._navigate(payload);
        case "click":
          return await this._click(payload);
        case "type_text":
          return await this._typeText(payload);
        case "screenshot":
          return await this._screenshot(payload);
        case "get_text":
          return await this._getText(payload);
        case "evaluate":
          return await this._evaluate(payload);
        default:
          return { ok: false, error: `Unknown browser action: ${toolType}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  async _navigate(p) {
    const page = await this._ensurePage();
    const url = String(p["url"] ?? "");
    const waitUntil = p["waitFor"] === "networkidle" ? "networkidle" : "load";
    await page.goto(url, { waitUntil, timeout: 3e4 });
    return { ok: true, url: page.url(), title: await page.title() };
  }
  async _click(p) {
    const page = await this._ensurePage();
    const selector = String(p["selector"] ?? "");
    await page.click(selector, { timeout: 1e4 });
    return { ok: true, selector };
  }
  async _typeText(p) {
    const page = await this._ensurePage();
    const selector = String(p["selector"] ?? "");
    const text = String(p["text"] ?? "");
    await page.click(selector, { timeout: 1e4 });
    await page.fill(selector, text);
    return { ok: true, selector, charsTyped: text.length };
  }
  async _screenshot(p) {
    const page = await this._ensurePage();
    const fullPage = p["fullPage"] === true;
    const buf = await page.screenshot({ fullPage, type: "png" });
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    return { ok: true, dataUrl, sizeBytes: buf.length, url: page.url(), fullPage };
  }
  async _getText(p) {
    const page = await this._ensurePage();
    const selector = p["selector"] ? String(p["selector"]) : null;
    const text = selector ? await page.locator(selector).first().innerText({ timeout: 1e4 }) : await page.evaluate(() => {
      return globalThis.document?.body?.innerText ?? "";
    });
    return { ok: true, text: text.slice(0, 5e4), truncated: text.length > 5e4 };
  }
  async _evaluate(p) {
    const page = await this._ensurePage();
    const script = String(p["script"] ?? "");
    const result = await page.evaluate(script);
    return { ok: true, result };
  }
  async dispose() {
    await this._page?.close().catch(() => {
    });
    await this._context?.close().catch(() => {
    });
    await this._browser?.close().catch(() => {
    });
    this._page = null;
    this._context = null;
    this._browser = null;
  }
};

// src/diff-edit-service.ts
var vscode5 = __toESM(require("vscode"));
var path8 = __toESM(require("path"));

// src/post-edit-diagnostics.ts
var vscode4 = __toESM(require("vscode"));
var path7 = __toESM(require("path"));
var SEVERITY_NAMES = ["error", "warning", "info", "hint"];
async function collectForUris(uris, workspaceRoot, opts = {}) {
  const unique = dedupe(uris);
  if (unique.length) await waitForDiagnosticChange(unique, opts.timeoutMs ?? 1200);
  const limit = opts.limit ?? 20;
  let errors = 0;
  let warnings = 0;
  const problems = [];
  for (const uri of unique) {
    for (const d of vscode4.languages.getDiagnostics(uri)) {
      if (d.severity === vscode4.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode4.DiagnosticSeverity.Warning) warnings++;
      if (d.severity <= vscode4.DiagnosticSeverity.Warning && problems.length < limit) {
        problems.push({
          path: rel(uri, workspaceRoot),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: SEVERITY_NAMES[d.severity] ?? "info",
          message: d.message,
          source: typeof d.source === "string" ? d.source : void 0
        });
      }
    }
  }
  return { errors, warnings, problems };
}
function waitForDiagnosticChange(uris, timeoutMs) {
  return new Promise((resolve3) => {
    const keys = new Set(uris.map((u) => u.toString()));
    const cleanup = () => {
      sub.dispose();
      clearTimeout(timer);
    };
    const sub = vscode4.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) {
        cleanup();
        resolve3();
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      resolve3();
    }, timeoutMs);
  });
}
function dedupe(uris) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const u of uris) {
    const key = u.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}
function rel(uri, workspaceRoot) {
  const folder = vscode4.workspace.getWorkspaceFolder(uri);
  const base = folder?.uri.fsPath ?? workspaceRoot;
  const r = path7.relative(base, uri.fsPath).replace(/\\/g, "/");
  return r && !r.startsWith("..") ? r : uri.fsPath.replace(/\\/g, "/");
}

// src/diff-edit-service.ts
var DiffEditService = class {
  constructor(_workspaceRoot, _applier) {
    this._workspaceRoot = _workspaceRoot;
    this._applier = _applier;
  }
  _resolve(p) {
    const abs = path8.isAbsolute(p) ? p : path8.join(this._workspaceRoot, p);
    return vscode5.Uri.file(abs);
  }
  async applyEdit(input, opts) {
    const rel2 = input.path;
    if (!rel2) return { ok: false, error: "path is required." };
    if (!input.oldString) return { ok: false, error: "oldString must not be empty \u2014 use file_write to create or overwrite a file." };
    if (input.oldString === input.newString) return { ok: false, error: "oldString and newString are identical \u2014 nothing to change." };
    const uri = this._resolve(rel2);
    let doc;
    try {
      doc = await vscode5.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${rel2}. Use file_write to create a new file.` };
    }
    const original = doc.getText();
    const { old: oldString, count: occurrences } = resolveOldString(original, input.oldString);
    if (occurrences === 0) {
      return { ok: false, error: `oldString was not found in ${rel2} (also tried a whitespace-tolerant match). Read the file and copy the exact text (including whitespace).` };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return { ok: false, error: `oldString matches ${occurrences} locations in ${rel2}. Add surrounding context to make it unique, or set replaceAll:true.` };
    }
    const updated = input.replaceAll ? original.split(oldString).join(input.newString) : replaceFirst(original, oldString, input.newString);
    const replacements = input.replaceAll ? occurrences : 1;
    const edit = new vscode5.WorkspaceEdit();
    edit.replace(uri, new vscode5.Range(doc.positionAt(0), doc.positionAt(original.length)), updated);
    const res = await this._applier.apply(edit, { summary: `${replacements} edit(s) in ${rel2}`, autoApprove: opts.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the edit." };
    const diagnostics = await collectForUris([uri], this._workspaceRoot);
    return { ok: true, path: rel2, replacements, diagnostics, autoApproveAll: res.autoApproveAll || void 0 };
  }
  async applyBatchEdits(input, opts) {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, error: "At least one edit is required." };
    }
    const grouped = /* @__PURE__ */ new Map();
    for (const edit of input.edits) {
      const rel2 = String(edit.path ?? "").trim();
      if (!rel2) return { ok: false, error: "Each edit requires a path." };
      if (edit.oldString === edit.newString) {
        return { ok: false, error: `oldString and newString are identical in ${rel2}.` };
      }
      const bucket = grouped.get(rel2) ?? [];
      bucket.push({
        path: rel2,
        oldString: String(edit.oldString ?? ""),
        newString: String(edit.newString ?? ""),
        replaceAll: edit.replaceAll === true
      });
      grouped.set(rel2, bucket);
    }
    const workspaceEdit = new vscode5.WorkspaceEdit();
    const fileResults = [];
    let totalReplacements = 0;
    const touchedUris = [];
    for (const [rel2, edits] of grouped.entries()) {
      const uri = this._resolve(rel2);
      let doc;
      try {
        doc = await vscode5.workspace.openTextDocument(uri);
      } catch {
        return { ok: false, error: `Could not open ${rel2}. Use file_write to create new files.` };
      }
      let text = doc.getText();
      let replacementsForFile = 0;
      for (const edit of edits) {
        const { old: oldString, count: occurrences } = resolveOldString(text, edit.oldString);
        if (occurrences === 0) {
          return { ok: false, error: `oldString was not found in ${rel2} (also tried a whitespace-tolerant match). Read the file and copy the exact text (including whitespace).` };
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return { ok: false, error: `oldString matches ${occurrences} locations in ${rel2}. Add surrounding context or set replaceAll:true.` };
        }
        text = edit.replaceAll ? text.split(oldString).join(edit.newString) : replaceFirst(text, oldString, edit.newString);
        const replacements = edit.replaceAll ? occurrences : 1;
        replacementsForFile += replacements;
        totalReplacements += replacements;
      }
      workspaceEdit.replace(
        uri,
        new vscode5.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        text
      );
      touchedUris.push(uri);
      fileResults.push({ path: rel2, replacements: replacementsForFile });
    }
    const res = await this._applier.apply(workspaceEdit, {
      summary: `${totalReplacements} edit(s) across ${fileResults.length} file(s)`,
      autoApprove: opts.autoApprove
    });
    if (!res.applied) return { ok: false, error: "User rejected the edit batch." };
    const diagnostics = await collectForUris(touchedUris, this._workspaceRoot);
    return {
      ok: true,
      files: fileResults.length,
      edits: input.edits.length,
      replacements: totalReplacements,
      results: fileResults,
      diagnostics,
      autoApproveAll: res.autoApproveAll || void 0
    };
  }
};
function findWhitespaceTolerantMatch(original, oldString) {
  const origLines = original.split("\n");
  const needleLines = oldString.replace(/\n+$/, "").split("\n");
  if (needleLines.length === 0 || needleLines.length === 1 && needleLines[0] === "") return null;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const needleNorm = needleLines.map(norm);
  const lineStart = [];
  let off = 0;
  for (const line of origLines) {
    lineStart.push(off);
    off += line.length + 1;
  }
  const matches = [];
  for (let i = 0; i + needleLines.length <= origLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (norm(origLines[i + j]) !== needleNorm[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const last = i + needleLines.length - 1;
    matches.push({ start: lineStart[i], end: lineStart[last] + origLines[last].length });
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;
  return original.slice(matches[0].start, matches[0].end);
}
function resolveOldString(text, oldString) {
  const exact = countOccurrences(text, oldString);
  if (exact > 0) return { old: oldString, count: exact };
  const flexible = findWhitespaceTolerantMatch(text, oldString);
  if (flexible) return { old: flexible, count: countOccurrences(text, flexible) };
  return { old: oldString, count: 0 };
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
function replaceFirst(haystack, needle, replacement) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

// src/lsp-service.ts
var vscode6 = __toESM(require("vscode"));
var fs5 = __toESM(require("fs"));
var path9 = __toESM(require("path"));
var MAX_RESULTS = 100;
var HARD_MAX = 500;
var NAV_COMMANDS = {
  definition: "vscode.executeDefinitionProvider",
  typeDefinition: "vscode.executeTypeDefinitionProvider",
  declaration: "vscode.executeDeclarationProvider",
  implementation: "vscode.executeImplementationProvider",
  references: "vscode.executeReferenceProvider"
};
var SYMBOL_KIND_NAMES = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum-member",
  "struct",
  "event",
  "operator",
  "type-parameter"
];
var SEVERITY_NAMES2 = ["error", "warning", "info", "hint"];
var SEVERITY_THRESHOLD = { error: 0, warning: 1, info: 2, hint: 3 };
var LspService = class {
  constructor(_workspaceRoot, _applier) {
    this._workspaceRoot = _workspaceRoot;
    this._applier = _applier;
  }
  async dispatch(op, payload, ctx) {
    try {
      switch (op) {
        case "symbols":
          return await this._symbols(payload, ctx);
        case "navigate":
          return await this._navigate(payload, ctx);
        case "hover":
          return await this._hover(payload, ctx);
        case "diagnostics":
          return await this._diagnostics(payload);
        case "rename":
          return await this._rename(payload, ctx);
        case "actions":
          return await this._actions(payload, ctx);
        case "format":
          return await this._format(payload, ctx);
        case "insert":
          return await this._insert(payload, ctx);
        default:
          return { ok: false, error: `Unknown code-intelligence op: ${op}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // ── code_symbols ───────────────────────────────────────────────────────────
  async _symbols(payload, ctx) {
    const query = typeof payload["query"] === "string" ? payload["query"].trim() : "";
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    const limit = clamp(num2(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    if (query) {
      const raw = await this._withWarmup(
        () => this._exec("vscode.executeWorkspaceSymbolProvider", query),
        (r) => !r || r.length === 0,
        ctx
      ) ?? [];
      const symbols = raw.slice(0, limit).map((s) => ({
        name: s.name,
        kind: kindName(s.kind),
        container: s.containerName || void 0,
        path: this._relPath(s.location.uri),
        line: s.location.range.start.line + 1
      }));
      return { ok: true, scope: "workspace", query, symbols, totalFound: raw.length, truncated: raw.length > symbols.length };
    }
    if (p) {
      const uri = this._resolveUri(p);
      const raw = await this._exec("vscode.executeDocumentSymbolProvider", uri) ?? [];
      return { ok: true, scope: "document", path: this._relPath(uri), symbols: buildSymbolTree(raw) };
    }
    return { ok: false, error: "Provide `path` for a document symbol tree or `query` to search workspace symbols." };
  }
  // ── code_navigate ──────────────────────────────────────────────────────────
  async _navigate(payload, ctx) {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const kind = String(payload["kind"] ?? "");
    const command = NAV_COMMANDS[kind];
    if (!command) return { ok: false, error: `Unknown navigate kind '${kind}'. Use definition | typeDefinition | declaration | implementation | references.` };
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;
    const limit = clamp(num2(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const context = clamp(num2(payload["context"]) ?? 0, 0, 3);
    const wantBody = payload["includeBody"] === true && kind !== "references";
    const raw = await this._withWarmup(
      () => this._exec(command, resolved.uri, resolved.position),
      (r) => !r || r.length === 0,
      ctx
    ) ?? [];
    const sliced = raw.slice(0, limit);
    const locations = [];
    for (const loc of sliced) {
      const { uri, range } = locParts(loc);
      locations.push(await this._toCodeLocation(uri, range, context, wantBody, ctx));
    }
    return {
      ok: true,
      kind,
      target: { path: target.path, line: resolved.position.line + 1, column: resolved.position.character + 1, symbol: resolved.symbolName },
      locations,
      totalFound: raw.length,
      truncated: raw.length > sliced.length
    };
  }
  // ── code_hover ─────────────────────────────────────────────────────────────
  async _hover(payload, ctx) {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;
    const hovers = await this._withWarmup(
      () => this._exec("vscode.executeHoverProvider", resolved.uri, resolved.position),
      (r) => !r || r.length === 0,
      ctx
    ) ?? [];
    const text = hovers.flatMap((h) => h.contents.map(stringifyMarkdown)).map((s) => s.trim()).filter(Boolean).join("\n\n");
    if (!text) return { ok: false, error: "No hover information at the target (the language server may still be indexing)." };
    return { ok: true, text: text.slice(0, 4e3), path: target.path, line: resolved.position.line + 1, symbol: resolved.symbolName };
  }
  // ── code_diagnostics ───────────────────────────────────────────────────────
  async _diagnostics(payload) {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    const sev = typeof payload["severity"] === "string" ? payload["severity"].toLowerCase() : "";
    const limit = clamp(num2(payload["limit"]) ?? MAX_RESULTS, 1, HARD_MAX);
    const threshold = SEVERITY_THRESHOLD[sev];
    const entries = p ? [[this._resolveUri(p), vscode6.languages.getDiagnostics(this._resolveUri(p))]] : vscode6.languages.getDiagnostics();
    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    const flat = [];
    for (const [uri, diags] of entries) {
      for (const d of diags) {
        const name = SEVERITY_NAMES2[d.severity] ?? "info";
        counts[name]++;
        if (threshold !== void 0 && d.severity > threshold) continue;
        flat.push({ uri, d });
      }
    }
    flat.sort((a, b) => a.d.severity - b.d.severity);
    const sliced = flat.slice(0, limit);
    const docCache = /* @__PURE__ */ new Map();
    const problems = [];
    for (const { uri, d } of sliced) {
      let snippet = "";
      try {
        const key = uri.toString();
        let doc = docCache.get(key);
        if (!doc) {
          doc = await vscode6.workspace.openTextDocument(uri);
          docCache.set(key, doc);
        }
        snippet = doc.lineAt(d.range.start.line).text.trim();
      } catch {
      }
      problems.push({
        path: this._relPath(uri),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: SEVERITY_NAMES2[d.severity] ?? "info",
        message: d.message,
        source: typeof d.source === "string" ? d.source : void 0,
        code: stringifyCode(d.code),
        snippet
      });
    }
    return { ok: true, scope: p ? "file" : "workspace", counts, problems, totalFound: flat.length, truncated: flat.length > sliced.length };
  }
  // ── code_rename ────────────────────────────────────────────────────────────
  async _rename(payload, ctx) {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const newName = String(payload["newName"] ?? "").trim();
    if (!newName) return { ok: false, error: "newName is required." };
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;
    const edit = await this._exec("vscode.executeDocumentRenameProvider", resolved.uri, resolved.position, newName);
    if (!edit || edit.size === 0) {
      return { ok: false, error: "The language server returned no rename edits (the symbol may not be renameable here)." };
    }
    const label = resolved.symbolName ?? target.symbol ?? "symbol";
    const res = await this._applier.apply(edit, { summary: `Rename '${label}' to '${newName}'`, autoApprove: ctx.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the rename." };
    const diagnostics = await collectForUris(edit.entries().map(([uri]) => uri), this._workspaceRoot);
    return { ok: true, newName, files: res.files, edits: res.edits, diagnostics, autoApproveAll: res.autoApproveAll || void 0 };
  }
  // ── code_actions ───────────────────────────────────────────────────────────
  async _actions(payload, ctx) {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const line = num2(payload["line"]);
    if (line === void 0) return { ok: false, error: "line is required." };
    const endLine = num2(payload["endLine"]) ?? line;
    const only = typeof payload["only"] === "string" ? payload["only"] : void 0;
    const apply = typeof payload["apply"] === "string" ? payload["apply"].trim() : "";
    const uri = this._resolveUri(p);
    let doc;
    try {
      doc = await vscode6.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${p}.` };
    }
    const startLine = clamp(line - 1, 0, doc.lineCount - 1);
    const lastLine = clamp(endLine - 1, startLine, doc.lineCount - 1);
    const range = new vscode6.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
    const raw = await this._exec(
      "vscode.executeCodeActionProvider",
      uri,
      range,
      only,
      apply ? 50 : 0
    ) ?? [];
    if (!apply) {
      const actions = raw.map((a) => isCodeAction(a) ? { title: a.title, kind: a.kind?.value, isPreferred: a.isPreferred || void 0 } : { title: a.title, command: a.command });
      if (actions.length === 0) return { ok: true, actions, message: "No code actions available for that range." };
      return { ok: true, actions };
    }
    const lower = apply.toLowerCase();
    const chosen = raw.find((a) => a.title.toLowerCase() === lower) ?? raw.find((a) => a.title.toLowerCase().startsWith(lower));
    if (!chosen) {
      return { ok: false, error: `No code action matched '${apply}'. Available: ${raw.map((a) => a.title).slice(0, 8).join(", ") || "none"}.` };
    }
    let applied = false;
    let diagUris = [uri];
    if (isCodeAction(chosen)) {
      if (chosen.edit && chosen.edit.size > 0) {
        const res = await this._applier.apply(chosen.edit, { summary: `Code action: ${chosen.title}`, autoApprove: ctx.autoApprove });
        if (!res.applied) return { ok: false, error: "User rejected the code action." };
        applied = true;
        diagUris = chosen.edit.entries().map(([u]) => u);
        if (chosen.command) await this._runCommand(chosen.command);
        const diagnostics2 = await collectForUris(diagUris, this._workspaceRoot);
        return { ok: true, title: chosen.title, files: res.files, edits: res.edits, diagnostics: diagnostics2, autoApproveAll: res.autoApproveAll || void 0 };
      }
      if (chosen.command) {
        await this._runCommand(chosen.command);
        applied = true;
      }
    } else {
      await this._runCommand(chosen);
      applied = true;
    }
    if (!applied) return { ok: false, error: `Code action '${chosen.title}' could not be resolved to an edit headlessly.` };
    const diagnostics = await collectForUris(diagUris, this._workspaceRoot);
    return { ok: true, title: chosen.title, ranEditorCommand: true, diagnostics };
  }
  // ── code_format ────────────────────────────────────────────────────────────
  async _format(payload, ctx) {
    const p = typeof payload["path"] === "string" ? payload["path"] : "";
    if (!p) return { ok: false, error: "path is required." };
    const uri = this._resolveUri(p);
    let doc;
    try {
      doc = await vscode6.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${p}.` };
    }
    const cfg = vscode6.workspace.getConfiguration("editor", uri);
    const options = { tabSize: cfg.get("tabSize") ?? 2, insertSpaces: cfg.get("insertSpaces") ?? true };
    const rangeArg = payload["range"];
    let edits;
    if (rangeArg && num2(rangeArg.startLine) !== void 0 && num2(rangeArg.endLine) !== void 0) {
      const startLine = clamp(num2(rangeArg.startLine) - 1, 0, doc.lineCount - 1);
      const lastLine = clamp(num2(rangeArg.endLine) - 1, startLine, doc.lineCount - 1);
      const range = new vscode6.Range(startLine, 0, lastLine, doc.lineAt(lastLine).text.length);
      edits = await this._exec("vscode.executeFormatRangeProvider", uri, range, options);
    } else {
      edits = await this._exec("vscode.executeFormatDocumentProvider", uri, options);
    }
    if (!edits || edits.length === 0) return { ok: true, formatted: false, message: "No formatting changes (already formatted or no formatter for this language)." };
    const edit = new vscode6.WorkspaceEdit();
    for (const e of edits) edit.replace(uri, e.range, e.newText);
    const res = await this._applier.apply(edit, { summary: `Format ${this._relPath(uri)}`, autoApprove: ctx.autoApprove });
    if (!res.applied) return { ok: false, error: "User rejected the formatting." };
    return { ok: true, formatted: true, edits: res.edits, autoApproveAll: res.autoApproveAll || void 0 };
  }
  async _insert(payload, ctx) {
    const target = parseTarget(payload);
    if (!target) return { ok: false, error: "target.path is required." };
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    if (!text) return { ok: false, error: "text is required." };
    const positionMode = String(payload["position"] ?? "after");
    if (!["before", "after", "start", "end"].includes(positionMode)) {
      return { ok: false, error: "position must be before, after, start, or end." };
    }
    const resolved = await this._resolveTarget(target, ctx);
    if (!resolved.ok) return resolved;
    const insertPosition = resolveInsertPosition(resolved.doc, resolved.range, positionMode);
    const edit = new vscode6.WorkspaceEdit();
    edit.insert(resolved.uri, insertPosition, text);
    const label = resolved.symbolName ?? target.symbol ?? `${target.path}:${resolved.position.line + 1}`;
    const res = await this._applier.apply(edit, {
      summary: `Insert code ${positionMode} ${label}`,
      autoApprove: ctx.autoApprove
    });
    if (!res.applied) return { ok: false, error: "User rejected the insertion." };
    const diagnostics = await collectForUris([resolved.uri], this._workspaceRoot);
    return {
      ok: true,
      path: this._relPath(resolved.uri),
      line: insertPosition.line + 1,
      column: insertPosition.character + 1,
      diagnostics,
      autoApproveAll: res.autoApproveAll || void 0
    };
  }
  async _runCommand(command) {
    await this._exec(command.command, ...command.arguments ?? []);
  }
  // ── Position resolution ────────────────────────────────────────────────────
  async _resolveTarget(target, ctx) {
    const uri = this._resolveUri(target.path);
    let doc;
    try {
      doc = await vscode6.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${target.path}.` };
    }
    if (target.symbol) {
      const flat = await this._flatDocumentSymbols(uri, ctx);
      const matches = flat.filter((s) => symbolMatches(s, target.symbol, target.kind));
      if (matches.length === 0) {
        const near = flat.slice(0, 8).map((s) => s.name).join(", ");
        return { ok: false, error: `Symbol '${target.symbol}' not found in ${target.path}.${near ? ` Nearby symbols: ${near}.` : ""}` };
      }
      if (matches.length > 1 && !target.firstMatch) {
        return {
          ok: false,
          ambiguous: true,
          error: `'${target.symbol}' matches ${matches.length} symbols in ${target.path}. Pass kind, line, or firstMatch:true to disambiguate.`,
          candidates: matches.map((m2) => this._toRef(m2))
        };
      }
      const m = matches[0];
      return { ok: true, uri, position: m.selection, range: m.range, doc, symbolName: m.name };
    }
    if (typeof target.line === "number") {
      const lineIdx = Math.max(0, target.line - 1);
      if (lineIdx >= doc.lineCount) return { ok: false, error: `Line ${target.line} is out of range (${doc.lineCount} lines in ${target.path}).` };
      const lineText = doc.lineAt(lineIdx).text;
      let col;
      if (target.matchText) {
        const i = lineText.indexOf(target.matchText);
        col = i >= 0 ? i : firstNonWs(lineText);
      } else if (typeof target.column === "number") {
        col = Math.max(0, target.column - 1);
      } else {
        col = firstNonWs(lineText);
      }
      return {
        ok: true,
        uri,
        position: new vscode6.Position(lineIdx, col),
        range: new vscode6.Range(lineIdx, 0, lineIdx, lineText.length),
        doc
      };
    }
    return { ok: false, error: "Provide `symbol` or `line` in target." };
  }
  // ── Helpers ────────────────────────────────────────────────────────────────
  async _flatDocumentSymbols(uri, ctx) {
    const syms = await this._withWarmup(
      () => this._exec("vscode.executeDocumentSymbolProvider", uri),
      (r) => !r || r.length === 0,
      ctx ?? { autoApprove: false }
    ) ?? [];
    const out = [];
    const walk = (list, container) => {
      for (const s of list) {
        if (isDocumentSymbol(s)) {
          out.push({ name: s.name, kind: s.kind, container, selection: s.selectionRange.start, range: s.range, uri });
          if (s.children?.length) walk(s.children, container ? `${container}.${s.name}` : s.name);
        } else {
          out.push({ name: s.name, kind: s.kind, container: s.containerName || void 0, selection: s.location.range.start, range: s.location.range, uri: s.location.uri });
        }
      }
    };
    walk(syms);
    return out;
  }
  async _toCodeLocation(uri, range, context, wantBody, ctx) {
    let snippet = "";
    let symbol;
    let kind;
    try {
      const doc = await vscode6.workspace.openTextDocument(uri);
      if (wantBody) {
        const body = await this._symbolBody(doc, range.start, ctx);
        snippet = body.text;
        symbol = body.name;
        kind = body.kind;
      } else if (context > 0) {
        const start = Math.max(0, range.start.line - context);
        const end = Math.min(doc.lineCount - 1, range.end.line + context);
        snippet = doc.getText(new vscode6.Range(start, 0, end, doc.lineAt(end).text.length));
      } else {
        snippet = doc.lineAt(range.start.line).text.trim();
      }
    } catch {
    }
    return {
      path: this._relPath(uri),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      snippet,
      symbol,
      kind
    };
  }
  async _symbolBody(doc, position, ctx) {
    const flat = await this._flatDocumentSymbols(doc.uri, ctx);
    let best;
    for (const s of flat) {
      if (s.range.contains(position) && (!best || rangeSize(s.range) < rangeSize(best.range))) best = s;
    }
    if (!best) return { text: doc.lineAt(position.line).text.trim() };
    let text = doc.getText(best.range);
    const lines = text.split("\n");
    if (lines.length > 200) text = `${lines.slice(0, 200).join("\n")}
\u2026 (truncated)`;
    return { text, name: best.name, kind: kindName(best.kind) };
  }
  _toRef(s) {
    return { name: s.name, kind: kindName(s.kind), path: this._relPath(s.uri), line: s.selection.line + 1, container: s.container };
  }
  async _exec(command, ...args) {
    return withTimeout(vscode6.commands.executeCommand(command, ...args), 9e3);
  }
  async _withWarmup(fn, isEmpty, ctx) {
    let r = await fn();
    for (let i = 0; i < 5 && isEmpty(r); i++) {
      if (ctx.signal?.aborted) break;
      await delay(400);
      r = await fn();
    }
    return r;
  }
  _resolveUri(p) {
    if (path9.isAbsolute(p)) return vscode6.Uri.file(p);
    for (const folder of vscode6.workspace.workspaceFolders ?? []) {
      const candidate = path9.join(folder.uri.fsPath, p);
      if (fs5.existsSync(candidate)) return vscode6.Uri.file(candidate);
    }
    return vscode6.Uri.file(path9.join(this._workspaceRoot, p));
  }
  _relPath(uri) {
    const folder = vscode6.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const rel2 = path9.relative(base, uri.fsPath).replace(/\\/g, "/");
    return rel2 && !rel2.startsWith("..") ? rel2 : uri.fsPath.replace(/\\/g, "/");
  }
};
function parseTarget(payload) {
  const t = payload["target"];
  if (!t || typeof t !== "object") return null;
  const o = t;
  if (typeof o["path"] !== "string" || !o["path"]) return null;
  return {
    path: o["path"],
    symbol: typeof o["symbol"] === "string" ? o["symbol"] : void 0,
    kind: typeof o["kind"] === "string" ? o["kind"] : void 0,
    line: typeof o["line"] === "number" ? o["line"] : void 0,
    column: typeof o["column"] === "number" ? o["column"] : void 0,
    matchText: typeof o["matchText"] === "string" ? o["matchText"] : void 0,
    firstMatch: o["firstMatch"] === true
  };
}
function symbolMatches(s, name, kind) {
  const qualified = s.container ? `${s.container}.${s.name}` : s.name;
  const nameOk = s.name === name || qualified === name || qualified.endsWith(`.${name}`);
  if (!nameOk) return false;
  if (kind && kindName(s.kind).toLowerCase() !== kind.toLowerCase()) return false;
  return true;
}
function buildSymbolTree(list) {
  return list.map((s) => {
    if (isDocumentSymbol(s)) {
      return {
        name: s.name,
        kind: kindName(s.kind),
        line: s.range.start.line + 1,
        endLine: s.range.end.line + 1,
        detail: s.detail || void 0,
        children: s.children?.length ? buildSymbolTree(s.children) : void 0
      };
    }
    return {
      name: s.name,
      kind: kindName(s.kind),
      line: s.location.range.start.line + 1,
      container: s.containerName || void 0
    };
  });
}
function locParts(loc) {
  if ("targetUri" in loc) return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange };
  return { uri: loc.uri, range: loc.range };
}
function resolveInsertPosition(doc, range, mode) {
  if (mode === "before") return new vscode6.Position(range.start.line, 0);
  if (mode === "start") return range.start;
  if (mode === "end") return range.end;
  const afterLine = range.end.line;
  if (afterLine >= doc.lineCount - 1) {
    return range.end;
  }
  return new vscode6.Position(afterLine + 1, 0);
}
function isDocumentSymbol(s) {
  return s.selectionRange !== void 0;
}
function isCodeAction(a) {
  return typeof a.command !== "string";
}
function stringifyMarkdown(c) {
  if (typeof c === "string") return c;
  if ("value" in c) return c.value;
  return "";
}
function stringifyCode(code) {
  if (code == null) return void 0;
  if (typeof code === "string" || typeof code === "number") return String(code);
  if (typeof code === "object" && "value" in code) return String(code.value);
  return void 0;
}
function kindName(k) {
  return SYMBOL_KIND_NAMES[k] ?? "symbol";
}
function num2(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : void 0;
}
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
function firstNonWs(s) {
  const i = s.search(/\S/);
  return i >= 0 ? i : 0;
}
function rangeSize(r) {
  return (r.end.line - r.start.line) * 1e3 + (r.end.character - r.start.character);
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function withTimeout(p, ms) {
  return new Promise((resolve3) => {
    const t = setTimeout(() => resolve3(void 0), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve3(v);
    }, () => {
      clearTimeout(t);
      resolve3(void 0);
    });
  });
}

// src/workspace-edit-applier.ts
var vscode7 = __toESM(require("vscode"));
var path10 = __toESM(require("path"));
var PROPOSED_SCHEME = "blacksite-proposed";
var MAX_PREVIEW_DIFFS = 6;
var ProposedContentProvider = class {
  _contents = /* @__PURE__ */ new Map();
  _emitter = new vscode7.EventEmitter();
  onDidChange = this._emitter.event;
  set(key, content) {
    this._contents.set(key, content);
    const uri = vscode7.Uri.parse(`${PROPOSED_SCHEME}:${key}`);
    this._emitter.fire(uri);
    return uri;
  }
  clear() {
    this._contents.clear();
  }
  provideTextDocumentContent(uri) {
    return this._contents.get(uri.path.replace(/^\//, "")) ?? "";
  }
  dispose() {
    this._emitter.dispose();
  }
};
var WorkspaceEditApplier = class {
  constructor(_workspaceRoot) {
    this._workspaceRoot = _workspaceRoot;
    this._registration = vscode7.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this._proposed);
  }
  _proposed = new ProposedContentProvider();
  _registration;
  _counter = 0;
  _applyQueue = Promise.resolve();
  _approvalProvider;
  /**
   * Route the apply/reject decision through the host UI (the chat webview) instead of a
   * native modal. When unset, falls back to the VS Code modal. The diff preview opens in
   * the editor either way.
   */
  setApprovalProvider(provider) {
    this._approvalProvider = provider;
  }
  dispose() {
    this._registration.dispose();
    this._proposed.dispose();
  }
  /** Preview (unless auto-approving) then apply a WorkspaceEdit, saving touched documents. */
  async apply(edit, opts) {
    const result = new Promise((resolve3, reject) => {
      this._applyQueue = this._applyQueue.then(async () => {
        try {
          const res = await this._applyInternal(edit, opts);
          resolve3(res);
        } catch (err) {
          reject(err);
        }
      });
    });
    return result;
  }
  async _applyInternal(edit, opts) {
    const entries = edit.entries();
    const files = entries.length;
    const edits = entries.reduce((n, [, es]) => n + es.length, 0);
    if (files === 0 || edits === 0) {
      const applied2 = await vscode7.workspace.applyEdit(edit);
      return { applied: applied2, files, edits };
    }
    let decision = "apply";
    if (!opts.autoApprove) {
      decision = await this._previewAndConfirm(entries, opts.summary);
      if (decision === "reject") return { applied: false, files, edits };
    }
    const applied = await vscode7.workspace.applyEdit(edit);
    if (applied) await this._save(entries.map(([uri]) => uri));
    return { applied, files, edits, autoApproveAll: decision === "all" || void 0 };
  }
  // ── Internals ──────────────────────────────────────────────────────────────
  async _previewAndConfirm(entries, summary) {
    for (const [uri, edits] of entries.slice(0, MAX_PREVIEW_DIFFS)) {
      try {
        const doc = await vscode7.workspace.openTextDocument(uri);
        const proposed = applyTextEdits(doc, edits);
        const base = path10.basename(uri.fsPath);
        const proposedUri = this._proposed.set(`${++this._counter}/${base}`, proposed);
        await vscode7.commands.executeCommand("vscode.diff", uri, proposedUri, `${base} \u2194 Blacksite proposed`, { preview: false });
      } catch {
      }
    }
    const detail = [
      summary,
      "",
      ...entries.map(([uri, edits]) => `${this._rel(uri)} \u2014 ${edits.length} edit(s)`),
      entries.length > MAX_PREVIEW_DIFFS ? `
(${entries.length} files total; first ${MAX_PREVIEW_DIFFS} shown as diffs)` : ""
    ].filter((l) => l !== "").join("\n");
    let outcome = this._approvalProvider ? await this._approvalProvider({ summary: detail, fileCount: entries.length }) : null;
    if (!outcome) {
      const choice = await vscode7.window.showWarningMessage(
        `Apply Blacksite changes to ${entries.length} file(s)?`,
        { modal: true, detail },
        "Apply",
        "Apply All",
        "Reject"
      );
      outcome = choice === "Apply All" ? "all" : choice === "Apply" ? "apply" : "reject";
    }
    await this._closeProposedDiffs();
    this._proposed.clear();
    return outcome;
  }
  async _closeProposedDiffs() {
    const tabs = vscode7.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode7.TabInputTextDiff && t.input.modified.scheme === PROPOSED_SCHEME);
    if (tabs.length) await vscode7.window.tabGroups.close(tabs);
  }
  async _save(uris) {
    const seen = /* @__PURE__ */ new Set();
    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const doc = await vscode7.workspace.openTextDocument(uri);
        if (doc.isDirty) await doc.save();
      } catch {
      }
    }
  }
  _rel(uri) {
    const folder = vscode7.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const rel2 = path10.relative(base, uri.fsPath).replace(/\\/g, "/");
    return rel2 && !rel2.startsWith("..") ? rel2 : uri.fsPath.replace(/\\/g, "/");
  }
};
function applyTextEdits(doc, edits) {
  const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
  let text = doc.getText();
  for (const e of sorted) {
    const start = doc.offsetAt(e.range.start);
    const end = doc.offsetAt(e.range.end);
    text = text.slice(0, start) + e.newText + text.slice(end);
  }
  return text;
}

// src/workspace-context.ts
var vscode10 = __toESM(require("vscode"));
var fs8 = __toESM(require("fs"));
var path13 = __toESM(require("path"));

// src/base-context-store.ts
var fs6 = __toESM(require("fs"));
var path11 = __toESM(require("path"));
var vscode8 = __toESM(require("vscode"));
var BASE_CONTEXT_FILE = "base-context.json";
var BLACKSITE_DIR = ".blacksite";
var BASE_CONTEXT_SCHEMA_VERSION = 1;
var MAX_TOPIC_TITLE = 120;
var MAX_TOPIC_NOTES = 16e3;
var MAX_PROMPT_CHARS = 6e3;
var MAX_TOPIC_FILES = 6;
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function ensureDir(dirPath) {
  if (!fs6.existsSync(dirPath)) fs6.mkdirSync(dirPath, { recursive: true });
}
function defaultDocument() {
  return {
    schemaVersion: BASE_CONTEXT_SCHEMA_VERSION,
    updatedAt: null,
    topics: []
  };
}
function normalizeFileRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const filePath = typeof record.path === "string" ? normalizeStoredPath(record.path) : "";
  if (!filePath) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("bc_file"),
    path: filePath,
    addedAt: typeof record.addedAt === "string" && record.addedAt ? record.addedAt : nowIso2()
  };
}
function normalizeTopic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const title = typeof record.title === "string" ? cleanTitle(record.title) : "";
  if (!title) return null;
  const files = Array.isArray(record.files) ? record.files.map(normalizeFileRef).filter((file) => file !== null).slice(0, MAX_TOPIC_FILES) : [];
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("bc_topic"),
    title,
    notes: typeof record.notes === "string" ? record.notes.slice(0, MAX_TOPIC_NOTES) : "",
    enabled: record.enabled !== false,
    pinned: record.pinned === true,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso2(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso2(),
    files
  };
}
function normalizeDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDocument();
  const record = value;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : BASE_CONTEXT_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    topics: Array.isArray(record.topics) ? record.topics.map(normalizeTopic).filter((topic) => topic !== null) : []
  };
}
function cleanTitle(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TOPIC_TITLE);
}
function normalizeStoredPath(value) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}
function relativeToWorkspace(workspaceRoot, filePath) {
  const absolute = path11.resolve(filePath);
  const relative8 = path11.relative(workspaceRoot, absolute).replace(/\\/g, "/");
  if (!relative8 || relative8.startsWith("..")) return null;
  return normalizeStoredPath(relative8);
}
function sortTopics(topics) {
  return topics.slice().sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
function shortText(value, maxChars) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}\u2026` : normalized;
}
function readTextSnippet(filePath, maxChars) {
  try {
    const raw = fs6.readFileSync(filePath, "utf8").replace(/\0/g, "");
    return shortText(raw, maxChars);
  } catch {
    return "";
  }
}
function summarizeBaseContextForPrompt(workspaceRoot, maxChars = MAX_PROMPT_CHARS) {
  const filePath = path11.join(workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
  if (!fs6.existsSync(filePath)) return "";
  const document = normalizeDocument(readJsonFile(filePath));
  const enabledTopics = sortTopics(document.topics).filter((topic) => topic.enabled);
  if (enabledTopics.length === 0) return "";
  const sections = [];
  let remaining = maxChars;
  for (const topic of enabledTopics) {
    const lines = [`- ${topic.title}`];
    if (topic.notes.trim()) {
      lines.push(`  Notes: ${shortText(topic.notes, 600)}`);
    }
    for (const file of topic.files.slice(0, 3)) {
      const absolute = path11.join(workspaceRoot, file.path);
      const snippet = readTextSnippet(absolute, 900);
      if (snippet) {
        lines.push(`  File ${file.path}: ${snippet}`);
      } else {
        lines.push(`  File ${file.path}`);
      }
    }
    const block = lines.join("\n");
    if (block.length > remaining && sections.length > 0) break;
    sections.push(block.slice(0, remaining));
    remaining -= block.length + 1;
    if (remaining <= 180) break;
  }
  return sections.join("\n");
}
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs6.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
var BaseContextStore = class {
  constructor(_workspaceRoot) {
    this._workspaceRoot = _workspaceRoot;
  }
  _emitter = new vscode8.EventEmitter();
  onDidChange = this._emitter.event;
  dispose() {
    this._emitter.dispose();
  }
  ensureInitialized() {
    ensureDir(path11.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs6.existsSync(this.filePath())) {
      fs6.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}
`, "utf8");
    }
  }
  filePath() {
    return path11.join(this._workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
  }
  read() {
    return normalizeDocument(readJsonFile(this.filePath()));
  }
  createTopic(title = "New topic") {
    const document = this.read();
    const timestamp = nowIso2();
    const topic = {
      id: newId("bc_topic"),
      title: cleanTitle(title) || "New topic",
      notes: "",
      enabled: true,
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      files: []
    };
    document.topics.unshift(topic);
    this.write(document);
    return topic;
  }
  updateTopic(topicId, patch) {
    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) return document;
    if (typeof patch.title === "string") {
      const title = cleanTitle(patch.title);
      if (title) topic.title = title;
    }
    if (typeof patch.notes === "string") topic.notes = patch.notes.slice(0, MAX_TOPIC_NOTES);
    if (typeof patch.enabled === "boolean") topic.enabled = patch.enabled;
    if (typeof patch.pinned === "boolean") topic.pinned = patch.pinned;
    topic.updatedAt = nowIso2();
    this.write(document);
    return document;
  }
  deleteTopic(topicId) {
    const document = this.read();
    document.topics = document.topics.filter((topic) => topic.id !== topicId);
    this.write(document);
    return document;
  }
  addFile(topicId, filePath) {
    const relative8 = relativeToWorkspace(this._workspaceRoot, filePath);
    if (!relative8) throw new Error("Only workspace files can be attached to Base Context.");
    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) throw new Error("Topic not found.");
    if (topic.files.some((file) => file.path === relative8)) return document;
    if (topic.files.length >= MAX_TOPIC_FILES) throw new Error(`Each topic supports up to ${MAX_TOPIC_FILES} files.`);
    topic.files.push({
      id: newId("bc_file"),
      path: relative8,
      addedAt: nowIso2()
    });
    topic.updatedAt = nowIso2();
    this.write(document);
    return document;
  }
  removeFile(topicId, fileId) {
    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) return document;
    topic.files = topic.files.filter((file) => file.id !== fileId);
    topic.updatedAt = nowIso2();
    this.write(document);
    return document;
  }
  write(document) {
    const normalized = normalizeDocument({
      ...document,
      schemaVersion: BASE_CONTEXT_SCHEMA_VERSION,
      updatedAt: nowIso2(),
      topics: document.topics
    });
    fs6.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}
`, "utf8");
    this._emitter.fire(normalized);
  }
};

// src/planning-store.ts
var fs7 = __toESM(require("fs"));
var path12 = __toESM(require("path"));
var vscode9 = __toESM(require("vscode"));
var BLACKSITE_DIR2 = ".blacksite";
var PLANNING_FILE = "planning.json";
var PLANNING_SCHEMA_VERSION = 2;
var MAX_TEXT = 2e3;
var MAX_NOTES = 12;
var MAX_PROMPT_CHARS2 = 5500;
function nowIso3() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId2(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function nextSeq(ids, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
function buildPlanStep(record, id, timestamp) {
  const title = cleanText(record.title, 160);
  if (!title) return null;
  return {
    id,
    title,
    detail: cleanParagraph(record.detail, 500) || void 0,
    acceptanceCriteria: cleanParagraph(record.acceptanceCriteria, 500) || void 0,
    status: normalizeStepStatus(record.status) ?? "pending",
    notes: [],
    updatedAt: timestamp
  };
}
function normalizeShortList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => cleanText(entry, maxChars)).filter(Boolean).slice(0, maxItems);
}
function normalizeComplexity(value) {
  const key = statusKey(value);
  return key === "small" || key === "medium" || key === "large" ? key : null;
}
function isExactPermutation(order, currentIds) {
  if (order.length !== currentIds.length) return false;
  const orderSet = new Set(order);
  if (orderSet.size !== order.length) return false;
  const currentSet = new Set(currentIds);
  for (const id of orderSet) {
    if (!currentSet.has(id)) return false;
  }
  return true;
}
function ensureDir2(dirPath) {
  if (!fs7.existsSync(dirPath)) fs7.mkdirSync(dirPath, { recursive: true });
}
function defaultDocument2() {
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    updatedAt: null,
    plans: [],
    todoRuns: []
  };
}
function cleanText(value, maxChars = MAX_TEXT) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxChars) : "";
}
function cleanParagraph(value, maxChars = MAX_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}
function statusKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function normalizePlanStatus(value) {
  switch (statusKey(value)) {
    case "draft":
    case "new":
    case "planned":
    case "planning":
      return "draft";
    case "active":
    case "in_progress":
    case "inprogress":
    case "doing":
    case "started":
    case "resumed":
    case "resume":
    case "wip":
      return "active";
    case "on_hold":
    case "onhold":
    case "hold":
    case "held":
    case "paused":
    case "pause":
    case "suspended":
    case "parked":
    case "shelved":
      return "on_hold";
    case "completed":
    case "complete":
    case "done":
    case "finished":
    case "success":
    case "shipped":
      return "completed";
    case "blocked":
    case "block":
    case "stuck":
    case "waiting":
      return "blocked";
    case "cancelled":
    case "canceled":
    case "cancel":
    case "abandoned":
    case "dropped":
    case "closed":
      return "cancelled";
    default:
      return null;
  }
}
function normalizePhaseStatus(value) {
  switch (statusKey(value)) {
    case "pending":
    case "todo":
    case "not_started":
    case "notstarted":
    case "queued":
    case "new":
    case "waiting":
      return "pending";
    case "in_progress":
    case "inprogress":
    case "active":
    case "doing":
    case "started":
    case "running":
    case "wip":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
    case "finished":
    case "success":
    case "passed":
    case "shipped":
      return "completed";
    case "blocked":
    case "block":
    case "stuck":
    case "on_hold":
    case "held":
    case "paused":
      return "blocked";
    default:
      return null;
  }
}
function normalizeStepStatus(value) {
  return normalizePhaseStatus(value);
}
function isManualHoldStatus(status) {
  return status === "on_hold" || status === "cancelled";
}
function normalizeTodoStatus(value) {
  if (value === "pending" || value === "running" || value === "done" || value === "failed") return value;
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "in_progress":
    case "inprogress":
    case "active":
    case "started":
    case "doing":
    case "wip":
      return "running";
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
    case "finished":
    case "ok":
    case "passed":
      return "done";
    case "error":
    case "errored":
    case "blocked":
    case "cancelled":
    case "canceled":
    case "aborted":
    case "fail":
      return "failed";
    case "todo":
    case "not_started":
    case "queued":
    case "waiting":
    case "new":
      return "pending";
    default:
      return null;
  }
}
function normalizeNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.map((note) => cleanParagraph(note, 400)).filter(Boolean).slice(0, MAX_NOTES);
}
function normalizeTaskPlanStep(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const title = cleanText(record.title, 160);
  const status = normalizeStepStatus(record.status) ?? "pending";
  if (!title) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId2("plan_step"),
    title,
    detail: cleanParagraph(record.detail, 500) || void 0,
    acceptanceCriteria: cleanParagraph(record.acceptanceCriteria, 500) || void 0,
    status,
    notes: normalizeNotes(record.notes),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso3()
  };
}
function normalizeTaskPlanPhase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const title = cleanText(record.title, 160);
  if (!title) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId2("plan_phase"),
    title,
    objective: cleanParagraph(record.objective, 500) || void 0,
    risks: cleanParagraph(record.risks, 500) || void 0,
    dependsOn: normalizeShortList(record.dependsOn, 20, 120),
    acceptanceCriteria: normalizeShortList(record.acceptanceCriteria, 20, 300),
    complexity: normalizeComplexity(record.complexity) || void 0,
    status: normalizePhaseStatus(record.status) ?? "pending",
    steps: Array.isArray(record.steps) ? record.steps.map(normalizeTaskPlanStep).filter((step) => step !== null) : [],
    notes: normalizeNotes(record.notes),
    linkedTodoIds: Array.isArray(record.linkedTodoIds) ? record.linkedTodoIds.map((entry) => cleanText(entry, 120)).filter(Boolean) : [],
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso3(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : void 0
  };
}
function normalizeTaskPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const title = cleanText(record.title, 180);
  if (!title) return null;
  const phases = Array.isArray(record.phases) ? record.phases.map(normalizeTaskPlanPhase).filter((phase) => phase !== null) : [];
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId2("plan"),
    title,
    summary: cleanParagraph(record.summary, 1e3) || void 0,
    status: normalizePlanStatus(record.status) ?? "draft",
    phases,
    notes: normalizeNotes(record.notes),
    activePhaseId: cleanText(record.activePhaseId, 120) || void 0,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso3(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso3(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : void 0,
    sessionId: cleanText(record.sessionId, 120) || void 0,
    lastRequestId: cleanText(record.lastRequestId, 120) || void 0
  };
}
function normalizeTodoStep(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const label = cleanText(record.label, 180);
  const status = normalizeTodoStatus(record.status);
  if (!label || !status) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId2("todo_step"),
    label,
    status,
    result: cleanParagraph(record.result, 500) || void 0
  };
}
function normalizeTodoRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  const name = cleanText(record.name, 180);
  if (!name) return null;
  const steps = Array.isArray(record.steps) ? record.steps.map(normalizeTodoStep).filter((step) => step !== null) : [];
  if (steps.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId2("todo"),
    name,
    steps,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso3(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso3(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : void 0,
    sessionId: cleanText(record.sessionId, 120) || void 0,
    requestId: cleanText(record.requestId, 120) || void 0,
    lastRequestId: cleanText(record.lastRequestId, 120) || void 0,
    planId: cleanText(record.planId, 120) || void 0,
    phaseId: cleanText(record.phaseId, 120) || void 0
  };
}
function normalizeDocument2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDocument2();
  const record = value;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : PLANNING_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    plans: Array.isArray(record.plans) ? record.plans.map(normalizeTaskPlan).filter((plan) => plan !== null) : [],
    todoRuns: Array.isArray(record.todoRuns) ? record.todoRuns.map(normalizeTodoRun).filter((run) => run !== null) : []
  };
}
function cloneTodoStep(step) {
  return { ...step };
}
function todoProgress(doneCount, failedCount, total) {
  return `${doneCount}/${total} done${failedCount ? `, ${failedCount} failed` : ""}`;
}
function summarizeTodoRun(run) {
  const steps = run.steps.map(cloneTodoStep);
  const pendingSteps = steps.filter((step) => step.status === "pending");
  const runningSteps = steps.filter((step) => step.status === "running");
  const completedSteps = steps.filter((step) => step.status === "done");
  const failedSteps = steps.filter((step) => step.status === "failed");
  const total = steps.length;
  let status = "pending";
  if (run.completedAt) {
    status = failedSteps.length > 0 ? "failed" : "completed";
  } else if (runningSteps.length > 0) {
    status = "running";
  } else if (completedSteps.length > 0 || failedSteps.length > 0) {
    status = "in_progress";
  }
  return {
    id: run.id,
    name: run.name,
    status,
    isActive: !run.completedAt,
    progress: todoProgress(completedSteps.length, failedSteps.length, total),
    counts: {
      total,
      pending: pendingSteps.length,
      running: runningSteps.length,
      done: completedSteps.length,
      failed: failedSteps.length
    },
    currentStep: runningSteps[0] ?? pendingSteps[0],
    nextStep: pendingSteps[0],
    completedSteps,
    runningSteps,
    pendingSteps,
    failedSteps,
    steps,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    planId: run.planId,
    phaseId: run.phaseId
  };
}
function summarizePlan(plan) {
  const phases = plan.phases.map((phase) => {
    const counts = {
      total: phase.steps.length,
      pending: phase.steps.filter((step) => step.status === "pending").length,
      inProgress: phase.steps.filter((step) => step.status === "in_progress").length,
      completed: phase.steps.filter((step) => step.status === "completed").length,
      blocked: phase.steps.filter((step) => step.status === "blocked").length
    };
    const currentStep = phase.steps.find((step) => step.status === "in_progress") ?? phase.steps.find((step) => step.status === "pending");
    return {
      id: phase.id,
      title: phase.title,
      objective: phase.objective,
      risks: phase.risks,
      dependsOn: phase.dependsOn?.length ? [...phase.dependsOn] : void 0,
      acceptanceCriteria: phase.acceptanceCriteria?.length ? [...phase.acceptanceCriteria] : void 0,
      complexity: phase.complexity,
      status: phase.status,
      counts,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : void 0,
      steps: phase.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        detail: step.detail,
        acceptanceCriteria: step.acceptanceCriteria
      })),
      linkedTodoIds: [...phase.linkedTodoIds]
    };
  });
  const activePhase = plan.phases.find((phase) => phase.id === plan.activePhaseId) ?? plan.phases.find((phase) => phase.status === "in_progress") ?? plan.phases.find((phase) => phase.status === "pending");
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    activePhaseId: activePhase?.id,
    activePhaseTitle: activePhase?.title,
    phaseCount: plan.phases.length,
    completedPhaseCount: plan.phases.filter((phase) => phase.status === "completed").length,
    phases,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    completedAt: plan.completedAt
  };
}
function appendNote(notes, note) {
  const clean = cleanParagraph(note, 500);
  if (!clean) return notes;
  return [clean, ...notes].slice(0, MAX_NOTES);
}
function readJsonFile2(filePath) {
  try {
    return JSON.parse(fs7.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function readPlanningDocument(workspaceRoot) {
  const document = normalizeDocument2(readJsonFile2(path12.join(workspaceRoot, BLACKSITE_DIR2, PLANNING_FILE)));
  for (const plan of document.plans) reconcilePlan(plan);
  return document;
}
function sortByUpdatedAt(items) {
  return items.slice().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
function resolveTodoStep(run, rawStepRef) {
  const stepRef = rawStepRef.trim();
  if (!stepRef) return null;
  const exact = run.steps.find((step) => step.id === stepRef);
  if (exact) return exact;
  const lower = stepRef.toLowerCase();
  const byLabel = run.steps.find((step) => step.label.toLowerCase() === lower);
  if (byLabel) return byLabel;
  const numeric = Number(stepRef.replace(/^step-/i, ""));
  if (Number.isInteger(numeric) && numeric >= 0) {
    return run.steps[numeric] ?? run.steps[numeric - 1] ?? null;
  }
  return null;
}
function reconcilePhaseStatus(phase) {
  const total = phase.steps.length;
  const completed = phase.steps.filter((step) => step.status === "completed").length;
  const inProgress = phase.steps.filter((step) => step.status === "in_progress").length;
  const blocked = phase.steps.filter((step) => step.status === "blocked").length;
  if (total === 0) return;
  if (completed === total) {
    phase.status = "completed";
    phase.completedAt = phase.completedAt ?? nowIso3();
    return;
  }
  delete phase.completedAt;
  if (inProgress > 0) {
    phase.status = "in_progress";
    return;
  }
  if (blocked > 0 && completed + blocked === total) {
    phase.status = "blocked";
    return;
  }
  if (completed > 0 || blocked > 0) {
    phase.status = "in_progress";
    return;
  }
  if (phase.status !== "blocked") phase.status = "pending";
}
function reconcilePlan(plan) {
  if (isManualHoldStatus(plan.status)) return;
  const preserveDraft = plan.status === "draft";
  for (const phase of plan.phases) {
    reconcilePhaseStatus(phase);
  }
  const completedCount = plan.phases.filter((phase) => phase.status === "completed").length;
  const inProgressPhase = plan.phases.find((phase) => phase.status === "in_progress");
  const pendingPhase = plan.phases.find((phase) => phase.status === "pending");
  const blockedPhase = plan.phases.find((phase) => phase.status === "blocked");
  plan.activePhaseId = inProgressPhase?.id ?? pendingPhase?.id ?? blockedPhase?.id ?? plan.phases.at(-1)?.id;
  if (plan.phases.length > 0 && completedCount === plan.phases.length) {
    plan.status = "completed";
    plan.completedAt = plan.completedAt ?? nowIso3();
    return;
  }
  delete plan.completedAt;
  if (inProgressPhase) {
    plan.status = "active";
    return;
  }
  if (blockedPhase && !pendingPhase) {
    plan.status = "blocked";
    return;
  }
  if (preserveDraft && !inProgressPhase && !blockedPhase && completedCount === 0) {
    plan.status = "draft";
    return;
  }
  plan.status = "active";
}
function linkTodoToPlan(plan, phaseId, todoId) {
  if (!plan || !phaseId) return;
  const phase = plan.phases.find((entry) => entry.id === phaseId);
  if (!phase) return;
  if (!phase.linkedTodoIds.includes(todoId)) phase.linkedTodoIds.push(todoId);
  phase.updatedAt = nowIso3();
  if (phase.status === "pending") phase.status = "in_progress";
  plan.activePhaseId = phase.id;
  if (plan.status === "draft") plan.status = "active";
  plan.updatedAt = nowIso3();
  reconcilePlan(plan);
}
function applyTodoStateToPlan(plan, run) {
  if (!plan || !run.phaseId) return;
  const phase = plan.phases.find((entry) => entry.id === run.phaseId);
  if (!phase) return;
  const summary = summarizeTodoRun(run);
  if (summary.status === "running" || summary.status === "in_progress") {
    phase.status = "in_progress";
  } else if (summary.status === "completed") {
    phase.status = "completed";
    phase.completedAt = phase.completedAt ?? nowIso3();
  } else if (summary.status === "failed") {
    phase.status = "blocked";
  }
  phase.updatedAt = nowIso3();
  plan.updatedAt = nowIso3();
  reconcilePlan(plan);
}
function formatPlanForPrompt(plan) {
  const summary = summarizePlan(plan);
  const lines = [
    `- ${summary.title} (${summary.id}) [${summary.status}]`
  ];
  if (summary.summary) lines.push(`  Summary: ${summary.summary}`);
  if (summary.activePhaseTitle) lines.push(`  Current phase: ${summary.activePhaseTitle}`);
  for (const phase of summary.phases.slice(0, 4)) {
    lines.push(`  - Phase ${phase.title} [${phase.status}]${phase.complexity ? ` (${phase.complexity})` : ""}`);
    if (phase.objective) lines.push(`    Objective: ${phase.objective}`);
    if (phase.risks) lines.push(`    Risks: ${phase.risks}`);
    if (phase.currentStep) lines.push(`    Current/next: ${phase.currentStep.id} [${phase.currentStep.status}] ${phase.currentStep.title}`);
  }
  return lines.join("\n");
}
function formatTodoForPrompt(run) {
  const summary = summarizeTodoRun(run);
  const lines = [`- ${summary.name} (${summary.id}) [${summary.status}] ${summary.progress}`];
  if (summary.currentStep) {
    lines.push(`  Current/next: ${summary.currentStep.id} [${summary.currentStep.status}] ${summary.currentStep.label}`);
  }
  return lines.join("\n");
}
function summarizePlanningStateForPrompt(workspaceRoot, maxChars = MAX_PROMPT_CHARS2) {
  const document = readPlanningDocument(workspaceRoot);
  const sortedPlans = sortByUpdatedAt(document.plans);
  const activePlans = sortedPlans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled" && plan.status !== "on_hold");
  const heldPlans = sortedPlans.filter((plan) => plan.status === "on_hold");
  const activeTodos = sortByUpdatedAt(document.todoRuns).filter((run) => !run.completedAt);
  if (activePlans.length === 0 && heldPlans.length === 0 && activeTodos.length === 0) return "";
  const blocks = [];
  if (activePlans.length > 0) {
    blocks.push(
      "Active plans \u2014 keep these in mind and current. As you make progress, call plan_update to advance step/phase status; add or remove steps and phases with plan_update when scope changes rather than recreating the plan:"
    );
    for (const plan of activePlans.slice(0, 3)) blocks.push(formatPlanForPrompt(plan));
  }
  if (heldPlans.length > 0) {
    blocks.push(
      "Plans ON HOLD \u2014 the user paused these. Do NOT act on, advance, or modify them unless the user explicitly resumes them:"
    );
    for (const plan of heldPlans.slice(0, 5)) blocks.push(`- ${plan.title} (${plan.id}) [on_hold]`);
  }
  if (activeTodos.length > 0) {
    blocks.push("Active task items:");
    for (const run of activeTodos.slice(0, 3)) blocks.push(formatTodoForPrompt(run));
  }
  return blocks.join("\n").slice(0, maxChars);
}
var PlanningStore = class {
  constructor(_workspaceRoot) {
    this._workspaceRoot = _workspaceRoot;
  }
  _emitter = new vscode9.EventEmitter();
  onDidChange = this._emitter.event;
  dispose() {
    this._emitter.dispose();
  }
  ensureInitialized() {
    ensureDir2(path12.join(this._workspaceRoot, BLACKSITE_DIR2));
    if (!fs7.existsSync(this.filePath())) {
      fs7.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument2(), null, 2)}
`, "utf8");
    }
  }
  filePath() {
    return path12.join(this._workspaceRoot, BLACKSITE_DIR2, PLANNING_FILE);
  }
  read() {
    const document = normalizeDocument2(readJsonFile2(this.filePath()));
    for (const plan of document.plans) reconcilePlan(plan);
    return document;
  }
  async dispatch(op, payload, ctx) {
    switch (op) {
      case "create":
        return this.createPlan(payload, ctx);
      case "update":
        return this.updatePlan(payload, ctx);
      case "list":
        return this.listPlans(payload);
      case "todoCreate":
        return this.createTodoRun(payload, ctx);
      case "todoUpdate":
        return this.updateTodoRun(payload, ctx);
      case "todoStatus":
        return this.todoStatus(payload);
      case "todoList":
        return this.todoList(payload);
      default:
        return { ok: false, error: `Unknown planning operation: ${op}` };
    }
  }
  clearCompleted() {
    const document = this.read();
    document.plans = document.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled");
    document.todoRuns = document.todoRuns.filter((run) => !run.completedAt);
    const activeTodoIds = new Set(document.todoRuns.map((run) => run.id));
    for (const plan of document.plans) {
      for (const phase of plan.phases) {
        phase.linkedTodoIds = phase.linkedTodoIds.filter((entry) => activeTodoIds.has(entry));
      }
    }
    this.write(document);
    return document;
  }
  archivePlan(planId) {
    const document = this.read();
    document.plans = document.plans.filter((plan) => plan.id !== planId);
    this.write(document);
    return document;
  }
  /**
   * User-driven plan status override (hold / resume / cancel / reopen). Unlike the
   * agent's plan_update, this respects the user's intent verbatim: holding or
   * cancelling sticks (reconcilePlan leaves manual-hold states alone), while resuming
   * to "active" lets reconciliation re-derive the real state from step progress.
   */
  setPlanStatus(planId, status) {
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return document;
    const timestamp = nowIso3();
    plan.status = status;
    if (status === "completed" || status === "cancelled") {
      plan.completedAt = plan.completedAt ?? timestamp;
    } else {
      delete plan.completedAt;
    }
    plan.updatedAt = timestamp;
    reconcilePlan(plan);
    this.write(document);
    return document;
  }
  archiveTodoRun(todoId) {
    const document = this.read();
    document.todoRuns = document.todoRuns.filter((run) => run.id !== todoId);
    for (const plan of document.plans) {
      for (const phase of plan.phases) {
        phase.linkedTodoIds = phase.linkedTodoIds.filter((entry) => entry !== todoId);
      }
    }
    this.write(document);
    return document;
  }
  createPlan(payload, ctx) {
    const title = cleanText(payload.title, 180);
    const rawPhases = Array.isArray(payload.phases) ? payload.phases : [];
    const phases = [];
    for (const [phaseIndex, phaseValue] of rawPhases.entries()) {
      const phaseRecord = phaseValue && typeof phaseValue === "object" ? phaseValue : {};
      const phaseTitle = cleanText(phaseRecord.title, 160) || `Phase ${phaseIndex + 1}`;
      const rawSteps = Array.isArray(phaseRecord.steps) ? phaseRecord.steps : [];
      const steps = [];
      for (const [stepIndex, stepValue] of rawSteps.entries()) {
        const stepRecord = stepValue && typeof stepValue === "object" ? stepValue : {};
        const stepTitle = cleanText(stepRecord.title, 160);
        if (!stepTitle) continue;
        steps.push({
          id: `step-${stepIndex + 1}`,
          title: stepTitle,
          detail: cleanParagraph(stepRecord.detail, 500) || void 0,
          acceptanceCriteria: cleanParagraph(stepRecord.acceptanceCriteria, 500) || void 0,
          status: "pending",
          notes: [],
          updatedAt: nowIso3()
        });
      }
      phases.push({
        id: `phase-${phaseIndex + 1}`,
        title: phaseTitle,
        objective: cleanParagraph(phaseRecord.objective, 500) || void 0,
        risks: cleanParagraph(phaseRecord.risks, 500) || void 0,
        dependsOn: normalizeShortList(phaseRecord.dependsOn, 20, 120),
        acceptanceCriteria: normalizeShortList(phaseRecord.acceptanceCriteria, 20, 300),
        complexity: normalizeComplexity(phaseRecord.complexity) || void 0,
        status: "pending",
        steps,
        notes: [],
        linkedTodoIds: [],
        updatedAt: nowIso3()
      });
    }
    if (!title) return { ok: false, error: "title is required." };
    if (phases.length === 0) return { ok: false, error: "At least one phase is required." };
    const timestamp = nowIso3();
    const plan = {
      id: newId2("plan"),
      title,
      summary: cleanParagraph(payload.summary, 1e3) || void 0,
      status: normalizePlanStatus(payload.status) ?? "active",
      phases,
      notes: [],
      activePhaseId: phases[0]?.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionId: ctx.sessionId,
      lastRequestId: ctx.requestId
    };
    reconcilePlan(plan);
    const document = this.read();
    document.plans.unshift(plan);
    this.write(document);
    return {
      ok: true,
      planId: plan.id,
      phaseIds: plan.phases.map((phase) => phase.id),
      plan: summarizePlan(plan)
    };
  }
  updatePlan(payload, ctx) {
    const planId = cleanText(payload.planId, 120);
    if (!planId) return { ok: false, error: "planId is required." };
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return { ok: false, error: `Plan not found: ${planId}` };
    const timestamp = nowIso3();
    if (typeof payload.title === "string") {
      const title = cleanText(payload.title, 180);
      if (title) plan.title = title;
    }
    if (typeof payload.summary === "string") {
      plan.summary = cleanParagraph(payload.summary, 1e3) || void 0;
    }
    const status = normalizePlanStatus(payload.status);
    if (status) {
      plan.status = status;
      if (status === "completed" || status === "cancelled") {
        plan.completedAt = plan.completedAt ?? timestamp;
      } else {
        delete plan.completedAt;
      }
    }
    if (payload.note != null) plan.notes = appendNote(plan.notes, payload.note);
    const activePhaseId = cleanText(payload.activePhaseId, 120);
    if (activePhaseId && plan.phases.some((phase2) => phase2.id === activePhaseId)) {
      plan.activePhaseId = activePhaseId;
    }
    const phaseId = cleanText(payload.phaseId, 120);
    const phase = phaseId ? plan.phases.find((entry) => entry.id === phaseId) : void 0;
    if (phaseId && !phase) {
      return { ok: false, error: `Phase '${phaseId}' not found in plan '${planId}'. Use plan_list to see valid phase IDs.` };
    }
    if (phase) {
      if (typeof payload.phaseTitle === "string") {
        const phaseTitle = cleanText(payload.phaseTitle, 160);
        if (phaseTitle) phase.title = phaseTitle;
      }
      if (typeof payload.phaseObjective === "string") {
        phase.objective = cleanParagraph(payload.phaseObjective, 500) || void 0;
      }
      if (typeof payload.phaseRisks === "string") {
        phase.risks = cleanParagraph(payload.phaseRisks, 500) || void 0;
      }
      if (Array.isArray(payload.phaseDependsOn)) {
        phase.dependsOn = normalizeShortList(payload.phaseDependsOn, 20, 120);
      }
      if (Array.isArray(payload.phaseAcceptanceCriteria)) {
        phase.acceptanceCriteria = normalizeShortList(payload.phaseAcceptanceCriteria, 20, 300);
      }
      if (typeof payload.phaseComplexity === "string") {
        if (!payload.phaseComplexity.trim()) phase.complexity = void 0;
        else {
          const complexity = normalizeComplexity(payload.phaseComplexity);
          if (complexity) phase.complexity = complexity;
        }
      }
      const phaseStatus = normalizePhaseStatus(payload.phaseStatus);
      if (phaseStatus) {
        phase.status = phaseStatus;
        if (phaseStatus === "completed") phase.completedAt = phase.completedAt ?? timestamp;
        else delete phase.completedAt;
      }
      if (payload.phaseNote != null) phase.notes = appendNote(phase.notes, payload.phaseNote);
      const stepId = cleanText(payload.stepId, 120);
      const step = stepId ? phase.steps.find((entry) => entry.id === stepId || entry.title === stepId || entry.title.toLowerCase() === stepId.toLowerCase()) : void 0;
      if (stepId && !step) {
        return { ok: false, error: `Step '${stepId}' not found in phase '${phaseId}'. Use plan_list to see valid step IDs.` };
      }
      if (step) {
        if (typeof payload.stepTitle === "string") {
          const stepTitle = cleanText(payload.stepTitle, 160);
          if (stepTitle) step.title = stepTitle;
        }
        if (typeof payload.stepDetail === "string") {
          step.detail = cleanParagraph(payload.stepDetail, 500) || void 0;
        }
        if (typeof payload.stepAcceptanceCriteria === "string") {
          step.acceptanceCriteria = cleanParagraph(payload.stepAcceptanceCriteria, 500) || void 0;
        }
        const stepStatus = normalizeStepStatus(payload.stepStatus);
        if (stepStatus) step.status = stepStatus;
        if (payload.stepNote != null) step.notes = appendNote(step.notes, payload.stepNote);
        step.updatedAt = timestamp;
      }
      if (Array.isArray(payload.addSteps) && payload.addSteps.length > 0) {
        let seq = nextSeq(phase.steps.map((entry) => entry.id), "step");
        for (const raw of payload.addSteps) {
          const record = raw && typeof raw === "object" ? raw : {};
          const built = buildPlanStep(record, `step-${seq}`, timestamp);
          if (built) {
            phase.steps.push(built);
            seq += 1;
          }
        }
      }
      const removeStepRef = cleanText(payload.removeStepId, 120);
      if (removeStepRef) {
        const lower = removeStepRef.toLowerCase();
        phase.steps = phase.steps.filter((entry) => entry.id !== removeStepRef && entry.title.toLowerCase() !== lower);
      }
      if (Array.isArray(payload.reorderStepIds) && payload.reorderStepIds.length > 0) {
        const order = payload.reorderStepIds.map((entry) => cleanText(entry, 120)).filter(Boolean);
        const currentIds = phase.steps.map((entry) => entry.id);
        if (!isExactPermutation(order, currentIds)) {
          return { ok: false, error: "reorderStepIds must include every existing step ID in the target phase exactly once. Use plan_list for valid step IDs." };
        }
        const byId = new Map(phase.steps.map((entry) => [entry.id, entry]));
        phase.steps = order.map((id) => byId.get(id));
      }
      const moveStepRef = cleanText(payload.moveStepId, 120);
      if (moveStepRef) {
        const moveTargetPhaseId = cleanText(payload.moveStepToPhaseId, 120);
        const destPhase = moveTargetPhaseId ? plan.phases.find((entry) => entry.id === moveTargetPhaseId) : void 0;
        if (!moveTargetPhaseId || !destPhase) {
          return { ok: false, error: "moveStepId requires a valid moveStepToPhaseId. Use plan_list for valid phase IDs." };
        }
        const lower = moveStepRef.toLowerCase();
        const moveIndex = phase.steps.findIndex((entry) => entry.id === moveStepRef || entry.title.toLowerCase() === lower);
        if (moveIndex === -1) {
          return { ok: false, error: `Step '${moveStepRef}' not found in phase '${phaseId}'. Use plan_list to see valid step IDs.` };
        }
        const [moved] = phase.steps.splice(moveIndex, 1);
        if (destPhase.steps.some((entry) => entry.id === moved.id)) {
          moved.id = `step-${nextSeq(destPhase.steps.map((entry) => entry.id), "step")}`;
        }
        moved.updatedAt = timestamp;
        destPhase.steps.push(moved);
        destPhase.updatedAt = timestamp;
      }
      phase.updatedAt = timestamp;
    } else if (Array.isArray(payload.addSteps) && payload.addSteps.length > 0) {
      return { ok: false, error: "addSteps requires a phaseId identifying which phase to extend. Use plan_list for valid phase IDs." };
    }
    if (Array.isArray(payload.addPhases) && payload.addPhases.length > 0) {
      let phaseSeq = nextSeq(plan.phases.map((entry) => entry.id), "phase");
      const newPhases = [];
      for (const rawPhase of payload.addPhases) {
        const phaseRecord = rawPhase && typeof rawPhase === "object" ? rawPhase : {};
        const phaseTitle = cleanText(phaseRecord.title, 160);
        if (!phaseTitle) continue;
        const steps = [];
        const rawSteps = Array.isArray(phaseRecord.steps) ? phaseRecord.steps : [];
        let stepSeq = 1;
        for (const rawStep of rawSteps) {
          const stepRecord = rawStep && typeof rawStep === "object" ? rawStep : {};
          const built = buildPlanStep(stepRecord, `step-${stepSeq}`, timestamp);
          if (built) {
            steps.push(built);
            stepSeq += 1;
          }
        }
        newPhases.push({
          id: `phase-${phaseSeq}`,
          title: phaseTitle,
          objective: cleanParagraph(phaseRecord.objective, 500) || void 0,
          risks: cleanParagraph(phaseRecord.risks, 500) || void 0,
          dependsOn: normalizeShortList(phaseRecord.dependsOn, 20, 120),
          acceptanceCriteria: normalizeShortList(phaseRecord.acceptanceCriteria, 20, 300),
          complexity: normalizeComplexity(phaseRecord.complexity) || void 0,
          status: "pending",
          steps,
          notes: [],
          linkedTodoIds: [],
          updatedAt: timestamp
        });
        phaseSeq += 1;
      }
      const insertBeforeId = cleanText(payload.insertPhaseBeforeId, 120);
      if (insertBeforeId) {
        const insertIndex = plan.phases.findIndex((entry) => entry.id === insertBeforeId);
        if (insertIndex === -1) {
          return { ok: false, error: `Phase '${insertBeforeId}' not found for insertPhaseBeforeId. Use plan_list for valid phase IDs.` };
        }
        plan.phases.splice(insertIndex, 0, ...newPhases);
      } else {
        plan.phases.push(...newPhases);
      }
    }
    const removePhaseRef = cleanText(payload.removePhaseId, 120);
    if (removePhaseRef) {
      plan.phases = plan.phases.filter((entry) => entry.id !== removePhaseRef);
      if (plan.activePhaseId === removePhaseRef) plan.activePhaseId = void 0;
    }
    if (Array.isArray(payload.reorderPhaseIds) && payload.reorderPhaseIds.length > 0) {
      const order = payload.reorderPhaseIds.map((entry) => cleanText(entry, 120)).filter(Boolean);
      const currentIds = plan.phases.map((entry) => entry.id);
      if (!isExactPermutation(order, currentIds)) {
        return { ok: false, error: "reorderPhaseIds must include every existing phase ID exactly once. Use plan_list for valid phase IDs." };
      }
      const byId = new Map(plan.phases.map((entry) => [entry.id, entry]));
      plan.phases = order.map((id) => byId.get(id));
    }
    plan.updatedAt = timestamp;
    plan.lastRequestId = ctx.requestId ?? plan.lastRequestId;
    reconcilePlan(plan);
    this.write(document);
    return {
      ok: true,
      updated: true,
      plan: summarizePlan(plan)
    };
  }
  listPlans(payload) {
    const activeOnly = payload.activeOnly !== false;
    const plans = sortByUpdatedAt(this.read().plans).filter((plan) => !activeOnly || plan.status !== "completed" && plan.status !== "cancelled").map(summarizePlan);
    return {
      ok: true,
      planCount: plans.length,
      plans
    };
  }
  createTodoRun(payload, ctx) {
    const stepsInput = Array.isArray(payload.steps) ? payload.steps : [];
    if (stepsInput.length === 0) return { ok: false, error: "At least one step is required." };
    const steps = [];
    for (const [index, stepValue] of stepsInput.entries()) {
      const record = stepValue && typeof stepValue === "object" ? stepValue : {};
      const label = cleanText(record.label, 180);
      if (!label) continue;
      steps.push({
        id: `step-${index + 1}`,
        label,
        status: "pending"
      });
    }
    if (steps.length === 0) return { ok: false, error: "Each task item step requires a label." };
    const todoId = newId2("todo");
    const createdAt = nowIso3();
    const run = {
      id: todoId,
      name: cleanText(payload.name, 180) || `Task Items ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`,
      steps,
      createdAt,
      updatedAt: createdAt,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      lastRequestId: ctx.requestId,
      planId: cleanText(payload.planId, 120) || void 0,
      phaseId: cleanText(payload.phaseId, 120) || void 0
    };
    const document = this.read();
    if (run.phaseId) {
      for (const existing of document.todoRuns) {
        if (!existing.completedAt && existing.phaseId === run.phaseId) {
          existing.completedAt = createdAt;
          existing.updatedAt = createdAt;
          for (const step of existing.steps) {
            if (step.status === "pending" || step.status === "running") {
              step.status = "done";
              step.result = step.result || "Superseded by a newer task-items run.";
            }
          }
        }
      }
    }
    const plan = run.planId ? document.plans.find((entry) => entry.id === run.planId) : void 0;
    linkTodoToPlan(plan, run.phaseId, run.id);
    document.todoRuns.unshift(run);
    this.write(document);
    return {
      ok: true,
      todoId,
      stepCount: run.steps.length,
      steps: run.steps.map(({ id, label }) => ({ id, label })),
      run: summarizeTodoRun(run)
    };
  }
  updateTodoRun(payload, ctx) {
    const todoId = cleanText(payload.todoId, 120);
    if (!todoId) return { ok: false, error: "todoId is required." };
    const status = normalizeTodoStatus(payload.status);
    if (!status || status !== "running" && status !== "done" && status !== "failed") {
      return { ok: false, error: "status must be running, done, or failed." };
    }
    const document = this.read();
    const run = document.todoRuns.find((entry) => entry.id === todoId);
    if (!run) return { ok: false, error: `Task-items run not found: ${todoId}` };
    const stepRef = cleanText(payload.stepId, 120);
    const step = resolveTodoStep(run, stepRef);
    if (!step) {
      return { ok: false, error: `Step not found: ${stepRef}` };
    }
    step.status = status;
    step.result = cleanParagraph(payload.result, 500) || step.result;
    run.updatedAt = nowIso3();
    run.lastRequestId = ctx.requestId ?? run.lastRequestId;
    run.sessionId = run.sessionId ?? ctx.sessionId;
    const doneCount = run.steps.filter((entry) => entry.status === "done").length;
    const failedCount = run.steps.filter((entry) => entry.status === "failed").length;
    if (doneCount + failedCount === run.steps.length) {
      run.completedAt = run.completedAt ?? nowIso3();
    } else {
      delete run.completedAt;
    }
    const linkedPlan = run.planId ? document.plans.find((entry) => entry.id === run.planId) : void 0;
    applyTodoStateToPlan(linkedPlan, run);
    this.write(document);
    return {
      ok: true,
      updated: true,
      progress: todoProgress(doneCount, failedCount, run.steps.length),
      updatedStep: cloneTodoStep(step),
      run: summarizeTodoRun(run)
    };
  }
  todoStatus(payload) {
    const todoId = cleanText(payload.todoId, 120);
    const runs = sortByUpdatedAt(this.read().todoRuns);
    const run = todoId ? runs.find((entry) => entry.id === todoId) : runs.find((entry) => !entry.completedAt) ?? runs[0];
    if (!run) return { ok: false, error: "No task-items runs found." };
    return {
      ok: true,
      run: summarizeTodoRun(run)
    };
  }
  todoList(payload) {
    const activeOnly = payload.activeOnly !== false;
    const planId = cleanText(payload.planId, 120) || void 0;
    const runs = sortByUpdatedAt(this.read().todoRuns).filter((run) => !activeOnly || !run.completedAt).filter((run) => !planId || run.planId === planId).map(summarizeTodoRun);
    return {
      ok: true,
      runCount: runs.length,
      runs
    };
  }
  write(document) {
    const normalized = normalizeDocument2({
      ...document,
      schemaVersion: PLANNING_SCHEMA_VERSION,
      updatedAt: nowIso3()
    });
    fs7.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}
`, "utf8");
    this._emitter.fire(normalized);
  }
};

// src/workspace-context.ts
var CONTEXT_FILE = ".blacksite/context.md";
var MEMORY_FILE = ".blacksite/memory.md";
var UI_PREFERENCES_FILE = ".blacksite/ui-preferences.json";
function summarizeUiPreference(preference) {
  const subject = preference.elementKey || preference.componentName || preference.elementType || "ui-element";
  const selection = preference.selection?.optionLabel || preference.selection?.optionId || "preferred selection recorded";
  const tokens = Array.isArray(preference.technicalDetails?.tokens) ? preference.technicalDetails?.tokens?.slice(0, 4).join(", ") : "";
  const cssProps = preference.technicalDetails?.cssProperties ? Object.entries(preference.technicalDetails.cssProperties).slice(0, 4).map(([key, value]) => `${key}=${String(value)}`).join(", ") : "";
  const notes = Array.isArray(preference.technicalDetails?.notes) ? preference.technicalDetails.notes.slice(0, 2).join("; ") : "";
  const details = [tokens ? `tokens: ${tokens}` : "", cssProps ? `css: ${cssProps}` : "", notes ? `notes: ${notes}` : ""].filter(Boolean).join(" | ");
  return details ? `- ${subject}: ${selection} (${details})` : `- ${subject}: ${selection}`;
}
function readUiPreferenceSummary(workspaceRoot) {
  try {
    const uiPreferencesPath = path13.join(workspaceRoot, UI_PREFERENCES_FILE);
    if (!fs8.existsSync(uiPreferencesPath)) return "";
    const raw = fs8.readFileSync(uiPreferencesPath, "utf8").slice(0, 5e4);
    const parsed = JSON.parse(raw);
    const preferences = Array.isArray(parsed.preferences) ? parsed.preferences : [];
    if (preferences.length === 0) return "";
    const recent = preferences.slice().sort((left, right) => {
      const leftTime = Date.parse(left.lastConfirmedAt ?? "");
      const rightTime = Date.parse(right.lastConfirmedAt ?? "");
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    }).slice(0, 8);
    return recent.map(summarizeUiPreference).join("\n");
  } catch {
    return "";
  }
}
async function gatherWorkspaceSnapshot(workspaceRoot, runtime) {
  const allRoots = vscode10.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [workspaceRoot];
  const activeEditor = vscode10.window.activeTextEditor;
  const activeFile = activeEditor ? path13.relative(workspaceRoot, activeEditor.document.fileName).replace(/\\/g, "/") : void 0;
  const activeLine = activeEditor ? activeEditor.selection.active.line + 1 : void 0;
  const openFiles = vscode10.workspace.textDocuments.filter((d) => !d.isUntitled && d.uri.scheme === "file").map((d) => path13.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/")).filter((p) => !p.startsWith("..")).slice(0, 20);
  const allDiagnostics = vscode10.languages.getDiagnostics();
  let errorCount = 0;
  let warnCount = 0;
  const topErrors = [];
  for (const [uri, diags] of allDiagnostics) {
    const relPath = path13.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    for (const d of diags) {
      if (d.severity === vscode10.DiagnosticSeverity.Error) {
        errorCount++;
        if (topErrors.length < 8) {
          topErrors.push(`${relPath}:${d.range.start.line + 1} \u2014 ${d.message}`);
        }
      } else if (d.severity === vscode10.DiagnosticSeverity.Warning) {
        warnCount++;
      }
    }
  }
  const diagnosticSummary = errorCount + warnCount > 0 ? `${errorCount} error(s), ${warnCount} warning(s) in workspace` : "No diagnostics";
  const diagnosticDetails = topErrors.join("\n");
  let gitStatusSummary = "";
  try {
    const resp = await runtime.handleMessage({ type: "workspace.git", payload: { op: "status" } });
    const data = resp.result;
    if (data?.ok && data.data) {
      const s = data.data;
      gitStatusSummary = `Branch: ${s.branch ?? "?"} | Staged: ${s.staged?.length ?? 0} | Unstaged: ${s.unstaged?.length ?? 0} | Untracked: ${s.untracked?.length ?? 0}`;
    } else if (data && data.ok === false && /not a git repository/i.test(data.message ?? "")) {
      gitStatusSummary = "Not a git repository (git tools will fail here unless you init one).";
    }
  } catch {
  }
  let baseContext = "";
  try {
    const contextPath = path13.join(workspaceRoot, CONTEXT_FILE);
    if (fs8.existsSync(contextPath)) {
      baseContext = fs8.readFileSync(contextPath, "utf8").slice(0, 4e3);
    }
  } catch {
  }
  const structuredBaseContext = summarizeBaseContextForPrompt(workspaceRoot);
  let projectMemory = "";
  try {
    const memoryPath = path13.join(workspaceRoot, MEMORY_FILE);
    if (fs8.existsSync(memoryPath)) {
      projectMemory = fs8.readFileSync(memoryPath, "utf8").slice(-4e3);
    }
  } catch {
  }
  const uiPreferenceSummary = readUiPreferenceSummary(workspaceRoot);
  const planningSummary = summarizePlanningStateForPrompt(workspaceRoot);
  return {
    workspaceRoot,
    allRoots,
    openFiles,
    activeFile: activeFile && !activeFile.startsWith("..") ? activeFile : void 0,
    activeLine,
    diagnosticSummary,
    diagnosticDetails,
    gitStatusSummary,
    baseContext,
    structuredBaseContext,
    projectMemory,
    uiPreferenceSummary,
    planningSummary
  };
}
function buildSystemPrompt(snapshot) {
  const parts = [
    "You are Blacksite, an AI coding assistant integrated into VS Code.",
    "You operate as one system with this harness: reach for its purpose-built tools before generic shell work, keep its plans and memory current, and let its context, approval, and diagnostics machinery do its job rather than working around it.",
    ""
  ];
  if (snapshot.allRoots.length > 1) {
    parts.push("Workspace roots:");
    for (const r of snapshot.allRoots) parts.push(`  ${r}`);
  } else {
    parts.push(`Workspace root: ${snapshot.workspaceRoot}`);
  }
  if (snapshot.activeFile) {
    const activeLabel = snapshot.activeLine ? `${snapshot.activeFile}:${snapshot.activeLine}` : snapshot.activeFile;
    parts.push(`Active file: ${activeLabel}`);
  }
  if (snapshot.openFiles.length > 0) {
    parts.push("", "Open editors:", ...snapshot.openFiles.map((f) => `  ${f}`));
  }
  if (snapshot.diagnosticSummary && snapshot.diagnosticSummary !== "No diagnostics") {
    parts.push("", `Diagnostics: ${snapshot.diagnosticSummary}`);
    if (snapshot.diagnosticDetails) {
      parts.push("Top errors:");
      for (const line of snapshot.diagnosticDetails.split("\n")) {
        parts.push(`  ${line}`);
      }
    }
  }
  if (snapshot.gitStatusSummary) {
    parts.push("", `Git: ${snapshot.gitStatusSummary}`);
  }
  if (snapshot.baseContext) {
    parts.push("", "Project context (.blacksite/context.md):", snapshot.baseContext);
  }
  if (snapshot.structuredBaseContext) {
    parts.push("", "Base Context (.blacksite/base-context.json \u2014 static cross-conversation topics and file anchors):", snapshot.structuredBaseContext);
  }
  if (snapshot.projectMemory && snapshot.projectMemory.replace(/#.*Memory/i, "").trim()) {
    parts.push("", "Project memory (.blacksite/memory.md \u2014 notes you saved in prior sessions):", snapshot.projectMemory.trim());
  }
  if (snapshot.uiPreferenceSummary) {
    parts.push("", "UI preference memory (.blacksite/ui-preferences.json):", snapshot.uiPreferenceSummary);
  }
  if (snapshot.planningSummary) {
    parts.push("", "Existing plans and task items (.blacksite/planning.json):", snapshot.planningSummary);
  }
  if (snapshot.mcpServers && snapshot.mcpServers.length > 0) {
    parts.push(
      "",
      "Configured MCP servers (use mcp_list_tools with the target below to discover tools, then mcp_call_tool):",
      ...snapshot.mcpServers.map((s) => `  ${s.name} [${s.transport}] \u2192 ${s.target}`)
    );
  }
  parts.push(
    "",
    "## Output Formatting",
    "",
    "You are running inside a VS Code extension with a rich webview that renders Markdown fully.",
    "Use formatting deliberately to make your output clear and scannable.",
    "",
    "**Rich content you can produce:**",
    "- **Inline images**: `![description](https://url)` \u2014 embeds the image directly in the conversation. Use for diagrams, charts, architecture visuals, or any relevant online resource.",
    "- **File/line links**: `[filename.ts:42](path/to/file.ts#L42)` \u2014 clicking these opens the file in the editor at that line. Paths are relative to the workspace root. Always prefer these over plain filename mentions.",
    "  - Line numbers: append `#L<n>` to the path (e.g. `src/agent-session.ts#L294`).",
    "  - Example: `[See AgentSession.send](src/agent-session.ts#L743)`",
    "- **Tables**: Use standard Markdown pipe tables for comparisons, parameter lists, or structured data.",
    "- **Code blocks**: Always specify the language tag for syntax context (e.g. ` ```typescript `, ` ```python `).",
    "- **Document cards**: Open a ` ```doc ` block to render a styled analysis report, architecture summary, or reference card inline in the conversation. The contents are full Markdown.",
    "- **Headings**: Use `##` / `###` to organize responses with multiple sections.",
    "",
    "**When to use rich formatting:**",
    "- Reference a specific file/line \u2192 always use a file link.",
    "- Comparing multiple options or parameters \u2192 use a table.",
    "- Response has 3+ distinct sections \u2192 add headings.",
    "- Producing a comprehensive analysis or report \u2192 wrap in a ` ```doc ` block.",
    "- Mentioning a public diagram or visual \u2192 embed it with `![\u2026](url)`.",
    "- Short conversational answers \u2192 plain prose is fine, no need to over-structure.",
    "",
    "**Narration during execution:**",
    "When you write explanatory text between tool calls (status updates, reasoning, plans), separate distinct thoughts with a blank line. This keeps narration readable \u2014 each paragraph renders with visible breathing room in the UI."
  );
  parts.push(
    "",
    "## Guidelines",
    "",
    "- Stay on the task until it is complete, blocked by a concrete external issue, or waiting on explicit user input/approval.",
    "- Read files before editing them. Verify changes after writing.",
    "- Prefer code intelligence over text search: code_symbols to map a file, code_navigate to jump to definitions/implementations or find references, and code_hover to inspect a type or signature. Fall back to file_search only when those don't apply.",
    "- Make changes with file_edit (surgical, shows the user a diff) rather than rewriting whole files; use file_write for new files.",
    "- Use file_edit_batch for coordinated exact-string replacements across multiple files, and code_insert when you need to add code relative to a symbol or line without brittle whole-file matching.",
    "- After editing, call code_diagnostics to catch errors the language servers report, then fix them before finishing.",
    "- After each tool result, decide the next step immediately. If more work is needed and no input is required, keep going instead of yielding an empty handoff.",
    `- On a longer sequence of tool calls, narrate briefly between steps (one short sentence on what you found or what you're doing next) rather than going silent. The user sees each tool call as it happens; several in a row with no accompanying text reads as stuck even though you're actively working. This matters most for slow steps (installs, test runs, broad searches) \u2014 a one-line "why" before or after keeps the run legible in real time.`,
    "- For shell commands, confirm the cwd and command before running.",
    "- Operations marked write/network/destructive will prompt the user for approval \u2014 as will any command whose binary isn't on the recognized/allowed list, regardless of its tier. Don't retry an unrecognized-command prompt with a different phrasing; wait for the user's decision.",
    "- When writing code, prefer small focused changes. Run tests or lint after editing.",
    "- Use git_op status before commits. Use git_op diff to review changes.",
    "- To persist durable notes for future sessions, use memory_append (project memory) \u2014 it is read back into context on the next conversation.",
    "- Use Base Context for static, reusable project context that should stay available across conversations.",
    "- Before starting multi-phase work, use plan_list to check for an existing plan; continue it with plan_update rather than creating a duplicate. Give phases clear objectives and steps concrete detail so the plan is actionable the moment the user approves it.",
    "- When a plan has more than 2-3 phases, prefer creating it with just the first phase or two via plan_create, then extend it with plan_update's addPhases once you've made real progress \u2014 rather than authoring every phase up front in one call. Early phases are usually wrong before you've seen the codebase; batching commits you to guesses before you have the evidence to make them well, and a phaseNote or stepNote explaining what changed your mind is what makes the incremental approach worth it.",
    "- Keep the active plan in mind and current: as each step or phase finishes, call plan_update to set its status; add, remove, reorder, or move steps/phases with plan_update (addPhases / addSteps / removeStepId / removePhaseId / reorderPhaseIds / reorderStepIds / moveStepId+moveStepToPhaseId / insertPhaseBeforeId) when the work changes shape instead of recreating the plan. Status fields accept natural wording ('done', 'in progress', 'paused').",
    "- Never advance, modify, or act on a plan whose status is on_hold or cancelled unless the user explicitly resumes it.",
    "- For concrete 3+ step execution, use todo_list before todo_create, then keep todo_update current while the work is actually happening."
  );
  parts.push(
    "",
    "## Environment & tooling",
    "",
    "You run inside VS Code on the user's machine. Understand the tools you have before reaching for them \u2014 adapt to a constraint instead of retrying against it.",
    "",
    "- **Running commands:** shell_run executes a one-shot command and returns when it exits \u2014 use it for builds, tests, lint, installs, and scripts. process_start launches a long-running process (dev server, watcher, REPL) and returns a handleId you poll with process_read_output and stop with process_stop. Anything that does not exit on its own must go through process_start, not shell_run.",
    "- **Command restrictions:** inline-eval flags are blocked for security \u2014 `node -e`/`--eval`/`-r`, `python -c`, `ruby -e`, `php -r`, and the like. To run a snippet, write it to a file and execute the file (e.g. write `serve.cjs`, then run `node serve.cjs`). Only allowlisted binaries run at all. If a command is rejected, change approach \u2014 do not reissue the same call.",
    "- **Dev tooling** (npm, npx, vite, tsc, eslint, pytest, \u2026) runs through shell_run / process_start on every platform, Windows shims included. Invoke them by name.",
    "- **Browser tools** (browser_navigate and friends) only exist when the browser runtime is installed. If a browser call reports it is unavailable, stop trying it \u2014 start a local server with process_start and give the user the URL instead.",
    "- **Searching is directory-scoped:** file_search and file_glob take a directory plus a pattern, never a single file path. To inspect one file, read it. Prefer code intelligence (code_symbols, code_navigate, code_hover) over text search wherever it applies.",
    "",
    "## Your toolset",
    "",
    "Your available tools are your source of truth \u2014 the sections below map what each family is for. Some families appear only when configured (a connected database, a browser runtime, integration credentials, an enabled memory index); if a tool is not in your list, that capability is not available this session.",
    "",
    "- **Code intelligence** (prefer over text search and hand edits \u2014 it understands the language): code_symbols maps a file's structure; code_navigate jumps to definitions, implementations, and references; code_hover shows a symbol's type/signature; code_rename renames a symbol safely across the project; code_actions applies language-server quick-fixes and refactors; code_format formats; code_insert adds code relative to a symbol or line without brittle whole-file matching.",
    "- **Diagnostics & tests:** after edits, code_diagnostics reports language-server errors for the files you touched \u2014 fix them before finishing. report_problems surfaces issues in the Problems panel for the user. test_detect finds the project's test setup and test_run executes it; use them instead of guessing a test command.",
    "- **Delegation:** subagent_spawn runs an independent lane in an isolated context and returns only a concise synthesis. Delegate self-contained investigation, verification, or broad file triage early (complexity standard | complex | deep) so your own context stays focused on orchestration and the final answer. The lane cannot see this conversation \u2014 put everything it needs in the task. Do not delegate trivial or tightly-coupled work; the coordination cost outweighs it.",
    "- **Planning & memory:** plan_* and todo_* persist phased plans and live task items across conversations (see the planning guidance above). memory_append saves durable project notes and memory_read reads them back; when memory_search is present, use it to recall relevant past actions and decisions semantically before re-deriving context.",
    "- **Data workbench** (present only when a database is connected): db_list_objects / db_describe_object / db_preview_rows to explore schema and rows; db_run_read_query for read-only SQL; db_preview_write_query to classify \u2014 never execute \u2014 a write; db_vector_search for semantic lookup over indexed collections. Writes are never run silently: surface the SQL and let the user decide.",
    "- **Integrations:** when github_* / gitlab_* / jira_* / confluence_* / salesforce_* tools are present, their credentials are configured \u2014 use them for issues, PRs/MRs, tickets, and docs rather than scraping or guessing. Configured MCP servers (listed above) extend the toolset: call mcp_list_tools for a target, then mcp_call_tool.",
    "- **Version control:** git_op runs status/diff/add/commit/branch and related git operations; worktree_op manages git worktrees for isolated parallel work. Use git_op status before committing and git_op diff to review.",
    "- **Large tool outputs:** any tool result is capped per call; when one is truncated, the notice gives you the exact toolCallId, a line count, and any error/warning keyword hits in the hidden remainder \u2014 use those to decide what to do next. Copy the toolCallId verbatim. Prefer tool_output_search when you know roughly what you're looking for (it jumps straight to matching lines with context), tool_output_page when you need to read forward from a specific offset, and narrowing the original call over either when that gets you the answer faster.",
    "",
    "## Editing discipline",
    "",
    "- Make surgical changes with file_edit / file_edit_batch / code_insert. Reserve file_write for new files or genuinely small ones.",
    "- Never rewrite a large existing file in a single file_write: one response has an output-token budget, and a long write truncates mid-file and fails the call. Edit only the regions that change, or assemble a large new file across successive writes.",
    "- Before an edit, confirm oldString and newString actually differ \u2014 an identical-string edit is a wasted turn.",
    "- When any tool call fails, read the error and change the call. Repeating an identical failing call wastes the turn and the context budget."
  );
  return parts.join("\n");
}
function registerFileWatcher(workspaceRoot, onContextChange) {
  const watcher = vscode10.workspace.createFileSystemWatcher(
    new vscode10.RelativePattern(workspaceRoot, "**/*.{ts,tsx,js,jsx,py,go,rs,json,md,yaml,yml,toml,sh,css,html,scss,less}"),
    false,
    false,
    false
  );
  let timer;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onContextChange, 2e3);
  };
  watcher.onDidCreate(debounced);
  watcher.onDidChange(debounced);
  watcher.onDidDelete(debounced);
  return { dispose: () => {
    watcher.dispose();
    if (timer) clearTimeout(timer);
  } };
}
function getSelectionContext() {
  const editor = vscode10.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const sel = editor.selection;
  const text = editor.document.getText(sel);
  if (!text.trim()) return null;
  const file = path13.basename(editor.document.fileName);
  const start = sel.start.line + 1;
  const end = sel.end.line + 1;
  const label = start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
  return { text, label };
}
function getFileContext(uri) {
  try {
    const raw = fs8.readFileSync(uri.fsPath, "utf8").slice(0, 2e4);
    const label = path13.basename(uri.fsPath);
    const ext = path13.extname(uri.fsPath).slice(1) || "text";
    return { text: `\`\`\`${ext}
${raw}
\`\`\``, label };
  } catch {
    return null;
  }
}
function getDiagnosticContext(uri, diagnostic) {
  const file = path13.basename(uri.fsPath);
  const line = diagnostic.range.start.line + 1;
  const severity = vscode10.DiagnosticSeverity[diagnostic.severity];
  const label = `${file}:${line} (${severity})`;
  const text = `${severity} at ${file}:${line} \u2014 ${diagnostic.message}`;
  return { text, label };
}

// src/mcp-panel.ts
var vscode11 = __toESM(require("vscode"));
var STATE_KEY = "blacksite.mcpServers";
function getMcpServers(context) {
  const fromState = context.workspaceState.get(STATE_KEY, []);
  const fromConfig = vscode11.workspace.getConfiguration("blacksite").get("mcpServers", []);
  const byId = /* @__PURE__ */ new Map();
  for (const s of [...fromConfig, ...fromState]) {
    if (s && typeof s.id === "string") byId.set(s.id, s);
  }
  return [...byId.values()];
}
var McpPanel = class _McpPanel {
  constructor(_ctx) {
    this._ctx = _ctx;
    this._panel = vscode11.window.createWebviewPanel(
      "blacksite.mcp",
      "Blacksite \u2014 MCP Servers",
      vscode11.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this._panel.webview.html = this._buildHtml();
    this._panel.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._ctx.subscriptions
    );
    this._panel.onDidDispose(() => {
      _McpPanel._instance = void 0;
    });
    setTimeout(() => this._syncServers(), 80);
  }
  static _instance;
  _panel;
  static show(context) {
    if (_McpPanel._instance) {
      _McpPanel._instance._panel.reveal(vscode11.ViewColumn.One);
      return _McpPanel._instance;
    }
    const p = new _McpPanel(context);
    _McpPanel._instance = p;
    return p;
  }
  getServers() {
    return this._ctx.workspaceState.get(STATE_KEY, []);
  }
  _saveServers(servers) {
    return this._ctx.workspaceState.update(STATE_KEY, servers);
  }
  _syncServers() {
    void this._panel.webview.postMessage({ type: "servers", servers: this.getServers() });
  }
  async _onMessage(msg) {
    const p = msg.payload;
    switch (msg.type) {
      case "ready":
        this._syncServers();
        break;
      case "add_server": {
        const servers = this.getServers();
        servers.push({
          id: `mcp_${Date.now()}`,
          name: String(p?.name ?? "New Server"),
          transport: p?.transport ?? "http",
          command: p?.command ? String(p.command) : void 0,
          url: p?.url ? String(p.url) : void 0,
          enabled: true
        });
        await this._saveServers(servers);
        this._syncServers();
        break;
      }
      case "remove_server": {
        const id = String(p?.id ?? "");
        await this._saveServers(this.getServers().filter((s) => s.id !== id));
        this._syncServers();
        break;
      }
      case "toggle_server": {
        const id = String(p?.id ?? "");
        await this._saveServers(this.getServers().map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s));
        this._syncServers();
        break;
      }
    }
  }
  _buildHtml() {
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
<link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>MCP Servers</title>
<style>
:root {
  --bg:      var(--vscode-editor-background, #09090b);
  --fg:      var(--vscode-foreground, #f4f4f5);
  --muted:   var(--vscode-descriptionForeground, #71717a);
  --border:  rgba(255,255,255,0.08);
  --input-bg: rgba(255,255,255,0.06);
  --input-bd: rgba(255,255,255,0.12);
  --accent:       #8b5cf6;
  --accent-hover: #7c3aed;
  --accent-dim:   rgba(139,92,246,0.10);
  --accent-glow:  rgba(139,92,246,0.22);
  --accent-bd:    rgba(139,92,246,0.32);
  --ok-bg:   rgba(141,180,168,0.12); --ok:   #8db4a8; --ok-bd:   rgba(141,180,168,0.25);
  --grad: linear-gradient(135deg,#c08de0 0%,#8b5cf6 50%,#60a5fa 100%);
  --r: 12px; --r-sm: 6px; --r-pill: 999px;
  --ease: cubic-bezier(0.4,0,0.2,1); --t: 0.18s var(--ease);
  --font: 'Lexend','Inter',var(--vscode-font-family,system-ui),sans-serif;
  --mono: 'SF Mono','Fira Code','Cascadia Code',var(--vscode-editor-font-family,monospace);
  --fs: var(--vscode-font-size,13px);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:var(--font);font-size:var(--fs);color:var(--fg);background:var(--bg);padding:28px 24px;max-width:640px;-webkit-font-smoothing:antialiased;}
::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:transparent;} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.10);border-radius:2px;}

.page-header { margin-bottom: 24px; }
.page-title {
  font-size: 1.2em; font-weight: 700; letter-spacing: -0.02em;
  background: var(--grad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  display: inline-block; margin-bottom: 4px;
}
.page-sub { color: var(--muted); font-size: 12px; line-height: 1.6; }

.list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 28px; }

.card {
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: rgba(255,255,255,0.03);
  transition: border-color var(--t), background var(--t);
}
.card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12); }
.card.off { opacity: 0.45; }
.card-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; box-shadow: 0 0 6px rgba(141,180,168,0.5); }
.card.off .card-dot { background: var(--muted); box-shadow: none; }
.card-info { flex: 1; }
.card-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.card-meta { font-size: 11px; color: var(--muted); font-family: var(--mono); }
.card-actions { display: flex; gap: 6px; flex-shrink: 0; }

.empty {
  color: var(--muted); font-size: 12px; text-align: center; padding: 24px;
  border: 1px dashed rgba(255,255,255,0.10); border-radius: var(--r);
  line-height: 1.6;
}

.section {
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 20px;
  background: rgba(255,255,255,0.02);
}
.section-title { font-size: 13px; font-weight: 600; margin-bottom: 16px; color: var(--fg); }

.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.field label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
.field input, .field select {
  background: var(--input-bg); color: var(--fg);
  border: 1px solid var(--input-bd); border-radius: var(--r-sm);
  padding: 8px 10px; font-size: 13px; font-family: var(--font); outline: none;
  transition: border-color var(--t), box-shadow var(--t);
}
.field input:focus, .field select:focus {
  border-color: var(--accent-bd);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.field input::placeholder { color: var(--muted); }

.btn {
  display: inline-flex; align-items: center; gap: 5px;
  border: none; padding: 8px 16px; border-radius: var(--r-sm);
  cursor: pointer; font-family: var(--font); font-size: 12px; font-weight: 600;
  letter-spacing: 0.01em; transition: background var(--t), transform var(--t), box-shadow var(--t);
}
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(139,92,246,0.4); }
.btn.primary:active { transform: scale(0.97); box-shadow: none; }
.btn.ghost { background: rgba(255,255,255,0.06); color: var(--muted); border: 1px solid rgba(255,255,255,0.09); padding: 4px 10px; font-size: 11px; border-radius: var(--r-sm); }
.btn.ghost:hover { background: rgba(255,255,255,0.10); color: var(--fg); }

.tf { display: none; }
.tf.on { display: block; }
</style>
</head>
<body>
<div class="page-header">
  <div class="page-title">MCP Servers</div>
  <div class="page-sub">Connect Model Context Protocol servers for extended tooling.</div>
</div>
<div class="list" id="list"></div>
<div class="section">
  <div class="section-title">Add Server</div>
  <div class="field"><label>Name</label><input id="f-name" placeholder="My MCP Server"></div>
  <div class="field"><label>Transport</label>
    <select id="f-transport" onchange="onT()">
      <option value="http">HTTP / SSE</option>
      <option value="stdio">stdio</option>
    </select>
  </div>
  <div class="tf on" id="tf-http">
    <div class="field"><label>URL</label><input id="f-url" placeholder="http://localhost:3000/sse"></div>
  </div>
  <div class="tf" id="tf-stdio">
    <div class="field"><label>Command</label><input id="f-cmd" placeholder="npx @my/mcp-server"></div>
  </div>
  <button class="btn primary" onclick="add()">Add Server</button>
</div>
<script>
const vscode = acquireVsCodeApi();
let servers = [];
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function onT(){const t=document.getElementById('f-transport').value;document.getElementById('tf-http').classList.toggle('on',t==='http');document.getElementById('tf-stdio').classList.toggle('on',t==='stdio');}
function render(){
  const el=document.getElementById('list');
  if(!servers.length){el.innerHTML='<div class="empty">No MCP servers configured yet.<br>Add one below to get started.</div>';return;}
  el.innerHTML=servers.map(s=>{
    const meta=s.transport==='http'?s.url:s.command;
    return \`<div class="card\${s.enabled?'':' off'}">
      <div class="card-dot"></div>
      <div class="card-info">
        <div class="card-name">\${esc(s.name)}</div>
        <div class="card-meta">\${esc(s.transport)} \xB7 \${esc(meta||'')}</div>
      </div>
      <div class="card-actions">
        <button class="btn ghost" onclick="toggle('\${esc(s.id)}')">\${s.enabled?'Disable':'Enable'}</button>
        <button class="btn ghost" onclick="del('\${esc(s.id)}')">Remove</button>
      </div>
    </div>\`;
  }).join('');
}
function add(){
  const name=document.getElementById('f-name').value.trim();
  const transport=document.getElementById('f-transport').value;
  const url=document.getElementById('f-url').value.trim();
  const cmd=document.getElementById('f-cmd').value.trim();
  if(!name)return alert('Name is required');
  if(transport==='http'&&!url)return alert('URL is required');
  if(transport==='stdio'&&!cmd)return alert('Command is required');
  vscode.postMessage({type:'add_server',payload:{name,transport,url:url||undefined,command:cmd||undefined}});
  document.getElementById('f-name').value='';
  document.getElementById('f-url').value='';
  document.getElementById('f-cmd').value='';
}
function toggle(id){vscode.postMessage({type:'toggle_server',payload:{id}});}
function del(id){if(confirm('Remove this server?'))vscode.postMessage({type:'remove_server',payload:{id}});}
window.addEventListener('message',e=>{if(e.data.type==='servers'){servers=e.data.servers||[];render();}});
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`
    );
  }
};

// src/model-fetcher.ts
var import_https2 = __toESM(require("https"));
var import_http2 = __toESM(require("http"));

// src/bedrock-config.ts
var BEDROCK_CONVERSE_DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-20250514-v1:0";
var BEDROCK_MANTLE_DEFAULT_MODEL = "anthropic.claude-opus-4-8";
function normalizeBedrockApi(api) {
  return api === "mantle" ? "mantle" : "converse";
}
function defaultBedrockModel(api) {
  return normalizeBedrockApi(api) === "mantle" ? BEDROCK_MANTLE_DEFAULT_MODEL : BEDROCK_CONVERSE_DEFAULT_MODEL;
}

// src/model-fetcher.ts
var BEDROCK_MANTLE_MODELS = [
  { id: "anthropic.claude-fable-5", name: "Claude Fable 5 (Mantle)", contextLength: 1e6, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-8", name: "Claude Opus 4.8 (Mantle)", contextLength: 1e6, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-7", name: "Claude Opus 4.7 (Mantle)", contextLength: 1e6, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5 (Mantle)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" }
];
var FALLBACK_MODELS = {
  anthropic: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextLength: 2e5, inputPricePerM: 15, outputPricePerM: 75, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextLength: 2e5, inputPricePerM: 3, outputPricePerM: 15, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextLength: 2e5, inputPricePerM: 0.8, outputPricePerM: 4, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", contextLength: 2e5, inputPricePerM: 3, outputPricePerM: 15, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextLength: 2e5, inputPricePerM: 3, outputPricePerM: 15, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" }
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8 (OR)", contextLength: 2e5, inputPricePerM: 15, outputPricePerM: 75, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (OR)", contextLength: 2e5, inputPricePerM: 3, outputPricePerM: 15, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-4o", name: "GPT-4o (OR)", contextLength: 128e3, inputPricePerM: 2.5, outputPricePerM: 10, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro (OR)", contextLength: 1048576, inputPricePerM: 1.25, outputPricePerM: 10, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/o3-mini", name: "o3-mini (OR)", contextLength: 2e5, inputPricePerM: 1.1, outputPricePerM: 4.4, supportsThinking: true, supportsVision: false, supportsTools: true, source: "fallback" }
  ],
  openai: [
    { id: "gpt-4o", name: "GPT-4o", contextLength: 128e3, inputPricePerM: 2.5, outputPricePerM: 10, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "gpt-4o-mini", name: "GPT-4o mini", contextLength: 128e3, inputPricePerM: 0.15, outputPricePerM: 0.6, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "o3", name: "o3", contextLength: 2e5, inputPricePerM: 10, outputPricePerM: 40, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "o3-mini", name: "o3-mini", contextLength: 2e5, inputPricePerM: 1.1, outputPricePerM: 4.4, supportsThinking: true, supportsVision: false, supportsTools: true, source: "fallback" },
    { id: "o1", name: "o1", contextLength: 2e5, inputPricePerM: 15, outputPricePerM: 60, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "o1-mini", name: "o1-mini", contextLength: 128e3, inputPricePerM: 1.1, outputPricePerM: 4.4, supportsThinking: true, supportsVision: false, supportsTools: true, source: "fallback" }
  ],
  // Best-effort offline fallback only — the live ListFoundationModels +
  // ListInferenceProfiles call (bedrock-models.ts) is authoritative and returns
  // the exact IDs for the caller's region. These are US cross-region inference
  // profiles in the Converse format (us.anthropic.<dated-snapshot>-vN:0).
  // Opus 4.6 / 4.7 / 4.8 and Sonnet 4.6 are intentionally omitted: their Bedrock
  // inference-profile IDs are not published as static dated snapshots and the
  // version suffix isn't derivable, so they're surfaced via live listing rather
  // than a guessed ID that would 404. Add them here verbatim if you pin specific
  // IDs from the live picker / AWS console.
  bedrock: [
    { id: "us.anthropic.claude-opus-4-5-20251101-v1:0", name: "Claude Opus 4.5 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-1-20250805-v1:0", name: "Claude Opus 4.1 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-20250514-v1:0", name: "Claude Opus 4 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4 (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", name: "Claude 3.7 Sonnet (Bedrock)", contextLength: 2e5, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", name: "Claude 3.5 Sonnet (Bedrock)", contextLength: 2e5, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-haiku-20241022-v1:0", name: "Claude 3.5 Haiku (Bedrock)", contextLength: 2e5, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" }
  ]
};
function get(url, headers) {
  return new Promise((resolve3, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Bad URL: ${url}`));
      return;
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? import_https2.default : import_http2.default;
    const req = mod.request({ hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c.toString();
      });
      res.on("end", () => resolve3({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(15e3, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}
function detectsThinking(modelId) {
  const id = modelId.toLowerCase();
  if (id.includes("claude-4") || id.includes("claude-sonnet-4") || id.includes("claude-opus-4") || id.includes("3-7") || id.includes("claude-3-7")) return true;
  if (/^(anthropic\/)?o[13]/.test(id) || id.startsWith("o1") || id.startsWith("o3")) return true;
  if (id.startsWith("gpt-5") || id.startsWith("openai/gpt-5")) return true;
  if (id.startsWith("openai/o")) return true;
  return false;
}
async function fetchAnthropic(apiKey) {
  const { status, body } = await get("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "Blacksite-VSCode/1.0"
  });
  if (status !== 200) throw new Error(`Anthropic /v1/models returned ${status}`);
  const data = JSON.parse(body).data ?? [];
  return data.map((m) => ({
    id: m.id,
    name: m.display_name ?? m.id,
    supportsThinking: detectsThinking(m.id),
    supportsVision: true,
    supportsTools: true,
    source: "api"
  }));
}
async function fetchOpenRouter(apiKey) {
  const { status, body } = await get("https://openrouter.ai/api/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0"
  });
  if (status !== 200) throw new Error(`OpenRouter /api/v1/models returned ${status}`);
  const data = JSON.parse(body).data ?? [];
  return data.filter((m) => Boolean(m.id)).map((m) => {
    const inp = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : void 0;
    const outp = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : void 0;
    return {
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length,
      inputPricePerM: inp ? Math.round(inp * 100) / 100 : void 0,
      outputPricePerM: outp ? Math.round(outp * 100) / 100 : void 0,
      supportsThinking: detectsThinking(m.id),
      supportsVision: true,
      supportsTools: true,
      source: "api"
    };
  });
}
var OPENAI_META = {
  "gpt-4o": { ctx: 128e3, inp: 2.5, out: 10 },
  "gpt-4o-mini": { ctx: 128e3, inp: 0.15, out: 0.6 },
  "gpt-4-turbo": { ctx: 128e3, inp: 10, out: 30 },
  "gpt-4": { ctx: 8192, inp: 30, out: 60 },
  "gpt-3.5-turbo": { ctx: 16385, inp: 0.5, out: 1.5 },
  "o1": { ctx: 2e5, inp: 15, out: 60 },
  "o1-mini": { ctx: 128e3, inp: 1.1, out: 4.4 },
  "o1-preview": { ctx: 128e3, inp: 15, out: 60 },
  "o3": { ctx: 2e5, inp: 10, out: 40 },
  "o3-mini": { ctx: 2e5, inp: 1.1, out: 4.4 },
  "o4-mini": { ctx: 2e5, inp: 1.1, out: 4.4 }
};
var CHAT_MODEL_RE = /^(gpt-[45]|gpt-3\.5-turbo|o[134])/;
async function fetchOpenAI(apiKey) {
  const { status, body } = await get("https://api.openai.com/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0"
  });
  if (status !== 200) throw new Error(`OpenAI /v1/models returned ${status}`);
  const data = JSON.parse(body).data ?? [];
  return data.filter((m) => CHAT_MODEL_RE.test(m.id) && !m.id.includes("instruct") && !m.id.includes("audio")).sort((a, b) => a.id.localeCompare(b.id)).map((m) => {
    const meta = OPENAI_META[m.id];
    return {
      id: m.id,
      name: m.id,
      contextLength: meta?.ctx,
      inputPricePerM: meta?.inp,
      outputPricePerM: meta?.out,
      supportsThinking: detectsThinking(m.id),
      supportsVision: m.id.includes("4o") || m.id.startsWith("o") || m.id.startsWith("gpt-5") || m.id.includes("vision"),
      supportsTools: true,
      source: "api"
    };
  });
}
async function fetchModels(provider, apiKey) {
  switch (provider) {
    case "anthropic":
      return fetchAnthropic(apiKey);
    case "openrouter":
      return fetchOpenRouter(apiKey);
    case "openai":
      return fetchOpenAI(apiKey);
    default:
      return FALLBACK_MODELS[provider] ?? [];
  }
}
function getFallbackModels(provider) {
  return FALLBACK_MODELS[provider] ?? [];
}
function getContextLength(provider, modelId) {
  const fallback = FALLBACK_MODELS[provider]?.find((m) => m.id === modelId);
  if (fallback?.contextLength) return fallback.contextLength;
  if (provider === "openai") {
    const meta = OPENAI_META[modelId];
    if (meta?.ctx) return meta.ctx;
  }
  const mantleModel = BEDROCK_MANTLE_MODELS.find((m) => m.id === modelId);
  if (mantleModel?.contextLength) return mantleModel.contextLength;
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return 2e5;
  if (id.includes("gemini-2.5")) return 1048576;
  if (id.includes("gemini-2.0") || id.includes("gemini-1.5")) return 1e6;
  if (/^(openai\/)?o[134]/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return 2e5;
  if (id.includes("gpt-5")) return 4e5;
  if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) return 128e3;
  if (id.includes("gpt-4")) return 8192;
  if (id.includes("gpt-3.5")) return 16385;
  if (provider === "bedrock") return 2e5;
  return void 0;
}

// src/builtin-subagent-profiles.ts
var BUILTIN_SUBAGENT_PROFILES = [
  {
    id: "frontend_ui",
    name: "Frontend UI",
    description: "UI-facing implementation and browser-surface verification.",
    systemPromptAddition: "Focus on browser-facing behavior, UI state wiring, styling integrity, and user-visible regressions. Prefer concise observations tied to concrete surfaces and verification steps.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z"
  },
  {
    id: "backend_api",
    name: "Backend API",
    description: "Server, runtime, schema, and integration work.",
    systemPromptAddition: "Focus on backend behavior, contracts, process execution, local services, and failure handling. Prefer concrete command paths, data flow checks, and minimal verification sets.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z"
  },
  {
    id: "qa_regression",
    name: "QA Regression",
    description: "Targeted verification and failure reproduction.",
    systemPromptAddition: "Focus on reproducing defects, selecting the smallest credible regression coverage, and surfacing behavior deltas with exact evidence.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z"
  },
  {
    id: "repo_ops",
    name: "Repo Ops",
    description: "Git, local tooling, and operator-focused repo workflows.",
    systemPromptAddition: "Focus on repository operations, local command execution, workspace state, and safe confirmation handling for network or destructive actions.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z"
  }
];
function getBuiltinSubagentProfiles() {
  return BUILTIN_SUBAGENT_PROFILES.map((p) => ({ ...p }));
}
function mergeBuiltinSubagentProfiles(customProfiles) {
  const builtins = getBuiltinSubagentProfiles();
  const custom = (customProfiles ?? []).filter((p) => !p.builtin);
  return [...builtins, ...custom];
}
function findSubagentProfile(customProfiles, profileId) {
  return mergeBuiltinSubagentProfiles(customProfiles).find((p) => p.id === profileId) ?? null;
}

// src/compressor.ts
var SYSTEM_PROMPT = `You are a precision conversation historian. Your job is to compress a conversation transcript into a structured JSON summary that preserves ALL information needed to continue the work without loss.

Analyse every message carefully. The summary MUST be comprehensive enough that an AI resuming the conversation can do so seamlessly, as if it had read the full transcript.

Output ONLY a single valid JSON object \u2014 no markdown fences, no prose outside the JSON. Use this exact structure:

{
  "compressionMeta": {
    "messageCount": <integer \u2014 how many messages were compressed>,
    "version": 1
  },
  "objective": "<The main goal or task the user and AI are working toward>",
  "status": "<one of: planning | in_progress | awaiting_user | blocked | nearly_complete | complete>",
  "workContext": {
    "files": ["<every file path that was read, written, edited, or referenced>"],
    "technologies": ["<languages, frameworks, libraries, tools, APIs mentioned>"],
    "keySymbols": ["<important variable names, function names, class names, types that were discussed or changed>"],
    "environment": "<OS, runtime, version constraints, or other environment details mentioned>"
  },
  "decisions": [
    {
      "what": "<decision that was made>",
      "why": "<reason or constraint behind it>",
      "impact": "<how this affects future work>"
    }
  ],
  "codeChanges": [
    {
      "file": "<path>",
      "description": "<what was changed and why>",
      "status": "<applied | pending | reverted | discussed-only>"
    }
  ],
  "discoveries": [
    "<important finding, bug, constraint, or architectural insight>"
  ],
  "userRequirements": [
    "<explicit requirement, preference, or constraint the user stated>"
  ],
  "errors": [
    "<errors, failures, or problems that occurred and their resolution status>"
  ],
  "pendingTasks": [
    {
      "task": "<clear description of what needs to be done>",
      "priority": "<high | medium | low>",
      "status": "<pending | in_progress | blocked | done>",
      "blockedBy": "<optional \u2014 what is blocking this task>"
    }
  ],
  "conversationNarrative": "<3\u20136 sentence prose summary of the conversation arc: what was attempted, what worked, what failed, and where things stand now>",
  "criticalContext": "<any other context that MUST be preserved for the conversation to continue correctly \u2014 e.g. specific values, agreed-upon constraints, partial work in progress>"
}

Rules:
- Be exhaustive. Omitting a decision, file, or requirement causes information loss.
- Use exact file paths, function names, and error messages from the transcript \u2014 do not paraphrase identifiers.
- If a field has no relevant content, use an empty array [] or empty string "".
- Do NOT truncate long strings \u2014 use the full content for identifiers and key facts.`;
function messagesToText(messages) {
  return messages.map((m, i) => {
    const role = m.role.toUpperCase();
    let text;
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.filter((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_result" || b.type === "tool_use").map((b) => {
        if (b.type === "thinking") return `[thinking] ${b.thinking ?? ""}`;
        if (b.type === "tool_result") {
          const body = typeof b.content === "string" ? b.content.slice(0, 800) : "";
          return `[tool_result] ${body}`;
        }
        if (b.type === "tool_use") {
          const args = b.input ? JSON.stringify(b.input).slice(0, 400) : "{}";
          return `[tool_call:${b.name ?? "unknown"}] ${args}`;
        }
        return b.text ?? "";
      }).join("\n");
    } else {
      text = "";
    }
    return `[${i}] ${role}: ${text.trim()}`;
  }).join("\n\n");
}
var COMPRESSION_TIMEOUT_MS = 6e4;
async function callAnthropic(opts, transcript) {
  const url = opts.baseUrl ?? "https://api.anthropic.com/v1/messages";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": opts.apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Compress the following conversation transcript:

${transcript}` }]
    }),
    signal: AbortSignal.timeout(COMPRESSION_TIMEOUT_MS)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Compression API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}
async function callOpenAI(opts, transcript) {
  const pd = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions"
  };
  const url = opts.baseUrl ?? pd[opts.provider] ?? pd["openai"] ?? "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...opts.provider === "openrouter" ? { "HTTP-Referer": "https://blacksite.dev", "X-Title": "Blacksite" } : {}
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 8192,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Compress the following conversation transcript:

${transcript}` }
      ]
    }),
    signal: AbortSignal.timeout(COMPRESSION_TIMEOUT_MS)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Compression API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}
async function callBedrock(opts, transcript) {
  if (!opts.bedrock) throw new Error("Bedrock compression requires AWS credentials.");
  if (opts.bedrockApi === "mantle") {
    const response2 = await mantleMessage({
      credentials: opts.bedrock,
      model: opts.model,
      system: SYSTEM_PROMPT,
      maxTokens: 8192,
      messages: [{ role: "user", content: `Compress the following conversation transcript:

${transcript}` }]
    }, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS));
    return response2.content.find((b) => b.type === "text")?.text ?? "";
  }
  const response = await converseBedrock({
    credentials: opts.bedrock,
    modelId: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 8192,
    messages: [{ role: "user", content: [{ text: `Compress the following conversation transcript:

${transcript}` }] }]
  }, AbortSignal.timeout(COMPRESSION_TIMEOUT_MS));
  return response.output.message.content.filter((block) => "text" in block).map((block) => block.text).join("\n\n");
}
async function compressHistory(opts, messages) {
  const transcript = messagesToText(messages);
  const raw = opts.provider === "anthropic" ? await callAnthropic(opts, transcript) : opts.provider === "bedrock" ? await callBedrock(opts, transcript) : await callOpenAI(opts, transcript);
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) return trimmed;
  const jsonStr = trimmed.slice(start, end + 1);
  try {
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    return trimmed;
  }
}

// src/bedrock-models.ts
var BEDROCK_CONTROL_TIMEOUT_MS = 3e4;
var INFERENCE_PROFILE_PAGE_SIZE = 1e3;
var MAX_INFERENCE_PROFILE_PAGES = 10;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
function stringArrayValue(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}
function booleanValue(value) {
  return typeof value === "boolean" ? value : void 0;
}
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
function titleCaseProvider(value) {
  if (!value) return "Unknown";
  const normalized = value.replace(/[-_]+/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}
function inferProviderName(modelId) {
  const provider = modelId.includes(".") ? modelId.split(".")[0] ?? "" : "";
  if (!provider) return "Unknown";
  return titleCaseProvider(provider);
}
function extractFoundationModelIdFromArn(arn) {
  const marker = ":foundation-model/";
  const markerIndex = arn.indexOf(marker);
  if (markerIndex >= 0) return arn.slice(markerIndex + marker.length);
  const slashIndex = arn.lastIndexOf("/");
  return slashIndex >= 0 ? arn.slice(slashIndex + 1) : arn;
}
function shortModelLabel(modelId) {
  const parts = modelId.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : modelId;
}
function getStatus(summary) {
  if (!isRecord(summary["modelLifecycle"])) return void 0;
  const status = stringValue(summary["modelLifecycle"]["status"]);
  return status || void 0;
}
function mapFoundationModel(summary) {
  const id = stringValue(summary["modelId"]);
  if (!id) return null;
  const outputModalities = stringArrayValue(summary["outputModalities"]);
  if (outputModalities.length > 0 && !outputModalities.includes("TEXT")) return null;
  const inputModalities = stringArrayValue(summary["inputModalities"]);
  const modalities = Array.from(/* @__PURE__ */ new Set([...inputModalities, ...outputModalities]));
  const providerName = stringValue(summary["providerName"]) || inferProviderName(id);
  const modelName = stringValue(summary["modelName"]) || shortModelLabel(id);
  return {
    id,
    label: `${providerName} ${modelName}`,
    providerName,
    source: "foundation_model",
    modalities,
    inferenceTypes: stringArrayValue(summary["inferenceTypesSupported"]),
    customizationsSupported: stringArrayValue(summary["customizationsSupported"]),
    responseStreamingSupported: booleanValue(summary["responseStreamingSupported"]),
    status: getStatus(summary)
  };
}
function extractProfileFoundationModelId(profile) {
  const firstModel = arrayValue(profile["models"])[0];
  if (!isRecord(firstModel)) return "";
  const modelArn = stringValue(firstModel["modelArn"]);
  return modelArn ? extractFoundationModelIdFromArn(modelArn) : "";
}
function mapInferenceProfile(profile) {
  const id = stringValue(profile["inferenceProfileId"]) || stringValue(profile["inferenceProfileArn"]);
  if (!id) return null;
  const name = stringValue(profile["inferenceProfileName"]) || id;
  const foundationModelId = extractProfileFoundationModelId(profile);
  const providerName = foundationModelId ? inferProviderName(foundationModelId) : inferProviderName(id);
  const modelLabel = foundationModelId ? ` (${shortModelLabel(foundationModelId)})` : "";
  return {
    id,
    label: `${name}${modelLabel}`,
    providerName,
    source: "inference_profile",
    modalities: ["TEXT"],
    inferenceTypes: ["INFERENCE_PROFILE"],
    customizationsSupported: [],
    status: stringValue(profile["status"]) || void 0,
    foundationModelId: foundationModelId || void 0,
    profileType: stringValue(profile["type"]) || void 0,
    description: stringValue(profile["description"]) || void 0
  };
}
function enrichInferenceProfiles(profiles, foundationModels) {
  const foundationById = new Map(foundationModels.map((model) => [model.id, model]));
  return profiles.map((model) => {
    if (model.source !== "inference_profile" || !model.foundationModelId) return model;
    const foundation = foundationById.get(model.foundationModelId);
    if (!foundation) return model;
    return {
      ...model,
      providerName: model.providerName || foundation.providerName,
      responseStreamingSupported: foundation.responseStreamingSupported,
      customizationsSupported: foundation.customizationsSupported
    };
  });
}
async function bedrockGetJson(creds, path27, query) {
  const url = new URL(`https://bedrock.${creds.region}.amazonaws.com${path27}`);
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  const headers = { accept: "application/json", "content-type": "application/json" };
  try {
    const signedHeaders = signBedrockRequest(creds, "GET", url.toString(), headers, "");
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: signedHeaders,
      signal: AbortSignal.timeout(BEDROCK_CONTROL_TIMEOUT_MS)
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      try {
        const parsed = JSON.parse(errorText);
        return { ok: false, error: `Bedrock ${response.status}: ${parsed.message ?? parsed.Message ?? errorText}` };
      } catch {
        return { ok: false, error: `Bedrock ${response.status}: ${errorText}` };
      }
    }
    return { ok: true, data: await response.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function listFoundationModels(creds) {
  const response = await bedrockGetJson(
    creds,
    "/foundation-models",
    { byOutputModality: "TEXT" }
  );
  if (!response.ok) return response;
  const models = arrayValue(response.data.modelSummaries).map((summary) => isRecord(summary) ? mapFoundationModel(summary) : null).filter((model) => model !== null);
  return { ok: true, data: models };
}
async function listInferenceProfiles(creds) {
  const models = [];
  let nextToken = "";
  for (let page = 0; page < MAX_INFERENCE_PROFILE_PAGES; page += 1) {
    const response = await bedrockGetJson(
      creds,
      "/inference-profiles",
      { maxResults: String(INFERENCE_PROFILE_PAGE_SIZE), nextToken }
    );
    if (!response.ok) return response;
    models.push(
      ...arrayValue(response.data.inferenceProfileSummaries).map((profile) => isRecord(profile) ? mapInferenceProfile(profile) : null).filter((model) => model !== null)
    );
    nextToken = stringValue(response.data.nextToken);
    if (!nextToken) break;
  }
  return { ok: true, data: models };
}
function sourceRank(source) {
  return source === "inference_profile" ? 0 : 1;
}
function sortModels(models) {
  return [...models].sort((a, b) => {
    const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    const providerDiff = a.providerName.localeCompare(b.providerName);
    if (providerDiff !== 0) return providerDiff;
    return a.label.localeCompare(b.label);
  });
}
function dedupeModels(models) {
  const byId = /* @__PURE__ */ new Map();
  for (const model of sortModels(models)) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return Array.from(byId.values());
}
async function listAvailableBedrockModels(creds) {
  const [foundationResult, profileResult] = await Promise.all([
    listFoundationModels(creds),
    listInferenceProfiles(creds)
  ]);
  const warnings = [];
  const models = [];
  if (foundationResult.ok) {
    models.push(...foundationResult.data);
  } else {
    warnings.push(`Foundation models unavailable: ${foundationResult.error}`);
  }
  if (profileResult.ok) {
    models.push(...enrichInferenceProfiles(profileResult.data, foundationResult.ok ? foundationResult.data : []));
  } else {
    warnings.push(`Inference profiles unavailable: ${profileResult.error}`);
  }
  if (!foundationResult.ok && !profileResult.ok) {
    return { ok: false, error: warnings.join(" ") };
  }
  return {
    ok: true,
    data: { models: dedupeModels(models), refreshedAt: (/* @__PURE__ */ new Date()).toISOString(), warnings }
  };
}
function detectsThinking2(modelId) {
  const id = modelId.toLowerCase();
  return /claude-(opus|sonnet|haiku)-4/.test(id) || id.includes("claude-3-7") || id.includes("3-7-sonnet");
}
function bedrockModelsToModelInfo(models) {
  return models.map((model) => {
    const contextModelId = model.foundationModelId || model.id;
    return {
      id: model.id,
      name: model.label,
      contextLength: getContextLength("bedrock", contextModelId),
      supportsThinking: detectsThinking2(contextModelId),
      supportsVision: contextModelId.toLowerCase().includes("claude"),
      supportsTools: true,
      source: "api"
    };
  });
}

// src/vector-store.ts
var fs9 = __toESM(require("fs"));
var path14 = __toESM(require("path"));
function l2norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s) || 1;
}
function normalizeVec(v) {
  const n = l2norm(v);
  return v.map((x) => x / n);
}
function dotProduct(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
var VectorStore = class {
  constructor(filePath, maxEntries = 3e4) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
  }
  entries = [];
  dirty = false;
  saveTimer = null;
  load() {
    try {
      const raw = fs9.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      if (data.v === 1 && Array.isArray(data.entries)) {
        this.entries = data.entries;
      }
    } catch {
    }
  }
  save() {
    if (!this.dirty) return;
    try {
      fs9.mkdirSync(path14.dirname(this.filePath), { recursive: true });
      const data = { v: 1, entries: this.entries };
      fs9.writeFileSync(this.filePath, JSON.stringify(data), "utf8");
      this.dirty = false;
    } catch {
    }
  }
  _scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 3e3);
  }
  upsert(id, vector, payload) {
    const vec = normalizeVec(vector);
    const existing = this.entries.findIndex((e) => e.id === id);
    const entry = { id, vec, payload, ts: Date.now() };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
      if (this.entries.length > this.maxEntries) {
        this.entries.sort((a, b) => a.ts - b.ts);
        this.entries = this.entries.slice(this.entries.length - this.maxEntries);
      }
    }
    this.dirty = true;
    this._scheduleSave();
  }
  search(vector, topK, filter) {
    const q = normalizeVec(vector);
    const scored = [];
    for (const entry of this.entries) {
      if (filter && !filter(entry.payload)) continue;
      scored.push({ score: dotProduct(q, entry.vec), entry });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ score, entry }) => ({
      id: entry.id,
      score,
      payload: entry.payload
    }));
  }
  delete(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.dirty = true;
    this._scheduleSave();
    return true;
  }
  collectionSize(col) {
    return this.entries.filter((e) => e.payload["_col"] === col).length;
  }
  /** Drop every stored vector. Used when the embedding model/dimensions change and
      existing vectors are no longer comparable. The index self-heals as new content
      is embedded under the new model. */
  clear() {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.dirty = true;
    this.save();
  }
  get size() {
    return this.entries.length;
  }
  dispose() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }
};

// src/embedding-service.ts
var SPARSE_DIMS = 512;
var CACHE_MAX = 2e3;
var EmbeddingService = class {
  constructor(provider, getKey, baseUrl, spec, getBedrockConfig) {
    this.provider = provider;
    this.getKey = getKey;
    this.baseUrl = baseUrl;
    this.getBedrockConfig = getBedrockConfig;
    const def = defaultEmbeddingForProvider(provider === "anthropic" ? "openai" : provider);
    this.model = spec?.model?.trim() || def.model;
    this.dims = spec?.dims && spec.dims > 0 ? spec.dims : def.dims;
  }
  cache = /* @__PURE__ */ new Map();
  model;
  dims;
  /** The model id this service embeds with. */
  get modelId() {
    return this.model;
  }
  /** The output dimensionality this service produces (API path). */
  get dimensions() {
    return this.dims;
  }
  async embed(text) {
    const key = text.slice(0, 256);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let vec;
    try {
      vec = await this._apiEmbed(text);
    } catch {
      vec = sparseEmbed(text);
    }
    if (this.cache.size >= CACHE_MAX) {
      const first = this.cache.keys().next().value;
      if (first !== void 0) this.cache.delete(first);
    }
    this.cache.set(key, vec);
    return vec;
  }
  async embedBatch(texts) {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  get isApiAvailable() {
    return this.provider !== "anthropic";
  }
  async _apiEmbed(text) {
    if (this.provider === "bedrock") {
      const creds = await this.getBedrockConfig?.();
      if (!creds) throw new Error("no Bedrock credentials available");
      return invokeBedrockEmbedding(creds, this.model, text, this.dims);
    }
    let apiKey;
    let url;
    if (this.provider === "openai") {
      apiKey = await this.getKey("openai");
      url = this.baseUrl ?? "https://api.openai.com/v1/embeddings";
    } else if (this.provider === "openrouter") {
      apiKey = await this.getKey("openrouter");
      url = "https://openrouter.ai/api/v1/embeddings";
    } else {
      const openaiKey = await this.getKey("openai");
      const openrouterKey = await this.getKey("openrouter");
      if (openaiKey) {
        apiKey = openaiKey;
        url = "https://api.openai.com/v1/embeddings";
      } else if (openrouterKey) {
        apiKey = openrouterKey;
        url = "https://openrouter.ai/api/v1/embeddings";
      } else {
        url = "";
      }
    }
    if (!apiKey || !url) throw new Error("no embedding API key available");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8e3), dimensions: this.dims })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) throw new Error("empty embedding response");
    return emb;
  }
};
function sparseEmbed(text) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9_./-]/g, " ").split(/\s+/).filter(Boolean);
  const vec = new Float32Array(SPARSE_DIMS);
  const counts = /* @__PURE__ */ new Map();
  for (const tok of tokens) {
    const dim = fnv32(tok) % SPARSE_DIMS;
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }
  const total = tokens.length || 1;
  for (const [dim, count] of counts) {
    vec[dim] = (1 + Math.log(count)) / Math.sqrt(total);
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map((x) => x / norm);
}
function fnv32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h;
}

// src/agent-memory-index.ts
var COL_TOOL = "tc";
var COL_CHUNK = "ch";
var COL_MEMORY = "mm";
var SIMILARITY_THRESHOLD = 0.7;
var SIMILARITY_TIMEOUT_MS = 1800;
var SIMILARITY_TOOLS = /* @__PURE__ */ new Set([
  "file_edit",
  "file_edit_batch",
  "file_write",
  "file_delete",
  "file_move",
  "shell_run",
  "process_start",
  "git_op",
  "worktree_op",
  "code_rename",
  "code_actions",
  "code_format",
  "plan_create",
  "plan_update",
  "todo_create",
  "todo_update"
]);
var AgentMemoryIndex = class {
  constructor(store, embedding) {
    this.store = store;
    this.embedding = embedding;
  }
  ready = false;
  init() {
    this.store.load();
    this.ready = true;
  }
  // ── Tool call indexing ───────────────────────────────────────────────────────
  /** Index a completed tool call. Fire-and-forget; errors are non-fatal. */
  async indexToolCall(sessionId, toolName, input, result, turnIndex) {
    if (!this.ready || !SIMILARITY_TOOLS.has(toolName)) return;
    const text = `${toolName} ${shortInput(toolName, input)} \u2192 ${shortResult(result)}`;
    try {
      const vec = await this.embedding.embed(text);
      const id = `${COL_TOOL}:${sessionId}:t${turnIndex}`;
      this.store.upsert(id, vec, {
        _col: COL_TOOL,
        sessionId,
        toolName,
        inputSummary: shortInput(toolName, input),
        resultSummary: shortResult(result),
        turnIndex
      });
    } catch {
    }
  }
  /** Query similar past tool calls from OTHER sessions (cross-session memory). */
  async similarToolCalls(toolName, input, currentSessionId, topK = 3) {
    if (!this.ready || !SIMILARITY_TOOLS.has(toolName)) return [];
    const text = `${toolName} ${shortInput(toolName, input)}`;
    try {
      const vec = await withTimeout2(this.embedding.embed(text), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store.search(vec, topK + 2, (p) => p["_col"] === COL_TOOL && p["sessionId"] !== currentSessionId).filter((r) => r.score >= SIMILARITY_THRESHOLD).slice(0, topK).map((r) => ({
        toolName: String(r.payload["toolName"] ?? ""),
        inputSummary: String(r.payload["inputSummary"] ?? ""),
        resultSummary: String(r.payload["resultSummary"] ?? ""),
        sessionId: String(r.payload["sessionId"] ?? ""),
        turnIndex: Number(r.payload["turnIndex"] ?? 0),
        score: r.score
      }));
    } catch {
      return [];
    }
  }
  // ── Transcript chunk indexing ────────────────────────────────────────────────
  /**
   * Index a batch of compressed messages as a searchable transcript chunk.
   * Returns a short ref string the agent can use with memory_search.
   */
  async indexTranscriptChunk(sessionId, messages, chunkIndex, summary) {
    const ref = `${sessionId.slice(-8)}:c${chunkIndex}`;
    if (!this.ready) return ref;
    const searchText = `${summary} ${messagesToText2(messages)}`.slice(0, 4e3);
    try {
      const vec = await withTimeout2(this.embedding.embed(searchText), SIMILARITY_TIMEOUT_MS, null);
      if (vec) {
        this.store.upsert(`${COL_CHUNK}:${ref}`, vec, {
          _col: COL_CHUNK,
          sessionId,
          chunkIndex,
          summary: summary.slice(0, 500),
          ref
        });
      }
    } catch {
    }
    return ref;
  }
  /** Semantic search over compressed transcript chunks. */
  async searchTranscript(query, topK = 5) {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout2(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store.search(vec, topK, (p) => p["_col"] === COL_CHUNK).map((r) => ({
        sessionId: String(r.payload["sessionId"] ?? ""),
        chunkIndex: Number(r.payload["chunkIndex"] ?? 0),
        summary: String(r.payload["summary"] ?? ""),
        ref: String(r.payload["ref"] ?? ""),
        score: r.score
      }));
    } catch {
      return [];
    }
  }
  // ── Memory note indexing ─────────────────────────────────────────────────────
  /** Index an agent-written memory note for semantic retrieval. */
  async indexMemory(note, id) {
    if (!this.ready) return;
    try {
      const vec = await this.embedding.embed(note);
      this.store.upsert(id ?? `${COL_MEMORY}:${Date.now()}`, vec, {
        _col: COL_MEMORY,
        text: note.slice(0, 1e3)
      });
    } catch {
    }
  }
  /** Semantic search over indexed memory notes. */
  async searchMemories(query, topK = 5) {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout2(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      return this.store.search(vec, topK, (p) => p["_col"] === COL_MEMORY).map((r) => ({ text: String(r.payload["text"] ?? ""), score: r.score }));
    } catch {
      return [];
    }
  }
  // ── Unified semantic search ──────────────────────────────────────────────────
  /** Search across one or more collections at once. */
  async semanticSearch(query, collections = ["tool_calls", "transcript", "memories"], topK = 5) {
    if (!this.ready) return [];
    try {
      const vec = await withTimeout2(this.embedding.embed(query), SIMILARITY_TIMEOUT_MS, null);
      if (!vec) return [];
      const colMap = {
        tool_calls: COL_TOOL,
        transcript: COL_CHUNK,
        memories: COL_MEMORY
      };
      const active = new Set(collections.map((c) => colMap[c]).filter(Boolean));
      if (!active.size) return [];
      return this.store.search(vec, topK * collections.length, (p) => active.has(String(p["_col"] ?? ""))).slice(0, topK).map((r) => {
        const col = String(r.payload["_col"] ?? "");
        const colName = col === COL_TOOL ? "tool_calls" : col === COL_CHUNK ? "transcript" : "memories";
        let content = "";
        let ref = "";
        if (col === COL_TOOL) {
          content = `${r.payload["toolName"]} ${r.payload["inputSummary"]} \u2192 ${r.payload["resultSummary"]}`;
          ref = `${String(r.payload["sessionId"] ?? "").slice(-8)}:t${r.payload["turnIndex"]}`;
        } else if (col === COL_CHUNK) {
          content = String(r.payload["summary"] ?? "");
          ref = String(r.payload["ref"] ?? "");
        } else {
          content = String(r.payload["text"] ?? "");
          ref = r.id;
        }
        return { collection: colName, content, ref, score: r.score };
      });
    } catch {
      return [];
    }
  }
  // ── Stats ────────────────────────────────────────────────────────────────────
  get stats() {
    const toolCalls = this.store.collectionSize(COL_TOOL);
    const chunks = this.store.collectionSize(COL_CHUNK);
    const memories = this.store.collectionSize(COL_MEMORY);
    return { toolCalls, chunks, memories, total: toolCalls + chunks + memories };
  }
  /** Drop every indexed vector. Used when the embedding model/dimensions change. */
  clear() {
    this.store.clear();
  }
  dispose() {
    this.store.dispose();
  }
};
function shortInput(_toolName, input) {
  const parts = [];
  if (input.path) parts.push(String(input.path).slice(-50));
  if (input.command) parts.push(String(input.command).slice(0, 60));
  if (input.pattern) parts.push(String(input.pattern).slice(0, 40));
  if (input.op) parts.push(String(input.op));
  if (input.branch) parts.push(String(input.branch));
  if (input.oldString) parts.push(String(input.oldString).slice(0, 60));
  return (parts.join(" ").trim() || JSON.stringify({ ...input, newString: void 0 }).slice(0, 80)).replace(/\s+/g, " ");
}
function shortResult(result) {
  if (!result || typeof result !== "object") return String(result ?? "").slice(0, 80);
  const r = result;
  if (typeof r.error === "string") return `ERR: ${r.error.slice(0, 80)}`;
  if (typeof r.content === "string") return r.content.slice(0, 100);
  if (typeof r.path === "string") return r.path;
  if (typeof r.exitCode === "number") return `exit ${r.exitCode}`;
  return JSON.stringify(result).slice(0, 100);
}
function messagesToText2(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string") return m.content.slice(0, 200);
    if (!Array.isArray(m.content)) return "";
    return m.content.filter((b) => b.type === "text").map((b) => (b.text ?? "").slice(0, 100)).join(" ");
  }).join(" ").slice(0, 2e3);
}
async function withTimeout2(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve3) => setTimeout(() => resolve3(fallback), ms))
  ]);
}

// src/execution-logger.ts
var vscode12 = __toESM(require("vscode"));
var fs10 = __toESM(require("fs"));
var path15 = __toESM(require("path"));

// ../../src/shared/redaction.ts
var DEFAULT_SENSITIVE_KEY_RE = /(authorization|app-token|token|jwt|secret|password|api[-_]?key|access[-_]?key|session)/i;
var DEFAULT_MAX_DEPTH = 6;
function sanitizeForLogging(value, options = {}) {
  return sanitizeValue(value, {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStringChars: options.maxStringChars,
    maxArrayItems: options.maxArrayItems,
    maxObjectKeys: options.maxObjectKeys,
    sensitiveKeyPattern: options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_RE
  }, 0, /* @__PURE__ */ new WeakSet());
}
function sanitizeValue(value, options, depth, seen) {
  if (typeof value === "string") return truncateString(value, options.maxStringChars);
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, options.maxStringChars),
      stack: truncateString(value.stack || "", options.maxStringChars)
    };
  }
  if (depth >= options.maxDepth) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const maxItems = options.maxArrayItems ?? value.length;
    const output = value.slice(0, Math.max(0, maxItems)).map((entry) => sanitizeValue(entry, options, depth + 1, seen));
    if (value.length > maxItems) output.push(`[${value.length - maxItems} item(s) omitted]`);
    return output;
  }
  const entries = Object.entries(value);
  const maxKeys = options.maxObjectKeys ?? entries.length;
  const redacted = {};
  for (const [key, entry] of entries.slice(0, Math.max(0, maxKeys))) {
    redacted[key] = options.sensitiveKeyPattern.test(key) ? "[redacted]" : sanitizeValue(entry, options, depth + 1, seen);
  }
  if (entries.length > maxKeys) redacted.__omittedKeys = entries.length - maxKeys;
  return redacted;
}
function truncateString(value, limit) {
  if (!limit || limit <= 0 || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit)).trimEnd()}
...[truncated ${value.length - limit} chars]`;
}

// src/execution-log-format.ts
var SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi
];
function buildPromptPreview(text, limit = 160) {
  const collapsed = redactPromptPreview(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return "(empty)";
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit)).trimEnd()}...`;
}
function createSessionStartEntry(ctx) {
  return {
    ts: ctx.ts,
    kind: "session_start",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot
  };
}
function createTurnStartEntry(ctx, meta) {
  return {
    ts: ctx.ts,
    kind: "turn_start",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    data: {
      inputChars: meta.inputChars,
      promptPreview: buildPromptPreview(meta.promptPreview),
      mentionCount: meta.mentionCount ?? 0,
      contextLabel: meta.contextLabel
    }
  };
}
function createTurnEndEntry(ctx, ok, elapsedMs, error) {
  return {
    ts: ctx.ts,
    kind: "turn_end",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    ok,
    elapsedMs,
    error: error ? buildPromptPreview(error, 200) : void 0
  };
}
function createStructuredEventEntry(ctx, event, lane) {
  return {
    ts: ctx.ts,
    kind: "event",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    lane,
    eventType: event.type,
    data: sanitizeEvent(event)
  };
}
function redactPromptPreview(text) {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, redactMatch);
  }
  return output;
}
function redactMatch(match) {
  if (/^Bearer\s+/i.test(match)) return "Bearer [redacted]";
  const separatorIndex = match.search(/[:=]/);
  if (separatorIndex >= 0) {
    const prefix = match.slice(0, separatorIndex + 1);
    return `${prefix} [redacted]`;
  }
  return "[redacted]";
}
function sanitizeEvent(event) {
  switch (event.type) {
    case "tool_call_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputPreview: buildPromptPreview(event.inputPreview, 200),
        input: sanitizeUnknown(event.input, {
          maxDepth: 4,
          maxStringChars: 300,
          maxArrayItems: 10,
          maxObjectKeys: 24
        })
      };
    case "tool_call_result":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok: event.ok,
        summary: buildPromptPreview(event.summary, 200),
        elapsedMs: event.elapsedMs,
        result: sanitizeUnknown(event.result, {
          maxDepth: 4,
          maxStringChars: 400,
          maxArrayItems: 10,
          maxObjectKeys: 24
        })
      };
    default:
      return sanitizeUnknown(event, {
        maxDepth: 4,
        maxStringChars: 300,
        maxArrayItems: 12,
        maxObjectKeys: 24
      });
  }
}
function sanitizeUnknown(value, options) {
  return redactSanitizedStrings(sanitizeForLogging(value, options));
}
function redactSanitizedStrings(value) {
  if (typeof value === "string") return redactPromptPreview(value);
  if (Array.isArray(value)) return value.map((entry) => redactSanitizedStrings(entry));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactSanitizedStrings(entry);
  }
  return output;
}

// src/execution-logger.ts
var ExecutionLogger = class {
  _channel;
  _workspaceRoot;
  _logPath;
  _structuredLogPath;
  _logStream = null;
  _structuredLogStream = null;
  _turnCount = 0;
  _sessionId;
  _provider;
  _model;
  _activeTurnId;
  _turnStartedAt = /* @__PURE__ */ new Map();
  constructor(workspaceRoot, context) {
    this._workspaceRoot = workspaceRoot;
    this._channel = vscode12.window.createOutputChannel("Blacksite Agent");
    context.subscriptions.push({ dispose: () => this.dispose() });
    this._logPath = path15.join(workspaceRoot, ".blacksite", "execution.log");
    this._structuredLogPath = path15.join(workspaceRoot, ".blacksite", "execution.jsonl");
    this._openStream();
  }
  _openStream() {
    try {
      const dir = path15.dirname(this._logPath);
      if (!fs10.existsSync(dir)) fs10.mkdirSync(dir, { recursive: true });
      this._logStream = fs10.createWriteStream(this._logPath, { flags: "a", encoding: "utf8" });
      this._structuredLogStream = fs10.createWriteStream(this._structuredLogPath, { flags: "a", encoding: "utf8" });
    } catch {
    }
  }
  _ts() {
    return (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 23);
  }
  _write(line) {
    const full = `[${this._ts()}] ${line}`;
    this._channel.appendLine(full);
    if (this._logStream?.writable) this._logStream.write(`${full}
`);
  }
  _writeStructured(entry) {
    if (!this._structuredLogStream?.writable) return;
    this._structuredLogStream.write(`${JSON.stringify(entry)}
`);
  }
  _context(ts = this._ts(), turnId = this._activeTurnId) {
    return {
      ts,
      sessionId: this._sessionId,
      provider: this._provider,
      model: this._model,
      workspaceRoot: this._workspaceRoot,
      turnId,
      turnCount: this._turnCount
    };
  }
  sessionStart(sessionId, model, provider) {
    this._sessionId = sessionId;
    this._provider = provider;
    this._model = model;
    const bar = "\u2550".repeat(64);
    this._write(bar);
    this._write(`SESSION  ${sessionId.slice(-8)}  |  ${provider} / ${model}`);
    this._write(`ROOT     ${this._workspaceRoot}`);
    this._write(bar);
    this._writeStructured(createSessionStartEntry(this._context()));
  }
  turnStart(turnId, meta) {
    this._turnCount++;
    this._activeTurnId = turnId;
    this._turnStartedAt.set(turnId, Date.now());
    this._write(`\u2500\u2500\u2500 TURN ${this._turnCount}  (${turnId}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (!meta) return;
    const promptParts = [
      `chars=${meta.inputChars}`,
      `mentions=${meta.mentionCount ?? 0}`
    ];
    if (meta.contextLabel) promptParts.push(`context=${meta.contextLabel}`);
    this._write(`PROMPT   ${promptParts.join("  ")}  ${buildPromptPreview(meta.promptPreview)}`);
    this._writeStructured(createTurnStartEntry(this._context(this._ts(), turnId), meta));
  }
  turnEnd(turnId, ok, error) {
    const startedAt = this._turnStartedAt.get(turnId);
    const elapsedMs = startedAt ? Math.max(Date.now() - startedAt, 0) : 0;
    this._turnStartedAt.delete(turnId);
    if (!ok && error) {
      this._write(`\u2500\u2500\u2500 END   ${turnId}  |  \u2717 ${buildPromptPreview(error, 120)}  (${elapsedMs}ms)`);
    } else {
      this._write(`\u2500\u2500\u2500 END   ${turnId}  |  \u2713 OK  (${elapsedMs}ms)`);
    }
    this._writeStructured(createTurnEndEntry(this._context(this._ts(), turnId), ok, elapsedMs, error));
    if (this._activeTurnId === turnId) this._activeTurnId = void 0;
  }
  logEvent(event, lanePrefix) {
    const p = lanePrefix ? `[${lanePrefix}] ` : "";
    this._writeStructured(createStructuredEventEntry(this._context(), event, lanePrefix));
    switch (event.type) {
      case "iteration_start":
        this._write(`${p}\u25B6 Iteration #${event.iteration}`);
        break;
      case "text_delta":
      case "thinking_delta":
        break;
      case "usage_update":
        this._write(
          `${p}\u25C6 Tokens  in=${event.inputTokens}  out=${event.outputTokens}  cacheR=${event.cacheReadTokens}  cacheW=${event.cacheWriteTokens}`
        );
        break;
      case "runtime_state":
        this._write(
          `${p}\u25CC Runtime  ctx=${event.state.usagePct == null ? "n/a" : `${Math.round(event.state.usagePct)}%`}  compact=${event.state.compressionCount}${event.state.isCompacting ? "  [compacting]" : ""}`
        );
        break;
      case "tool_call_start":
        this._write(
          `${p}\u2699  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]  ${buildPromptPreview(event.inputPreview, 150)}`
        );
        break;
      case "tool_call_result": {
        const icon = event.ok ? "\u2713" : "\u2717";
        this._write(
          `${p}${icon}  ${event.toolName.padEnd(22)} [${event.toolCallId.slice(-6)}]  (${event.elapsedMs}ms)  ${buildPromptPreview(event.summary, 100)}`
        );
        if (!event.ok && event.result) {
          const errMsg = typeof event.result === "object" && event.result !== null && "error" in event.result ? String(event.result["error"]) : JSON.stringify(event.result).slice(0, 200);
          this._write(`${p}    \u26A0  ${buildPromptPreview(errMsg, 200)}`);
        }
        break;
      }
      case "execution_diagnostic":
        this._write(`${p}[${event.level.toUpperCase().padEnd(5)}] ${event.message}`);
        break;
      case "approval_pending":
        this._write(
          `${p}\u26A0  Approval pending  [tier:${event.tier}]  ${event.description.slice(0, 100)}`
        );
        break;
      case "approval_result":
        this._write(`${p}   \u2192 ${event.granted ? "Granted" : "Denied"}  [${event.toolCallId.slice(-6)}]`);
        break;
      case "question_card_pending":
        this._write(`${p}?  Question: ${event.question.slice(0, 100)}`);
        break;
      case "question_card_result":
        this._write(`${p}   \u2192 Selected: "${event.selectedKey}"`);
        break;
      case "turn_complete":
        this._write(`${p}\u25A0  Complete  stopReason=${event.stopReason}  iter=${event.iterations}`);
        break;
      case "error":
        this._write(`${p}\u2717  ERROR: ${buildPromptPreview(event.message, 200)}`);
        break;
      case "subagent_lane_start":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] \u25B6 Started  "${event.label}"  task: ${event.task.replace(/\s+/g, " ").slice(0, 80)}`
        );
        break;
      case "subagent_lane_event":
        this.logEvent(event.event, `LANE:${event.laneId.slice(-6)}`);
        break;
      case "subagent_lane_complete":
        this._write(
          `[LANE:${event.laneId.slice(-6)}] ${event.ok ? "\u2713" : "\u2717"}  "${event.label}"  ${event.ok ? "OK" : event.error ?? "failed"}  (${event.elapsedMs}ms, ${event.toolRounds} rounds)`
        );
        break;
    }
  }
  get stats() {
    return {
      turnCount: this._turnCount,
      logPath: this._logPath,
      structuredLogPath: this._structuredLogPath
    };
  }
  show() {
    this._channel.show(true);
  }
  getLogPath() {
    return this._logPath;
  }
  clear() {
    this._channel.clear();
  }
  dispose() {
    try {
      this._logStream?.end();
    } catch {
    }
    try {
      this._structuredLogStream?.end();
    } catch {
    }
    this._logStream = null;
    this._structuredLogStream = null;
    this._channel.dispose();
  }
};

// src/session-restore.ts
function pickRestoreState(queued, activeStored) {
  if (queued) return queued;
  if (activeStored && activeStored.messages.length > 0) {
    return {
      sessionId: activeStored.sessionId,
      messages: activeStored.messages,
      ...activeStored.state ?? {}
    };
  }
  return null;
}

// src/data/query-guard.ts
var READ_COMMANDS = /* @__PURE__ */ new Set(["SELECT", "WITH", "EXPLAIN", "VALUES"]);
var WRITE_COMMANDS = /* @__PURE__ */ new Set(["INSERT", "UPDATE", "DELETE", "UPSERT", "REPLACE"]);
var DDL_COMMANDS = /* @__PURE__ */ new Set(["CREATE", "ALTER", "REINDEX", "ANALYZE", "VACUUM"]);
var DESTRUCTIVE_COMMANDS = /* @__PURE__ */ new Set(["DROP", "TRUNCATE", "DETACH"]);
var READ_ONLY_PRAGMAS = /* @__PURE__ */ new Set([
  "table_info",
  "table_list",
  "index_list",
  "index_info",
  "foreign_key_list",
  "database_list",
  "schema_version",
  "user_version",
  "integrity_check",
  "quick_check",
  "page_count",
  "page_size",
  "freelist_count",
  "wal_checkpoint",
  "collation_list",
  "compile_options",
  "function_list",
  "module_list"
]);
var severityRank = {
  read: 0,
  unknown: 1,
  ddl: 2,
  write: 3,
  destructive: 4
};
function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function splitStatements(sql) {
  const cleaned = stripSqlComments(sql);
  const parts = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function maskStringLiterals(sql) {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      out += ch === "'" ? ch : " ";
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch === '"' ? ch : " ";
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}
function hasWhereClause(sql) {
  return /\bWHERE\b/i.test(maskStringLiterals(sql));
}
function classifyOne(statement) {
  const trimmed = statement.trim();
  const match = /^([a-zA-Z]+)/.exec(trimmed);
  const command = (match?.[1] ?? "").toUpperCase();
  if (command === "PRAGMA") {
    const pragmaMatch = /^PRAGMA\s+([a-zA-Z_]+)/i.exec(trimmed);
    const name = (pragmaMatch?.[1] ?? "").toLowerCase();
    const isAssignment = /=/.test(trimmed);
    const kind = READ_ONLY_PRAGMAS.has(name) && !isAssignment ? "read" : "write";
    return { sql: trimmed, kind, command };
  }
  if (READ_COMMANDS.has(command)) return { sql: trimmed, kind: "read", command };
  if (DESTRUCTIVE_COMMANDS.has(command)) return { sql: trimmed, kind: "destructive", command };
  if (WRITE_COMMANDS.has(command)) {
    if ((command === "DELETE" || command === "UPDATE") && !hasWhereClause(trimmed)) {
      return { sql: trimmed, kind: "destructive", command };
    }
    return { sql: trimmed, kind: "write", command };
  }
  if (DDL_COMMANDS.has(command)) {
    if (command === "ALTER" && /\bDROP\b/i.test(trimmed)) {
      return { sql: trimmed, kind: "destructive", command };
    }
    return { sql: trimmed, kind: "ddl", command };
  }
  return { sql: trimmed, kind: "unknown", command: command || "(empty)" };
}
function classifyQuery(sql) {
  const statements = splitStatements(sql).map(classifyOne);
  if (statements.length === 0) {
    return { statements: [], readOnly: true, destructive: false, overall: "read", multiple: false };
  }
  let overall = "read";
  for (const s of statements) {
    if (severityRank[s.kind] > severityRank[overall]) overall = s.kind;
  }
  return {
    statements,
    readOnly: statements.every((s) => s.kind === "read"),
    destructive: statements.some((s) => s.kind === "destructive"),
    overall,
    multiple: statements.length > 1
  };
}
function describeForConfirmation(classification) {
  if (classification.readOnly) return "Read-only query \u2014 runs directly.";
  const commands7 = classification.statements.filter((s) => s.kind !== "read").map((s) => s.command).join(", ");
  if (classification.destructive) {
    return `Destructive operation (${commands7}). This can delete or drop data and requires explicit confirmation.`;
  }
  return `Write operation (${commands7}). Review the target before running.`;
}

// src/data/assistant-query-prompts.ts
var ASSISTANT_SYSTEM_PROMPT = [
  "You are a careful SQL assistant for a local SQLite database inside a developer tool.",
  "You are given the live schema. Produce exactly one SQL statement that answers the user's question.",
  "Rules:",
  "- Prefer the stable views (names starting with v_) when they fit the question.",
  "- Use only tables/views/columns that appear in the provided schema.",
  "- Default to read-only SELECT queries. Only propose a write (INSERT/UPDATE/DELETE) when the user explicitly asks to change data, and never DROP/TRUNCATE.",
  "- Always include a LIMIT on broad SELECTs unless the user asks for an aggregate.",
  "Respond ONLY with a JSON object of the form:",
  '{"explanation": "<one or two plain-language sentences>", "sql": "<a single SQL statement>"}',
  "Do not wrap the JSON in markdown fences or add any prose outside the JSON."
].join("\n");
function buildSchemaContext(surface, maxObjects = 40) {
  const catalog = surface.getCatalog();
  const lines = [];
  for (const group of catalog.groups) {
    if (group.type !== "table" && group.type !== "view") continue;
    for (const object of group.objects.slice(0, maxObjects)) {
      try {
        const desc = surface.describeObject(object.name);
        const cols = desc.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
        lines.push(`${desc.type.toUpperCase()} ${object.name}(${cols})`);
      } catch {
        lines.push(`${group.type.toUpperCase()} ${object.name}`);
      }
    }
  }
  return lines.join("\n");
}
function buildUserPrompt(question, schemaContext) {
  return [
    "Schema:",
    schemaContext || "(no tables found)",
    "",
    `Question: ${question.trim()}`
  ].join("\n");
}
function parseAssistantResponse(raw) {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { explanation: trimmed.slice(0, 600), sql: null };
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";
    const sqlRaw = typeof parsed.sql === "string" ? parsed.sql.trim() : "";
    const sql = sqlRaw.replace(/;+\s*$/, "") || null;
    return { explanation: explanation || "Proposed query:", sql };
  } catch {
    return { explanation: trimmed.slice(0, 600), sql: null };
  }
}

// src/data/assistant-query-planner.ts
var AssistantQueryPlanner = class {
  constructor(surface, generate) {
    this.surface = surface;
    this.generate = generate;
  }
  async ask(question) {
    const trimmed = question.trim();
    if (!trimmed) return { ok: false, explanation: "", error: "Ask a question first." };
    let raw;
    try {
      const schema2 = buildSchemaContext(this.surface);
      raw = await this.generate(ASSISTANT_SYSTEM_PROMPT, buildUserPrompt(trimmed, schema2));
    } catch (err) {
      return { ok: false, explanation: "", error: err instanceof Error ? err.message : String(err) };
    }
    const parsed = parseAssistantResponse(raw);
    if (!parsed.sql) {
      return { ok: true, explanation: parsed.explanation };
    }
    const classification = classifyQuery(parsed.sql);
    const safety = classification.overall;
    if (classification.readOnly && !classification.multiple) {
      try {
        const result = await this.surface.runQuery(parsed.sql, { maxRows: 50 });
        if (result.ok && result.kind === "read") {
          const summary = `${parsed.explanation} (returned ${result.rowCount} row${result.rowCount === 1 ? "" : "s"})`;
          return { ok: true, explanation: summary, sql: parsed.sql, safety, needsConfirmation: false };
        }
      } catch {
      }
      return { ok: true, explanation: parsed.explanation, sql: parsed.sql, safety, needsConfirmation: false };
    }
    return {
      ok: true,
      explanation: `${parsed.explanation} This statement modifies data \u2014 review it and run it from the Query tab to confirm.`,
      sql: parsed.sql,
      safety,
      needsConfirmation: true
    };
  }
};

// src/webview-html.ts
var fs11 = __toESM(require("fs"));
var path16 = __toESM(require("path"));
var vscode13 = __toESM(require("vscode"));
function makeNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
function renderWebviewHtml(webview, extensionUri, scriptFile) {
  const shellPath = path16.join(extensionUri.fsPath, "out", "webview", "shell.html");
  const scriptUri = webview.asWebviewUri(
    vscode13.Uri.joinPath(extensionUri, "out", "webview", scriptFile)
  );
  const nonce = makeNonce();
  let html;
  try {
    html = fs11.readFileSync(shellPath, "utf8");
  } catch {
    return "<h1>Blacksite \u2014 webview not found. Run `npm run build`.</h1>";
  }
  return html.replace(/\{\{cspSource\}\}/g, webview.cspSource).replace(/\{\{scriptUri\}\}/g, scriptUri.toString()).replace(/\{\{nonce\}\}/g, nonce);
}

// src/workspace-paths.ts
var path17 = __toESM(require("path"));
function isWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}
function pathModuleFor(value) {
  return isWindowsPath(value) ? path17.win32 : path17.posix;
}
function normalizeWithModule(root, pathModule) {
  return pathModule.resolve(root.trim());
}
function isWithinWorkspace2(targetPath, workspaceRoots) {
  const trimmedTarget = targetPath.trim();
  if (!trimmedTarget) return false;
  const targetModule = pathModuleFor(trimmedTarget);
  const resolvedTarget = normalizeWithModule(trimmedTarget, targetModule);
  return workspaceRoots.map((root) => root.trim()).filter(Boolean).some((root) => {
    const rootModule = pathModuleFor(root);
    if (rootModule !== targetModule) return false;
    const normalizedRoot = normalizeWithModule(root, rootModule);
    const relative8 = rootModule.relative(normalizedRoot, resolvedTarget);
    return relative8 === "" || !relative8.startsWith("..") && !rootModule.isAbsolute(relative8);
  });
}
function resolveWorkspacePath2(targetPath, workspaceRoots) {
  const trimmed = targetPath.trim();
  if (!trimmed || workspaceRoots.length === 0) return null;
  const rootModule = pathModuleFor(workspaceRoots[0]);
  const targetModule = pathModuleFor(trimmed);
  if (targetModule.isAbsolute(trimmed)) {
    const absolute = normalizeWithModule(trimmed, targetModule);
    return isWithinWorkspace2(absolute, workspaceRoots) ? absolute : null;
  }
  const baseRoot = normalizeWithModule(workspaceRoots[0], rootModule);
  const candidate = rootModule.resolve(baseRoot, trimmed);
  return isWithinWorkspace2(candidate, [baseRoot]) ? candidate : null;
}

// src/chat-provider.ts
var SETTINGS_KEY = "blacksite.settings.v2";
var PROVIDER_DEFAULTS2 = {
  anthropic: { model: "claude-sonnet-4-6", temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 1e4 } },
  openrouter: { model: "anthropic/claude-sonnet-4-6", temperature: 1, maxTokens: 8192 },
  openai: { model: "gpt-4o", temperature: 1, maxTokens: 8192 },
  bedrock: { model: BEDROCK_CONVERSE_DEFAULT_MODEL, temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 1e4 } }
};
var DELEGATED_TOOL_NAMES = ["subagent_spawn"];
var SUBAGENT_TIMEOUT_REASON = "Delegated lane timed out.";
function makeLaneId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function normalizeDelegatedComplexity(input) {
  if (input.complexity === "standard" || input.complexity === "complex" || input.complexity === "deep") return input.complexity;
  const chars = input.task.length + (input.context?.length ?? 0);
  if (chars > 1e4) return "deep";
  if (chars > 3e3) return "complex";
  return "standard";
}
function resolveSubagentBudget(input, sessionMaxIterations) {
  const complexity = normalizeDelegatedComplexity(input);
  const timeoutSeconds = complexity === "deep" ? 420 : complexity === "complex" ? 240 : 120;
  const maxToolRounds = complexity === "deep" ? 14 : complexity === "complex" ? 10 : 6;
  const maxIterations = Math.min(Math.max(sessionMaxIterations, maxToolRounds + 2), maxToolRounds + 4);
  return { complexity, timeoutSeconds, maxToolRounds, maxIterations };
}
function delegatedLanePrompt(task, context) {
  const trimmedContext = context?.trim();
  return trimmedContext ? `Delegated task:
${task.trim()}

Additional context:
${trimmedContext}` : `Delegated task:
${task.trim()}`;
}
function buildDelegatedSystemPrompt(basePrompt, budget, profileAddition) {
  const lines = [
    "You are a delegated Blacksite subagent running one focused lane for a parent agent.",
    "Stay tightly scoped to the delegated task. Gather evidence, make changes if needed, and return a concise synthesis for the parent to integrate.",
    "Do not address the end user directly. Do not explain the parent workflow. Work only within this lane.",
    "If you need user approval, ask through the provided tools. If information is missing, state the gap clearly in the final answer.",
    `Execution budget: ${budget.complexity} complexity, ${budget.maxToolRounds} tool rounds, ${budget.timeoutSeconds}s timeout.`
  ];
  if (profileAddition?.trim()) {
    lines.push("", `Profile guidance: ${profileAddition.trim()}`);
  }
  lines.push("", basePrompt);
  return lines.join("\n");
}
function extractLatestAssistantText(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content.filter((block) => !!block && typeof block === "object").filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text ?? "").join("\n").trim();
    if (text) return text;
  }
  return "";
}
function isBaseAgentEvent(event) {
  return event.type !== "subagent_lane_start" && event.type !== "subagent_lane_event" && event.type !== "subagent_lane_complete";
}
function namespaceChildEvent(laneId, event) {
  const namespacedId = (toolCallId) => `${laneId}:${toolCallId}`;
  switch (event.type) {
    case "tool_call_start":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "tool_call_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "approval_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_pending":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    case "question_card_result":
      return { ...event, toolCallId: namespacedId(event.toolCallId) };
    default:
      return event;
  }
}
function normalizeModelIdForLookup(modelId) {
  const trimmed = modelId.trim().toLowerCase();
  const slashIndex = trimmed.lastIndexOf("/");
  const colonIndex = trimmed.lastIndexOf(":");
  return colonIndex > slashIndex ? trimmed.slice(0, colonIndex) : trimmed;
}
function modelIdsMatch(left, right) {
  const a = normalizeModelIdForLookup(left);
  const b = normalizeModelIdForLookup(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
var ChatProvider = class {
  constructor(_context, _runtime, _secrets, _sessionStore, _workspaceRoot, _memory, _diagnostics, _planning, _dataSurface) {
    this._context = _context;
    this._runtime = _runtime;
    this._secrets = _secrets;
    this._sessionStore = _sessionStore;
    this._workspaceRoot = _workspaceRoot;
    this._memory = _memory;
    this._diagnostics = _diagnostics;
    this._planning = _planning;
    this._dataSurface = _dataSurface;
    this._runner = new BackgroundRunner();
    this._chromium = new ChromiumRunner();
    this._applier = new WorkspaceEditApplier(_workspaceRoot);
    this._applier.setApprovalProvider((req) => this._requestEditApproval(req));
    this._editService = new DiffEditService(_workspaceRoot, this._applier);
    this._lspService = new LspService(_workspaceRoot, this._applier);
    this._logger = new ExecutionLogger(_workspaceRoot, _context);
    this._context.subscriptions.push({ dispose: () => this._runner.dispose() });
    this._context.subscriptions.push({ dispose: () => void this._chromium.dispose() });
    this._context.subscriptions.push({ dispose: () => this._applier.dispose() });
    this._context.subscriptions.push({ dispose: () => this._memoryIndex?.dispose() });
    if (this._readSettings().agentMemory?.enabled) {
      this._initMemoryIndex();
    }
  }
  _view;
  _session = null;
  _restoredSessionState = null;
  _runner;
  _chromium;
  _applier;
  _editService;
  _lspService;
  // Cache of fetched model lists keyed by provider
  _modelCache = /* @__PURE__ */ new Map();
  // Pending question cards: toolCallId → resolve function
  _pendingQuestionCards = /* @__PURE__ */ new Map();
  _pendingApprovals = /* @__PURE__ */ new Map();
  // Live turn id for out-of-band approvals (e.g. file-edit apply) routed to the webview.
  _liveTurnId;
  _editApprovalSeq = 0;
  // Semantic memory index (initialized when agentMemory.enabled = true)
  _memoryIndex = null;
  // Execution logger — always active; writes to OutputChannel + .blacksite/execution.log
  _logger;
  _initMemoryIndex() {
    try {
      const settings = this._readSettings();
      const store = new VectorStore(
        path18.join(this._workspaceRoot, ".blacksite", "memory-index.json")
      );
      const embedding = this._buildEmbeddingService(settings);
      const idx = new AgentMemoryIndex(store, embedding);
      idx.init();
      this._memoryIndex = idx;
    } catch {
    }
  }
  _disposeMemoryIndex() {
    this._memoryIndex?.dispose();
    this._memoryIndex = null;
  }
  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode14.Uri.joinPath(this._context.extensionUri, "out")]
    };
    webviewView.webview.html = this._loadHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (msg) => {
        this._onMessage(msg).catch((err) => {
          console.error("[Blacksite] _onMessage unhandled rejection:", err instanceof Error ? err.message : String(err));
        });
      },
      void 0,
      this._context.subscriptions
    );
  }
  clearMessages() {
    this._sessionStore.archiveActive();
    this._session = null;
    this._restoredSessionState = null;
    this._sessionStore.clearActive();
    clearCheckpoint(this._context);
    this._post({ type: "clear" });
  }
  cancelCurrentRun() {
    this._runner.cancel();
  }
  /** Open the VS Code Output panel to the Blacksite Agent log channel. */
  showLogs() {
    this._logger.show();
  }
  async closeBrowser() {
    await this._chromium.dispose();
  }
  createDataAssistant(surface) {
    return new AssistantQueryPlanner(surface, (system, user) => this._generateAssistantText(system, user));
  }
  /**
   * Builds an EmbeddingService from the current embedding settings. OpenAI/OpenRouter
   * embed via a bearer key; Bedrock embeds via SigV4-signed Titan/Cohere InvokeModel
   * calls using the stored AWS credentials; anthropic has no embeddings endpoint and
   * falls back to an openai/openrouter key or the local sparse vector. An explicit
   * embedding-provider override wins over the main chat provider.
   */
  _buildEmbeddingService(settings) {
    const embedProvider = settings.embedding?.provider ?? settings.provider;
    return new EmbeddingService(
      embedProvider,
      (p) => this._secrets.getApiKey(p),
      void 0,
      { model: settings.embedding?.model, dims: settings.embedding?.dims },
      () => this._secrets.getBedrockConfig()
    );
  }
  /**
   * Returns a text→vector embedder for the Data workbench, honoring the unified
   * embedding-model setting. Reads settings fresh on each call so model changes take
   * effect without re-wiring. Falls back to the local sparse vector if the API path
   * fails (no key, network error), matching prior behavior.
   */
  createEmbedder() {
    return (text) => this._buildEmbeddingService(this._readSettings()).embed(text);
  }
  async compactConversation() {
    if (this._runner.busy) {
      void vscode14.window.showInformationMessage("Blacksite is still running. Wait for the current turn to finish before compacting.");
      return;
    }
    const stored = this._sessionStore.loadActive();
    if (!this._session && !this._restoredSessionState && !stored?.messages.length) {
      void vscode14.window.showInformationMessage("No conversation history is available to compact yet.");
      return;
    }
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const compressionProviderName = settings.compression?.provider ?? settings.provider;
    const apiKey = await this._secrets.getOrPromptApiKey(compressionProviderName);
    if (!apiKey) return;
    if (!this._session) {
      this._session = await this._createSession(apiKey);
      this._logger.sessionStart(this._session.sessionId, pSettings.model, settings.provider);
      const restore = pickRestoreState(this._restoredSessionState, stored);
      if (restore) {
        this._restoreSessionFromState(this._session, restore.messages, restore, restore.sessionId);
        this._restoredSessionState = null;
      }
    }
    const compressionProvider = this._buildCompressionProvider(apiKey, settings, pSettings, { forceEnabled: true });
    if (!compressionProvider || !this._session) {
      void vscode14.window.showWarningMessage("Compression is not available for the current session.");
      return;
    }
    const pending = this._session.manualCompact(compressionProvider);
    this._postSessionRuntimeState();
    const result = await pending;
    this._persistSession(this._session);
    this._postSessionRuntimeState();
    if (result.ok) void vscode14.window.showInformationMessage(result.message);
    else void vscode14.window.showWarningMessage(result.message);
  }
  async offerCheckpointResume(cp) {
    const action = await vscode14.window.showInformationMessage(
      `Blacksite: Unfinished run detected (${cp.iteration} iteration(s)). Resume?`,
      "Resume",
      "Discard"
    );
    if (action === "Resume") {
      const apiKey = await this._secrets.getOrPromptApiKey(this._readSettings().provider);
      if (!apiKey) return;
      this._session = await this._createSession(apiKey);
      this._restoreSessionFromState(this._session, cp.messages, cp.state, cp.sessionId);
      this._post({ type: "history_restored", messages: this._session.history });
      this._postSessionRuntimeState();
      void this._continueSend("[Resumed from checkpoint]");
    } else {
      clearCheckpoint(this._context);
    }
  }
  /** Build a fresh AgentSession wired with the current settings, workspace context, and providers. */
  async _createSession(apiKey) {
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const snapshot = await gatherWorkspaceSnapshot(this._workspaceRoot, this._runtime);
    snapshot.mcpServers = this._enabledMcpServers();
    const delegationEnabled = !settings.disabledTools.includes("subagent_spawn");
    const systemPrompt = delegationEnabled ? `${buildSystemPrompt(snapshot)}
- When the work has an independent investigation or implementation lane, delegate it early with subagent_spawn so the parent context stays focused on orchestration and synthesis.` : buildSystemPrompt(snapshot);
    const ctxLen = await this._resolveContextLength(settings.provider, pSettings.model, apiKey);
    const compressionProvider = this._buildCompressionProvider(apiKey, settings, pSettings);
    const transcriptProvider = this._buildTranscriptProvider();
    const bedrock = settings.provider === "bedrock" ? await this._secrets.getBedrockConfig() : void 0;
    return new AgentSession({
      apiKey,
      model: pSettings.model,
      systemPrompt,
      workspaceRoot: this._workspaceRoot,
      runtime: this._runtime,
      context: this._context,
      provider: settings.provider,
      bedrock,
      bedrockApi: settings.bedrockApi,
      temperature: pSettings.temperature,
      maxTokens: pSettings.maxTokens,
      thinking: pSettings.thinking,
      reasoningEffort: pSettings.reasoningEffort,
      maxIterations: settings.maxIterations,
      disabledTools: settings.disabledTools,
      contextLength: ctxLen,
      compressionProvider,
      compressionTriggerPct: settings.compression?.triggerPct,
      compressionKeepRecent: settings.compression?.keepRecent,
      transcriptProvider,
      httpReferer: settings.openrouterConfig?.httpReferer,
      xTitle: settings.openrouterConfig?.xTitle,
      serviceKeyProvider: (svc) => this._secrets.getApiKey(svc),
      browserRunner: this._chromium,
      editProvider: this._editService,
      diagnosticsProvider: this._diagnostics,
      lspProvider: this._lspService,
      questionCardProvider: (toolCallId, question, options, context) => this._createQuestionCardPromise(toolCallId, question, options, context),
      approvalProvider: (toolCallId, toolName, description, tier) => this._createApprovalPromise(toolCallId, toolName, description, tier),
      subagentProvider: this._createSubagentProvider(apiKey, settings, pSettings),
      subagentMaxConcurrent: settings.subagent?.maxConcurrent,
      memoryProvider: {
        append: (note) => this._memory.appendMemory(note),
        readMemory: () => this._memory.readMemory(),
        readContext: () => this._memory.readContext()
      },
      planningProvider: this._planning,
      dataProvider: this._buildDataToolProvider(),
      agentMemoryIndex: this._memoryIndex ?? void 0
    });
  }
  /**
   * Expose the embedded database to the agent as read-only / classify-only db_* tools.
   * Writes are never executed here: run_read_query rejects non-reads and
   * preview_write_query only classifies, preserving the "no silent writes" rule.
   */
  _buildDataToolProvider() {
    const surface = this._dataSurface;
    if (!surface) return void 0;
    return {
      dispatch: async (op, payload) => {
        try {
          switch (op) {
            case "list_objects":
              return { ok: true, catalog: surface.getCatalog() };
            case "describe_object":
              return { ok: true, description: surface.describeObject(String(payload["name"] ?? "")) };
            case "preview_rows":
              return {
                ok: true,
                result: surface.previewRows(String(payload["name"] ?? ""), {
                  limit: typeof payload["limit"] === "number" ? payload["limit"] : 50,
                  offset: typeof payload["offset"] === "number" ? payload["offset"] : 0,
                  filter: typeof payload["filter"] === "string" ? payload["filter"] : void 0
                })
              };
            case "run_read_query": {
              const result = await surface.runQuery(String(payload["sql"] ?? ""), {
                confirmed: false,
                maxRows: typeof payload["maxRows"] === "number" ? payload["maxRows"] : 200
              });
              if (!result.ok) {
                return { ok: false, error: result.message, classification: result.classification };
              }
              return { ...result };
            }
            case "preview_write_query":
              return { ok: true, ...surface.previewQuery(String(payload["sql"] ?? "")) };
            case "vector_search": {
              const raw = payload["vector"];
              const text = typeof payload["text"] === "string" ? payload["text"] : "";
              if (!Array.isArray(raw) && !text.trim()) {
                return { ok: false, error: "vector_search requires either a 'vector' array or a non-empty 'text' field." };
              }
              const vector = Array.isArray(raw) ? raw.map((x) => Number(x)) : sparseEmbed(text);
              const hits = await surface.vectorSearch({
                vector,
                topK: typeof payload["topK"] === "number" ? payload["topK"] : 10,
                collection: typeof payload["collection"] === "string" && payload["collection"] ? payload["collection"] : void 0
              });
              return { ok: true, hits };
            }
            case "list_saved_queries":
              return { ok: true, savedQueries: surface.listSavedQueries() };
            default:
              return { ok: false, error: `Unknown data operation: ${op}` };
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    };
  }
  async _generateAssistantText(systemPrompt, userPrompt) {
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const apiKey = await this._secrets.getOrPromptApiKey(settings.provider);
    if (!apiKey) throw new Error(`No API key configured for ${settings.provider}.`);
    if (settings.provider === "bedrock") {
      const config = await this._secrets.getBedrockConfig();
      if (!config) throw new Error("No AWS credentials configured for Bedrock.");
      if (settings.bedrockApi === "mantle") {
        const response3 = await mantleMessage({
          credentials: config,
          model: pSettings.model,
          system: systemPrompt,
          maxTokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
          messages: [{ role: "user", content: userPrompt }]
        });
        return response3.content.find((b) => b.type === "text")?.text?.trim() ?? "";
      }
      const response2 = await converseBedrock({
        credentials: config,
        modelId: pSettings.model,
        systemPrompt,
        maxTokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
        messages: [{ role: "user", content: [{ text: userPrompt }] }]
      });
      return response2.output.message.content.filter((block) => "text" in block).map((block) => block.text).join("\n\n").trim();
    }
    if (settings.provider === "anthropic") {
      const response2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: pSettings.model,
          max_tokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      if (!response2.ok) {
        const text = await response2.text().catch(() => "");
        throw new Error(`Anthropic error ${response2.status}: ${text.slice(0, 300)}`);
      }
      const data2 = await response2.json();
      return data2.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
    }
    const baseUrl = settings.provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
    const body = {
      model: pSettings.model,
      max_tokens: Math.min(pSettings.maxTokens ?? 4096, 4096),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    };
    if (settings.provider === "openai" && pSettings.reasoningEffort) {
      body["reasoning_effort"] = pSettings.reasoningEffort;
    }
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...settings.provider === "openrouter" ? {
          "HTTP-Referer": settings.openrouterConfig?.httpReferer ?? "https://blacksite.dev",
          "X-Title": settings.openrouterConfig?.xTitle ?? "Blacksite"
        } : {}
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${settings.provider} error ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }
  _restoreSessionFromState(session, messages, state, sessionId) {
    const fullHistory = state?.fullHistory ?? (sessionId ? this._sessionStore.loadFullHistory(sessionId) : void 0);
    session.restoreState({
      messages,
      ...state ?? {},
      fullHistory
    });
  }
  _buildRuntimeFromStoredSession(sessionId, messages, state) {
    const keepRecent = this._readSettings().compression?.keepRecent ?? 20;
    const fullHistory = state?.fullHistory ?? this._sessionStore.loadFullHistory(sessionId) ?? messages;
    const lastInputTokens = state?.lastInputTokens ?? 0;
    const contextLength = state?.contextLength;
    const usagePct = contextLength && lastInputTokens > 0 ? Math.min(lastInputTokens / contextLength * 100, 100) : null;
    return {
      sessionId,
      contextLength,
      lastInputTokens,
      usagePct,
      compressionEnabled: !!this._readSettings().compression?.enabled,
      isCompacting: false,
      compressionCount: state?.compressionCount ?? 0,
      hasCompressedHistory: !!state?.compressedSummary,
      lastCompressedAt: state?.lastCompressedAt,
      lastCompressedMessageCount: state?.lastCompressedMessageCount,
      lastCompressionError: state?.lastCompressionError,
      lastCompressionTrigger: state?.lastCompressionTrigger,
      keepRecent,
      activeMessageCount: messages.length,
      fullMessageCount: fullHistory.length,
      compressedMessageCount: Math.max(fullHistory.length - messages.length, 0),
      compressibleMessageCount: messages.length > keepRecent + 4 ? messages.length - keepRecent : 0,
      lastStopReason: state?.lastStopReason,
      autoContinueCount: state?.autoContinueCount ?? 0,
      pendingGate: state?.pendingGate
    };
  }
  _postSessionRuntimeState(runtime) {
    const next = runtime ?? this._session?.runtimeState;
    if (!next) return;
    this._post({ type: "session_runtime", runtime: next });
  }
  _persistSession(session) {
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const stored = this._sessionStore.loadActive();
    this._sessionStore.saveActive({
      sessionId: session.sessionId,
      createdAt: stored?.sessionId === session.sessionId ? stored.createdAt : Date.now(),
      updatedAt: Date.now(),
      model: pSettings.model,
      workspaceRoot: this._workspaceRoot,
      messages: session.history,
      state: session.exportState(false)
    });
    this._sessionStore.saveFullHistory(session.sessionId, session.fullHistory);
  }
  _buildCompressionProvider(apiKey, settings, pSettings, options) {
    if (!options?.forceEnabled && !settings.compression?.enabled) return void 0;
    const cmp = settings.compression;
    const provider = cmp?.provider ?? settings.provider;
    const model = cmp?.model ?? pSettings.model;
    const secrets = this._secrets;
    return {
      compress: async (messages) => {
        const cmpKey = provider !== settings.provider ? await secrets.getApiKey(provider) ?? apiKey : apiKey;
        const bedrock = provider === "bedrock" ? await secrets.getBedrockConfig() : void 0;
        const bedrockApi = provider === "bedrock" ? settings.bedrockApi : void 0;
        return compressHistory({ apiKey: cmpKey, model, provider, bedrock, bedrockApi }, messages);
      }
    };
  }
  _buildTranscriptProvider() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getFullHistory: () => this._session?.fullHistory ?? []
    };
  }
  _enabledMcpServers() {
    return getMcpServers(this._context).filter((s) => s.enabled).map((s) => ({
      name: s.name,
      transport: s.transport,
      target: (s.transport === "http" ? s.url : s.command) ?? ""
    })).filter((s) => s.target);
  }
  _createSubagentProvider(apiKey, settings, pSettings) {
    return {
      spawn: (request) => this._runDelegatedLane(apiKey, settings, pSettings, request)
    };
  }
  async *_runDelegatedLane(apiKey, settings, pSettings, request) {
    const laneId = makeLaneId("lane");
    const subRequestId = makeLaneId("sub");
    const label = request.input.label?.trim() || "Delegated lane";
    const budget = resolveSubagentBudget(request.input, settings.maxIterations);
    const snapshot = await gatherWorkspaceSnapshot(this._workspaceRoot, this._runtime);
    snapshot.mcpServers = this._enabledMcpServers();
    const laneStartedAt = Date.now();
    const profile = request.input.profileId ? findSubagentProfile(settings.subagent?.profiles, request.input.profileId) : null;
    const subProvider = settings.subagent?.provider ?? settings.provider;
    const subModel = settings.subagent?.model ?? pSettings.model;
    const subApiKey = subProvider !== settings.provider ? await this._secrets.getApiKey(subProvider) ?? apiKey : apiKey;
    const subPSettings = subProvider !== settings.provider ? this._providerSettings(subProvider, settings) : pSettings;
    const resolvedSubModel = subModel || subPSettings.model;
    const subBedrock = subProvider === "bedrock" ? await this._secrets.getBedrockConfig() : void 0;
    const childChromium = new ChromiumRunner();
    const controller = new AbortController();
    const forwardAbort = () => {
      if (!controller.signal.aborted) controller.abort(request.signal?.reason ?? "Parent run cancelled.");
    };
    if (request.signal) {
      if (request.signal.aborted) forwardAbort();
      else request.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeoutHandle = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(SUBAGENT_TIMEOUT_REASON);
    }, budget.timeoutSeconds * 1e3);
    try {
      const childSession = new AgentSession({
        apiKey: subApiKey,
        model: resolvedSubModel,
        systemPrompt: buildDelegatedSystemPrompt(buildSystemPrompt(snapshot), budget, profile?.systemPromptAddition),
        workspaceRoot: this._workspaceRoot,
        runtime: this._runtime,
        context: this._context,
        provider: subProvider,
        bedrock: subBedrock,
        bedrockApi: subProvider === "bedrock" ? settings.bedrockApi : void 0,
        signal: controller.signal,
        temperature: subPSettings.temperature,
        maxTokens: subPSettings.maxTokens,
        thinking: subProvider === "anthropic" || subProvider === "bedrock" ? subPSettings.thinking : void 0,
        reasoningEffort: subPSettings.reasoningEffort,
        httpReferer: settings.openrouterConfig?.httpReferer,
        xTitle: settings.openrouterConfig?.xTitle,
        maxIterations: budget.maxIterations,
        disabledTools: Array.from(/* @__PURE__ */ new Set([...settings.disabledTools ?? [], ...DELEGATED_TOOL_NAMES])),
        serviceKeyProvider: (svc) => this._secrets.getApiKey(svc),
        browserRunner: childChromium,
        editProvider: this._editService,
        diagnosticsProvider: this._diagnostics,
        lspProvider: this._lspService,
        questionCardProvider: (toolCallId, question, options, context) => this._createQuestionCardPromise(
          `${laneId}:${toolCallId}`,
          question,
          options,
          context,
          controller.signal
        ),
        approvalProvider: (toolCallId, toolName, description, tier) => this._createApprovalPromise(
          `${laneId}:${toolCallId}`,
          toolName,
          description,
          tier,
          controller.signal
        ),
        memoryProvider: {
          append: (note) => this._memory.appendMemory(note),
          readMemory: () => this._memory.readMemory(),
          readContext: () => this._memory.readContext()
        },
        planningProvider: this._planning,
        checkpointingEnabled: false
      });
      yield {
        type: "subagent_lane_start",
        parentToolCallId: request.parentToolCallId,
        laneId,
        subRequestId,
        label,
        task: request.input.task
      };
      let stopReason = "";
      let errorMessage = "";
      try {
        for await (const event of childSession.send(delegatedLanePrompt(request.input.task, request.input.context))) {
          if (!isBaseAgentEvent(event)) continue;
          if (event.type === "turn_complete") stopReason = event.stopReason;
          if (event.type === "error") errorMessage = event.message;
          yield {
            type: "subagent_lane_event",
            parentToolCallId: request.parentToolCallId,
            laneId,
            event: namespaceChildEvent(laneId, event)
          };
        }
      } catch (laneErr) {
        errorMessage = laneErr instanceof Error ? laneErr.message : String(laneErr);
      }
      const answer = extractLatestAssistantText(childSession.history);
      const toolRounds = Math.max(childSession.iteration - 1, 0);
      if (controller.signal.aborted && controller.signal.reason === SUBAGENT_TIMEOUT_REASON) {
        errorMessage = `Timed out after ${budget.timeoutSeconds}s.`;
      } else if (controller.signal.aborted && !errorMessage) {
        errorMessage = "Cancelled.";
      } else if (!errorMessage && !answer) {
        errorMessage = "Delegated lane returned no final answer.";
      }
      const ok = !errorMessage && !!answer;
      yield {
        type: "subagent_lane_complete",
        parentToolCallId: request.parentToolCallId,
        laneId,
        subRequestId,
        label,
        ok,
        answer,
        ...errorMessage ? { error: errorMessage } : {},
        elapsedMs: Math.max(Date.now() - laneStartedAt, 0),
        stopReason,
        toolRounds,
        budget
      };
      yield {
        type: "subagent_tool_result",
        result: ok ? {
          ok: true,
          subRequestId,
          answer,
          toolRounds,
          usage: null,
          scratchFiles: [],
          budget,
          nextStep: "Review the delegated lane output and continue synthesis."
        } : { ok: false, error: errorMessage || "Delegated lane failed." }
      };
    } finally {
      clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", forwardAbort);
      await childChromium.dispose();
    }
  }
  injectContext(text, label) {
    this._post({ type: "inject_context", text, label });
  }
  // ── Message dispatch ─────────────────────────────────────────────────────────
  async _onMessage(msg) {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
        this._restoreSessionToWebview();
        break;
      case "send_message": {
        const p = msg.payload;
        const content = String(p?.content ?? "").trim();
        const mentions = Array.isArray(p?.mentions) ? p.mentions.map((m) => String(m)) : [];
        if (content) await this._handleSend(content, p?.context, mentions);
        break;
      }
      case "request_files": {
        const query = String(msg.query ?? "");
        const files = await this._searchWorkspaceFiles(query);
        this._post({ type: "files_data", query, files });
        break;
      }
      case "cancel_current":
        this._runner.cancel();
        break;
      case "compact_conversation":
        await this.compactConversation();
        break;
      case "new_chat":
        this._sessionStore.archiveActive();
        this._session = null;
        this._restoredSessionState = null;
        this._sessionStore.clearActive();
        clearCheckpoint(this._context);
        this._post({ type: "clear" });
        break;
      // ── History ───────────────────────────────────────────────────────────────
      case "get_history":
        this._post({ type: "history_data", sessions: this._sessionStore.loadHistory() });
        break;
      case "load_session": {
        const sessionId = String(msg.sessionId ?? "");
        if (!sessionId) break;
        this._sessionStore.archiveActive();
        const stored = this._sessionStore.loadSessionFromHistory(sessionId);
        if (!stored) break;
        this._session = null;
        this._restoredSessionState = { sessionId: stored.sessionId, messages: stored.messages, ...stored.state ?? {} };
        this._sessionStore.saveActive(stored);
        this._post({ type: "clear" });
        const display = stored.messages.filter((m) => m.role === "user" || m.role === "assistant");
        this._post({ type: "history_restored", messages: display });
        if (stored.state?.contextLength || stored.state?.compressionCount || stored.state?.lastInputTokens) {
          this._post({
            type: "session_runtime",
            runtime: this._buildRuntimeFromStoredSession(stored.sessionId, stored.messages, stored.state)
          });
        }
        break;
      }
      case "delete_session": {
        const sessionId = String(msg.sessionId ?? "");
        if (!sessionId) break;
        this._sessionStore.deleteSessionFromHistory(sessionId);
        this._post({ type: "history_data", sessions: this._sessionStore.loadHistory() });
        break;
      }
      // ── Settings ──────────────────────────────────────────────────────────────
      case "get_settings":
        await this._sendSettingsToWebview();
        break;
      case "set_active_provider": {
        const provider = msg.provider;
        if (!this._isValidProvider(provider)) break;
        const s = this._readSettings();
        s.provider = provider;
        this._writeSettings(s);
        await this._syncVisibleSettingsToConfig(s);
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }
      case "set_provider_model": {
        const provider = msg.provider;
        const model = String(msg.model ?? "").trim();
        if (!this._isValidProvider(provider) || !model) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), model };
        this._writeSettings(s);
        if (provider === s.provider) {
          await this._syncVisibleSettingsToConfig(s);
        }
        this._session = null;
        break;
      }
      case "set_temperature": {
        const provider = msg.provider;
        const temperature = Number(msg.temperature);
        if (!this._isValidProvider(provider) || isNaN(temperature)) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), temperature };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      case "set_max_tokens": {
        const provider = msg.provider;
        const maxTokens = Number(msg.maxTokens);
        if (!this._isValidProvider(provider) || isNaN(maxTokens) || maxTokens < 1) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), maxTokens };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      case "set_thinking": {
        const provider = msg.provider;
        const enabled = Boolean(msg.enabled);
        const budgetTokens = Number(msg.budgetTokens) || 1e4;
        if (!this._isValidProvider(provider)) break;
        const s = this._readSettings();
        const cur = this._providerSettings(provider, s);
        s.providerSettings[provider] = { ...cur, thinking: { enabled, budgetTokens } };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      case "set_reasoning_effort": {
        const provider = msg.provider;
        const effort = msg.effort;
        if (!this._isValidProvider(provider) || !effort) break;
        const s = this._readSettings();
        s.providerSettings[provider] = { ...this._providerSettings(provider, s), reasoningEffort: effort };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      case "set_max_iterations": {
        const n = Number(msg.maxIterations);
        if (isNaN(n) || n < 1) break;
        const s = this._readSettings();
        s.maxIterations = n;
        this._writeSettings(s);
        break;
      }
      case "toggle_tool": {
        const toolName = String(msg.toolName ?? "");
        const enabled = Boolean(msg.enabled);
        if (!toolName) break;
        const s = this._readSettings();
        if (enabled) {
          s.disabledTools = s.disabledTools.filter((t) => t !== toolName);
        } else {
          if (!s.disabledTools.includes(toolName)) s.disabledTools.push(toolName);
        }
        this._writeSettings(s);
        break;
      }
      case "set_compression": {
        const s = this._readSettings();
        const enabled = Boolean(msg.enabled);
        const triggerPct = Number(msg.triggerPct);
        const keepRecent = Number(msg.keepRecent);
        const provider = msg.provider ?? void 0;
        const model = msg.model ? String(msg.model) : void 0;
        s.compression = {
          enabled,
          triggerPct: isNaN(triggerPct) ? 60 : Math.max(10, Math.min(90, triggerPct)),
          keepRecent: isNaN(keepRecent) ? 20 : Math.max(4, Math.min(80, keepRecent)),
          provider,
          model
        };
        this._writeSettings(s);
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }
      case "set_embedding": {
        const s = this._readSettings();
        const provider = this._isValidProvider(msg.provider) ? msg.provider : void 0;
        const model = msg.model ? String(msg.model) : void 0;
        const dimsNum = Number(msg.dims);
        const dims = isFinite(dimsNum) && dimsNum > 0 ? Math.floor(dimsNum) : void 0;
        s.embedding = { provider, model, dims };
        this._writeSettings(s);
        if (this._memoryIndex) {
          this._disposeMemoryIndex();
          this._initMemoryIndex();
        }
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }
      case "rebuild_embeddings": {
        try {
          this._memoryIndex?.clear();
          await this._dataSurface?.vectorRebuild();
          void vscode14.window.showInformationMessage(
            "Embedding index cleared. New content will be embedded with the selected model as the agent works."
          );
        } catch (err) {
          void vscode14.window.showWarningMessage(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this._sendSettingsToWebview();
        break;
      }
      case "set_memory_index": {
        const enabled = Boolean(msg.enabled);
        const s = this._readSettings();
        s.agentMemory = { ...s.agentMemory, enabled };
        this._writeSettings(s);
        if (enabled && !this._memoryIndex) {
          const choice = await vscode14.window.showInformationMessage(
            `Agent Memory Index will create a local vector database at .blacksite/memory-index.json to enable semantic search over past agent actions and conversation history. Embedding API calls will be made using your configured provider key.`,
            "Enable",
            "Cancel"
          );
          if (choice !== "Enable") {
            s.agentMemory = { ...s.agentMemory, enabled: false };
            this._writeSettings(s);
            await this._sendSettingsToWebview();
            break;
          }
          this._initMemoryIndex();
        } else if (!enabled) {
          this._disposeMemoryIndex();
        }
        this._session = null;
        await this._sendSettingsToWebview();
        break;
      }
      case "get_memory_stats": {
        const stats = this._memoryIndex?.stats ?? { toolCalls: 0, chunks: 0, memories: 0, total: 0 };
        this._post({ type: "memory_stats", stats });
        break;
      }
      case "open_file": {
        const filePath = String(msg.path ?? "").trim();
        if (!filePath) break;
        const resolved = resolveWorkspacePath2(filePath, this._workspaceRoots());
        if (!resolved || !fs12.existsSync(resolved)) {
          void vscode14.window.showWarningMessage(`Blacksite: ${filePath} is outside the workspace or no longer exists.`);
          break;
        }
        const uri = vscode14.Uri.file(resolved);
        const lineNum = msg.line ? Number(msg.line) : void 0;
        const showOpts = {};
        if (lineNum && lineNum > 0) {
          const position = new vscode14.Position(lineNum - 1, 0);
          showOpts.selection = new vscode14.Range(position, position);
        }
        await vscode14.window.showTextDocument(uri, showOpts);
        break;
      }
      case "open_settings": {
        await this._openSettings(typeof msg.query === "string" ? msg.query : void 0);
        break;
      }
      case "show_logs":
        this._logger.show();
        break;
      case "export_logs": {
        const logPath = this._logger.getLogPath();
        if (fs12.existsSync(logPath)) {
          await vscode14.window.showTextDocument(vscode14.Uri.file(logPath), { preview: false });
        } else {
          void vscode14.window.showInformationMessage("No execution logs yet \u2014 run a task first.");
        }
        break;
      }
      case "question_card_answer": {
        const toolCallId = String(msg.toolCallId ?? "");
        const selectedKey = String(msg.selectedKey ?? "");
        if (!toolCallId || !selectedKey) break;
        const resolve3 = this._pendingQuestionCards.get(toolCallId);
        if (resolve3) {
          this._pendingQuestionCards.delete(toolCallId);
          resolve3(selectedKey);
        }
        break;
      }
      case "approval_decision": {
        const toolCallId = String(msg.toolCallId ?? "");
        const decision = String(msg.decision ?? "");
        if (!toolCallId || decision !== "allow" && decision !== "allow_all" && decision !== "allow_always" && decision !== "deny") break;
        if (decision === "allow_always") {
          const command = String(msg.command ?? "").trim();
          const scope = msg.scope === "workspace" || msg.scope === "global" ? msg.scope : void 0;
          if (command) void this._persistAutoApprove(command, scope);
        }
        const resolve3 = this._pendingApprovals.get(toolCallId);
        if (resolve3) {
          this._pendingApprovals.delete(toolCallId);
          resolve3(decision);
        }
        break;
      }
      case "fetch_models": {
        const provider = msg.provider ?? this._readSettings().provider;
        await this._fetchAndSendModels(provider);
        break;
      }
      // ── API keys ──────────────────────────────────────────────────────────────
      case "set_api_key": {
        const provider = String(msg.provider ?? "");
        if (!provider) break;
        const key = await this._secrets.promptForApiKey(provider);
        if (key) {
          const keyStatus = await this._secrets.getProviderStatus();
          this._post({ type: "key_status_update", keyStatus });
          if (this._isValidProvider(provider)) {
            void this._fetchAndSendModels(provider, key);
          }
        }
        break;
      }
      case "clear_api_key": {
        const provider = String(msg.provider ?? "");
        if (!provider) break;
        await this._secrets.deleteApiKey(provider);
        this._modelCache.delete(provider);
        const keyStatus = await this._secrets.getProviderStatus();
        this._post({ type: "key_status_update", keyStatus });
        break;
      }
      // ── Bedrock API mode toggle ───────────────────────────────────────────────
      case "set_bedrock_api": {
        const api = msg.api;
        if (api !== "converse" && api !== "mantle") break;
        const s = this._readSettings();
        s.bedrockApi = api;
        const currentBedrock = this._providerSettings("bedrock", s);
        s.providerSettings["bedrock"] = { ...currentBedrock, model: defaultBedrockModel(api) };
        this._writeSettings(s);
        await this._syncVisibleSettingsToConfig(s);
        this._session = null;
        void this._fetchAndSendModels("bedrock");
        await this._sendSettingsToWebview();
        break;
      }
      // ── OpenRouter config ─────────────────────────────────────────────────────
      case "set_openrouter_config": {
        const s = this._readSettings();
        s.openrouterConfig = {
          ...s.openrouterConfig,
          httpReferer: msg.httpReferer != null ? String(msg.httpReferer).trim() || void 0 : s.openrouterConfig?.httpReferer,
          xTitle: msg.xTitle != null ? String(msg.xTitle).trim() || void 0 : s.openrouterConfig?.xTitle
        };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      // ── Subagent settings ─────────────────────────────────────────────────────
      case "set_subagent_provider": {
        const s = this._readSettings();
        const sp = msg.provider;
        const sm = msg.model != null ? String(msg.model).trim() || void 0 : void 0;
        s.subagent = { ...s.subagent, profiles: s.subagent?.profiles ?? [], provider: sp, model: sm };
        this._writeSettings(s);
        this._session = null;
        break;
      }
      case "set_subagent_max_concurrent": {
        const n = Number(msg.maxConcurrent);
        if (isNaN(n) || n < 1) break;
        const s = this._readSettings();
        s.subagent = { ...s.subagent, profiles: s.subagent?.profiles ?? [], maxConcurrent: Math.min(Math.max(1, n), 8) };
        this._writeSettings(s);
        break;
      }
      case "upsert_subagent_profile": {
        const profile = msg.profile;
        if (!profile?.id || !profile.name) break;
        if (profile.builtin) break;
        const s = this._readSettings();
        const existing = (s.subagent?.profiles ?? []).findIndex((p) => p.id === profile.id);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const updated = { ...profile, updatedAt: now, createdAt: profile.createdAt ?? now };
        if (existing >= 0) {
          const profiles = [...s.subagent?.profiles ?? []];
          profiles[existing] = updated;
          s.subagent = { ...s.subagent, profiles, provider: s.subagent?.provider, model: s.subagent?.model };
        } else {
          s.subagent = { ...s.subagent, profiles: [...s.subagent?.profiles ?? [], updated], provider: s.subagent?.provider, model: s.subagent?.model };
        }
        this._writeSettings(s);
        await this._sendSettingsToWebview();
        break;
      }
      case "delete_subagent_profile": {
        const profileId = String(msg.profileId ?? "").trim();
        if (!profileId) break;
        const s = this._readSettings();
        const profiles = mergeBuiltinSubagentProfiles(s.subagent?.profiles);
        const target = profiles.find((p) => p.id === profileId);
        if (!target || target.builtin) break;
        s.subagent = { ...s.subagent, profiles: (s.subagent?.profiles ?? []).filter((p) => p.id !== profileId), provider: s.subagent?.provider, model: s.subagent?.model };
        this._writeSettings(s);
        await this._sendSettingsToWebview();
        break;
      }
    }
  }
  // ── Agent send ────────────────────────────────────────────────────────────────
  async _handleSend(content, context, mentions = []) {
    const settings = this._readSettings();
    const apiKey = await this._secrets.getOrPromptApiKey(settings.provider);
    if (!apiKey) {
      this._post({ type: "stream_error", message: `No API key for ${settings.provider}. Set it in Settings.` });
      return;
    }
    if (!this._session) {
      try {
        this._session = await this._createSession(apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this._post({ type: "stream_error", message: `Failed to start session: ${message}` });
        return;
      }
      const _ps = this._providerSettings(settings.provider, settings);
      this._logger.sessionStart(this._session.sessionId, _ps.model, settings.provider);
      const restore = pickRestoreState(this._restoredSessionState, this._sessionStore.loadActive());
      if (restore) {
        this._restoreSessionFromState(
          this._session,
          restore.messages,
          restore,
          restore.sessionId
        );
        this._restoredSessionState = null;
        this._postSessionRuntimeState();
      }
    }
    let fullContent = content;
    const mentionBlock = this._readMentionFiles(mentions);
    if (mentionBlock) {
      fullContent = `${mentionBlock}

${fullContent}`;
    }
    if (context?.text) {
      fullContent = `Context (${context.label ?? "selection"}):
${context.text}

${fullContent}`;
    }
    await this._continueSend(fullContent, {
      inputChars: fullContent.length,
      promptPreview: content,
      mentionCount: mentions.length,
      contextLabel: context?.label
    });
  }
  // ── @-file mentions ─────────────────────────────────────────────────────────
  _readMentionFiles(mentions) {
    const seen = /* @__PURE__ */ new Set();
    const blocks = [];
    for (const rel2 of mentions) {
      if (!rel2 || seen.has(rel2)) continue;
      seen.add(rel2);
      const abs = path18.isAbsolute(rel2) ? rel2 : path18.join(this._workspaceRoot, rel2);
      try {
        const raw = fs12.readFileSync(abs, "utf8").slice(0, 3e4);
        const ext = path18.extname(abs).slice(1) || "text";
        blocks.push(`Referenced file \`${rel2}\`:
\`\`\`${ext}
${raw}
\`\`\``);
      } catch {
        blocks.push(`Referenced file \`${rel2}\`: (could not be read)`);
      }
    }
    return blocks.join("\n\n");
  }
  _fileIndex = null;
  async _searchWorkspaceFiles(query) {
    const FRESH_MS = 3e4;
    if (!this._fileIndex || Date.now() - this._fileIndex.at > FRESH_MS) {
      const uris = await vscode14.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.next,coverage}/**",
        4e3
      );
      const paths = uris.map((u) => path18.relative(this._workspaceRoot, u.fsPath).replace(/\\/g, "/")).filter((p) => p && !p.startsWith(".."));
      this._fileIndex = { paths, at: Date.now() };
    }
    const q = query.toLowerCase();
    const scored = this._fileIndex.paths.map((p) => ({ p, score: scoreMatch(p, q) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || a.p.length - b.p.length).slice(0, 20).map((e) => e.p);
    return scored;
  }
  async _continueSend(content, meta) {
    if (!this._session) return;
    const session = this._session;
    const turnId = `turn_${Date.now()}`;
    const summary = {
      stopReason: "",
      text: "",
      toolCalls: 0,
      approvalPending: false,
      questionPending: false,
      errored: false
    };
    this._post({ type: "stream_start", id: turnId });
    this._postSessionRuntimeState();
    this._logger.turnStart(turnId, meta);
    this._liveTurnId = turnId;
    let turnError;
    try {
      await this._runner.runWithProgress(
        session,
        content,
        (event) => {
          if (event.type === "text_delta") summary.text += event.text;
          else if (event.type === "tool_call_start") summary.toolCalls += 1;
          else if (event.type === "approval_pending") summary.approvalPending = true;
          else if (event.type === "question_card_pending") summary.questionPending = true;
          else if (event.type === "turn_complete") summary.stopReason = event.stopReason;
          else if (event.type === "error") summary.errored = true;
          this._handleAgentEvent(event, turnId);
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turnError = message;
      summary.errored = true;
      this._post({ type: "stream_error", id: turnId, message });
    }
    if (!turnError && !summary.stopReason) {
      turnError = "Agent exited without a terminal turn_complete event.";
      this._post({ type: "stream_error", id: turnId, message: turnError });
    } else if (!turnError && (summary.stopReason === "error" || summary.stopReason === "protocol_violation" || summary.stopReason === "cancelled")) {
      turnError = `Terminal stop: ${summary.stopReason}`;
    }
    this._logger.turnEnd(turnId, !turnError, turnError);
    this._persistSession(session);
    this._postSessionRuntimeState();
    this._liveTurnId = void 0;
  }
  _postStreamEvent(turnId, event, lane) {
    const laneMeta = lane ? { laneId: lane.laneId, parentToolCallId: lane.parentToolCallId } : {};
    switch (event.type) {
      case "text_delta":
        this._post({ type: "stream_delta", id: turnId, text: event.text, ...laneMeta });
        break;
      case "thinking_delta":
        this._post({ type: "stream_thinking", id: turnId, text: event.text, ...laneMeta });
        break;
      case "usage_update": {
        const s = this._readSettings();
        const modelId = this._providerSettings(s.provider, s).model;
        const ctxLen = this._session?.runtimeState.contextLength ?? this._cachedContextLength(s.provider, modelId);
        this._post({ type: "stream_usage", id: turnId, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens, contextLength: ctxLen, ...laneMeta });
        break;
      }
      case "runtime_state":
        if (!lane) this._postSessionRuntimeState(event.state);
        break;
      case "execution_diagnostic":
        this._post({ type: "stream_diagnostic", id: turnId, level: event.level, message: event.message, ...laneMeta });
        break;
      case "iteration_start":
        this._post({ type: "stream_iteration", id: turnId, iteration: event.iteration, ...laneMeta });
        break;
      case "tool_call_start":
        this._post({
          type: "stream_tool_call",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputPreview: event.inputPreview,
          input: event.input,
          ...laneMeta
        });
        break;
      case "tool_call_result":
        this._post({
          type: "stream_tool_result",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: event.ok,
          summary: event.summary,
          result: event.result,
          elapsedMs: event.elapsedMs,
          ...laneMeta
        });
        break;
      case "approval_pending":
        this._post({
          type: "stream_approval_pending",
          id: turnId,
          toolCallId: event.toolCallId,
          description: event.description,
          tier: event.tier,
          unrecognizedCommand: event.unrecognizedCommand,
          ...laneMeta
        });
        break;
      case "approval_result":
        this._post({
          type: "stream_approval_result",
          id: turnId,
          toolCallId: event.toolCallId,
          granted: event.granted,
          decision: event.decision,
          ...laneMeta
        });
        break;
      case "question_card_pending":
        this._post({
          type: "stream_question_card",
          id: turnId,
          toolCallId: event.toolCallId,
          question: event.question,
          options: event.options,
          context: event.context,
          ...laneMeta
        });
        break;
      case "question_card_result":
        this._post({
          type: "stream_tool_result",
          id: turnId,
          toolCallId: event.toolCallId,
          toolName: "question_card",
          ok: true,
          summary: `"${event.selectedKey}" selected`,
          result: { ok: true, selectedKey: event.selectedKey },
          elapsedMs: 0,
          ...laneMeta
        });
        break;
      case "turn_complete":
        this._post({ type: "stream_end", id: turnId, stopReason: event.stopReason, iterations: event.iterations, ...laneMeta });
        break;
      case "error":
        this._post({ type: "stream_error", id: turnId, message: event.message, ...laneMeta });
        break;
    }
  }
  _handleAgentEvent(event, turnId) {
    this._logger.logEvent(event);
    switch (event.type) {
      case "subagent_lane_start":
        this._post({
          type: "stream_subagent_lane_start",
          id: turnId,
          parentToolCallId: event.parentToolCallId,
          laneId: event.laneId,
          subRequestId: event.subRequestId,
          label: event.label,
          task: event.task
        });
        break;
      case "subagent_lane_event":
        this._postStreamEvent(turnId, event.event, {
          laneId: event.laneId,
          parentToolCallId: event.parentToolCallId
        });
        break;
      case "subagent_lane_complete":
        this._post({
          type: "stream_subagent_lane_end",
          id: turnId,
          parentToolCallId: event.parentToolCallId,
          laneId: event.laneId,
          subRequestId: event.subRequestId,
          label: event.label,
          ok: event.ok,
          answer: event.answer,
          error: event.error,
          elapsedMs: event.elapsedMs,
          stopReason: event.stopReason,
          toolRounds: event.toolRounds,
          budget: event.budget
        });
        break;
      default:
        this._postStreamEvent(turnId, event);
        break;
    }
  }
  // ── Settings helpers ──────────────────────────────────────────────────────────
  _readSettings() {
    const cfgProvider = this._readCfgProvider();
    const cfgBedrockApi = this._readCfgBedrockApi();
    const stored = this._context.globalState.get(SETTINGS_KEY);
    if (!stored) {
      const legacyProvider = this._context.globalState.get("blacksite.provider");
      const legacyModel = this._context.globalState.get("blacksite.model");
      const provider = legacyProvider ?? cfgProvider;
      const s = {
        provider,
        providerSettings: {},
        maxIterations: 40,
        disabledTools: [],
        bedrockApi: cfgBedrockApi
      };
      if (legacyModel?.trim()) {
        s.providerSettings[provider] = { ...this._defaultProviderSettings(provider, s), model: legacyModel.trim() };
      }
      return s;
    }
    return {
      provider: this._isValidProvider(stored.provider) ? stored.provider : cfgProvider,
      providerSettings: stored.providerSettings ?? {},
      maxIterations: typeof stored.maxIterations === "number" && isFinite(stored.maxIterations) ? stored.maxIterations : 40,
      disabledTools: Array.isArray(stored.disabledTools) ? stored.disabledTools : [],
      compression: stored.compression,
      agentMemory: stored.agentMemory,
      embedding: stored.embedding,
      openrouterConfig: stored.openrouterConfig,
      subagent: stored.subagent,
      bedrockApi: normalizeBedrockApi(stored.bedrockApi ?? cfgBedrockApi)
    };
  }
  _writeSettings(s) {
    void this._context.globalState.update(SETTINGS_KEY, s);
  }
  _defaultProviderSettings(provider, s) {
    if (provider !== "bedrock") return PROVIDER_DEFAULTS2[provider];
    return { ...PROVIDER_DEFAULTS2.bedrock, model: defaultBedrockModel(s.bedrockApi) };
  }
  _defaultModelsForProvider(provider, s) {
    if (provider !== "bedrock") return getFallbackModels(provider);
    return normalizeBedrockApi(s.bedrockApi) === "mantle" ? BEDROCK_MANTLE_MODELS : getFallbackModels("bedrock");
  }
  _providerSettings(provider, s) {
    const defaults = this._defaultProviderSettings(provider, s);
    const merged = { ...defaults, ...s.providerSettings[provider] };
    if (!merged.model.trim()) merged.model = defaults.model;
    return merged;
  }
  _lookupModelInfo(modelId, models) {
    return models?.find((model) => modelIdsMatch(model.id, modelId));
  }
  _cachedContextLength(provider, modelId) {
    const cached = this._lookupModelInfo(modelId, this._modelCache.get(provider));
    return cached?.contextLength ?? getContextLength(provider, modelId);
  }
  async _resolveContextLength(provider, modelId, apiKey) {
    const cached = this._cachedContextLength(provider, modelId);
    if (cached) return cached;
    if (!apiKey) return void 0;
    try {
      const models = await fetchModels(provider, apiKey);
      this._modelCache.set(provider, models);
      return this._lookupModelInfo(modelId, models)?.contextLength;
    } catch {
      return void 0;
    }
  }
  _readCfgProvider() {
    const cfg = vscode14.workspace.getConfiguration("blacksite");
    const cp = cfg.get("provider");
    if (cp === "anthropic" || cp === "openrouter" || cp === "openai" || cp === "bedrock") return cp;
    return "anthropic";
  }
  _readCfgBedrockApi() {
    const cfg = vscode14.workspace.getConfiguration("blacksite");
    return normalizeBedrockApi(cfg.get("bedrockApi"));
  }
  _isValidProvider(p) {
    return p === "anthropic" || p === "openrouter" || p === "openai" || p === "bedrock";
  }
  async _sendSettingsToWebview() {
    const settings = this._readSettings();
    const keyStatus = await this._secrets.getProviderStatus();
    const models = this._modelCache.get(settings.provider) ?? this._defaultModelsForProvider(settings.provider, settings);
    const memoryStats = this._memoryIndex?.stats ?? null;
    const logStats = this._logger.stats;
    this._post({
      type: "settings_data",
      settings,
      keyStatus,
      models,
      memoryStats,
      logStats
    });
  }
  async _fetchAndSendModels(provider, knownKey) {
    this._post({ type: "models_loading", provider });
    if (provider === "bedrock") {
      const s = this._readSettings();
      if (normalizeBedrockApi(s.bedrockApi) === "mantle") {
        this._modelCache.set("bedrock", BEDROCK_MANTLE_MODELS);
        this._post({ type: "models_data", provider: "bedrock", models: BEDROCK_MANTLE_MODELS, source: "fallback" });
        return;
      }
      await this._fetchAndSendBedrockModels();
      return;
    }
    try {
      const apiKey = knownKey ?? await this._secrets.getApiKey(provider);
      if (!apiKey) {
        this._post({ type: "models_data", provider, models: getFallbackModels(provider), source: "fallback", error: "No API key" });
        return;
      }
      const models = await fetchModels(provider, apiKey);
      this._modelCache.set(provider, models);
      this._post({ type: "models_data", provider, models, source: "api" });
    } catch (err) {
      const fallback = getFallbackModels(provider);
      this._post({ type: "models_data", provider, models: fallback, source: "fallback", error: err instanceof Error ? err.message : String(err) });
    }
  }
  /** Live Bedrock model listing (foundation models + inference profiles), with a hardcoded fallback. */
  async _fetchAndSendBedrockModels() {
    const config = await this._secrets.getBedrockConfig();
    if (!config) {
      this._post({ type: "models_data", provider: "bedrock", models: getFallbackModels("bedrock"), source: "fallback", error: "No AWS credentials" });
      return;
    }
    const result = await listAvailableBedrockModels(config);
    if (!result.ok) {
      this._post({ type: "models_data", provider: "bedrock", models: getFallbackModels("bedrock"), source: "fallback", error: result.error });
      return;
    }
    const models = bedrockModelsToModelInfo(result.data.models);
    this._modelCache.set("bedrock", models);
    this._post({ type: "models_data", provider: "bedrock", models, source: "api" });
  }
  // ── Session restore ────────────────────────────────────────────────────────────
  _restoreSessionToWebview() {
    const stored = this._sessionStore.loadActive();
    if (!stored?.messages.length) return;
    const userAssistantOnly = stored.messages.filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    this._post({ type: "history_restored", messages: userAssistantOnly });
    if (this._session) {
      this._postSessionRuntimeState();
    } else if (stored.state?.contextLength || stored.state?.compressionCount || stored.state?.lastInputTokens) {
      this._post({
        type: "session_runtime",
        runtime: this._buildRuntimeFromStoredSession(stored.sessionId, stored.messages, stored.state)
      });
    }
    if (!this._session) {
      this._restoredSessionState = { sessionId: stored.sessionId, messages: stored.messages, ...stored.state ?? {} };
    }
  }
  // ── Question card ─────────────────────────────────────────────────────────────
  _createQuestionCardPromise(toolCallId, _question, _options, _context, signal = this._runner.signal) {
    return new Promise((resolve3, reject) => {
      const onAbort = () => {
        this._pendingQuestionCards.delete(toolCallId);
        reject(new Error("Cancelled."));
      };
      this._pendingQuestionCards.set(toolCallId, (key) => {
        signal?.removeEventListener("abort", onAbort);
        resolve3(key);
      });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  // ── Util ──────────────────────────────────────────────────────────────────────
  /**
   * Ask the user to apply a file edit through the chat webview (reusing the tool-approval
   * UI) instead of a native modal. The editor diff is already open. Maps the webview's
   * allow / allow_all / deny back to the applier's apply / all / reject.
   */
  async _requestEditApproval(req) {
    const turnId = this._liveTurnId;
    if (!turnId) return null;
    const approvalId = `edit_approval_${++this._editApprovalSeq}`;
    const description = `Apply changes to ${req.fileCount} file(s)

${req.summary}`;
    this._post({ type: "stream_approval_pending", id: turnId, toolCallId: approvalId, description, tier: "write" });
    let decision;
    try {
      decision = await this._createApprovalPromise(approvalId, "file_edit", description, "write");
    } catch {
      return "reject";
    }
    const granted = decision !== "deny";
    this._post({ type: "stream_approval_result", id: turnId, toolCallId: approvalId, granted, decision });
    return !granted ? "reject" : decision === "allow_all" ? "all" : "apply";
  }
  _createApprovalPromise(toolCallId, _toolName, _description, _tier, signal = this._runner.signal) {
    return new Promise((resolve3, reject) => {
      const onAbort = () => {
        this._pendingApprovals.delete(toolCallId);
        reject(new Error("Cancelled."));
      };
      this._pendingApprovals.set(toolCallId, (decision) => {
        signal?.removeEventListener("abort", onAbort);
        resolve3(decision);
      });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  _post(msg) {
    void this._view?.webview.postMessage(msg);
  }
  _workspaceRoots() {
    return vscode14.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [this._workspaceRoot];
  }
  /** Auto-detected fallback scope, used when a caller doesn't offer the user an explicit choice. */
  _settingsConfigTarget() {
    return vscode14.workspace.workspaceFolders?.length ? vscode14.ConfigurationTarget.Workspace : vscode14.ConfigurationTarget.Global;
  }
  /**
   * Persist a command binary to blacksite.permissions.autoApprove so its network/destructive
   * (or unrecognized-command) operations stop prompting. `scope` lets the user choose "this
   * project" vs. "all projects" explicitly; when omitted, falls back to the previous
   * auto-detect behavior (workspace scope when a folder is open, else global) so any other
   * caller that doesn't offer the choice keeps working unchanged. "workspace" is meaningless
   * with no folder open, so it degrades to global in that case too. The runtime picks up the
   * change via the onDidChangeConfiguration watcher in extension.ts.
   */
  async _persistAutoApprove(command, scope) {
    const binary = command.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase() ?? "";
    if (!binary) return;
    const target = scope === "global" ? vscode14.ConfigurationTarget.Global : scope === "workspace" && vscode14.workspace.workspaceFolders?.length ? vscode14.ConfigurationTarget.Workspace : this._settingsConfigTarget();
    const cfg = vscode14.workspace.getConfiguration("blacksite.permissions");
    const current = cfg.get("autoApprove", []);
    if (current.some((c) => c.trim().toLowerCase() === binary)) return;
    try {
      await cfg.update("autoApprove", [...current, binary], target);
    } catch (err) {
      void vscode14.window.showWarningMessage(`Blacksite: could not save the always-allow rule for "${binary}". ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async _syncVisibleSettingsToConfig(settings) {
    const cfg = vscode14.workspace.getConfiguration("blacksite");
    const activeModel = this._providerSettings(settings.provider, settings).model;
    const target = this._settingsConfigTarget();
    await Promise.all([
      cfg.update("provider", settings.provider, target),
      cfg.update("model", activeModel, target),
      cfg.update("bedrockApi", normalizeBedrockApi(settings.bedrockApi), target)
    ]);
  }
  async _openSettings(query) {
    const search = query?.trim() || "@ext:blacksite";
    await vscode14.commands.executeCommand("workbench.action.openSettings", search);
  }
  _loadHtml(webview) {
    return renderWebviewHtml(webview, this._context.extensionUri, "webview.js");
  }
};
function scoreMatch(relPath, query) {
  if (!query) return 1;
  const lower = relPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === query) return 100;
  if (base.startsWith(query)) return 80;
  if (base.includes(query)) return 60;
  if (lower.includes(query)) return 40;
  let qi = 0;
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] === query[qi]) qi++;
  }
  return qi === query.length ? 20 : 0;
}

// src/secret-store.ts
var vscode15 = __toESM(require("vscode"));
var PREFIX = "blacksite.apiKey.";
var PLACEHOLDERS = {
  anthropic: "sk-ant-api03-\u2026",
  openrouter: "sk-or-\u2026",
  openai: "sk-\u2026",
  bedrock: "AWS access key / secret (collected step by step)",
  github: "ghp_\u2026 or github_pat_\u2026",
  gitlab: "glpat-\u2026",
  jira: "user@example.com:ATATT3x\u2026 (email:token)",
  confluence: "user@example.com:ATATT3x\u2026 (email:token)",
  salesforce: "your-access-token"
};
var SecretStore = class {
  constructor(secrets) {
    this.secrets = secrets;
  }
  async getApiKey(provider) {
    return this.secrets.get(PREFIX + provider);
  }
  async setApiKey(provider, key) {
    await this.secrets.store(PREFIX + provider, key);
  }
  async deleteApiKey(provider) {
    await this.secrets.delete(PREFIX + provider);
  }
  async hasApiKey(provider) {
    if (provider === "bedrock") return !!await this.getBedrockConfig();
    const v = await this.getApiKey(provider);
    return !!v;
  }
  /** Prompt for and store a key; returns the key or undefined if cancelled. */
  async getOrPromptApiKey(provider) {
    if (provider === "bedrock") {
      const existing2 = await this.getBedrockConfig();
      if (existing2) return this.getApiKey("bedrock");
      return this.promptForApiKey(provider);
    }
    const existing = await this.getApiKey(provider);
    if (existing) return existing;
    return this.promptForApiKey(provider);
  }
  async promptForApiKey(provider) {
    if (provider === "bedrock") {
      const config = await this.promptForBedrockCredentials();
      return config ? this.getApiKey("bedrock") : void 0;
    }
    const key = await vscode15.window.showInputBox({
      title: `Blacksite \u2014 ${provider} API key`,
      prompt: `Enter your ${provider} key. Stored in VS Code SecretStorage, never leaves your machine.`,
      password: true,
      placeHolder: PLACEHOLDERS[provider] ?? "your-api-key",
      ignoreFocusOut: true
    });
    if (key?.trim()) {
      await this.setApiKey(provider, key.trim());
      return key.trim();
    }
    return void 0;
  }
  // ── Bedrock credentials (region + AWS keys, stored as one JSON blob) ──────────
  /** Parse the stored Bedrock credentials blob, or undefined if unset/invalid. */
  async getBedrockConfig() {
    const raw = await this.getApiKey("bedrock");
    if (!raw) return void 0;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.region || !parsed.accessKeyId || !parsed.secretAccessKey) return void 0;
      return {
        region: parsed.region,
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
        sessionToken: parsed.sessionToken || void 0
      };
    } catch {
      return void 0;
    }
  }
  async setBedrockConfig(config) {
    await this.setApiKey("bedrock", JSON.stringify(config));
  }
  /** Collect AWS region + credentials through a sequence of input boxes. */
  async promptForBedrockCredentials() {
    const existing = await this.getBedrockConfig();
    const region = await vscode15.window.showInputBox({
      title: "Blacksite \u2014 AWS Bedrock (1/4): Region",
      prompt: "AWS region for Bedrock (e.g. us-east-1).",
      value: existing?.region ?? "us-east-1",
      ignoreFocusOut: true
    });
    if (!region?.trim()) return void 0;
    const accessKeyId = await vscode15.window.showInputBox({
      title: "Blacksite \u2014 AWS Bedrock (2/4): Access Key ID",
      prompt: "AWS access key id (AKIA\u2026). Stored in VS Code SecretStorage.",
      value: existing?.accessKeyId ?? "",
      placeHolder: "AKIA\u2026",
      ignoreFocusOut: true
    });
    if (!accessKeyId?.trim()) return void 0;
    const secretAccessKey = await vscode15.window.showInputBox({
      title: "Blacksite \u2014 AWS Bedrock (3/4): Secret Access Key",
      prompt: "AWS secret access key. Stored in VS Code SecretStorage, never leaves your machine.",
      password: true,
      ignoreFocusOut: true
    });
    if (!secretAccessKey?.trim()) return void 0;
    const sessionToken = await vscode15.window.showInputBox({
      title: "Blacksite \u2014 AWS Bedrock (4/4): Session Token (optional)",
      prompt: "AWS session token for temporary credentials. Leave blank for long-lived keys.",
      password: true,
      value: existing?.sessionToken ?? "",
      ignoreFocusOut: true
    });
    const config = {
      region: region.trim(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      sessionToken: sessionToken?.trim() || void 0
    };
    await this.setBedrockConfig(config);
    return config;
  }
  /** Return masked status for all known providers — used by the settings panel. */
  async getProviderStatus() {
    const providers = ["anthropic", "openrouter", "openai", "bedrock", "github", "gitlab", "jira", "confluence", "salesforce"];
    const result = {};
    for (const p of providers) {
      result[p] = await this.hasApiKey(p);
    }
    return result;
  }
};

// src/session-store.ts
var ACTIVE_KEY = "blacksite.session.active";
var HISTORY_KEY = "blacksite.session.history";
var FULL_HISTORY_KEY = "blacksite.session.full_history";
var MAX_STORED_MSGS = 100;
var MAX_SESSIONS = 25;
var HISTORY_MSG_TRIM = 100;
var MAX_FULL_SESSIONS = 10;
var SessionStore = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  // ── Active session ─────────────────────────────────────────────────────────
  loadActive() {
    return this.ctx.workspaceState.get(ACTIVE_KEY);
  }
  saveActive(session) {
    const trimmed = { ...session, messages: session.messages.slice(-MAX_STORED_MSGS) };
    void this.ctx.workspaceState.update(ACTIVE_KEY, trimmed);
  }
  clearActive() {
    void this.ctx.workspaceState.update(ACTIVE_KEY, void 0);
  }
  newSessionId() {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  // ── History ────────────────────────────────────────────────────────────────
  /** Archive the current active session into history before starting a new one. */
  archiveActive() {
    const active = this.loadActive();
    if (!active || active.messages.length === 0) return;
    const history = this._loadHistory();
    const filtered = history.filter((s) => s.sessionId !== active.sessionId);
    const archived = {
      ...active,
      messages: active.messages.slice(-HISTORY_MSG_TRIM)
    };
    filtered.unshift(archived);
    this._saveHistory(filtered.slice(0, MAX_SESSIONS));
  }
  loadHistory() {
    return this._loadHistory().map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      model: s.model,
      firstMessage: this._extractFirstMessage(s),
      messageCount: s.messages.length
    }));
  }
  loadSessionFromHistory(sessionId) {
    return this._loadHistory().find((s) => s.sessionId === sessionId);
  }
  deleteSessionFromHistory(sessionId) {
    const history = this._loadHistory().filter((s) => s.sessionId !== sessionId);
    this._saveHistory(history);
  }
  // ── Full history (untruncated, for transcript_read tool) ───────────────────
  saveFullHistory(sessionId, messages) {
    const all = this._loadFullHistories();
    const filtered = all.filter((e) => e.sessionId !== sessionId);
    filtered.unshift({ sessionId, messages });
    void this.ctx.workspaceState.update(FULL_HISTORY_KEY, filtered.slice(0, MAX_FULL_SESSIONS));
  }
  loadFullHistory(sessionId) {
    return this._loadFullHistories().find((e) => e.sessionId === sessionId)?.messages;
  }
  _loadFullHistories() {
    return this.ctx.workspaceState.get(FULL_HISTORY_KEY, []);
  }
  _loadHistory() {
    return this.ctx.workspaceState.get(HISTORY_KEY, []);
  }
  _saveHistory(sessions) {
    void this.ctx.workspaceState.update(HISTORY_KEY, sessions);
  }
  _extractFirstMessage(session) {
    const first = session.messages.find((m) => m.role === "user");
    if (!first) return "(empty session)";
    const text = typeof first.content === "string" ? first.content : Array.isArray(first.content) ? first.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
    return text.slice(0, 80) + (text.length > 80 ? "\u2026" : "");
  }
};

// src/memory-store.ts
var fs13 = __toESM(require("fs"));
var path19 = __toESM(require("path"));
var DIR = ".blacksite";
var CONTEXT_FILE2 = "context.md";
var MEMORY_FILE2 = "memory.md";
var UI_PREFERENCES_FILE2 = "ui-preferences.json";
var SESSIONS_DIR = "sessions";
function ensureDir3(p) {
  if (!fs13.existsSync(p)) fs13.mkdirSync(p, { recursive: true });
}
function defaultUiPreferencesDocument() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    preferences: []
  };
}
var MemoryStore = class {
  dir;
  constructor(workspaceRoot) {
    this.dir = path19.join(workspaceRoot, DIR);
  }
  ensureInitialized() {
    ensureDir3(this.dir);
    ensureDir3(path19.join(this.dir, SESSIONS_DIR));
    const contextPath = this.contextPath();
    if (!fs13.existsSync(contextPath)) {
      fs13.writeFileSync(
        contextPath,
        `# Project Context

Add persistent notes about this project here.
Blacksite reads this file at the start of each conversation.
`,
        "utf8"
      );
    }
    const memPath = this.memoryPath();
    if (!fs13.existsSync(memPath)) {
      fs13.writeFileSync(memPath, `# Project Memory

`, "utf8");
    }
    const uiPreferencesPath = this.uiPreferencesPath();
    if (!fs13.existsSync(uiPreferencesPath)) {
      fs13.writeFileSync(
        uiPreferencesPath,
        `${JSON.stringify(defaultUiPreferencesDocument(), null, 2)}
`,
        "utf8"
      );
    }
  }
  contextPath() {
    return path19.join(this.dir, CONTEXT_FILE2);
  }
  memoryPath() {
    return path19.join(this.dir, MEMORY_FILE2);
  }
  uiPreferencesPath() {
    return path19.join(this.dir, UI_PREFERENCES_FILE2);
  }
  readContext() {
    try {
      return fs13.readFileSync(this.contextPath(), "utf8");
    } catch {
      return "";
    }
  }
  readMemory() {
    try {
      return fs13.readFileSync(this.memoryPath(), "utf8");
    } catch {
      return "";
    }
  }
  readUiPreferences() {
    try {
      const raw = fs13.readFileSync(this.uiPreferencesPath(), "utf8");
      const parsed = JSON.parse(raw);
      return {
        schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        preferences: Array.isArray(parsed.preferences) ? parsed.preferences : []
      };
    } catch {
      return defaultUiPreferencesDocument();
    }
  }
  writeUiPreferences(document) {
    const normalized = {
      schemaVersion: typeof document.schemaVersion === "number" ? document.schemaVersion : 1,
      updatedAt: document.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      preferences: Array.isArray(document.preferences) ? document.preferences : []
    };
    try {
      fs13.writeFileSync(this.uiPreferencesPath(), `${JSON.stringify(normalized, null, 2)}
`, "utf8");
    } catch {
    }
  }
  upsertUiPreference(entry) {
    const current = this.readUiPreferences();
    const key = `${entry.elementKey ?? ""}::${entry.componentName ?? ""}::${entry.elementType ?? ""}`;
    const nextEntry = {
      ...entry,
      lastConfirmedAt: entry.lastConfirmedAt ?? (/* @__PURE__ */ new Date()).toISOString()
    };
    const existingIndex = current.preferences.findIndex((item) => {
      const itemKey = `${item.elementKey ?? ""}::${item.componentName ?? ""}::${item.elementType ?? ""}`;
      return itemKey === key && itemKey !== "::::";
    });
    if (existingIndex >= 0) current.preferences.splice(existingIndex, 1, nextEntry);
    else current.preferences.unshift(nextEntry);
    this.writeUiPreferences({
      schemaVersion: current.schemaVersion || 1,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      preferences: current.preferences
    });
  }
  appendMemory(entry) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16);
    const text = `
## ${timestamp}

${entry.trim()}
`;
    try {
      fs13.appendFileSync(this.memoryPath(), text, "utf8");
    } catch {
    }
  }
  saveSession(sessionId, messages) {
    try {
      ensureDir3(path19.join(this.dir, SESSIONS_DIR));
      const file = path19.join(this.dir, SESSIONS_DIR, `${sessionId}.json`);
      fs13.writeFileSync(file, JSON.stringify({ sessionId, messages, savedAt: Date.now() }, null, 2), "utf8");
    } catch {
    }
  }
  listSessions() {
    try {
      const dir = path19.join(this.dir, SESSIONS_DIR);
      return fs13.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
    } catch {
      return [];
    }
  }
};

// src/code-actions.ts
var vscode16 = __toESM(require("vscode"));
var BlacksiteCodeActionProvider = class {
  static providedCodeActionKinds = [
    vscode16.CodeActionKind.QuickFix,
    vscode16.CodeActionKind.RefactorRewrite
  ];
  provideCodeActions(document, range, context) {
    const actions = [];
    for (const diag of context.diagnostics) {
      if (diag.severity === vscode16.DiagnosticSeverity.Error || diag.severity === vscode16.DiagnosticSeverity.Warning) {
        const label = diag.message.length > 60 ? diag.message.slice(0, 57) + "\u2026" : diag.message;
        const fix = new vscode16.CodeAction(`Blacksite: Fix "${label}"`, vscode16.CodeActionKind.QuickFix);
        fix.command = {
          command: "blacksite.fixDiagnostic",
          title: "Fix with Blacksite",
          arguments: [document.uri, diag]
        };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
    }
    if (!(range instanceof vscode16.Range ? range : range).isEmpty) {
      const explain = new vscode16.CodeAction("Blacksite: Explain selection", vscode16.CodeActionKind.RefactorRewrite);
      explain.command = { command: "blacksite.explainSelection", title: "Explain selection" };
      actions.push(explain);
    }
    return actions;
  }
};

// src/diagnostics-publisher.ts
var vscode17 = __toESM(require("vscode"));
var path20 = __toESM(require("path"));
var SEVERITY_MAP = {
  error: vscode17.DiagnosticSeverity.Error,
  warning: vscode17.DiagnosticSeverity.Warning,
  info: vscode17.DiagnosticSeverity.Information,
  hint: vscode17.DiagnosticSeverity.Hint
};
var DiagnosticsPublisher = class {
  constructor(_workspaceRoot) {
    this._workspaceRoot = _workspaceRoot;
    this._collection = vscode17.languages.createDiagnosticCollection("blacksite");
  }
  _collection;
  /** Replace all Blacksite-reported problems with the supplied set (or clear them). */
  report(problems, clear) {
    try {
      this._collection.clear();
      if (clear || problems.length === 0) return { ok: true, count: 0, files: 0 };
      const byFile = /* @__PURE__ */ new Map();
      for (const p of problems) {
        if (!p || typeof p.path !== "string" || !p.path || typeof p.message !== "string") continue;
        const abs = path20.isAbsolute(p.path) ? p.path : path20.join(this._workspaceRoot, p.path);
        const list = byFile.get(abs) ?? [];
        list.push(this._toDiagnostic(p));
        byFile.set(abs, list);
      }
      let count = 0;
      for (const [file, diags] of byFile) {
        this._collection.set(vscode17.Uri.file(file), diags);
        count += diags.length;
      }
      return { ok: true, count, files: byFile.size };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  _toDiagnostic(p) {
    const startLine = Math.max(0, (p.line || 1) - 1);
    const startCol = Math.max(0, (p.column ?? 1) - 1);
    const endLine = Math.max(startLine, (p.endLine ?? p.line ?? 1) - 1);
    const endCol = p.endColumn != null ? Math.max(0, p.endColumn - 1) : Number.MAX_SAFE_INTEGER;
    const range = new vscode17.Range(startLine, startCol, endLine, endCol);
    const diag = new vscode17.Diagnostic(range, p.message, SEVERITY_MAP[p.severity ?? "warning"] ?? vscode17.DiagnosticSeverity.Warning);
    diag.source = p.source ? `Blacksite \xB7 ${p.source}` : "Blacksite";
    return diag;
  }
  clear() {
    this._collection.clear();
  }
  dispose() {
    this._collection.dispose();
  }
};

// src/base-context-provider.ts
var fs14 = __toESM(require("fs"));
var path21 = __toESM(require("path"));
var vscode18 = __toESM(require("vscode"));
var BaseContextProvider = class {
  constructor(_context, _workspaceRoot, _store) {
    this._context = _context;
    this._workspaceRoot = _workspaceRoot;
    this._store = _store;
    this._subscription = this._store.onDidChange(() => this._postState());
  }
  _view;
  _subscription;
  dispose() {
    this._subscription.dispose();
  }
  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode18.Uri.joinPath(this._context.extensionUri, "out")]
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "base-context.js");
    webviewView.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._context.subscriptions
    );
    this._postState();
  }
  async promptAndAddFile(uri) {
    const target = uri ?? vscode18.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file") {
      vscode18.window.showWarningMessage("Blacksite: No workspace file is available to add to Base Context.");
      return;
    }
    const relative8 = path21.relative(this._workspaceRoot, target.fsPath).replace(/\\/g, "/");
    if (!relative8 || relative8.startsWith("..")) {
      vscode18.window.showWarningMessage("Blacksite: Only files inside the current workspace can be added to Base Context.");
      return;
    }
    const document = this._store.read();
    const picks = document.topics.map((topic) => ({
      label: topic.title,
      description: topic.enabled ? "Included" : "Excluded",
      id: topic.id
    }));
    picks.unshift({ label: "+ New topic", description: "Create a new Base Context topic", id: "__new__" });
    const pick = await vscode18.window.showQuickPick(picks, {
      title: "Add File To Base Context",
      placeHolder: `Choose a topic for ${relative8}`
    });
    if (!pick) return;
    let topicId = pick.id;
    if (topicId === "__new__") {
      const title = await vscode18.window.showInputBox({
        title: "New Base Context Topic",
        prompt: "Enter a topic title",
        value: path21.basename(target.fsPath)
      });
      if (!title) return;
      topicId = this._store.createTopic(title).id;
    }
    try {
      this._store.addFile(topicId, target.fsPath);
      vscode18.window.showInformationMessage(`Blacksite: Added ${relative8} to Base Context.`);
      this._postState();
    } catch (err) {
      vscode18.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  async _onMessage(msg) {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "create_topic":
        this._store.createTopic(typeof msg.title === "string" ? msg.title : "New topic");
        break;
      case "update_topic":
        this._store.updateTopic(String(msg.topicId ?? ""), {
          title: typeof msg.title === "string" ? msg.title : void 0,
          notes: typeof msg.notes === "string" ? msg.notes : void 0,
          enabled: typeof msg.enabled === "boolean" ? msg.enabled : void 0,
          pinned: typeof msg.pinned === "boolean" ? msg.pinned : void 0
        });
        break;
      case "delete_topic":
        this._store.deleteTopic(String(msg.topicId ?? ""));
        break;
      case "add_active_file":
        await this.promptAndAddFile(vscode18.window.activeTextEditor?.document.uri);
        break;
      case "add_file_to_topic": {
        const target = vscode18.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== "file") {
          vscode18.window.showWarningMessage("Blacksite: Open a workspace file first.");
          break;
        }
        try {
          this._store.addFile(String(msg.topicId ?? ""), target.fsPath);
          this._postState();
        } catch (err) {
          vscode18.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case "remove_file":
        this._store.removeFile(String(msg.topicId ?? ""), String(msg.fileId ?? ""));
        break;
      case "open_file":
        await this._openFile(String(msg.path ?? ""));
        break;
    }
  }
  async _openFile(relativePath) {
    if (!relativePath) return;
    const absolute = path21.join(this._workspaceRoot, relativePath);
    if (!fs14.existsSync(absolute)) {
      vscode18.window.showWarningMessage(`Blacksite: ${relativePath} no longer exists in this workspace.`);
      return;
    }
    const document = await vscode18.workspace.openTextDocument(absolute);
    await vscode18.window.showTextDocument(document, { preview: false });
  }
  _postState() {
    if (!this._view) return;
    void this._view.webview.postMessage({
      type: "base_context_state",
      document: this._store.read(),
      activeFile: this._activeEditorRelativePath()
    });
  }
  _activeEditorRelativePath() {
    const uri = vscode18.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file") return null;
    const relative8 = path21.relative(this._workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    return relative8 && !relative8.startsWith("..") ? relative8 : null;
  }
};

// src/planning-provider.ts
var vscode19 = __toESM(require("vscode"));
var PlanningProvider = class {
  constructor(_context, _store) {
    this._context = _context;
    this._store = _store;
    this._subscription = this._store.onDidChange(() => this._postState());
  }
  _view;
  _subscription;
  dispose() {
    this._subscription.dispose();
  }
  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode19.Uri.joinPath(this._context.extensionUri, "out")]
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "planning.js");
    webviewView.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._context.subscriptions
    );
    this._postState();
  }
  _onMessage(msg) {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
      case "refresh":
        this._postState();
        break;
      case "clear_completed":
        this._store.clearCompleted();
        break;
      case "archive_plan":
        this._store.archivePlan(String(msg.planId ?? ""));
        break;
      case "set_plan_status": {
        const planId = String(msg.planId ?? "");
        const status = normalizePlanStatus(msg.status);
        if (planId && status) this._store.setPlanStatus(planId, status);
        break;
      }
      case "archive_todo":
        this._store.archiveTodoRun(String(msg.todoId ?? ""));
        break;
    }
  }
  _postState() {
    if (!this._view) return;
    const document = this._store.read();
    const activePlans = document.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled").length;
    const activeTodos = document.todoRuns.filter((run) => !run.completedAt).length;
    void this._view.webview.postMessage({
      type: "planning_state",
      document,
      counts: {
        activePlans,
        activeTodos,
        totalPlans: document.plans.length,
        totalTodos: document.todoRuns.length
      }
    });
  }
};

// src/data-provider.ts
var fs17 = __toESM(require("fs"));
var vscode20 = __toESM(require("vscode"));

// src/data/sql-driver.ts
var import_node_module = require("node:module");
var path22 = __toESM(require("node:path"));
var nodeRequire = typeof require === "function" ? require : (0, import_node_module.createRequire)(path22.join(process.cwd(), "index.js"));
var SqlDriverUnavailableError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SqlDriverUnavailableError";
  }
};
function toRunResult(raw) {
  return {
    changes: Number(raw.changes ?? 0),
    lastInsertRowid: Number(raw.lastInsertRowid ?? 0)
  };
}
function bindArgs(params) {
  if (params === void 0) return [];
  if (Array.isArray(params)) return params;
  return [params];
}
var NodeSqliteDriver = class {
  constructor(db) {
    this.db = db;
  }
  engine = "node:sqlite";
  exec(sql) {
    this.db.exec(sql);
  }
  run(sql, params) {
    return toRunResult(this.db.prepare(sql).run(...bindArgs(params)));
  }
  all(sql, params) {
    return this.db.prepare(sql).all(...bindArgs(params));
  }
  get(sql, params) {
    return this.db.prepare(sql).get(...bindArgs(params));
  }
  pragma(name) {
    const row = this.db.prepare(`PRAGMA ${name}`).get();
    if (!row) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }
  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  close() {
    this.db.close();
  }
};
var BetterSqliteDriver = class {
  constructor(db) {
    this.db = db;
  }
  engine = "better-sqlite3";
  exec(sql) {
    this.db.exec(sql);
  }
  run(sql, params) {
    return toRunResult(this.db.prepare(sql).run(...bindArgs(params)));
  }
  all(sql, params) {
    return this.db.prepare(sql).all(...bindArgs(params));
  }
  get(sql, params) {
    return this.db.prepare(sql).get(...bindArgs(params));
  }
  pragma(name) {
    const value = this.db.pragma(name, { simple: true });
    return typeof value === "number" ? value : Number(value ?? 0);
  }
  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  close() {
    this.db.close();
  }
};
function tryNodeSqlite(filePath) {
  try {
    const mod = nodeRequire("node:sqlite");
    if (!mod?.DatabaseSync) return null;
    return new NodeSqliteDriver(new mod.DatabaseSync(filePath));
  } catch {
    return null;
  }
}
function tryBetterSqlite(filePath) {
  try {
    const Database = nodeRequire("better-sqlite3");
    return new BetterSqliteDriver(new Database(filePath));
  } catch {
    return null;
  }
}
function openSqlDriver(filePath, preference = "auto") {
  const order = preference === "node:sqlite" ? [() => tryNodeSqlite(filePath)] : preference === "better-sqlite3" ? [() => tryBetterSqlite(filePath)] : [() => tryNodeSqlite(filePath), () => tryBetterSqlite(filePath)];
  for (const attempt of order) {
    const driver = attempt();
    if (driver) return driver;
  }
  throw new SqlDriverUnavailableError(
    "No SQLite binding available. Expected Node >= 22.5 (node:sqlite) or an installed better-sqlite3."
  );
}

// src/data/migration-runner.ts
function normalizeMigrations(migrations) {
  const seen = /* @__PURE__ */ new Set();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Migration "${migration.name}" has an invalid version: ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return [...migrations].sort((a, b) => a.version - b.version);
}
function getSchemaVersion(driver) {
  return driver.pragma("user_version");
}
function runMigrations(driver, migrations) {
  const ordered = normalizeMigrations(migrations);
  const fromVersion = getSchemaVersion(driver);
  const applied = [];
  let currentVersion = fromVersion;
  for (const migration of ordered) {
    if (migration.version <= currentVersion) continue;
    driver.transaction(() => {
      driver.exec(migration.sql);
      driver.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push({ version: migration.version, name: migration.name });
    currentVersion = migration.version;
  }
  return { fromVersion, toVersion: currentVersion, applied };
}

// src/data/schema/v1.ts
var V1_SCHEMA = `-- Blacksite Data Workbench \u2014 schema v1
-- Canonical embedded relational store (SQLite). Applied by the migration runner as
-- migration version 1. The identical DDL is embedded in \`schema/v1.ts\` for runtime
-- bundling; \`tests/unit/vscode-db-migrations.spec.ts\` guards the two against drift.

-- \u2500\u2500 Meta \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- \u2500\u2500 Source registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_sources (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,           -- file | memory | base_context | session | plan | import
  uri        TEXT,                    -- workspace-relative path or logical locator
  title      TEXT,
  metadata   TEXT,                    -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON core_sources(kind);

-- \u2500\u2500 Documents \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_documents (
  id         TEXT PRIMARY KEY,
  source_id  TEXT REFERENCES core_sources(id) ON DELETE CASCADE,
  title      TEXT,
  body       TEXT,
  mime       TEXT,
  byte_size  INTEGER NOT NULL DEFAULT 0,
  hash       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON core_documents(source_id);

-- \u2500\u2500 Chunks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES core_documents(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT,                   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON core_chunks(document_id);

-- \u2500\u2500 Embeddings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_embeddings (
  id         TEXT PRIMARY KEY,
  chunk_id   TEXT REFERENCES core_chunks(id) ON DELETE CASCADE,
  collection TEXT NOT NULL DEFAULT 'default',
  model      TEXT,
  dims       INTEGER NOT NULL DEFAULT 0,
  vector     TEXT NOT NULL,           -- JSON array of floats (L2-normalised)
  norm       REAL NOT NULL DEFAULT 1,
  payload    TEXT,                    -- JSON metadata used for filtering/preview
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON core_embeddings(collection);
CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON core_embeddings(chunk_id);

-- \u2500\u2500 Notes / memory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'note',  -- note | memory | base_context | ui_preference
  title      TEXT,
  body       TEXT NOT NULL,
  tags       TEXT,                    -- JSON array
  source_id  TEXT REFERENCES core_sources(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_kind ON core_notes(kind);

-- \u2500\u2500 Agent sessions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_agent_sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  provider      TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | cancelled
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT,                 -- JSON
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT
);

-- \u2500\u2500 Tool events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_tool_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES core_agent_sessions(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  runtime_type TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',       -- ok | error | denied
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  input        TEXT,                  -- JSON (redacted)
  output       TEXT,                  -- JSON (redacted)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_events_session ON core_tool_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_created ON core_tool_events(created_at);

-- \u2500\u2500 Ingestion / background jobs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- import | embed | reindex | sync
  status      TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | failed | cancelled
  progress    REAL NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  payload     TEXT,                   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON core_jobs(status);

-- \u2500\u2500 Saved queries \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_saved_queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sql         TEXT NOT NULL,
  description TEXT,
  backend     TEXT NOT NULL DEFAULT 'embedded',
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at TEXT
);

-- \u2500\u2500 Retrieval profiles & runs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE TABLE IF NOT EXISTS core_retrieval_profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  embedding_model TEXT,
  dims            INTEGER NOT NULL DEFAULT 0,
  chunk_size      INTEGER NOT NULL DEFAULT 1024,
  chunk_overlap   INTEGER NOT NULL DEFAULT 128,
  vector_backend  TEXT NOT NULL DEFAULT 'exact_local',
  config          TEXT,               -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS core_retrieval_runs (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT REFERENCES core_retrieval_profiles(id) ON DELETE SET NULL,
  query        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok',
  top_k        INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  trace        TEXT,                  -- JSON
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retrieval_runs_profile ON core_retrieval_runs(profile_id);

-- \u2500\u2500 Views (stable GUI/adapter surface) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
CREATE VIEW IF NOT EXISTS v_recent_agent_activity AS
  SELECT te.id           AS event_id,
         te.session_id   AS session_id,
         s.title         AS session_title,
         te.tool_name    AS tool_name,
         te.runtime_type AS runtime_type,
         te.status       AS status,
         te.duration_ms  AS duration_ms,
         te.created_at   AS created_at
  FROM core_tool_events te
  LEFT JOIN core_agent_sessions s ON s.id = te.session_id
  ORDER BY te.created_at DESC;

CREATE VIEW IF NOT EXISTS v_documents_with_chunk_counts AS
  SELECT d.id        AS id,
         d.source_id AS source_id,
         d.title     AS title,
         d.mime      AS mime,
         d.byte_size AS byte_size,
         d.updated_at AS updated_at,
         COUNT(DISTINCT c.id) AS chunk_count,
         COUNT(DISTINCT e.id) AS embedding_count
  FROM core_documents d
  LEFT JOIN core_chunks c ON c.document_id = d.id
  LEFT JOIN core_embeddings e ON e.chunk_id = c.id
  GROUP BY d.id;

CREATE VIEW IF NOT EXISTS v_memory_timeline AS
  SELECT id           AS id,
         kind         AS kind,
         title        AS title,
         substr(body, 1, 280) AS preview,
         source_id    AS source_id,
         created_at   AS created_at,
         updated_at   AS updated_at
  FROM core_notes
  ORDER BY COALESCE(updated_at, created_at) DESC;

CREATE VIEW IF NOT EXISTS v_active_jobs AS
  SELECT id         AS id,
         kind       AS kind,
         status     AS status,
         progress   AS progress,
         completed  AS completed,
         total      AS total,
         error      AS error,
         created_at AS created_at,
         updated_at AS updated_at,
         started_at AS started_at
  FROM core_jobs
  WHERE status IN ('queued', 'running')
  ORDER BY created_at DESC;
`;

// src/data/database-manager.ts
var MIGRATIONS = [
  { version: 1, name: "v1-core-schema", sql: V1_SCHEMA }
];
var DatabaseManager = class {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this._migrations = options.migrations ?? MIGRATIONS;
    this._injectedDriver = options.driver;
  }
  _driver = null;
  _migration = null;
  _migrations;
  _injectedDriver;
  // Serialized write broker: the tail of a promise chain. Each write awaits the
  // previous one, guaranteeing one writer at a time regardless of caller count.
  _writeChain = Promise.resolve();
  /**
   * Open the database, apply durability pragmas, and run migrations. Throws
   * {@link SqlDriverUnavailableError} when no SQLite binding is present so the
   * caller can disable the Data surface while keeping the rest of the extension up.
   */
  open() {
    if (this._driver) return this._migration;
    const driver = this._injectedDriver ?? openSqlDriver(this.filePath);
    driver.exec(
      `PRAGMA journal_mode = WAL;
       PRAGMA synchronous = NORMAL;
       PRAGMA foreign_keys = ON;
       PRAGMA busy_timeout = 5000;`
    );
    this._migration = runMigrations(driver, this._migrations);
    this._driver = driver;
    return this._migration;
  }
  get isOpen() {
    return this._driver !== null;
  }
  get engine() {
    return this._driver?.engine ?? null;
  }
  get migrationResult() {
    return this._migration;
  }
  /** The open driver. Throws if {@link open} has not been called. */
  get driver() {
    if (!this._driver) throw new Error("DatabaseManager is not open. Call open() first.");
    return this._driver;
  }
  /** Read helpers — safe to call concurrently. */
  all(sql, params) {
    return this.driver.all(sql, params);
  }
  get(sql, params) {
    return this.driver.get(sql, params);
  }
  /**
   * Run a write through the single serialized broker. `fn` receives the driver and
   * may issue multiple statements / a transaction; it is guaranteed exclusive write
   * ordering relative to every other enqueued write.
   */
  enqueueWrite(fn) {
    const run = this._writeChain.then(() => fn(this.driver));
    this._writeChain = run.catch(() => void 0);
    return run;
  }
  close() {
    if (!this._driver) return;
    try {
      this._driver.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
    }
    try {
      this._driver.close();
    } catch {
    }
    this._driver = null;
  }
};

// src/data/database-paths.ts
var fs15 = __toESM(require("fs"));
var path23 = __toESM(require("path"));
var DATABASE_FILE = "blacksite.db";
function ensureDir4(dir) {
  fs15.mkdirSync(dir, { recursive: true });
}
function resolveStorageLocations(inputs) {
  let root;
  let source;
  if (inputs.storageFsPath) {
    root = inputs.storageFsPath;
    source = "storageUri";
  } else if (inputs.globalStorageFsPath) {
    root = path23.join(inputs.globalStorageFsPath, "data");
    source = "globalStorageUri";
  } else if (inputs.workspaceRoot) {
    root = path23.join(inputs.workspaceRoot, ".blacksite", "data");
    source = "workspace";
  } else {
    throw new Error("No storage location available: provide storageUri, globalStorageUri, or workspaceRoot.");
  }
  const blobsDir = path23.join(root, "blobs");
  const indexesDir = path23.join(root, "indexes");
  ensureDir4(root);
  ensureDir4(blobsDir);
  ensureDir4(indexesDir);
  return {
    root,
    databaseFile: path23.join(root, DATABASE_FILE),
    blobsDir,
    indexesDir,
    source
  };
}

// src/data/vector-provider.ts
function l2norm2(vector) {
  let sum = 0;
  for (const x of vector) sum += x * x;
  return Math.sqrt(sum) || 1;
}
function normalize(vector) {
  const n = l2norm2(vector);
  return vector.map((x) => x / n);
}
function dot(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

// src/data/exact-local-vector-provider.ts
function newId3() {
  return `emb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function parsePayload(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
var ExactLocalVectorProvider = class {
  constructor(db) {
    this.db = db;
  }
  mode = "exact_local";
  async upsert(record) {
    await this.upsertBatch([record]);
  }
  async upsertBatch(records) {
    if (records.length === 0) return;
    await this.db.enqueueWrite((driver) => {
      driver.transaction(() => {
        for (const record of records) {
          const normalized = normalize(record.vector);
          const id = record.id || newId3();
          const collection = record.collection ?? "default";
          const payload = record.payload ? JSON.stringify(record.payload) : null;
          driver.run(
            `INSERT INTO core_embeddings (id, chunk_id, collection, model, dims, vector, norm, payload)
             VALUES (:id, :chunk_id, :collection, :model, :dims, :vector, 1, :payload)
             ON CONFLICT(id) DO UPDATE SET
               chunk_id = excluded.chunk_id,
               collection = excluded.collection,
               model = excluded.model,
               dims = excluded.dims,
               vector = excluded.vector,
               payload = excluded.payload`,
            {
              id,
              chunk_id: record.chunkId ?? null,
              collection,
              model: record.model ?? null,
              dims: normalized.length,
              vector: JSON.stringify(normalized),
              payload
            }
          );
        }
      });
    });
  }
  async delete(id) {
    return this.db.enqueueWrite((driver) => {
      const result = driver.run("DELETE FROM core_embeddings WHERE id = ?", [id]);
      return result.changes > 0;
    });
  }
  async search(query, options = {}) {
    const topK = Math.max(1, options.topK ?? 10);
    const q = normalize(query);
    const rows = options.collection ? this.db.all("SELECT * FROM core_embeddings WHERE collection = ?", [options.collection]) : this.db.all("SELECT * FROM core_embeddings");
    const scored = [];
    for (const row of rows) {
      let vector;
      try {
        vector = JSON.parse(row.vector);
      } catch {
        continue;
      }
      if (vector.length !== q.length) continue;
      const payload = parsePayload(row.payload);
      if (options.filter && !options.filter(payload)) continue;
      scored.push({
        id: row.id,
        score: dot(q, vector),
        collection: row.collection,
        payload,
        chunkId: row.chunk_id ?? void 0
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
  async stats() {
    const rows = this.db.all(
      `SELECT collection, COUNT(*) AS count, MAX(dims) AS dims, MAX(model) AS model
       FROM core_embeddings GROUP BY collection ORDER BY collection`
    );
    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return {
      backend: this.mode,
      total,
      collections: rows.map((row) => ({
        name: row.collection,
        count: Number(row.count),
        dims: Number(row.dims),
        model: row.model ?? void 0
      }))
    };
  }
  async rebuild() {
  }
};

// src/data/catalog-store.ts
var IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isSafeIdentifier(name) {
  return IDENTIFIER_RE.test(name);
}
var CatalogStore = class {
  constructor(db) {
    this.db = db;
  }
  listMaster(type) {
    return this.db.all(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type = ? AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      [type]
    );
  }
  safeRowCount(table) {
    if (!isSafeIdentifier(table)) return void 0;
    try {
      const row = this.db.get(`SELECT COUNT(*) AS n FROM "${table}"`);
      return row ? Number(row.n) : 0;
    } catch {
      return void 0;
    }
  }
  /** Build the full Explorer tree the webview renders. */
  getCatalogTree() {
    const tables = this.listMaster("table").map((row) => ({
      name: row.name,
      type: "table",
      rowCount: this.safeRowCount(row.name)
    }));
    const views = this.listMaster("view").map((row) => ({
      name: row.name,
      type: "view"
    }));
    const collections = this.db.all(
      `SELECT collection, COUNT(*) AS count, MAX(dims) AS dims, MAX(model) AS model
         FROM core_embeddings GROUP BY collection ORDER BY collection`
    ).map((row) => ({
      name: row.collection,
      type: "vector_collection",
      rowCount: Number(row.count),
      detail: `${Number(row.dims)} dims${row.model ? ` \xB7 ${row.model}` : ""}`
    }));
    const savedQueries = this.db.all("SELECT id, name FROM core_saved_queries ORDER BY updated_at DESC").map((row) => ({ name: row.name, type: "saved_query", detail: row.id }));
    const jobs = this.db.all(
      "SELECT id, kind, status FROM core_jobs ORDER BY created_at DESC LIMIT 50"
    ).map((row) => ({ name: `${row.kind} \xB7 ${row.id}`, type: "job", detail: row.status }));
    const groups = [
      { id: "tables", label: "Tables", type: "table", objects: tables },
      { id: "views", label: "Views", type: "view", objects: views },
      { id: "vectors", label: "Vector Collections", type: "vector_collection", objects: collections },
      { id: "saved", label: "Saved Queries", type: "saved_query", objects: savedQueries },
      { id: "jobs", label: "Jobs", type: "job", objects: jobs }
    ];
    return {
      engine: this.db.engine,
      schemaVersion: this.db.migrationResult?.toVersion ?? 0,
      groups
    };
  }
  /** Inspect a table or view: columns, indexes, row count, and DDL. */
  describeObject(name) {
    if (!isSafeIdentifier(name)) {
      throw new Error(`Invalid object name: ${name}`);
    }
    const master = this.db.get(
      "SELECT name, type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
      [name]
    );
    if (!master) throw new Error(`Object not found: ${name}`);
    const columns = this.db.all(
      `PRAGMA table_info("${name}")`
    ).map((col) => ({
      name: col.name,
      type: col.type,
      notNull: Number(col.notnull) === 1,
      primaryKey: Number(col.pk) > 0,
      defaultValue: col.dflt_value
    }));
    const indexes = this.db.all(`PRAGMA index_list("${name}")`).map((idx) => ({
      name: idx.name,
      unique: Number(idx.unique) === 1,
      columns: this.db.all(`PRAGMA index_info("${idx.name}")`).map((c) => c.name)
    }));
    return {
      name,
      type: master.type === "view" ? "view" : "table",
      columns,
      rowCount: this.safeRowCount(name) ?? 0,
      indexes,
      createSql: master.sql
    };
  }
  /** Paginated, filterable preview of a table or view. */
  previewRows(name, options = {}) {
    if (!isSafeIdentifier(name)) {
      throw new Error(`Invalid object name: ${name}`);
    }
    const description = this.describeObject(name);
    const columnNames = description.columns.map((c) => c.name);
    const limit = Math.min(Math.max(1, options.limit ?? 50), 1e3);
    const offset = Math.max(0, options.offset ?? 0);
    const params = [];
    let whereClause = "";
    const filter = options.filter?.trim();
    if (filter) {
      const textColumns = description.columns.filter((c) => /char|text|clob|TEXT/i.test(c.type) || c.type === "").map((c) => c.name);
      const cols = textColumns.length > 0 ? textColumns : columnNames;
      const likeTerms = cols.map((col) => `CAST("${col}" AS TEXT) LIKE ? COLLATE NOCASE`);
      whereClause = ` WHERE ${likeTerms.join(" OR ")}`;
      for (let i = 0; i < cols.length; i++) params.push(`%${filter}%`);
    }
    let orderClause = "";
    if (options.orderBy && columnNames.includes(options.orderBy)) {
      const dir = options.orderDir === "desc" ? "DESC" : "ASC";
      orderClause = ` ORDER BY "${options.orderBy}" ${dir}`;
    }
    const totalRow = this.db.get(
      `SELECT COUNT(*) AS n FROM "${name}"${whereClause}`,
      params
    );
    const totalRows = totalRow ? Number(totalRow.n) : 0;
    const rows = this.db.all(
      `SELECT * FROM "${name}"${whereClause}${orderClause} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { object: name, columns: columnNames, rows, totalRows, limit, offset };
  }
};

// src/data/query-service.ts
function newId4(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function columnsOf(rows) {
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}
var QueryService = class {
  constructor(db) {
    this.db = db;
  }
  /**
   * Run arbitrary SQL with the safety guard applied. Read statements return rows;
   * write statements require `confirmed`; multi-statement scripts are rejected so a
   * benign-looking SELECT cannot smuggle a trailing DELETE.
   */
  async run(sql, options = {}) {
    const classification = classifyQuery(sql);
    if (classification.multiple) {
      return {
        ok: false,
        kind: "blocked",
        classification,
        message: "Multiple statements are not allowed in one run. Execute them one at a time.",
        needsConfirmation: false
      };
    }
    const started = Date.now();
    if (classification.readOnly) {
      const maxRows = Math.min(Math.max(1, options.maxRows ?? 500), 1e4);
      const rows = this.db.all(sql, options.params);
      const truncated = rows.length > maxRows;
      const limited = truncated ? rows.slice(0, maxRows) : rows;
      return {
        ok: true,
        kind: "read",
        columns: columnsOf(limited),
        rows: limited,
        rowCount: limited.length,
        truncated,
        elapsedMs: Date.now() - started
      };
    }
    if (!options.confirmed) {
      return {
        ok: false,
        kind: "blocked",
        classification,
        message: describeForConfirmation(classification),
        needsConfirmation: true
      };
    }
    const result = await this.db.enqueueWrite((driver) => driver.run(sql, options.params));
    return {
      ok: true,
      kind: "write",
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
      elapsedMs: Date.now() - started
    };
  }
  /**
   * Classify SQL without running it — backs `db.preview_write_query` and the UI's
   * "what will this do?" affordance.
   */
  preview(sql) {
    const classification = classifyQuery(sql);
    return { classification, message: describeForConfirmation(classification) };
  }
  // ── Saved queries ──────────────────────────────────────────────────────────
  listSavedQueries() {
    return this.db.all("SELECT * FROM core_saved_queries ORDER BY updated_at DESC").map(mapSavedQuery);
  }
  getSavedQuery(id) {
    const row = this.db.get("SELECT * FROM core_saved_queries WHERE id = ?", [id]);
    return row ? mapSavedQuery(row) : void 0;
  }
  async saveQuery(input) {
    const name = input.name.trim() || "Untitled query";
    const sql = input.sql.trim();
    if (!sql) throw new Error("Cannot save an empty query.");
    const description = input.description?.trim() || null;
    const id = input.id ?? newId4("sq");
    await this.db.enqueueWrite((driver) => {
      driver.run(
        `INSERT INTO core_saved_queries (id, name, sql, description, backend, updated_at)
         VALUES (:id, :name, :sql, :description, 'embedded', datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           sql = excluded.sql,
           description = excluded.description,
           updated_at = datetime('now')`,
        { id, name, sql, description }
      );
    });
    return this.getSavedQuery(id);
  }
  async deleteSavedQuery(id) {
    return this.db.enqueueWrite((driver) => {
      const result = driver.run("DELETE FROM core_saved_queries WHERE id = ?", [id]);
      return result.changes > 0;
    });
  }
  async markSavedQueryRun(id) {
    await this.db.enqueueWrite((driver) => {
      driver.run(
        "UPDATE core_saved_queries SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?",
        [id]
      );
    });
  }
};
function mapSavedQuery(row) {
  return {
    id: row.id,
    name: row.name,
    sql: row.sql,
    description: row.description,
    backend: row.backend,
    runCount: Number(row.run_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at
  };
}

// src/data/data-surface-provider.ts
var DataSurfaceProvider = class {
  constructor(db, vectors) {
    this.db = db;
    this.vectors = vectors;
    this.catalog = new CatalogStore(db);
    this.queries = new QueryService(db);
  }
  catalog;
  queries;
  /** Swap the active vector backend (exact_local ⇄ pgvector_container). */
  setVectorProvider(provider) {
    this.vectors = provider;
  }
  status() {
    return {
      available: this.db.isOpen,
      engine: this.db.engine,
      schemaVersion: this.db.migrationResult?.toVersion ?? 0,
      vectorBackend: this.vectors.mode
    };
  }
  // ── Catalog ────────────────────────────────────────────────────────────────
  getCatalog() {
    return this.catalog.getCatalogTree();
  }
  describeObject(name) {
    return this.catalog.describeObject(name);
  }
  previewRows(name, options) {
    return this.catalog.previewRows(name, options);
  }
  // ── Query ──────────────────────────────────────────────────────────────────
  runQuery(sql, options) {
    return this.queries.run(sql, options);
  }
  previewQuery(sql) {
    return this.queries.preview(sql);
  }
  listSavedQueries() {
    return this.queries.listSavedQueries();
  }
  getSavedQuery(id) {
    return this.queries.getSavedQuery(id);
  }
  saveQuery(input) {
    return this.queries.saveQuery(input);
  }
  deleteSavedQuery(id) {
    return this.queries.deleteSavedQuery(id);
  }
  markSavedQueryRun(id) {
    return this.queries.markSavedQueryRun(id);
  }
  // ── Vectors ────────────────────────────────────────────────────────────────
  vectorSearch(input) {
    return this.vectors.search(input.vector, { topK: input.topK, collection: input.collection });
  }
  vectorStats() {
    return this.vectors.stats();
  }
  vectorRebuild() {
    return this.vectors.rebuild();
  }
};

// src/data/legacy-import.ts
var fs16 = __toESM(require("fs"));
var path24 = __toESM(require("path"));
var BLACKSITE_DIR3 = ".blacksite";
function stableId(prefix, ...parts) {
  let h = 2166136261;
  const input = parts.join("\0");
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return `${prefix}_${h.toString(36)}`;
}
function emptyRecords() {
  return { sources: [], notes: [], embeddings: [] };
}
function mergeRecords(target, add) {
  target.sources.push(...add.sources);
  target.notes.push(...add.notes);
  target.embeddings.push(...add.embeddings);
}
function parseBaseContext(json) {
  const records = emptyRecords();
  if (!json || typeof json !== "object") return records;
  const topics = json.topics;
  if (!Array.isArray(topics)) return records;
  const sourceId = "src_base_context";
  records.sources.push({
    id: sourceId,
    kind: "base_context",
    uri: `${BLACKSITE_DIR3}/base-context.json`,
    title: "Base Context",
    metadata: { topicCount: topics.length }
  });
  for (const topic of topics) {
    if (!topic || typeof topic !== "object") continue;
    const t = topic;
    const title = typeof t.title === "string" ? t.title : "Untitled topic";
    const notes = typeof t.notes === "string" ? t.notes : "";
    const id = typeof t.id === "string" && t.id ? stableId("note", "bc", t.id) : stableId("note", "bc", title);
    records.notes.push({
      id,
      kind: "base_context",
      title,
      body: notes || title,
      sourceId,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : null,
      updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : null
    });
  }
  return records;
}
function parseMemoryMarkdown(markdown) {
  const records = emptyRecords();
  if (!markdown.trim()) return records;
  const sourceId = "src_memory_md";
  records.sources.push({
    id: sourceId,
    kind: "memory",
    uri: `${BLACKSITE_DIR3}/memory.md`,
    title: "Project Memory",
    metadata: null
  });
  const sections = markdown.split(/^##\s+/m);
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const newlineIdx = section.indexOf("\n");
    const heading = (newlineIdx >= 0 ? section.slice(0, newlineIdx) : section).trim();
    const body = (newlineIdx >= 0 ? section.slice(newlineIdx + 1) : "").trim();
    if (!body) continue;
    records.notes.push({
      id: stableId("note", "mem", heading, body.slice(0, 64)),
      kind: "memory",
      title: heading || null,
      body,
      sourceId,
      createdAt: heading || null,
      updatedAt: heading || null
    });
  }
  return records;
}
function parseMemoryIndex(json) {
  const records = emptyRecords();
  if (!json || typeof json !== "object") return records;
  const entries = json.entries;
  if (!Array.isArray(entries)) return records;
  const sourceId = "src_memory_index";
  records.sources.push({
    id: sourceId,
    kind: "import",
    uri: `${BLACKSITE_DIR3}/memory-index.json`,
    title: "Legacy Memory Index",
    metadata: { entries: entries.length }
  });
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    const vec = e.vec;
    if (!Array.isArray(vec) || vec.length === 0) continue;
    const id = typeof e.id === "string" && e.id ? e.id : stableId("emb", JSON.stringify(vec).slice(0, 64));
    const payload = e.payload && typeof e.payload === "object" ? e.payload : {};
    const collection = typeof payload["_col"] === "string" ? payload["_col"] : "memory";
    records.embeddings.push({
      id,
      vector: vec.map((x) => Number(x)),
      payload,
      collection
    });
  }
  return records;
}
function parsePlanning(json) {
  const records = emptyRecords();
  if (!json || typeof json !== "object") return records;
  const plans = json.plans;
  if (!Array.isArray(plans)) return records;
  const sourceId = "src_planning";
  records.sources.push({
    id: sourceId,
    kind: "plan",
    uri: `${BLACKSITE_DIR3}/planning.json`,
    title: "Planning",
    metadata: { planCount: plans.length }
  });
  for (const plan of plans) {
    if (!plan || typeof plan !== "object") continue;
    const p = plan;
    const title = typeof p.title === "string" ? p.title : "Untitled plan";
    const summary = typeof p.summary === "string" ? p.summary : "";
    const phases = Array.isArray(p.phases) ? p.phases : [];
    const phaseLines = phases.map((phase) => phase && typeof phase === "object" ? phase.title : null).filter((t) => typeof t === "string").map((t) => `- ${t}`).join("\n");
    const body = [summary, phaseLines].filter(Boolean).join("\n\n") || title;
    const id = typeof p.id === "string" && p.id ? stableId("note", "plan", p.id) : stableId("note", "plan", title);
    records.notes.push({
      id,
      kind: "note",
      title: `Plan: ${title}`,
      body,
      sourceId,
      createdAt: typeof p.createdAt === "string" ? p.createdAt : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null
    });
  }
  return records;
}
function readJson(filePath) {
  try {
    return JSON.parse(fs16.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function readText(filePath) {
  try {
    return fs16.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
function collectLegacyRecords(workspaceRoot) {
  const dir = path24.join(workspaceRoot, BLACKSITE_DIR3);
  const records = emptyRecords();
  mergeRecords(records, parseBaseContext(readJson(path24.join(dir, "base-context.json"))));
  mergeRecords(records, parsePlanning(readJson(path24.join(dir, "planning.json"))));
  mergeRecords(records, parseMemoryMarkdown(readText(path24.join(dir, "memory.md"))));
  mergeRecords(records, parseMemoryIndex(readJson(path24.join(dir, "memory-index.json"))));
  return records;
}
async function applyImportRecords(db, records) {
  return db.enqueueWrite((driver) => {
    let sources = 0;
    let notes = 0;
    let embeddings = 0;
    driver.transaction(() => {
      for (const source of records.sources) {
        const result = driver.run(
          `INSERT OR IGNORE INTO core_sources (id, kind, uri, title, metadata)
           VALUES (:id, :kind, :uri, :title, :metadata)`,
          {
            id: source.id,
            kind: source.kind,
            uri: source.uri,
            title: source.title,
            metadata: source.metadata ? JSON.stringify(source.metadata) : null
          }
        );
        sources += result.changes;
      }
      for (const note of records.notes) {
        const result = driver.run(
          `INSERT OR IGNORE INTO core_notes (id, kind, title, body, source_id, created_at, updated_at)
           VALUES (:id, :kind, :title, :body, :source_id, COALESCE(:created_at, datetime('now')), COALESCE(:updated_at, datetime('now')))`,
          {
            id: note.id,
            kind: note.kind,
            title: note.title,
            body: note.body,
            source_id: note.sourceId,
            created_at: note.createdAt,
            updated_at: note.updatedAt
          }
        );
        notes += result.changes;
      }
      for (const emb of records.embeddings) {
        const norm = Math.sqrt(emb.vector.reduce((s, x) => s + x * x, 0)) || 1;
        const normalized = emb.vector.map((x) => x / norm);
        const result = driver.run(
          `INSERT OR IGNORE INTO core_embeddings (id, chunk_id, collection, model, dims, vector, norm, payload)
           VALUES (:id, NULL, :collection, :model, :dims, :vector, 1, :payload)`,
          {
            id: emb.id,
            collection: emb.collection ?? "memory",
            model: emb.model ?? null,
            dims: normalized.length,
            vector: JSON.stringify(normalized),
            payload: emb.payload ? JSON.stringify(emb.payload) : null
          }
        );
        embeddings += result.changes;
      }
    });
    return { sources, notes, embeddings };
  });
}
function hasImported(db) {
  const row = db.get("SELECT value FROM core_meta WHERE key = 'legacy_import_at'");
  return Boolean(row?.value);
}
async function markImported(db, summary) {
  await db.enqueueWrite((driver) => {
    driver.run(
      `INSERT INTO core_meta (key, value, updated_at) VALUES ('legacy_import_at', :value, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      { value: JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...summary }) }
    );
  });
}

// src/data/container-runtime.ts
var import_node_child_process = require("node:child_process");

// src/data/postgres-pgvector-profile.ts
var POSTGRES_PGVECTOR_PROFILE = {
  id: "blacksite-pgvector",
  label: "PostgreSQL + pgvector",
  image: "pgvector/pgvector:pg16",
  ports: [{ host: 54329, container: 5432 }],
  env: {
    POSTGRES_USER: "blacksite",
    POSTGRES_PASSWORD: "blacksite",
    POSTGRES_DB: "blacksite"
  },
  healthCheck: ["pg_isready", "-U", "blacksite", "-d", "blacksite"],
  initSql: [
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "CREATE TABLE IF NOT EXISTS embeddings (id TEXT PRIMARY KEY, collection TEXT NOT NULL DEFAULT 'default', payload JSONB, vector vector);",
    "CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON embeddings(collection);"
  ]
};
function connectionStringFor(profile) {
  const port = profile.ports[0]?.host ?? 5432;
  const user = profile.env.POSTGRES_USER ?? "postgres";
  const password = profile.env.POSTGRES_PASSWORD ?? "";
  const db = profile.env.POSTGRES_DB ?? "postgres";
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
}
function parseSidecarHealth(raw) {
  const text = raw.trim();
  if (!text || /no such object|not found|error: no/i.test(text)) {
    return { health: "missing", running: false, detail: "Container does not exist." };
  }
  if (text.includes("|") && !text.startsWith("[") && !text.startsWith("{")) {
    const [state = "", healthRaw = ""] = text.split("|").map((s) => s.trim().toLowerCase());
    return interpret(state, healthRaw);
  }
  try {
    const parsed = JSON.parse(text);
    const node = Array.isArray(parsed) ? parsed[0] : parsed;
    const state = node?.State;
    const status = (state?.Status ?? "").toLowerCase();
    const health = (state?.Health?.Status ?? "").toLowerCase();
    return interpret(status, health);
  } catch {
    const lower = text.toLowerCase();
    if (/\(healthy\)/.test(lower)) return { health: "running", running: true, detail: text };
    if (/\(health: starting\)|starting/.test(lower)) return { health: "starting", running: true, detail: text };
    if (/\(unhealthy\)/.test(lower)) return { health: "unhealthy", running: true, detail: text };
    if (/^up\b/.test(lower)) return { health: "running", running: true, detail: text };
    if (/^exited|^created/.test(lower)) return { health: "stopped", running: false, detail: text };
    return { health: "unhealthy", running: false, detail: text };
  }
}
function interpret(state, health) {
  if (state === "running") {
    if (health === "healthy" || health === "") return { health: "running", running: true, detail: `running${health ? " (healthy)" : ""}` };
    if (health === "starting") return { health: "starting", running: true, detail: "running (starting)" };
    return { health: "unhealthy", running: true, detail: `running (${health})` };
  }
  if (state === "created") return { health: "starting", running: false, detail: "created" };
  if (state === "exited" || state === "dead") return { health: "stopped", running: false, detail: state };
  return { health: "missing", running: false, detail: state || "unknown" };
}

// src/data/container-runtime.ts
var defaultCommandRunner = (command, args) => new Promise((resolve3) => {
  (0, import_node_child_process.execFile)(command, args, { timeout: 6e4, windowsHide: true }, (err, stdout, stderr) => {
    const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
    resolve3({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
  });
});
var ContainerRuntime = class {
  constructor(run = defaultCommandRunner) {
    this.run = run;
  }
  _engine = null;
  /** Detect an available container engine, preferring docker. Caches the result. */
  async detectEngine() {
    if (this._engine) return this._engine;
    for (const engine of ["docker", "podman"]) {
      const result = await this.run(engine, ["--version"]).catch(() => null);
      if (result && result.code === 0) {
        this._engine = engine;
        return engine;
      }
    }
    return null;
  }
  async isAvailable() {
    return await this.detectEngine() !== null;
  }
  /** Create-and-start (or start an existing) container for the profile. */
  async up(profile) {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine (docker/podman) detected." };
    const existing = await this.status(profile);
    if (existing.health !== "missing") {
      const start = await this.run(engine, ["start", profile.id]);
      return { ok: start.code === 0, message: start.code === 0 ? "Started existing container." : start.stderr.trim() };
    }
    const args = ["run", "-d", "--name", profile.id];
    for (const port of profile.ports) args.push("-p", `${port.host}:${port.container}`);
    for (const [key, value] of Object.entries(profile.env)) args.push("-e", `${key}=${value}`);
    args.push(profile.image);
    const result = await this.run(engine, args);
    return { ok: result.code === 0, message: result.code === 0 ? "Container created." : result.stderr.trim() };
  }
  async stop(profile) {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine detected." };
    const result = await this.run(engine, ["stop", profile.id]);
    return { ok: result.code === 0, message: result.code === 0 ? "Stopped." : result.stderr.trim() };
  }
  async remove(profile) {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine detected." };
    const result = await this.run(engine, ["rm", "-f", profile.id]);
    return { ok: result.code === 0, message: result.code === 0 ? "Removed." : result.stderr.trim() };
  }
  /** Inspect the container's normalized health. */
  async status(profile) {
    const engine = await this.detectEngine();
    if (!engine) return { health: "missing", running: false, detail: "No container engine detected." };
    const result = await this.run(engine, [
      "inspect",
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      profile.id
    ]);
    if (result.code !== 0) return parseSidecarHealth(result.stderr || result.stdout);
    return parseSidecarHealth(result.stdout);
  }
  /** Tail recent container logs. */
  async logs(profile, tail = 100) {
    const engine = await this.detectEngine();
    if (!engine) return "";
    const result = await this.run(engine, ["logs", "--tail", String(tail), profile.id]);
    return result.stdout || result.stderr;
  }
};

// src/data/pgvector-sidecar-provider.ts
function toVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}
var PgVectorSidecarProvider = class {
  constructor(client) {
    this.client = client;
  }
  mode = "pgvector_container";
  async upsert(record) {
    await this.upsertBatch([record]);
  }
  async upsertBatch(records) {
    for (const record of records) {
      const vector = toVectorLiteral(normalize(record.vector));
      await this.client.query(
        `INSERT INTO embeddings (id, collection, payload, vector)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET collection = EXCLUDED.collection, payload = EXCLUDED.payload, vector = EXCLUDED.vector`,
        [record.id, record.collection ?? "default", record.payload ? JSON.stringify(record.payload) : null, vector]
      );
    }
  }
  async delete(id) {
    await this.client.query("DELETE FROM embeddings WHERE id = $1", [id]);
    return true;
  }
  async search(query, options = {}) {
    const topK = Math.max(1, options.topK ?? 10);
    const vector = toVectorLiteral(normalize(query));
    const where = options.collection ? "WHERE collection = $2" : "";
    const params = options.collection ? [vector, options.collection, topK] : [vector, topK];
    const limitParam = options.collection ? "$3" : "$2";
    const result = await this.client.query(
      `SELECT id, collection, payload, 1 - (vector <=> $1) AS score
       FROM embeddings ${where}
       ORDER BY vector <=> $1 ASC
       LIMIT ${limitParam}`,
      params
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      score: Number(row.score ?? 0),
      collection: String(row.collection ?? "default"),
      payload: parsePayload2(row.payload),
      chunkId: void 0
    }));
  }
  async stats() {
    const result = await this.client.query(
      "SELECT collection, COUNT(*)::int AS count FROM embeddings GROUP BY collection ORDER BY collection"
    );
    const collections = result.rows.map((row) => ({
      name: String(row.collection ?? "default"),
      count: Number(row.count ?? 0),
      dims: 0
    }));
    return {
      backend: this.mode,
      total: collections.reduce((sum, c) => sum + c.count, 0),
      collections
    };
  }
  async rebuild() {
    await this.client.query(
      "CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)"
    );
  }
};
function parsePayload2(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
}
async function createPgVectorProvider(connectionString, initSql = []) {
  let pgModule = null;
  try {
    const req = typeof require === "function" ? require : null;
    pgModule = req ? req("pg") : null;
  } catch {
    pgModule = null;
  }
  if (!pgModule?.Client) {
    return { ok: false, reason: "The 'pg' client is not installed. Install it to enable the pgvector sidecar." };
  }
  try {
    const raw = new pgModule.Client({ connectionString });
    await raw.connect();
    const client = { query: (sql, params) => raw.query(sql, params), end: () => raw.end() };
    for (const statement of initSql) {
      if (statement.trim()) {
        await client.query(statement);
      }
    }
    return { ok: true, provider: new PgVectorSidecarProvider(client), client };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// src/data-provider.ts
function createDataWorkbench(context, workspaceRoot) {
  let manager = null;
  let surface = null;
  let status = { available: false, engine: null, schemaVersion: 0 };
  try {
    const locations = resolveStorageLocations({
      storageFsPath: context.storageUri?.fsPath,
      globalStorageFsPath: context.globalStorageUri.fsPath,
      workspaceRoot
    });
    manager = new DatabaseManager(locations.databaseFile);
    const migration = manager.open();
    const vectors = new ExactLocalVectorProvider(manager);
    surface = new DataSurfaceProvider(manager, vectors);
    status = { available: true, engine: manager.engine, schemaVersion: migration.toVersion };
    void runLegacyImport(manager).catch(() => void 0);
  } catch (err) {
    const reason = err instanceof SqlDriverUnavailableError ? "No SQLite binding is available on this host. Install better-sqlite3 or run on Node >= 22.5." : err instanceof Error ? err.message : String(err);
    status = { available: false, engine: null, schemaVersion: 0, reason };
  }
  return {
    surface,
    manager,
    status,
    dispose: () => manager?.close()
  };
}
async function runLegacyImport(manager) {
  if (hasImported(manager)) return;
  const workspaceRoot = vscode20.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;
  const records = collectLegacyRecords(workspaceRoot);
  const summary = await applyImportRecords(manager, records);
  await markImported(manager, summary);
}
var DataProvider = class {
  constructor(_context, _workspaceRoot, _workbench) {
    this._context = _context;
    this._workspaceRoot = _workspaceRoot;
    this._workbench = _workbench;
    void this.applyConfiguredBackend();
  }
  _view;
  _assistant;
  _embedder;
  _container = new ContainerRuntime();
  _sidecarProfile = POSTGRES_PGVECTOR_PROFILE;
  _pgClient = null;
  /** Wire the M3 assistant after construction (it depends on chat-provider secrets). */
  setAssistant(assistant) {
    this._assistant = assistant;
  }
  /** Wire the embedding function after construction (it depends on chat-provider secrets
      and the unified embedding-model setting). Falls back to a local sparse vector when
      absent or when the API path fails. */
  setEmbedder(embed) {
    this._embedder = embed;
  }
  async _embedQuery(text) {
    if (!this._embedder) return sparseEmbed(text);
    try {
      const vec = await this._embedder(text);
      return vec.length ? vec : sparseEmbed(text);
    } catch {
      return sparseEmbed(text);
    }
  }
  dispose() {
    void this._closePgClient();
  }
  async applyConfiguredBackend() {
    const settings = this._readSettings();
    await this._applyVectorBackend(settings.backendMode, { persist: false, silent: true });
  }
  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode20.Uri.joinPath(this._context.extensionUri, "out")]
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "data.js");
    webviewView.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._context.subscriptions
    );
    this._postState();
  }
  refresh() {
    this._postState();
  }
  /** Focus the Query tab with a SQL string pre-loaded (used by `blacksite.runQuery`). */
  loadQueryIntoEditor(sql) {
    this._post({ type: "load_query", sql });
  }
  async _onMessage(msg) {
    const type = String(msg.type ?? "");
    const surface = this._workbench.surface;
    try {
      switch (type) {
        case "ready":
        case "refresh":
          await this.applyConfiguredBackend();
          this._postState();
          break;
        case "describe_object": {
          if (!surface) break;
          const description = surface.describeObject(String(msg.name ?? ""));
          this._post({ type: "object_description", description });
          break;
        }
        case "preview_rows": {
          if (!surface) break;
          const result = surface.previewRows(String(msg.name ?? ""), {
            limit: typeof msg.limit === "number" ? msg.limit : this._previewPageSize(),
            offset: typeof msg.offset === "number" ? msg.offset : 0,
            filter: typeof msg.filter === "string" ? msg.filter : void 0,
            orderBy: typeof msg.orderBy === "string" ? msg.orderBy : void 0,
            orderDir: msg.orderDir === "desc" ? "desc" : msg.orderDir === "asc" ? "asc" : void 0
          });
          this._post({ type: "preview_result", result });
          break;
        }
        case "run_query": {
          if (!surface) break;
          const result = await surface.runQuery(String(msg.sql ?? ""), {
            confirmed: msg.confirmed === true,
            maxRows: this._maxQueryRows()
          });
          this._post({ type: "query_result", result });
          break;
        }
        case "save_query": {
          if (!surface) break;
          await surface.saveQuery({
            id: typeof msg.id === "string" ? msg.id : void 0,
            name: String(msg.name ?? "Untitled query"),
            sql: String(msg.sql ?? ""),
            description: typeof msg.description === "string" ? msg.description : void 0
          });
          this._postState();
          break;
        }
        case "open_saved_query": {
          if (!surface) break;
          const saved = surface.getSavedQuery(String(msg.id ?? ""));
          if (saved) this._post({ type: "load_query", sql: saved.sql, name: saved.name, id: saved.id });
          break;
        }
        case "delete_saved_query": {
          if (!surface) break;
          await surface.deleteSavedQuery(String(msg.id ?? ""));
          this._postState();
          break;
        }
        case "vector_search": {
          if (!surface) break;
          const text = String(msg.text ?? "").trim();
          if (!text) break;
          const vector = await this._embedQuery(text);
          const hits = await surface.vectorSearch({
            vector,
            topK: typeof msg.topK === "number" ? msg.topK : 10,
            collection: typeof msg.collection === "string" && msg.collection ? msg.collection : void 0
          });
          this._post({ type: "vector_results", hits, query: text });
          break;
        }
        case "sidecar_status": {
          const settings = this._readSettings();
          const available = await this._container.isAvailable();
          const status = available ? await this._container.status(this._sidecarProfile) : null;
          this._post({
            type: "sidecar_status",
            engineAvailable: available,
            profile: this._sidecarProfile.label,
            status,
            configuredBackend: settings.backendMode,
            activeBackend: surface?.status().vectorBackend ?? "exact_local"
          });
          break;
        }
        case "sidecar_up": {
          const result = await this._container.up(this._sidecarProfile);
          if (result.ok && this._readSettings().backendMode === "pgvector_container") {
            await this.applyConfiguredBackend();
          }
          this._post({ type: "sidecar_action", action: "up", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "sidecar_stop": {
          const result = await this._container.stop(this._sidecarProfile);
          if (result.ok && surface?.status().vectorBackend === "pgvector_container") {
            await this._applyVectorBackend("exact_local", { persist: false, silent: true });
          }
          this._post({ type: "sidecar_action", action: "stop", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "set_vector_backend": {
          const mode = msg.mode === "pgvector_container" ? "pgvector_container" : "exact_local";
          const result = await this._applyVectorBackend(mode, { persist: true, silent: false });
          this._post({ type: "sidecar_action", action: "switch", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "assistant_ask": {
          const question = String(msg.question ?? "").trim();
          if (!question) break;
          if (!this._assistantEnabled()) {
            this._post({ type: "assistant_reply", reply: { ok: false, explanation: "", error: "The database assistant is disabled. Enable it in settings (blacksite.data.enableAssistant)." } });
            break;
          }
          if (!this._assistant) {
            this._post({ type: "assistant_reply", reply: { ok: false, explanation: "", error: "Assistant is not available in this context." } });
            break;
          }
          const reply = await this._assistant.ask(question);
          this._post({ type: "assistant_reply", reply });
          break;
        }
        case "open_source_file": {
          await this._openFile(String(msg.path ?? ""));
          break;
        }
        case "open_settings": {
          await this._openSettings(typeof msg.query === "string" ? msg.query : void 0);
          break;
        }
      }
    } catch (err) {
      this._post({ type: "data_error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  _postState() {
    if (!this._view) return;
    const surface = this._workbench.surface;
    const settings = this._readSettings();
    const state = {
      type: "data_state",
      status: {
        ...this._workbench.status,
        assistantEnabled: settings.enableAssistant,
        activeBackend: surface?.status().vectorBackend ?? settings.backendMode
      },
      settings
    };
    if (surface) {
      state.catalog = surface.getCatalog();
      state.savedQueries = surface.listSavedQueries();
    }
    void this._view.webview.postMessage(state);
    if (surface) {
      void surface.vectorStats().then((stats) => this._post({ type: "vector_stats", stats })).catch(() => void 0);
    }
  }
  async _openFile(relativePath) {
    if (!relativePath) return;
    const absolute = resolveWorkspacePath2(relativePath, this._workspaceRoots());
    if (!absolute || !fs17.existsSync(absolute)) {
      vscode20.window.showWarningMessage(`Blacksite: ${relativePath} was not found in this workspace.`);
      return;
    }
    const document = await vscode20.workspace.openTextDocument(absolute);
    await vscode20.window.showTextDocument(document, { preview: true });
  }
  _post(message) {
    void this._view?.webview.postMessage(message);
  }
  _config() {
    return vscode20.workspace.getConfiguration("blacksite.data");
  }
  _configTarget() {
    return vscode20.workspace.workspaceFolders?.length ? vscode20.ConfigurationTarget.Workspace : vscode20.ConfigurationTarget.Global;
  }
  _workspaceRoots() {
    return vscode20.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [this._workspaceRoot];
  }
  async _closePgClient() {
    const client = this._pgClient;
    this._pgClient = null;
    if (client) {
      try {
        await client.end();
      } catch {
      }
    }
  }
  _readSettings() {
    const cfg = this._config();
    const backendMode = cfg.get("backendMode") === "pgvector_container" ? "pgvector_container" : "exact_local";
    return {
      previewPageSize: Math.max(10, Math.min(500, cfg.get("previewPageSize", 50))),
      maxQueryRows: Math.max(1, Math.min(1e4, cfg.get("maxQueryRows", 500))),
      enableAssistant: cfg.get("enableAssistant", true),
      backendMode
    };
  }
  async _openSettings(query) {
    const search = query?.trim() || "@ext:blacksite";
    await vscode20.commands.executeCommand("workbench.action.openSettings", search);
  }
  async _applyVectorBackend(mode, options) {
    const surface = this._workbench.surface;
    const manager = this._workbench.manager;
    if (!surface || !manager) {
      return { ok: false, message: "The embedded database engine is unavailable." };
    }
    const activeMode = surface.status().vectorBackend;
    if (activeMode === mode && (mode !== "pgvector_container" || this._pgClient)) {
      return { ok: true, message: mode === "pgvector_container" ? "pgvector sidecar is already active." : "Embedded exact search is already active." };
    }
    if (mode === "pgvector_container") {
      const readiness = await this._ensureSidecarReady();
      if (!readiness.ok) {
        return readiness;
      }
      const result = await createPgVectorProvider(
        connectionStringFor(this._sidecarProfile),
        this._sidecarProfile.initSql
      );
      if (!result.ok || !result.provider || !result.client) {
        return { ok: false, message: result.reason ?? "pgvector is unavailable." };
      }
      const previousClient = this._pgClient;
      surface.setVectorProvider(result.provider);
      this._pgClient = result.client;
      if (options.persist) {
        await this._config().update("backendMode", mode, this._configTarget());
      }
      if (previousClient) {
        try {
          await previousClient.end();
        } catch {
        }
      }
      return { ok: true, message: "Switched to pgvector sidecar." };
    }
    surface.setVectorProvider(new ExactLocalVectorProvider(manager));
    await this._closePgClient();
    if (options.persist) {
      await this._config().update("backendMode", mode, this._configTarget());
    }
    return { ok: true, message: "Switched to embedded exact search." };
  }
  async _ensureSidecarReady() {
    const available = await this._container.isAvailable();
    if (!available) {
      return { ok: false, message: "No container engine (docker/podman) detected." };
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const status = await this._container.status(this._sidecarProfile);
      if (status.health === "running") {
        return { ok: true, message: "Sidecar is ready." };
      }
      if (status.health === "missing") {
        return { ok: false, message: "The pgvector sidecar has not been started yet." };
      }
      if (status.health === "stopped" || status.health === "unhealthy") {
        return { ok: false, message: `The pgvector sidecar is not ready: ${status.detail}` };
      }
      await new Promise((resolve3) => setTimeout(resolve3, 1e3));
    }
    return { ok: false, message: "The pgvector sidecar is still starting. Try again in a moment." };
  }
  _previewPageSize() {
    return this._readSettings().previewPageSize;
  }
  _maxQueryRows() {
    return this._readSettings().maxQueryRows;
  }
  _assistantEnabled() {
    return this._readSettings().enableAssistant;
  }
};

// src/update-service.ts
var vscode21 = __toESM(require("vscode"));
var fs18 = __toESM(require("node:fs/promises"));
var os3 = __toESM(require("node:os"));
var path25 = __toESM(require("node:path"));
var import_node_child_process2 = require("node:child_process");
var LAST_CHECK_KEY = "blacksite.updates.lastCheckAt";
var DISMISSED_VERSION_KEY = "blacksite.updates.dismissedVersion";
var UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1e3;
var RELEASES_PAGE_SIZE = 10;
var API_TIMEOUT_MS = 15e3;
var GitHubApiError = class extends Error {
  constructor(message, status, repositorySlug, usedToken) {
    super(message);
    this.status = status;
    this.repositorySlug = repositorySlug;
    this.usedToken = usedToken;
  }
};
function getUpdateConfig() {
  const cfg = vscode21.workspace.getConfiguration("blacksite");
  return {
    checkOnStartup: cfg.get("updates.checkOnStartup", true),
    includePrerelease: cfg.get("updates.includePrerelease", false),
    repository: cfg.get("updates.repository", "").trim()
  };
}
function normalizeGithubRepositorySlug(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const bare = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (bare) return `${bare[1]}/${bare[2]}`;
  const cleaned = trimmed.replace(/^git\+/, "");
  const https3 = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (https3) return `${https3[1]}/${https3[2]}`;
  const ssh = cleaned.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}
function extractRepositoryString(repository) {
  if (typeof repository === "string") return repository;
  if (!repository || typeof repository !== "object") return "";
  const value = repository;
  return typeof value.url === "string" ? value.url : "";
}
function extractVersionFromVsixName(assetName, extensionPackageName = "") {
  const escapedPrefix = extensionPackageName ? escapeRegExp(`${extensionPackageName}-`) : "";
  const prefixed = escapedPrefix ? new RegExp(`${escapedPrefix}(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\.vsix$`, "i") : null;
  const prefixedMatch = prefixed ? assetName.match(prefixed) : null;
  if (prefixedMatch?.[1]) return prefixedMatch[1];
  const genericMatch = assetName.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.vsix$/i);
  return genericMatch?.[1] ?? null;
}
function extractReleaseVersion(release, asset, extensionPackageName) {
  const assetVersion = asset ? extractVersionFromVsixName(asset.name, extensionPackageName) : null;
  if (assetVersion) return assetVersion;
  const text = `${release.tag_name} ${release.name ?? ""}`;
  const genericMatch = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return genericMatch?.[1] ?? null;
}
function selectVsixAsset(assets, extensionPackageName = "") {
  const vsixAssets = assets.filter((asset) => /\.vsix$/i.test(asset.name));
  if (vsixAssets.length === 0) return null;
  if (vsixAssets.length === 1) return vsixAssets[0] ?? null;
  const preferredAssets = extensionPackageName ? vsixAssets.filter((asset) => asset.name.toLowerCase().startsWith(`${extensionPackageName.toLowerCase()}-`)) : vsixAssets;
  const candidateAssets = preferredAssets.length > 0 ? preferredAssets : vsixAssets;
  const newest = candidateAssets.map((asset) => ({
    asset,
    version: extractVersionFromVsixName(asset.name, extensionPackageName)
  })).filter((entry) => !!entry.version).sort((left, right) => compareVersions(right.version, left.version))[0];
  if (newest) return newest.asset;
  return candidateAssets[0] ?? null;
}
function parseVersion(version) {
  const normalized = version.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const [corePartRaw, prereleasePart] = normalized.split("-", 2);
  const corePart = corePartRaw ?? normalized;
  const coreSegments = corePart.split(".").map((segment) => Number.parseInt(segment, 10));
  if (coreSegments.length === 0 || coreSegments.some((segment) => Number.isNaN(segment))) return null;
  const prerelease = prereleasePart ? prereleasePart.split(".").map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment) : [];
  return { core: coreSegments, prerelease };
}
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" });
  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === void 0) return -1;
    if (rightPart === void 0) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart > rightPart ? 1 : -1;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart, void 0, { numeric: true, sensitivity: "base" });
  }
  return 0;
}
function resolveRepositorySlug(configuredRepository, extensionPackage) {
  if (configuredRepository) return normalizeGithubRepositorySlug(configuredRepository);
  return normalizeGithubRepositorySlug(extractRepositoryString(extensionPackage.repository));
}
function buildGitHubApiUrl(repositorySlug) {
  return `https://api.github.com/repos/${repositorySlug}/releases?per_page=${RELEASES_PAGE_SIZE}`;
}
function buildGitHubHeaders(token, accept) {
  const headers = {
    Accept: accept,
    "User-Agent": "blacksite-vscode-updater"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
function isPrivateRepoAuthStatus(status) {
  return status === 403 || status === 404;
}
function describeGitHubHttpError(status, statusText, repositorySlug, usedToken) {
  if (!usedToken && isPrivateRepoAuthStatus(status)) {
    return `GitHub returned ${status} ${statusText}. ${repositorySlug} may be private. Set a GitHub PAT with Blacksite: Set API Key and retry.`;
  }
  if (usedToken && status === 404) {
    return `GitHub returned 404 ${statusText}. ${repositorySlug} was not accessible with the configured GitHub token. Verify the repo name and token access.`;
  }
  if (usedToken && status === 403) {
    return `GitHub returned 403 ${statusText}. The configured GitHub token does not have access to ${repositorySlug}, or the GitHub API rate limit was reached.`;
  }
  return `GitHub returned ${status} ${statusText}.`;
}
function buildCliCommandCandidates() {
  const baseName = /insider/i.test(vscode21.env.appName) ? "code-insiders" : "code";
  const appRoot = vscode21.env.appRoot;
  const candidates = /* @__PURE__ */ new Set([
    path25.resolve(appRoot, "bin", baseName),
    path25.resolve(appRoot, "..", "..", "bin", baseName),
    path25.resolve(appRoot, "..", "..", "..", "bin", `${baseName}.cmd`),
    path25.resolve(appRoot, "..", "..", "..", "bin", baseName),
    process.platform === "win32" ? `${baseName}.cmd` : baseName,
    baseName
  ]);
  return Array.from(candidates);
}
function defaultCommandRunner2(command, args) {
  return new Promise((resolve3) => {
    const child = (0, import_node_child_process2.spawn)(command, args, {
      windowsHide: true,
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve3({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve3({ code: code ?? 1, stdout, stderr });
    });
  });
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var ExtensionUpdater = class {
  constructor(context, secrets, fetcher = fetch, runCommand = defaultCommandRunner2) {
    this.context = context;
    this.secrets = secrets;
    this.fetcher = fetcher;
    this.runCommand = runCommand;
  }
  async maybeCheckForUpdatesOnStartup() {
    if (this.context.extensionMode !== vscode21.ExtensionMode.Production) return;
    if (vscode21.env.uiKind !== vscode21.UIKind.Desktop) return;
    const config = getUpdateConfig();
    if (!config.checkOnStartup) return;
    const lastCheck = this.context.globalState.get(LAST_CHECK_KEY) ?? 0;
    if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    await this.checkForUpdates({ manual: false });
  }
  async checkForUpdates(options) {
    const extensionPackage = this.context.extension.packageJSON;
    const config = getUpdateConfig();
    const repositorySlug = resolveRepositorySlug(config.repository, extensionPackage);
    if (!repositorySlug) {
      if (options.manual) {
        void vscode21.window.showWarningMessage(
          "Blacksite: No valid GitHub repository is configured for VS Code extension updates."
        );
      }
      return;
    }
    const currentVersion = String(extensionPackage.version ?? "0.0.0");
    try {
      const updateInfo = await this.fetchLatestRelease(repositorySlug, config.includePrerelease, String(extensionPackage.name ?? ""));
      if (!updateInfo || compareVersions(updateInfo.version, currentVersion) <= 0) {
        if (options.manual) {
          void vscode21.window.showInformationMessage(`Blacksite ${currentVersion} is up to date.`);
        }
        return;
      }
      if (!options.manual) {
        const dismissedVersion = this.context.globalState.get(DISMISSED_VERSION_KEY);
        if (dismissedVersion === updateInfo.version) return;
      }
      await this.promptForUpdate(currentVersion, updateInfo, options.manual);
    } catch (error) {
      if (options.manual) {
        const message = error instanceof Error ? error.message : String(error);
        const actions = this.shouldOfferGitHubTokenSetup(error) ? ["Set GitHub Token"] : [];
        const action = await vscode21.window.showWarningMessage(
          `Blacksite: Update check failed. ${message}`,
          ...actions
        );
        if (action === "Set GitHub Token" && this.secrets) {
          const token = await this.secrets.promptForApiKey("github");
          if (token) {
            await this.checkForUpdates(options);
            return;
          }
        }
      }
    } finally {
      await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
    }
  }
  async fetchLatestRelease(repositorySlug, includePrerelease, extensionPackageName) {
    const githubToken = await this.secrets?.getApiKey("github");
    const response = await this.fetcher(buildGitHubApiUrl(repositorySlug), {
      headers: buildGitHubHeaders(githubToken, "application/vnd.github+json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new GitHubApiError(
        describeGitHubHttpError(response.status, response.statusText, repositorySlug, !!githubToken),
        response.status,
        repositorySlug,
        !!githubToken
      );
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid releases payload.");
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const release = item;
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = selectVsixAsset(assets, extensionPackageName);
      if (!asset) continue;
      const version = extractReleaseVersion(release, asset, extensionPackageName);
      if (!version) continue;
      return {
        version,
        asset,
        releaseUrl: release.html_url,
        releaseTitle: release.name?.trim() || release.tag_name
      };
    }
    return null;
  }
  async promptForUpdate(currentVersion, updateInfo, manual) {
    const action = await vscode21.window.showInformationMessage(
      `Blacksite ${updateInfo.version} is available (installed ${currentVersion}).`,
      "Update Now",
      "View Release",
      "Later"
    );
    if (action === "Update Now") {
      await this.installUpdate(updateInfo);
      return;
    }
    if (action === "View Release") {
      await vscode21.env.openExternal(vscode21.Uri.parse(updateInfo.releaseUrl));
    }
    if (!manual) {
      await this.context.globalState.update(DISMISSED_VERSION_KEY, updateInfo.version);
    }
  }
  async installUpdate(updateInfo) {
    try {
      const vsixPath = await vscode21.window.withProgress(
        {
          location: vscode21.ProgressLocation.Notification,
          title: `Installing Blacksite ${updateInfo.version}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: "Downloading VSIX\u2026" });
          const downloadedPath = await this.downloadVsix(updateInfo.asset);
          progress.report({ message: "Installing into VS Code\u2026" });
          await this.installVsix(downloadedPath);
          return downloadedPath;
        }
      );
      await this.context.globalState.update(DISMISSED_VERSION_KEY, void 0);
      const action = await vscode21.window.showInformationMessage(
        `Blacksite ${updateInfo.version} was installed. Reload Window to activate it.`,
        "Reload Window",
        "View Release"
      );
      if (action === "Reload Window") {
        await vscode21.commands.executeCommand("workbench.action.reloadWindow");
      } else if (action === "View Release") {
        await vscode21.env.openExternal(vscode21.Uri.parse(updateInfo.releaseUrl));
      }
      void vsixPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode21.window.showWarningMessage(
        `Blacksite: Automatic update failed. ${message}`,
        "View Release"
      );
      if (action === "View Release") {
        await vscode21.env.openExternal(vscode21.Uri.parse(updateInfo.releaseUrl));
      }
    }
  }
  async downloadVsix(asset) {
    const tempDir = path25.join(os3.tmpdir(), "blacksite-vscode-updates");
    await fs18.mkdir(tempDir, { recursive: true });
    const destination = path25.join(tempDir, asset.name);
    const githubToken = await this.secrets?.getApiKey("github");
    const downloadUrl = githubToken && asset.url ? asset.url : asset.browser_download_url;
    const response = await this.fetcher(downloadUrl, {
      headers: buildGitHubHeaders(githubToken, "application/octet-stream"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`VSIX download failed with ${response.status} ${response.statusText}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs18.writeFile(destination, bytes);
    return destination;
  }
  async installVsix(vsixPath) {
    const candidates = buildCliCommandCandidates();
    let lastFailure = "Unable to locate a usable VS Code CLI command.";
    for (const command of candidates) {
      const result = await this.runCommand(command, ["--install-extension", vsixPath, "--force"]);
      if (result.code === 0) return;
      const output = `${result.stderr}
${result.stdout}`.trim();
      if (output) lastFailure = output;
    }
    throw new Error(lastFailure);
  }
  shouldOfferGitHubTokenSetup(error) {
    return error instanceof GitHubApiError && !error.usedToken && isPrivateRepoAuthStatus(error.status) && !!this.secrets;
  }
};

// src/extension.ts
var chatProvider;
function readCommandPolicy() {
  const cfg = vscode22.workspace.getConfiguration("blacksite.permissions");
  const list = (key) => {
    const value = cfg.get(key, []);
    return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
  };
  return {
    allowedCommands: list("allowedCommands"),
    deniedCommands: list("deniedCommands"),
    autoApprove: list("autoApprove"),
    allowEvalFlags: cfg.get("allowEvalFlags", false)
  };
}
function activate(context) {
  const workspaceRoot = vscode22.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode22.workspace.getConfiguration("blacksite").get("workspaceRoot") ?? process.cwd();
  const runtime = new LocalRuntime(workspaceRoot, readCommandPolicy());
  context.subscriptions.push(
    vscode22.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blacksite.permissions")) runtime.setPolicy(readCommandPolicy());
    })
  );
  const secrets = new SecretStore(context.secrets);
  const sessionStore = new SessionStore(context);
  const memory = new MemoryStore(workspaceRoot);
  const baseContext = new BaseContextStore(workspaceRoot);
  const planning = new PlanningStore(workspaceRoot);
  try {
    memory.ensureInitialized();
  } catch {
  }
  try {
    baseContext.ensureInitialized();
  } catch {
  }
  try {
    planning.ensureInitialized();
  } catch {
  }
  context.subscriptions.push(baseContext, planning);
  const diagnostics = new DiagnosticsPublisher(workspaceRoot);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });
  const dataWorkbench = createDataWorkbench(context, workspaceRoot);
  context.subscriptions.push({ dispose: () => dataWorkbench.dispose() });
  chatProvider = new ChatProvider(context, runtime, secrets, sessionStore, workspaceRoot, memory, diagnostics, planning, dataWorkbench.surface ?? void 0);
  const baseContextProvider = new BaseContextProvider(context, workspaceRoot, baseContext);
  const planningProvider = new PlanningProvider(context, planning);
  const dataProvider = new DataProvider(context, workspaceRoot, dataWorkbench);
  const updater = new ExtensionUpdater(context, secrets);
  context.subscriptions.push(baseContextProvider, planningProvider, dataProvider);
  if (dataWorkbench.surface) {
    dataProvider.setAssistant(chatProvider.createDataAssistant(dataWorkbench.surface));
  }
  dataProvider.setEmbedder(chatProvider.createEmbedder());
  context.subscriptions.push(
    vscode22.window.registerWebviewViewProvider("blacksite.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode22.window.registerWebviewViewProvider("blacksite.plans", planningProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode22.window.registerWebviewViewProvider("blacksite.baseContext", baseContextProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode22.window.registerWebviewViewProvider("blacksite.data", dataProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.openData", () => {
      void vscode22.commands.executeCommand("blacksite.data.focus");
    }),
    vscode22.commands.registerCommand("blacksite.refreshData", () => {
      dataProvider.refresh();
    }),
    vscode22.commands.registerCommand("blacksite.runQuery", async () => {
      const sql = await vscode22.window.showInputBox({
        title: "Blacksite: Run Database Query",
        prompt: "Enter SQL to load into the Data workbench Query tab",
        placeHolder: "SELECT * FROM v_recent_agent_activity LIMIT 50"
      });
      if (!sql) return;
      await vscode22.commands.executeCommand("blacksite.data.focus");
      dataProvider.loadQueryIntoEditor(sql);
    }),
    vscode22.commands.registerCommand("blacksite.openSavedQuery", async () => {
      const surface = dataWorkbench.surface;
      if (!surface) {
        vscode22.window.showWarningMessage("Blacksite: The database engine is unavailable.");
        return;
      }
      const saved = surface.listSavedQueries();
      if (saved.length === 0) {
        vscode22.window.showInformationMessage("Blacksite: No saved queries yet.");
        return;
      }
      const pick = await vscode22.window.showQuickPick(
        saved.map((q) => ({ label: q.name, description: q.sql.slice(0, 80), id: q.id })),
        { title: "Open Saved Query", placeHolder: "Select a saved query" }
      );
      if (!pick) return;
      const query = surface.getSavedQuery(pick.id);
      if (query) {
        await vscode22.commands.executeCommand("blacksite.data.focus");
        dataProvider.loadQueryIntoEditor(query.sql);
      }
    })
  );
  context.subscriptions.push(
    vscode22.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new BlacksiteCodeActionProvider(),
      { providedCodeActionKinds: BlacksiteCodeActionProvider.providedCodeActionKinds }
    )
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.openChat", () => {
      void vscode22.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.clearChat", () => {
      chatProvider?.clearMessages();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.cancelRun", () => {
      chatProvider?.cancelCurrentRun();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.setApiKey", async () => {
      const provider = await vscode22.window.showQuickPick(
        [
          { label: "anthropic", value: "anthropic" },
          { label: "openrouter", value: "openrouter" },
          { label: "openai", value: "openai" },
          { label: "bedrock", value: "bedrock", description: "AWS region + access/secret keys" },
          { label: "github", value: "github" },
          { label: "gitlab", value: "gitlab" },
          { label: "jira", value: "jira" },
          { label: "confluence", value: "confluence" },
          { label: "salesforce", value: "salesforce" }
        ],
        { placeHolder: "Select provider", title: "Blacksite: Set API Key / Credentials" }
      );
      if (!provider) return;
      await secrets.promptForApiKey(provider.value);
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.explainSelection", () => {
      const ctx = getSelectionContext();
      if (!ctx) {
        vscode22.window.showWarningMessage("Blacksite: Select some code first.");
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode22.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.askAboutFile", (uri) => {
      const target = uri ?? vscode22.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode22.window.showWarningMessage("Blacksite: No file selected.");
        return;
      }
      const ctx = getFileContext(target);
      if (!ctx) {
        vscode22.window.showWarningMessage(`Blacksite: Could not read ${path26.basename(target.fsPath)}.`);
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode22.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand(
      "blacksite.fixDiagnostic",
      async (uri, diagnostic) => {
        const base = getDiagnosticContext(uri, diagnostic);
        let ctx = base;
        try {
          const doc = await vscode22.workspace.openTextDocument(uri);
          const startLine = Math.max(0, diagnostic.range.start.line - 3);
          const endLine = Math.min(doc.lineCount - 1, diagnostic.range.end.line + 3);
          const snippet = doc.getText(new vscode22.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
          ctx = { ...base, text: `${base.text}

\`\`\`${doc.languageId}
${snippet}
\`\`\`` };
        } catch {
        }
        chatProvider?.injectContext(ctx.text, ctx.label);
        void vscode22.commands.executeCommand("blacksite.chat.focus");
      }
    )
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.manageMcp", () => {
      McpPanel.show(context);
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.clearProblems", () => {
      diagnostics.clear();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.closeBrowser", async () => {
      await chatProvider?.closeBrowser();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.showLogs", () => {
      chatProvider?.showLogs();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.compactConversation", async () => {
      await chatProvider?.compactConversation();
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.addFileToBaseContext", async (uri) => {
      await baseContextProvider.promptAndAddFile(uri);
    })
  );
  context.subscriptions.push(
    vscode22.commands.registerCommand("blacksite.checkForUpdates", async () => {
      await updater.checkForUpdates({ manual: true });
    })
  );
  const watcher = registerFileWatcher(workspaceRoot, () => {
  });
  context.subscriptions.push(watcher);
  if (hasCheckpoint(context)) {
    const cp = loadCheckpoint(context);
    if (cp) {
      setTimeout(() => {
        void chatProvider?.offerCheckpointResume(cp);
      }, 1500);
    }
  }
  setTimeout(() => {
    void updater.maybeCheckForUpdatesOnStartup();
  }, 2500);
}
function deactivate() {
  chatProvider = void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
