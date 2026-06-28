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
var vscode18 = __toESM(require("vscode"));
var path20 = __toESM(require("path"));

// ../../packages/local-runtime/src/runtime.ts
var import_os4 = __toESM(require("os"), 1);

// ../../packages/local-runtime/src/shell.ts
var import_child_process2 = require("child_process");
var import_fs2 = __toESM(require("fs"), 1);
var import_os2 = __toESM(require("os"), 1);
var import_path3 = __toESM(require("path"), 1);

// ../../packages/local-runtime/src/security.ts
var import_path = __toESM(require("path"), 1);
function normalizeCommandName(command) {
  return import_path.default.basename(String(command || "")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
}
var DESTRUCTIVE_BINARIES = /* @__PURE__ */ new Set(["rm", "rmdir", "del", "rd", "erase", "dd", "shred", "truncate"]);
var NETWORK_BINARIES = /* @__PURE__ */ new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat"]);
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
function buildDescription(command, args) {
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
  "env"
]);
function isAllowedCommand(command, extraAllowed, allowedSet = DEFAULT_ALLOWED_COMMANDS) {
  const base = normalizeCommandName(command);
  if (allowedSet.has(base)) return true;
  if (extraAllowed) {
    const normalizedExtra = extraAllowed.map((e) => normalizeCommandName(e));
    return normalizedExtra.includes(base);
  }
  return false;
}

// ../../packages/local-runtime/src/process-manager.ts
var import_child_process = require("child_process");
var import_fs = __toESM(require("fs"), 1);
var import_os = __toESM(require("os"), 1);
var import_path2 = __toESM(require("path"), 1);
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
  processes = /* @__PURE__ */ new Map();
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
    const env = {};
    for (const key of keys) {
      if (typeof source[key] === "string") env[key] = source[key];
    }
    env.PYTHONIOENCODING = "utf-8";
    return env;
  }
  resolveCwd(requested) {
    const raw = String(requested ?? "").trim();
    const cwd = raw ? import_path2.default.isAbsolute(raw) ? raw : import_path2.default.join(import_os.default.homedir(), raw) : import_os.default.homedir();
    try {
      const stat = import_fs.default.statSync(cwd);
      if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${cwd}` };
      return { ok: true, cwd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  launch(options) {
    const { command, args, cwd, allowStdin = false } = options;
    const child = (0, import_child_process.spawn)(command, args, {
      cwd,
      env: this.buildEnv(),
      shell: false,
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
  const env = {};
  for (const key of keys) {
    if (typeof src[key] === "string") env[key] = src[key];
  }
  env.PYTHONIOENCODING = "utf-8";
  return env;
}
function resolveCwd(requested) {
  const raw = String(requested || "").trim();
  const cwd = raw ? import_path3.default.isAbsolute(raw) ? raw : import_path3.default.join(import_os2.default.homedir(), raw) : import_os2.default.homedir();
  try {
    const stat = import_fs2.default.statSync(cwd);
    if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${cwd}` };
    return { ok: true, cwd };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function handleShell(payload) {
  const command = String(payload.command || "").trim();
  const args = Array.isArray(payload.args) ? payload.args.map((a) => String(a)).filter(Boolean) : [];
  const confirmed = payload.confirmed === true;
  const timeoutMs = Math.min(Math.max(Number(payload.timeout) || SHELL_TIMEOUT_MS, 1e3), 10 * 60 * 1e3);
  if (!command) return { ok: false, error: "Missing command." };
  if (!isAllowedCommand(command, payload.allowedBinaries)) {
    return { ok: false, error: `Command "${command}" is not in the allowed list.` };
  }
  const cwdResult = resolveCwd(payload.cwd ?? "");
  if (!cwdResult.ok) return cwdResult;
  const cwd = cwdResult.cwd;
  const { tier } = classifyOperation(command, args);
  if ((tier === "network" || tier === "destructive") && !confirmed) {
    return { ok: true, requiresConfirmation: true, tier, description: buildDescription(command, args) };
  }
  const result = (0, import_child_process2.spawnSync)(command, args, {
    cwd,
    env: buildEnv(),
    shell: false,
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
    tier,
    cwd
  };
}

// ../../packages/local-runtime/src/file-ops.ts
var import_fs3 = __toESM(require("fs"), 1);
var import_os3 = __toESM(require("os"), 1);
var import_path4 = __toESM(require("path"), 1);
var READ_MAX_BYTES = 256 * 1024;
var EXCLUDED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "out", ".next", "__pycache__", ".venv", "venv"]);
function resolvePath(target) {
  const p = String(target ?? "").trim();
  return p && import_path4.default.isAbsolute(p) ? p : import_path4.default.join(import_os3.default.homedir(), p || "");
}
function listDirectory(target, limit = 500) {
  const resolved = resolvePath(target) || import_os3.default.homedir();
  try {
    const raw = import_fs3.default.readdirSync(resolved, { withFileTypes: true });
    const entries = raw.slice(0, limit).map((entry) => {
      let sizeBytes = null;
      let modifiedAt = null;
      try {
        const stat = import_fs3.default.statSync(import_path4.default.join(resolved, entry.name));
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
function readFile(target) {
  const filePath = String(target ?? "").trim();
  if (!filePath) return { ok: false, error: "Missing path." };
  const resolved = import_path4.default.isAbsolute(filePath) ? filePath : import_path4.default.join(import_os3.default.homedir(), filePath);
  try {
    const stat = import_fs3.default.statSync(resolved);
    if (stat.size > READ_MAX_BYTES) return { ok: false, error: `File too large (${stat.size} bytes, max ${READ_MAX_BYTES}).` };
    const content = import_fs3.default.readFileSync(resolved, "utf8");
    return { ok: true, path: resolved, content, sizeBytes: stat.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function writeFile(target, content, confirmed) {
  const filePath = String(target ?? "").trim();
  if (!filePath) return { ok: false, error: "Missing path." };
  if (typeof content !== "string") return { ok: false, error: "content must be a string." };
  const resolved = import_path4.default.isAbsolute(filePath) ? filePath : import_path4.default.join(import_os3.default.homedir(), filePath);
  if (!confirmed) return { ok: false, requiresConfirmation: true, tier: "write", description: `Write file: ${resolved}`, error: "Confirmation required." };
  try {
    import_fs3.default.mkdirSync(import_path4.default.dirname(resolved), { recursive: true });
    import_fs3.default.writeFileSync(resolved, content, "utf8");
    return { ok: true, path: resolved, bytesWritten: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function deletePath(target, confirmed) {
  const targetPath = String(target ?? "").trim();
  if (!targetPath) return { ok: false, error: "Missing path." };
  const resolved = import_path4.default.isAbsolute(targetPath) ? targetPath : import_path4.default.join(import_os3.default.homedir(), targetPath);
  if (!confirmed) return { ok: false, requiresConfirmation: true, tier: "write", description: `Delete: ${resolved}`, error: "Confirmation required." };
  try {
    const stat = import_fs3.default.statSync(resolved);
    if (stat.isDirectory()) {
      import_fs3.default.rmSync(resolved, { recursive: true, force: true });
    } else {
      import_fs3.default.unlinkSync(resolved);
    }
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function createDirectory(target) {
  const name = String(target ?? "").trim().replace(/[<>:"/\\|?*]/g, "_");
  if (!name) return { ok: false, error: "Missing path." };
  const projectPath = import_path4.default.isAbsolute(target) ? target : import_path4.default.join(import_os3.default.homedir(), "Documents", name);
  try {
    import_fs3.default.mkdirSync(projectPath, { recursive: true });
    return { ok: true, path: projectPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function glob(searchPath, pattern, maxResults = 200) {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  const resolved = resolvePath(searchPath) || process.cwd();
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
      entries = import_fs3.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const childPath = import_path4.default.join(dir, entry.name);
      const relPath = import_path4.default.relative(resolved, childPath).replace(/\\/g, "/");
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
    if (!import_fs3.default.statSync(resolved).isDirectory()) return { ok: false, error: "path must be a directory." };
    walk(resolved, 0);
    return { ok: true, path: resolved, pattern, results, truncated: results.length >= limit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
var SEARCH_MAX_FILE_BYTES = 512 * 1024;
function searchFiles(searchPath, pattern, options = {}) {
  if (!pattern) return { ok: false, error: "Missing pattern." };
  const resolved = resolvePath(searchPath) || import_os3.default.homedir();
  const limit = Math.min(options.maxResults ?? 100, 500);
  let regex;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "" : "i");
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
  const results = [];
  function walk(dir, depth) {
    if (depth > 8 || results.length >= limit) return;
    let entries;
    try {
      entries = import_fs3.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(import_path4.default.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const filePath = import_path4.default.join(dir, entry.name);
        if (options.include && !entry.name.includes(options.include) && !filePath.includes(options.include)) continue;
        let stat;
        try {
          stat = import_fs3.default.statSync(filePath);
        } catch {
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        let text;
        try {
          text = import_fs3.default.readFileSync(filePath, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          if (regex.test(lines[i])) {
            results.push({ file: import_path4.default.relative(resolved, filePath).replace(/\\/g, "/"), line: i + 1, text: lines[i].slice(0, 300) });
          }
        }
      }
    }
  }
  try {
    if (!import_fs3.default.statSync(resolved).isDirectory()) return { ok: false, error: "path must be a directory." };
    walk(resolved, 0);
    return { ok: true, path: resolved, pattern, results, truncated: results.length >= limit };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ../../packages/local-runtime/src/git.ts
var import_child_process3 = require("child_process");
var import_path5 = __toESM(require("path"), 1);
var GIT_TIMEOUT_MS = 3e4;
var LOG_UNIT = "";
var LOG_RECORD = "";
function safeStr(value) {
  return typeof value === "string" ? value.trim() : "";
}
function runGitSync(cwd, args, env) {
  const result = (0, import_child_process3.spawnSync)("git", args, {
    cwd,
    encoding: "utf8",
    env,
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
function resolveCwd2(rootPath, requested) {
  const rel2 = String(requested || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = import_path5.default.resolve(rootPath, rel2 || ".");
  const relative8 = import_path5.default.relative(rootPath, resolved);
  if (relative8 === ".." || relative8.startsWith(`..${import_path5.default.sep}`) || import_path5.default.isAbsolute(relative8)) {
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
function gitStatus(cwd, env) {
  const res = runGitSync(cwd, ["status", "--porcelain=v2", "--branch"], env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git status failed." };
  return { ok: true, data: parseGitStatus(res.stdout) };
}
function gitDiff(cwd, env, payload) {
  const args = ["diff", "--no-color"];
  if (payload["staged"] === true) args.push("--cached");
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env);
  if (!res.success && res.stderr) return { ok: false, code: "git_failed", message: res.stderr };
  return { ok: true, data: { ...parseGitDiff(res.stdout), raw: res.stdout.slice(0, 5e4) } };
}
function gitLog(cwd, env, payload) {
  const limit = Math.min(Math.max(Number(payload["limit"]) || 20, 1), 200);
  const format = ["%H", "%h", "%an", "%aI", "%D", "%s"].join(LOG_UNIT) + LOG_RECORD;
  const args = ["log", `-n`, String(limit), `--format=${format}`];
  const file = safeStr(payload["path"]);
  if (file) args.push("--", file);
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git log failed." };
  return { ok: true, data: { commits: parseGitLog(res.stdout) } };
}
function gitAdd(cwd, env, payload) {
  const all = payload["all"] === true;
  const file = safeStr(payload["path"]);
  if (!all && !file) return { ok: false, code: "path_missing", message: "A file path or all:true is required to stage." };
  const args = all ? ["add", "-A"] : ["add", "--", file];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git add failed." };
  return { ok: true, data: { success: true, path: file || "*", all } };
}
function gitRestore(cwd, env, payload) {
  const file = safeStr(payload["path"]);
  if (!file) return { ok: false, code: "path_missing", message: "A file path is required." };
  const staged = payload["staged"] === true;
  const args = staged ? ["restore", "--staged", "--", file] : ["restore", "--", file];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: false, code: "git_failed", message: res.stderr || "git restore failed." };
  return { ok: true, data: { success: true, path: file, staged } };
}
function gitCommit(cwd, env, payload) {
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
function gitCheckout(cwd, env, payload) {
  const branch = safeStr(payload["branch"]);
  if (!branch) return { ok: false, code: "branch_missing", message: "A branch name is required." };
  const create = payload["create"] === true;
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const res = runGitSync(cwd, args, env);
  if (!res.success) return { ok: true, data: { success: false, branch, created: false, stderr: res.stderr } };
  return { ok: true, data: { success: true, branch, created: create } };
}
function gitBranch(cwd, env, payload) {
  const action = ["list", "create", "delete"].includes(payload["action"]) ? payload["action"] : "list";
  if (action === "create") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to create." };
    const res2 = runGitSync(cwd, ["branch", name], env);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git branch failed." };
    return { ok: true, data: { action, created: name } };
  }
  if (action === "delete") {
    const name = safeStr(payload["name"]);
    if (!name) return { ok: false, code: "name_missing", message: "A branch name is required to delete." };
    const res2 = runGitSync(cwd, ["branch", "-D", name], env);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git branch -D failed." };
    return { ok: true, data: { action, deleted: name } };
  }
  const res = runGitSync(cwd, [
    "branch",
    "--all",
    "--format=%(refname:short)%(if)%(HEAD)%(then)	*%(end)%(if)%(upstream:short)%(then)	%(upstream:short)%(end)"
  ], env);
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
function gitStash(cwd, env, payload) {
  const action = ["push", "pop", "list"].includes(payload["action"]) ? payload["action"] : "list";
  if (action === "list") {
    const res2 = runGitSync(cwd, ["stash", "list"], env);
    if (!res2.success) return { ok: false, code: "git_failed", message: res2.stderr || "git stash list failed." };
    const stashes = res2.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
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
function gitPush(cwd, env, payload) {
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
  const res = runGitSync(cwd, args, env);
  return {
    ok: true,
    data: { success: res.success, exitCode: res.exitCode, remote: remote || "origin", branch, stdout: res.stdout.trim(), stderr: res.stderr.trim() }
  };
}
function handleGitOp(rootPath, payload, env) {
  let cwd;
  try {
    cwd = resolveCwd2(rootPath, safeStr(payload["cwd"]));
  } catch (error) {
    return { ok: false, code: "cwd_invalid", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    switch (payload["op"]) {
      case "status":
        return gitStatus(cwd, env);
      case "diff":
        return gitDiff(cwd, env, payload);
      case "log":
        return gitLog(cwd, env, payload);
      case "add":
        return gitAdd(cwd, env, payload);
      case "restore":
        return gitRestore(cwd, env, payload);
      case "commit":
        return gitCommit(cwd, env, payload);
      case "checkout":
        return gitCheckout(cwd, env, payload);
      case "branch":
        return gitBranch(cwd, env, payload);
      case "stash":
        return gitStash(cwd, env, payload);
      case "push":
        return gitPush(cwd, env, payload);
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
  return new Promise((resolve2, reject) => {
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
            resolve2(parsed);
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
            resolve2(parsed);
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
var import_fs4 = __toESM(require("fs"), 1);
var import_path6 = __toESM(require("path"), 1);
function detectFramework(root) {
  const has = (f) => import_fs4.default.existsSync(import_path6.default.join(root, f));
  if (has("go.mod")) return "go";
  if (has("pytest.ini") || has("setup.cfg")) return "pytest";
  if (has("pyproject.toml")) {
    try {
      const txt = import_fs4.default.readFileSync(import_path6.default.join(root, "pyproject.toml"), "utf8");
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
      const pkg = JSON.parse(import_fs4.default.readFileSync(import_path6.default.join(root, "package.json"), "utf8"));
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
  const cwd = opts.cwd ? import_path6.default.resolve(root, opts.cwd) : root;
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
  let jsonStr = res.stdout ?? "";
  const jsonStart = jsonStr.indexOf("{");
  if (jsonStart > 0) jsonStr = jsonStr.slice(jsonStart);
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
  const args = ["vitest", "run", "--reporter=json", "--reporter=default"];
  if (filter) args.push(filter);
  const res = (0, import_child_process5.spawnSync)("npx", args, { cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const raw = (res.stdout ?? "") + (res.stderr ?? "");
  const jsonStart = (res.stdout ?? "").indexOf("{");
  let jsonStr = jsonStart >= 0 ? (res.stdout ?? "").slice(jsonStart) : "";
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
  return {
    ok: false,
    framework: fw,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [{ test: "(runner)", message: "Could not parse test output. Check rawOutput for details." }],
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
var import_fs5 = __toESM(require("fs"), 1);
var import_path7 = __toESM(require("path"), 1);
var WORKTREE_DIR = ".blacksite/worktrees";
function createWorktree(repoRoot, taskId) {
  const safe = taskId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const branch = `blacksite/subagent-${safe}-${Date.now().toString(36)}`;
  const worktreePath = import_path7.default.join(repoRoot, WORKTREE_DIR, safe);
  import_fs5.default.mkdirSync(import_path7.default.join(repoRoot, WORKTREE_DIR), { recursive: true });
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
  const branchName = import_path7.default.basename(worktreePath);
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
  return new Promise((resolve2, reject) => {
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
      res.on("end", () => resolve2({ statusCode: res.statusCode ?? 0, body: data }));
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
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot ?? import_os4.default.homedir();
    this.processes = new ProcessManager();
  }
  async handleMessage(message) {
    const payload = message.payload ?? {};
    try {
      let result;
      switch (message.type) {
        // ── Shell ──────────────────────────────────────────────────────────────
        case "system.shell":
          result = handleShell(payload);
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
          if (!isAllowedCommand(command, payload["allowedBinaries"])) {
            result = { ok: false, error: `Command "${command}" is not in the allowed list.` };
            break;
          }
          const cwdResult = this.processes.resolveCwd(String(payload["cwd"] ?? ""));
          if (!cwdResult.ok) {
            result = cwdResult;
            break;
          }
          const { tier } = classifyOperation(command, args);
          if ((tier === "network" || tier === "destructive") && !confirmed) {
            result = { ok: true, requiresConfirmation: true, tier, description: buildDescription(command, args) };
            break;
          }
          const record = this.processes.launch({ command, args, cwd: cwdResult.cwd, allowStdin });
          result = { ok: true, process: this.processes.serialize(record.handleId), tier };
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
          result = listDirectory(String(payload["path"] ?? ""));
          break;
        case "system.read_file":
          result = readFile(String(payload["path"] ?? ""));
          break;
        case "system.write_file":
          result = writeFile(
            String(payload["path"] ?? ""),
            String(payload["content"] ?? ""),
            payload["confirmed"] === true
          );
          break;
        case "system.delete_path":
          result = deletePath(String(payload["path"] ?? ""), payload["confirmed"] === true);
          break;
        case "system.create_project":
          result = createDirectory(String(payload["path"] ?? payload["name"] ?? ""));
          break;
        case "system.mount_directory": {
          const dirPath = String(payload["path"] ?? "").trim();
          if (!dirPath) {
            result = { ok: false, error: "Missing path." };
            break;
          }
          const check = listDirectory(dirPath, 1);
          result = check.ok ? { ok: true, path: dirPath } : { ok: false, error: `Not a directory: ${dirPath}` };
          break;
        }
        case "system.glob":
          result = glob(
            String(payload["path"] ?? ""),
            String(payload["pattern"] ?? ""),
            payload["maxResults"]
          );
          break;
        case "system.search_files":
          result = searchFiles(String(payload["path"] ?? ""), String(payload["pattern"] ?? ""), {
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
var vscode12 = __toESM(require("vscode"));
var fs11 = __toESM(require("fs"));
var path15 = __toESM(require("path"));

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
    "Execute a one-shot shell command and return stdout/stderr. Use for build, test, lint, install, and scripted tasks.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Command arguments"),
      cwd: str("Working directory absolute path or relative to workspace root"),
      confirmed: bool("Set true to confirm network or destructive operations after review"),
      timeout: num("Timeout in milliseconds, max 600000"),
      allowedBinaries: arr({ type: "string" }, "Additional binaries to allow beyond defaults")
    },
    ["command"]
  ),
  tool(
    "process_start",
    "system.process.start",
    "Launch a long-running background process such as a dev server, watcher, or REPL. Returns a handleId for follow-up process tools.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Arguments"),
      cwd: str("Working directory"),
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
    "List files and directories at a path.",
    { path: str("Absolute path or path relative to the home directory") },
    ["path"]
  ),
  tool(
    "file_read",
    "system.read_file",
    "Read the full contents of a file up to 256 KB.",
    { path: str("Absolute file path or path relative to the home directory") },
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
    "Write or overwrite a whole file with the provided content. Use for creating new files; prefer file_edit for changing existing files. Requires confirmed:true.",
    {
      path: str("Absolute file path"),
      content: str("Full file content to write"),
      confirmed: bool("Must be true after reviewing the write")
    },
    ["path", "content", "confirmed"]
  ),
  tool(
    "file_delete",
    "system.delete_path",
    "Delete a file or directory. Requires confirmed:true.",
    {
      path: str("Absolute path to delete"),
      confirmed: bool("Must be true after reviewing the delete")
    },
    ["path", "confirmed"]
  ),
  tool(
    "file_mkdir",
    "system.create_project",
    "Create a directory. Use an absolute path for workspace locations; relative paths resolve under the user's home/documents area.",
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
      path: str("Root directory to search"),
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
var PLANNING_TOOLS = [
  tool(
    "plan_create",
    "planning.create",
    "Create a persistent phased plan for the current task or project slice. Use for multi-phase work where the user should be able to see objectives, current phase, and remaining phases across conversations.",
    {
      title: str("Plan title"),
      summary: str("Short summary of the overall objective"),
      status: str("Optional initial status: draft | active"),
      phases: arr(
        obj("", {
          title: str("Phase title"),
          objective: str("Optional objective for this phase"),
          steps: arr(
            obj("", {
              title: str("Step title"),
              detail: str("Optional implementation detail or verification note")
            }, ["title"]),
            "Ordered steps in this phase"
          )
        }, ["title"]),
        "Ordered phases for this plan"
      )
    },
    ["title", "phases"]
  ),
  tool(
    "plan_update",
    "planning.update",
    "Update an existing plan's status, current phase, phase notes, or step status. Use to advance phased work as implementation moves forward.",
    {
      planId: str("Plan ID returned by plan_create or plan_list"),
      title: str("Optional new plan title"),
      summary: str("Optional new plan summary"),
      status: str("Optional plan status: draft | active | completed | blocked | cancelled"),
      note: str("Optional plan-level note to append"),
      activePhaseId: str("Optional active phase ID"),
      phaseId: str("Optional target phase ID"),
      phaseTitle: str("Optional new phase title"),
      phaseObjective: str("Optional new phase objective"),
      phaseStatus: str("Optional phase status: pending | in_progress | completed | blocked"),
      phaseNote: str("Optional phase note to append"),
      stepId: str("Optional target step ID or exact step title within the phase"),
      stepTitle: str("Optional new step title"),
      stepDetail: str("Optional new step detail"),
      stepStatus: str("Optional step status: pending | in_progress | completed | blocked"),
      stepNote: str("Optional step note to append")
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
      )
    },
    ["task"]
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
            code: str("JavaScript module code to execute in the preview; use DOM APIs to render UI into document.body")
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
  ...GIT_TOOLS,
  ...TEST_TOOLS,
  ...WORKTREE_TOOLS,
  ...SUBAGENT_TOOLS,
  ...SERVICE_TOOLS,
  ...BROWSER_TOOLS,
  ...UI_TOOLS
];
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

// src/agent-session.ts
var DEFAULT_MAX_TOKENS = 8192;
var DEFAULT_MAX_ITER = 40;
var PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1/messages", authHeader: "x-api-key" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1/chat/completions", authHeader: "Bearer" },
  openai: { baseUrl: "https://api.openai.com/v1/chat/completions", authHeader: "Bearer" }
};
var AgentSession = class {
  constructor(opts) {
    this.opts = opts;
    this.sessionId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.provider = opts.provider ?? "anthropic";
    this._signal = opts.signal;
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
  restoreHistory(messages) {
    this.messages = [...messages];
  }
  _getTools() {
    const all = [...WORKSPACE_TOOLS, ...GIT_TOOLS, ...TEST_TOOLS, ...WORKTREE_TOOLS, ...SERVICE_TOOLS];
    if (this.opts.subagentProvider) all.push(...SUBAGENT_TOOLS);
    if (this.opts.memoryProvider) all.push(...MEMORY_TOOLS);
    if (this.opts.planningProvider) all.push(...PLANNING_TOOLS);
    if (this.opts.diagnosticsProvider) all.push(...DIAGNOSTICS_TOOLS);
    if (this.opts.lspProvider) all.push(...CODE_INTEL_TOOLS);
    if (this.opts.browserRunner) all.push(...BROWSER_TOOLS);
    const usable = this.opts.editProvider ? all : all.filter((t) => t.name !== "file_edit" && t.name !== "file_edit_batch");
    const disabled = new Set(this.opts.disabledTools ?? []);
    const filtered = disabled.size ? usable.filter((t) => !disabled.has(t.name)) : usable;
    return [...filtered, ...UI_TOOLS];
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
      return { ok: true, saved: note.length > 80 ? `${note.slice(0, 80)}\u2026` : note };
    }
    if (op === "read") {
      return { ok: true, memory: provider.readMemory(), context: provider.readContext() };
    }
    return { ok: false, error: `Unknown memory operation: ${op}` };
  }
  async *send(userContent) {
    this.messages.push({ role: "user", content: userContent });
    const maxIter = this.opts.maxIterations ?? DEFAULT_MAX_ITER;
    const turnStartIteration = this._iteration;
    while (this._iteration < maxIter) {
      if (this._signal?.aborted) {
        yield { type: "error", message: "Cancelled." };
        return;
      }
      this._iteration++;
      yield { type: "iteration_start", iteration: this._iteration };
      const assistantBlocks = [];
      const toolCalls = [];
      let stopReason = "end_turn";
      let currentText = "";
      try {
        const stream = this.provider === "anthropic" ? this._streamTurnAnthropic() : this._streamTurnOpenAI();
        for await (const ev of stream) {
          if (this._signal?.aborted) return;
          if (ev.type === "text_delta") {
            currentText += ev.text;
            yield { type: "text_delta", text: ev.text };
          } else if (ev.type === "tool_use_block") {
            toolCalls.push(ev.block);
            yield {
              type: "tool_call_start",
              toolCallId: ev.block.id,
              toolName: ev.block.name,
              inputPreview: JSON.stringify(ev.block.input).slice(0, 120),
              input: ev.block.input
            };
          } else if (ev.type === "stop_reason") {
            stopReason = ev.reason;
          }
        }
      } catch (err) {
        yield { type: "error", message: err instanceof Error ? err.message : String(err) };
        return;
      }
      if (currentText) assistantBlocks.push({ type: "text", text: currentText });
      for (const tc of toolCalls) assistantBlocks.push(tc);
      this.messages.push({ role: "assistant", content: assistantBlocks });
      if (toolCalls.length === 0) {
        yield { type: "turn_complete", stopReason, iterations: this._iteration - turnStartIteration };
        if (this.opts.checkpointingEnabled !== false) clearCheckpoint(this.opts.context);
        return;
      }
      const groups = [];
      for (const tc of toolCalls) {
        const isParallel = isParallelSubagent(tc);
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.parallel === isParallel) {
          lastGroup.toolCalls.push(tc);
        } else {
          groups.push({ parallel: isParallel, toolCalls: [tc] });
        }
      }
      const tcToIndex = /* @__PURE__ */ new Map();
      toolCalls.forEach((tc, idx) => tcToIndex.set(tc.id, idx));
      const toolResults = new Array(toolCalls.length);
      for (const group of groups) {
        if (this._signal?.aborted) return;
        if (group.parallel) {
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
                  content: JSON.stringify(res)
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
                  content: JSON.stringify(finalResult)
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
          for await (const event of mergeAsyncGenerators(generators)) {
            yield event;
          }
        } else {
          for (const tc of group.toolCalls) {
            if (this._signal?.aborted) return;
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
                  yield { type: "question_card_pending", toolCallId: tc.id, question, options, context };
                  try {
                    const selectedKey = await this.opts.questionCardProvider(tc.id, question, options, context);
                    const selectedLabel = options.find((o) => o.key === selectedKey)?.label ?? selectedKey;
                    yield { type: "question_card_result", toolCallId: tc.id, selectedKey };
                    result = { ok: true, selectedKey, selectedLabel };
                  } catch {
                    result = { ok: false, error: "Question was cancelled." };
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
              } else if (runtimeType.startsWith("memory.")) {
                result = this._handleMemory(runtimeType.slice("memory.".length), payload);
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
                  const { tier, description } = firstResult;
                  let granted = this._autoApprove;
                  if (!granted) {
                    yield { type: "approval_pending", toolCallId: tc.id, description, tier };
                    const decision = await requestApprovalWithDetails(tc.name, description, tier);
                    if (decision === "allow_all") this._autoApprove = true;
                    granted = decision !== "deny";
                  }
                  yield { type: "approval_result", toolCallId: tc.id, granted };
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
            const ok = isOk(result);
            const summary = ok ? summarizeResult(result) : String(result?.["error"] ?? "Failed");
            toolResults[idx] = {
              type: "tool_result",
              tool_use_id: tc.id,
              content: JSON.stringify(result)
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
      this.messages.push({ role: "user", content: toolResults });
      const cp = {
        sessionId: this.sessionId,
        iteration: this._iteration,
        model: this.opts.model,
        workspaceRoot: this.opts.workspaceRoot,
        messages: this.messages,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (this.opts.checkpointingEnabled !== false) saveCheckpoint(this.opts.context, cp);
    }
    yield { type: "turn_complete", stopReason: "max_iterations", iterations: this._iteration - turnStartIteration };
  }
  // ── Anthropic native streaming ─────────────────────────────────────────────
  async *_streamTurnAnthropic() {
    const tools = this._getTools().map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const url = this.opts.baseUrl ?? PROVIDER_DEFAULTS.anthropic.baseUrl;
    let maxTok = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    let thinking;
    if (this.opts.thinking?.enabled) {
      const budget = Math.max(1024, this.opts.thinking.budgetTokens);
      if (maxTok <= budget) maxTok = budget + 1024;
      thinking = { type: "enabled", budget_tokens: budget };
    }
    const body = {
      model: this.opts.model,
      max_tokens: maxTok,
      system: this.opts.systemPrompt,
      messages: this.messages,
      tools,
      stream: true
    };
    if (!thinking && this.opts.temperature !== void 0) body["temperature"] = this.opts.temperature;
    if (thinking) body["thinking"] = thinking;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": this.opts.apiKey,
        "content-type": "application/json"
      },
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
    const jsonAcc = /* @__PURE__ */ new Map();
    const blockMeta = /* @__PURE__ */ new Map();
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
      if (evType === "content_block_start") {
        const idx = Number(ev["index"]);
        const cb = ev["content_block"];
        const cbType = String(cb["type"] ?? "");
        blockMeta.set(idx, { type: cbType, id: String(cb["id"] ?? ""), name: String(cb["name"] ?? "") });
        if (cbType === "text") textAcc.set(idx, "");
        if (cbType === "tool_use") jsonAcc.set(idx, "");
      } else if (evType === "content_block_delta") {
        const idx = Number(ev["index"]);
        const delta = ev["delta"];
        const dType = String(delta["type"] ?? "");
        if (dType === "text_delta") {
          const text = String(delta["text"] ?? "");
          textAcc.set(idx, (textAcc.get(idx) ?? "") + text);
          yield { type: "text_delta", text };
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
        }
      } else if (evType === "message_delta") {
        const delta = ev["delta"];
        yield { type: "stop_reason", reason: String(delta["stop_reason"] ?? "end_turn") };
      }
    }
  }
  // ── OpenAI / OpenRouter streaming ──────────────────────────────────────────
  async *_streamTurnOpenAI() {
    const pd = PROVIDER_DEFAULTS[this.provider];
    const url = this.opts.baseUrl ?? pd.baseUrl;
    const msgs = toOpenAIMessages(this.messages, this.opts.systemPrompt);
    const tools = this._getTools().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
    const extraHeaders = {};
    if (this.provider === "openrouter") {
      extraHeaders["HTTP-Referer"] = "https://blacksite.dev";
      extraHeaders["X-Title"] = "Blacksite";
    }
    const reasoning = this.provider === "openai" && isOpenAIReasoningModel(this.opts.model);
    const maxTok = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const oaiBody = {
      model: this.opts.model,
      messages: msgs,
      tools,
      tool_choice: "auto",
      stream: true
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
    yield { type: "stop_reason", reason: stopReason === "tool_calls" ? "tool_use" : "end_turn" };
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
function toOpenAIMessages(messages, systemPrompt) {
  const result = [{ role: "system", content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b) => b.type === "text");
        for (const tr of toolResults) {
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
        const tool_calls = toolBlocks.length > 0 ? toolBlocks.map((tb) => ({
          id: tb.id,
          type: "function",
          function: { name: tb.name, arguments: JSON.stringify(tb.input) }
        })) : void 0;
        result.push({ role: "assistant", content, tool_calls });
      }
    }
  }
  return result;
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
  return {
    task: String(payload["task"] ?? ""),
    context: payload["context"] != null ? String(payload["context"]) : void 0,
    complexity: complexity === "standard" || complexity === "complex" || complexity === "deep" ? complexity : "auto",
    label: payload["label"] != null ? String(payload["label"]) : void 0,
    parallel: payload["parallel"] === true || payload["parallel"] === "true"
  };
}
function isParallelSubagent(tc) {
  const dispatch = resolveToolDispatch(tc.name, tc.input);
  if (dispatch.runtimeType !== "subagent.spawn") return false;
  const input = normalizeSubagentSpawnInput(dispatch.payload);
  return input.parallel === true;
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
      await new Promise((resolve2) => {
        resolveNext = resolve2;
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
  cancel() {
    this.abortController?.abort();
  }
  dispose() {
    this.statusBarItem.dispose();
  }
  async runWithProgress(session, userContent, onEvent, options = {}) {
    if (this.isRunning) {
      vscode2.window.showWarningMessage("Blacksite is already running a task. Cancel it first.");
      return;
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
            if (this.abortController?.signal.aborted) break;
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
var fs6 = __toESM(require("fs"));
var vscode3 = __toESM(require("vscode"));
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
  return candidates.filter(Boolean).find((p) => fs6.existsSync(p));
}
var ChromiumRunner = class {
  _browser = null;
  _context = null;
  _page = null;
  _launching = false;
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
      const { chromium } = await import("playwright-core");
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
var path9 = __toESM(require("path"));

// src/post-edit-diagnostics.ts
var vscode4 = __toESM(require("vscode"));
var path8 = __toESM(require("path"));
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
  return new Promise((resolve2) => {
    const keys = new Set(uris.map((u) => u.toString()));
    const cleanup = () => {
      sub.dispose();
      clearTimeout(timer);
    };
    const sub = vscode4.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) {
        cleanup();
        resolve2();
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      resolve2();
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
  const r = path8.relative(base, uri.fsPath).replace(/\\/g, "/");
  return r && !r.startsWith("..") ? r : uri.fsPath.replace(/\\/g, "/");
}

// src/diff-edit-service.ts
var DiffEditService = class {
  constructor(_workspaceRoot, _applier) {
    this._workspaceRoot = _workspaceRoot;
    this._applier = _applier;
  }
  _resolve(p) {
    const abs = path9.isAbsolute(p) ? p : path9.join(this._workspaceRoot, p);
    return vscode5.Uri.file(abs);
  }
  async applyEdit(input, opts) {
    const rel2 = input.path;
    if (!rel2) return { ok: false, error: "path is required." };
    if (input.oldString === input.newString) return { ok: false, error: "oldString and newString are identical \u2014 nothing to change." };
    const uri = this._resolve(rel2);
    let doc;
    try {
      doc = await vscode5.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${rel2}. Use file_write to create a new file.` };
    }
    const original = doc.getText();
    const occurrences = countOccurrences(original, input.oldString);
    if (occurrences === 0) {
      return { ok: false, error: `oldString was not found in ${rel2}. Read the file and copy the exact text (including whitespace).` };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return { ok: false, error: `oldString matches ${occurrences} locations in ${rel2}. Add surrounding context to make it unique, or set replaceAll:true.` };
    }
    const updated = input.replaceAll ? original.split(input.oldString).join(input.newString) : replaceFirst(original, input.oldString, input.newString);
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
        const occurrences = countOccurrences(text, edit.oldString);
        if (occurrences === 0) {
          return { ok: false, error: `oldString was not found in ${rel2}. Read the file and copy the exact text (including whitespace).` };
        }
        if (occurrences > 1 && !edit.replaceAll) {
          return { ok: false, error: `oldString matches ${occurrences} locations in ${rel2}. Add surrounding context or set replaceAll:true.` };
        }
        text = edit.replaceAll ? text.split(edit.oldString).join(edit.newString) : replaceFirst(text, edit.oldString, edit.newString);
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
var fs7 = __toESM(require("fs"));
var path10 = __toESM(require("path"));
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
    const resolved = await this._resolveTarget(target);
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
      locations.push(await this._toCodeLocation(uri, range, context, wantBody));
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
    const resolved = await this._resolveTarget(target);
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
    const resolved = await this._resolveTarget(target);
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
    const resolved = await this._resolveTarget(target);
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
  async _resolveTarget(target) {
    const uri = this._resolveUri(target.path);
    let doc;
    try {
      doc = await vscode6.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, error: `Could not open ${target.path}.` };
    }
    if (target.symbol) {
      const flat = await this._flatDocumentSymbols(uri);
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
  async _flatDocumentSymbols(uri) {
    const syms = await this._withWarmup(
      () => this._exec("vscode.executeDocumentSymbolProvider", uri),
      (r) => !r || r.length === 0,
      { autoApprove: false }
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
  async _toCodeLocation(uri, range, context, wantBody) {
    let snippet = "";
    let symbol;
    let kind;
    try {
      const doc = await vscode6.workspace.openTextDocument(uri);
      if (wantBody) {
        const body = await this._symbolBody(doc, range.start);
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
  async _symbolBody(doc, position) {
    const flat = await this._flatDocumentSymbols(doc.uri);
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
    const p = Promise.resolve(vscode6.commands.executeCommand(command, ...args));
    return withTimeout(p, 9e3);
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
    if (path10.isAbsolute(p)) return vscode6.Uri.file(p);
    for (const folder of vscode6.workspace.workspaceFolders ?? []) {
      const candidate = path10.join(folder.uri.fsPath, p);
      if (fs7.existsSync(candidate)) return vscode6.Uri.file(candidate);
    }
    return vscode6.Uri.file(path10.join(this._workspaceRoot, p));
  }
  _relPath(uri) {
    const folder = vscode6.workspace.getWorkspaceFolder(uri);
    const base = folder?.uri.fsPath ?? this._workspaceRoot;
    const rel2 = path10.relative(base, uri.fsPath).replace(/\\/g, "/");
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
  if (mode === "before" || mode === "start") return range.start;
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
  return new Promise((resolve2) => {
    const t = setTimeout(() => resolve2(void 0), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve2(v);
    }, () => {
      clearTimeout(t);
      resolve2(void 0);
    });
  });
}

// src/workspace-edit-applier.ts
var vscode7 = __toESM(require("vscode"));
var path11 = __toESM(require("path"));
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
  dispose() {
    this._registration.dispose();
    this._proposed.dispose();
  }
  /** Preview (unless auto-approving) then apply a WorkspaceEdit, saving touched documents. */
  async apply(edit, opts) {
    const result = new Promise((resolve2, reject) => {
      this._applyQueue = this._applyQueue.then(async () => {
        try {
          const res = await this._applyInternal(edit, opts);
          resolve2(res);
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
        const base = path11.basename(uri.fsPath);
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
    const choice = await vscode7.window.showWarningMessage(
      `Apply Blacksite changes to ${entries.length} file(s)?`,
      { modal: true, detail },
      "Apply",
      "Apply All",
      "Reject"
    );
    await this._closeProposedDiffs();
    this._proposed.clear();
    if (choice === "Apply All") return "all";
    if (choice === "Apply") return "apply";
    return "reject";
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
    const rel2 = path11.relative(base, uri.fsPath).replace(/\\/g, "/");
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
var fs10 = __toESM(require("fs"));
var path14 = __toESM(require("path"));

// src/base-context-store.ts
var fs8 = __toESM(require("fs"));
var path12 = __toESM(require("path"));
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
  if (!fs8.existsSync(dirPath)) fs8.mkdirSync(dirPath, { recursive: true });
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
  const absolute = path12.resolve(filePath);
  const relative8 = path12.relative(workspaceRoot, absolute).replace(/\\/g, "/");
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
    const raw = fs8.readFileSync(filePath, "utf8").replace(/\0/g, "");
    return shortText(raw, maxChars);
  } catch {
    return "";
  }
}
function summarizeBaseContextForPrompt(workspaceRoot, maxChars = MAX_PROMPT_CHARS) {
  const filePath = path12.join(workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
  if (!fs8.existsSync(filePath)) return "";
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
      const absolute = path12.join(workspaceRoot, file.path);
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
    return JSON.parse(fs8.readFileSync(filePath, "utf8"));
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
    ensureDir(path12.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs8.existsSync(this.filePath())) {
      fs8.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}
`, "utf8");
    }
  }
  filePath() {
    return path12.join(this._workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
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
    fs8.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}
`, "utf8");
    this._emitter.fire(normalized);
  }
};

// src/planning-store.ts
var fs9 = __toESM(require("fs"));
var path13 = __toESM(require("path"));
var vscode9 = __toESM(require("vscode"));
var BLACKSITE_DIR2 = ".blacksite";
var PLANNING_FILE = "planning.json";
var PLANNING_SCHEMA_VERSION = 1;
var MAX_TEXT = 2e3;
var MAX_NOTES = 12;
var MAX_PROMPT_CHARS2 = 5500;
function nowIso3() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function newId2(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function ensureDir2(dirPath) {
  if (!fs9.existsSync(dirPath)) fs9.mkdirSync(dirPath, { recursive: true });
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
function normalizePlanStatus(value) {
  return value === "draft" || value === "active" || value === "completed" || value === "blocked" || value === "cancelled" ? value : null;
}
function normalizePhaseStatus(value) {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked" ? value : null;
}
function normalizeStepStatus(value) {
  return normalizePhaseStatus(value);
}
function normalizeTodoStatus(value) {
  return value === "pending" || value === "running" || value === "done" || value === "failed" ? value : null;
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
      status: phase.status,
      counts,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : void 0,
      steps: phase.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        detail: step.detail
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
    return JSON.parse(fs9.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function readPlanningDocument(workspaceRoot) {
  const document = normalizeDocument2(readJsonFile2(path13.join(workspaceRoot, BLACKSITE_DIR2, PLANNING_FILE)));
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
  if (plan.status === "cancelled") return;
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
    lines.push(`  - Phase ${phase.title} [${phase.status}]`);
    if (phase.objective) lines.push(`    Objective: ${phase.objective}`);
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
  const activePlans = sortByUpdatedAt(document.plans).filter((plan) => plan.status !== "completed" && plan.status !== "cancelled");
  const activeTodos = sortByUpdatedAt(document.todoRuns).filter((run) => !run.completedAt);
  if (activePlans.length === 0 && activeTodos.length === 0) return "";
  const blocks = [];
  if (activePlans.length > 0) {
    blocks.push("Active plans:");
    for (const plan of activePlans.slice(0, 3)) blocks.push(formatPlanForPrompt(plan));
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
    ensureDir2(path13.join(this._workspaceRoot, BLACKSITE_DIR2));
    if (!fs9.existsSync(this.filePath())) {
      fs9.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument2(), null, 2)}
`, "utf8");
    }
  }
  filePath() {
    return path13.join(this._workspaceRoot, BLACKSITE_DIR2, PLANNING_FILE);
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
          status: "pending",
          notes: [],
          updatedAt: nowIso3()
        });
      }
      phases.push({
        id: `phase-${phaseIndex + 1}`,
        title: phaseTitle,
        objective: cleanParagraph(phaseRecord.objective, 500) || void 0,
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
    if (phase) {
      if (typeof payload.phaseTitle === "string") {
        const phaseTitle = cleanText(payload.phaseTitle, 160);
        if (phaseTitle) phase.title = phaseTitle;
      }
      if (typeof payload.phaseObjective === "string") {
        phase.objective = cleanParagraph(payload.phaseObjective, 500) || void 0;
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
      if (step) {
        if (typeof payload.stepTitle === "string") {
          const stepTitle = cleanText(payload.stepTitle, 160);
          if (stepTitle) step.title = stepTitle;
        }
        if (typeof payload.stepDetail === "string") {
          step.detail = cleanParagraph(payload.stepDetail, 500) || void 0;
        }
        const stepStatus = normalizeStepStatus(payload.stepStatus);
        if (stepStatus) step.status = stepStatus;
        if (payload.stepNote != null) step.notes = appendNote(step.notes, payload.stepNote);
        step.updatedAt = timestamp;
      }
      phase.updatedAt = timestamp;
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
    fs9.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}
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
    const uiPreferencesPath = path14.join(workspaceRoot, UI_PREFERENCES_FILE);
    if (!fs10.existsSync(uiPreferencesPath)) return "";
    const raw = fs10.readFileSync(uiPreferencesPath, "utf8").slice(0, 5e4);
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
  const openFiles = vscode10.workspace.textDocuments.filter((d) => !d.isUntitled && d.uri.scheme === "file").map((d) => path14.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/")).filter((p) => !p.startsWith("..")).slice(0, 20);
  const allDiagnostics = vscode10.languages.getDiagnostics();
  let errorCount = 0;
  let warnCount = 0;
  for (const [, diags] of allDiagnostics) {
    for (const d of diags) {
      if (d.severity === vscode10.DiagnosticSeverity.Error) errorCount++;
      else if (d.severity === vscode10.DiagnosticSeverity.Warning) warnCount++;
    }
  }
  const diagnosticSummary = errorCount + warnCount > 0 ? `${errorCount} error(s), ${warnCount} warning(s) in workspace` : "No diagnostics";
  let gitStatusSummary = "";
  try {
    const resp = await runtime.handleMessage({ type: "workspace.git", payload: { op: "status" } });
    const data = resp.result;
    if (data?.ok && data.data) {
      const s = data.data;
      gitStatusSummary = `Branch: ${s.branch ?? "?"} | Staged: ${s.staged?.length ?? 0} | Unstaged: ${s.unstaged?.length ?? 0} | Untracked: ${s.untracked?.length ?? 0}`;
    }
  } catch {
  }
  let baseContext = "";
  try {
    const contextPath = path14.join(workspaceRoot, CONTEXT_FILE);
    if (fs10.existsSync(contextPath)) {
      baseContext = fs10.readFileSync(contextPath, "utf8").slice(0, 4e3);
    }
  } catch {
  }
  const structuredBaseContext = summarizeBaseContextForPrompt(workspaceRoot);
  let projectMemory = "";
  try {
    const memoryPath = path14.join(workspaceRoot, MEMORY_FILE);
    if (fs10.existsSync(memoryPath)) {
      projectMemory = fs10.readFileSync(memoryPath, "utf8").slice(-4e3);
    }
  } catch {
  }
  const uiPreferenceSummary = readUiPreferenceSummary(workspaceRoot);
  const planningSummary = summarizePlanningStateForPrompt(workspaceRoot);
  return {
    workspaceRoot,
    allRoots,
    openFiles,
    diagnosticSummary,
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
    ""
  ];
  if (snapshot.allRoots.length > 1) {
    parts.push("Workspace roots:");
    for (const r of snapshot.allRoots) parts.push(`  ${r}`);
  } else {
    parts.push(`Workspace root: ${snapshot.workspaceRoot}`);
  }
  if (snapshot.openFiles.length > 0) {
    parts.push("", "Open editors:", ...snapshot.openFiles.map((f) => `  ${f}`));
  }
  if (snapshot.diagnosticSummary) {
    parts.push("", `Diagnostics: ${snapshot.diagnosticSummary}`);
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
    "Guidelines:",
    "- Read files before editing them. Verify changes after writing.",
    "- Prefer code intelligence over text search: code_symbols to map a file, code_navigate to jump to definitions/implementations or find references, and code_hover to inspect a type or signature. Fall back to file_search only when those don't apply.",
    "- Make changes with file_edit (surgical, shows the user a diff) rather than rewriting whole files; use file_write for new files.",
    "- Use file_edit_batch for coordinated exact-string replacements across multiple files, and code_insert when you need to add code relative to a symbol or line without brittle whole-file matching.",
    "- After editing, call code_diagnostics to catch errors the language servers report, then fix them before finishing.",
    "- For shell commands, confirm the cwd and command before running.",
    "- Operations marked write/network/destructive will prompt the user for approval.",
    "- When writing code, prefer small focused changes. Run tests or lint after editing.",
    "- Use git_op status before commits. Use git_op diff to review changes.",
    "- To persist durable notes for future sessions, use memory_append (project memory) \u2014 it is read back into context on the next conversation.",
    "- Use Base Context for static, reusable project context that should stay available across conversations.",
    "- Before starting multi-phase work, use plan_list to check for an existing plan, then use plan_create / plan_update to track phases and plan state.",
    "- For concrete 3+ step execution, use todo_list before todo_create, then keep todo_update current while the work is actually happening."
  );
  return parts.join("\n");
}
function registerFileWatcher(workspaceRoot, onContextChange) {
  const watcher = vscode10.workspace.createFileSystemWatcher(
    new vscode10.RelativePattern(workspaceRoot, "**/*.{ts,tsx,js,jsx,py,go,rs,json,md}"),
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
  const file = path14.basename(editor.document.fileName);
  const start = sel.start.line + 1;
  const end = sel.end.line + 1;
  const label = start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
  return { text, label };
}
function getFileContext(uri) {
  try {
    const raw = fs10.readFileSync(uri.fsPath, "utf8").slice(0, 2e4);
    const label = path14.basename(uri.fsPath);
    const ext = path14.extname(uri.fsPath).slice(1) || "text";
    return { text: `\`\`\`${ext}
${raw}
\`\`\``, label };
  } catch {
    return null;
  }
}
function getDiagnosticContext(uri, diagnostic) {
  const file = path14.basename(uri.fsPath);
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
  ]
};
function get(url, headers) {
  return new Promise((resolve2, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Bad URL: ${url}`));
      return;
    }
    const mod = u.protocol === "https:" ? import_https2.default : import_http2.default;
    const req = mod.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c.toString();
      });
      res.on("end", () => resolve2({ status: res.statusCode ?? 0, body }));
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
  return data.filter((m) => m.id && !m.id.endsWith(":free") || true).map((m) => {
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
var CHAT_MODEL_RE = /^(gpt-4|gpt-3\.5-turbo|o[134])/;
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
      supportsVision: m.id.includes("4o") || m.id.startsWith("o") || m.id.includes("vision"),
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

// src/chat-provider.ts
var SETTINGS_KEY = "blacksite.settings.v2";
var PROVIDER_DEFAULTS2 = {
  anthropic: { model: "claude-sonnet-4-6", temperature: 1, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 1e4 } },
  openrouter: { model: "anthropic/claude-sonnet-4-6", temperature: 1, maxTokens: 8192 },
  openai: { model: "gpt-4o", temperature: 1, maxTokens: 8192 }
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
function buildDelegatedSystemPrompt(basePrompt, budget) {
  return [
    "You are a delegated Blacksite subagent running one focused lane for a parent agent.",
    "Stay tightly scoped to the delegated task. Gather evidence, make changes if needed, and return a concise synthesis for the parent to integrate.",
    "Do not address the end user directly. Do not explain the parent workflow. Work only within this lane.",
    "If you need user approval, ask through the provided tools. If information is missing, state the gap clearly in the final answer.",
    `Execution budget: ${budget.complexity} complexity, ${budget.maxToolRounds} tool rounds, ${budget.timeoutSeconds}s timeout.`,
    "",
    basePrompt
  ].join("\n");
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
var ChatProvider = class {
  constructor(_context, _runtime, _secrets, _sessionStore, _workspaceRoot, _memory, _diagnostics, _planning) {
    this._context = _context;
    this._runtime = _runtime;
    this._secrets = _secrets;
    this._sessionStore = _sessionStore;
    this._workspaceRoot = _workspaceRoot;
    this._memory = _memory;
    this._diagnostics = _diagnostics;
    this._planning = _planning;
    this._runner = new BackgroundRunner();
    this._chromium = new ChromiumRunner();
    this._applier = new WorkspaceEditApplier(_workspaceRoot);
    this._editService = new DiffEditService(_workspaceRoot, this._applier);
    this._lspService = new LspService(_workspaceRoot, this._applier);
    this._context.subscriptions.push({ dispose: () => this._runner.dispose() });
    this._context.subscriptions.push({ dispose: () => void this._chromium.dispose() });
    this._context.subscriptions.push({ dispose: () => this._applier.dispose() });
  }
  _view;
  _session = null;
  _restoredHistory = null;
  _runner;
  _chromium;
  _applier;
  _editService;
  _lspService;
  // Cache of fetched model lists keyed by provider
  _modelCache = /* @__PURE__ */ new Map();
  // Pending question cards: toolCallId → resolve function
  _pendingQuestionCards = /* @__PURE__ */ new Map();
  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode12.Uri.joinPath(this._context.extensionUri, "src")]
    };
    webviewView.webview.html = this._loadHtml();
    webviewView.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._context.subscriptions
    );
  }
  clearMessages() {
    this._sessionStore.archiveActive();
    this._session = null;
    this._restoredHistory = null;
    this._sessionStore.clearActive();
    clearCheckpoint(this._context);
    this._post({ type: "clear" });
  }
  cancelCurrentRun() {
    this._runner.cancel();
  }
  async closeBrowser() {
    await this._chromium.dispose();
  }
  async offerCheckpointResume(cp) {
    const action = await vscode12.window.showInformationMessage(
      `Blacksite: Unfinished run detected (${cp.iteration} iteration(s)). Resume?`,
      "Resume",
      "Discard"
    );
    if (action === "Resume") {
      const apiKey = await this._secrets.getOrPromptApiKey(this._readSettings().provider);
      if (!apiKey) return;
      this._session = await this._createSession(apiKey);
      this._session.restoreHistory(cp.messages);
      this._post({ type: "history_restored", messages: this._session.history });
      this._continueSend("[Resumed from checkpoint]");
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
    return new AgentSession({
      apiKey,
      model: pSettings.model,
      systemPrompt,
      workspaceRoot: this._workspaceRoot,
      runtime: this._runtime,
      context: this._context,
      provider: settings.provider,
      temperature: pSettings.temperature,
      maxTokens: pSettings.maxTokens,
      thinking: pSettings.thinking,
      reasoningEffort: pSettings.reasoningEffort,
      maxIterations: settings.maxIterations,
      disabledTools: settings.disabledTools,
      serviceKeyProvider: (svc) => this._secrets.getApiKey(svc),
      browserRunner: this._chromium,
      editProvider: this._editService,
      diagnosticsProvider: this._diagnostics,
      lspProvider: this._lspService,
      questionCardProvider: (toolCallId, question, options, context) => this._createQuestionCardPromise(toolCallId, question, options, context),
      subagentProvider: this._createSubagentProvider(apiKey, settings, pSettings),
      memoryProvider: {
        append: (note) => this._memory.appendMemory(note),
        readMemory: () => this._memory.readMemory(),
        readContext: () => this._memory.readContext()
      },
      planningProvider: this._planning
    });
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
        apiKey,
        model: pSettings.model,
        systemPrompt: buildDelegatedSystemPrompt(buildSystemPrompt(snapshot), budget),
        workspaceRoot: this._workspaceRoot,
        runtime: this._runtime,
        context: this._context,
        provider: settings.provider,
        signal: controller.signal,
        temperature: pSettings.temperature,
        maxTokens: pSettings.maxTokens,
        thinking: pSettings.thinking,
        reasoningEffort: pSettings.reasoningEffort,
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
      case "new_chat":
        this._sessionStore.archiveActive();
        this._session = null;
        this._restoredHistory = null;
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
        this._restoredHistory = stored.messages;
        this._sessionStore.saveActive(stored);
        this._post({ type: "clear" });
        const display = stored.messages.filter((m) => m.role === "user" || m.role === "assistant");
        this._post({ type: "history_restored", messages: display });
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
      case "question_card_answer": {
        const toolCallId = String(msg.toolCallId ?? "");
        const selectedKey = String(msg.selectedKey ?? "");
        if (!toolCallId || !selectedKey) break;
        const resolve2 = this._pendingQuestionCards.get(toolCallId);
        if (resolve2) {
          this._pendingQuestionCards.delete(toolCallId);
          resolve2(selectedKey);
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
      this._session = await this._createSession(apiKey);
      if (this._restoredHistory) {
        this._session.restoreHistory(this._restoredHistory);
        this._restoredHistory = null;
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
    await this._continueSend(fullContent);
  }
  // ── @-file mentions ─────────────────────────────────────────────────────────
  _readMentionFiles(mentions) {
    const seen = /* @__PURE__ */ new Set();
    const blocks = [];
    for (const rel2 of mentions) {
      if (!rel2 || seen.has(rel2)) continue;
      seen.add(rel2);
      const abs = path15.isAbsolute(rel2) ? rel2 : path15.join(this._workspaceRoot, rel2);
      try {
        const raw = fs11.readFileSync(abs, "utf8").slice(0, 3e4);
        const ext = path15.extname(abs).slice(1) || "text";
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
    const FRESH_MS = 8e3;
    if (!this._fileIndex || Date.now() - this._fileIndex.at > FRESH_MS) {
      const uris = await vscode12.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.next,coverage}/**",
        4e3
      );
      const paths = uris.map((u) => path15.relative(this._workspaceRoot, u.fsPath).replace(/\\/g, "/")).filter((p) => p && !p.startsWith(".."));
      this._fileIndex = { paths, at: Date.now() };
    }
    const q = query.toLowerCase();
    const scored = this._fileIndex.paths.map((p) => ({ p, score: scoreMatch(p, q) })).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || a.p.length - b.p.length).slice(0, 20).map((e) => e.p);
    return scored;
  }
  async _continueSend(content) {
    if (!this._session) return;
    const session = this._session;
    const turnId = `turn_${Date.now()}`;
    this._post({ type: "stream_start", id: turnId });
    await this._runner.runWithProgress(
      session,
      content,
      (event) => this._handleAgentEvent(event, turnId)
    );
    const settings = this._readSettings();
    const pSettings = this._providerSettings(settings.provider, settings);
    const stored = this._sessionStore.loadActive();
    this._sessionStore.saveActive({
      sessionId: session.sessionId,
      createdAt: stored?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      model: pSettings.model,
      workspaceRoot: this._workspaceRoot,
      messages: session.history
    });
  }
  _postStreamEvent(turnId, event, lane) {
    const laneMeta = lane ? { laneId: lane.laneId, parentToolCallId: lane.parentToolCallId } : {};
    switch (event.type) {
      case "text_delta":
        this._post({ type: "stream_delta", id: turnId, text: event.text, ...laneMeta });
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
          ...laneMeta
        });
        break;
      case "approval_result":
        this._post({
          type: "stream_approval_result",
          id: turnId,
          toolCallId: event.toolCallId,
          granted: event.granted,
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
    const stored = this._context.globalState.get(SETTINGS_KEY);
    if (!stored) {
      const legacyProvider = this._context.globalState.get("blacksite.provider");
      const legacyModel = this._context.globalState.get("blacksite.model");
      const s = {
        provider: legacyProvider ?? this._readCfgProvider(),
        providerSettings: {},
        maxIterations: 40,
        disabledTools: []
      };
      if (legacyModel) s.providerSettings[s.provider] = { ...PROVIDER_DEFAULTS2[s.provider], model: legacyModel };
      return s;
    }
    return stored;
  }
  _writeSettings(s) {
    void this._context.globalState.update(SETTINGS_KEY, s);
  }
  _providerSettings(provider, s) {
    return { ...PROVIDER_DEFAULTS2[provider], ...s.providerSettings[provider] };
  }
  _readCfgProvider() {
    const cfg = vscode12.workspace.getConfiguration("blacksite");
    const cp = cfg.get("provider");
    if (cp === "anthropic" || cp === "openrouter" || cp === "openai") return cp;
    return "anthropic";
  }
  _isValidProvider(p) {
    return p === "anthropic" || p === "openrouter" || p === "openai";
  }
  async _sendSettingsToWebview() {
    const settings = this._readSettings();
    const keyStatus = await this._secrets.getProviderStatus();
    const models = this._modelCache.get(settings.provider) ?? getFallbackModels(settings.provider);
    this._post({
      type: "settings_data",
      settings,
      keyStatus,
      models
    });
  }
  async _fetchAndSendModels(provider, knownKey) {
    this._post({ type: "models_loading", provider });
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
  // ── Session restore ────────────────────────────────────────────────────────────
  _restoreSessionToWebview() {
    const stored = this._sessionStore.loadActive();
    if (!stored?.messages.length) return;
    const userAssistantOnly = stored.messages.filter(
      (m) => m.role === "user" || m.role === "assistant"
    );
    this._post({ type: "history_restored", messages: userAssistantOnly });
    if (!this._session) {
      this._restoredHistory = stored.messages;
    }
  }
  // ── Question card ─────────────────────────────────────────────────────────────
  _createQuestionCardPromise(toolCallId, _question, _options, _context, signal = this._runner.signal) {
    return new Promise((resolve2, reject) => {
      this._pendingQuestionCards.set(toolCallId, resolve2);
      const onAbort = () => {
        this._pendingQuestionCards.delete(toolCallId);
        reject(new Error("Cancelled."));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  // ── Util ──────────────────────────────────────────────────────────────────────
  _post(msg) {
    void this._view?.webview.postMessage(msg);
  }
  _loadHtml() {
    const htmlPath = path15.join(
      this._context.extensionUri.fsPath,
      "src",
      "webview",
      "index.html"
    );
    try {
      return fs11.readFileSync(htmlPath, "utf8");
    } catch {
      return "<h1>Blacksite \u2014 webview not found</h1>";
    }
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
var vscode13 = __toESM(require("vscode"));
var PREFIX = "blacksite.apiKey.";
var PLACEHOLDERS = {
  anthropic: "sk-ant-api03-\u2026",
  openrouter: "sk-or-\u2026",
  openai: "sk-\u2026",
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
    const v = await this.getApiKey(provider);
    return !!v;
  }
  /** Prompt for and store a key; returns the key or undefined if cancelled. */
  async getOrPromptApiKey(provider) {
    const existing = await this.getApiKey(provider);
    if (existing) return existing;
    return this.promptForApiKey(provider);
  }
  async promptForApiKey(provider) {
    const key = await vscode13.window.showInputBox({
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
  /** Return masked status for all known providers — used by the settings panel. */
  async getProviderStatus() {
    const providers = ["anthropic", "openrouter", "openai", "github", "gitlab", "jira", "confluence", "salesforce"];
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
var MAX_STORED_MSGS = 100;
var MAX_SESSIONS = 25;
var HISTORY_MSG_TRIM = 100;
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
var fs12 = __toESM(require("fs"));
var path16 = __toESM(require("path"));
var DIR = ".blacksite";
var CONTEXT_FILE2 = "context.md";
var MEMORY_FILE2 = "memory.md";
var UI_PREFERENCES_FILE2 = "ui-preferences.json";
var SESSIONS_DIR = "sessions";
function ensureDir3(p) {
  if (!fs12.existsSync(p)) fs12.mkdirSync(p, { recursive: true });
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
    this.dir = path16.join(workspaceRoot, DIR);
  }
  ensureInitialized() {
    ensureDir3(this.dir);
    ensureDir3(path16.join(this.dir, SESSIONS_DIR));
    const contextPath = this.contextPath();
    if (!fs12.existsSync(contextPath)) {
      fs12.writeFileSync(
        contextPath,
        `# Project Context

Add persistent notes about this project here.
Blacksite reads this file at the start of each conversation.
`,
        "utf8"
      );
    }
    const memPath = this.memoryPath();
    if (!fs12.existsSync(memPath)) {
      fs12.writeFileSync(memPath, `# Project Memory

`, "utf8");
    }
    const uiPreferencesPath = this.uiPreferencesPath();
    if (!fs12.existsSync(uiPreferencesPath)) {
      fs12.writeFileSync(
        uiPreferencesPath,
        `${JSON.stringify(defaultUiPreferencesDocument(), null, 2)}
`,
        "utf8"
      );
    }
  }
  contextPath() {
    return path16.join(this.dir, CONTEXT_FILE2);
  }
  memoryPath() {
    return path16.join(this.dir, MEMORY_FILE2);
  }
  uiPreferencesPath() {
    return path16.join(this.dir, UI_PREFERENCES_FILE2);
  }
  readContext() {
    try {
      return fs12.readFileSync(this.contextPath(), "utf8");
    } catch {
      return "";
    }
  }
  readMemory() {
    try {
      return fs12.readFileSync(this.memoryPath(), "utf8");
    } catch {
      return "";
    }
  }
  readUiPreferences() {
    try {
      const raw = fs12.readFileSync(this.uiPreferencesPath(), "utf8");
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
      fs12.writeFileSync(this.uiPreferencesPath(), `${JSON.stringify(normalized, null, 2)}
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
      fs12.appendFileSync(this.memoryPath(), text, "utf8");
    } catch {
    }
  }
  saveSession(sessionId, messages) {
    try {
      ensureDir3(path16.join(this.dir, SESSIONS_DIR));
      const file = path16.join(this.dir, SESSIONS_DIR, `${sessionId}.json`);
      fs12.writeFileSync(file, JSON.stringify({ sessionId, messages, savedAt: Date.now() }, null, 2), "utf8");
    } catch {
    }
  }
  listSessions() {
    try {
      const dir = path16.join(this.dir, SESSIONS_DIR);
      return fs12.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
    } catch {
      return [];
    }
  }
};

// src/code-actions.ts
var vscode14 = __toESM(require("vscode"));
var BlacksiteCodeActionProvider = class {
  static providedCodeActionKinds = [
    vscode14.CodeActionKind.QuickFix,
    vscode14.CodeActionKind.RefactorRewrite
  ];
  provideCodeActions(document, range, context) {
    const actions = [];
    for (const diag of context.diagnostics) {
      if (diag.severity === vscode14.DiagnosticSeverity.Error || diag.severity === vscode14.DiagnosticSeverity.Warning) {
        const label = diag.message.length > 60 ? diag.message.slice(0, 57) + "\u2026" : diag.message;
        const fix = new vscode14.CodeAction(`Blacksite: Fix "${label}"`, vscode14.CodeActionKind.QuickFix);
        fix.command = {
          command: "blacksite.fixDiagnostic",
          title: "Fix with Blacksite",
          arguments: [document.uri, diag]
        };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
    }
    if (!(range instanceof vscode14.Range ? range : range).isEmpty) {
      const explain = new vscode14.CodeAction("Blacksite: Explain selection", vscode14.CodeActionKind.RefactorRewrite);
      explain.command = { command: "blacksite.explainSelection", title: "Explain selection" };
      actions.push(explain);
    }
    return actions;
  }
};

// src/diagnostics-publisher.ts
var vscode15 = __toESM(require("vscode"));
var path17 = __toESM(require("path"));
var SEVERITY_MAP = {
  error: vscode15.DiagnosticSeverity.Error,
  warning: vscode15.DiagnosticSeverity.Warning,
  info: vscode15.DiagnosticSeverity.Information,
  hint: vscode15.DiagnosticSeverity.Hint
};
var DiagnosticsPublisher = class {
  constructor(_workspaceRoot) {
    this._workspaceRoot = _workspaceRoot;
    this._collection = vscode15.languages.createDiagnosticCollection("blacksite");
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
        const abs = path17.isAbsolute(p.path) ? p.path : path17.join(this._workspaceRoot, p.path);
        const list = byFile.get(abs) ?? [];
        list.push(this._toDiagnostic(p));
        byFile.set(abs, list);
      }
      let count = 0;
      for (const [file, diags] of byFile) {
        this._collection.set(vscode15.Uri.file(file), diags);
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
    const range = new vscode15.Range(startLine, startCol, endLine, endCol);
    const diag = new vscode15.Diagnostic(range, p.message, SEVERITY_MAP[p.severity ?? "warning"] ?? vscode15.DiagnosticSeverity.Warning);
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
var fs13 = __toESM(require("fs"));
var path18 = __toESM(require("path"));
var vscode16 = __toESM(require("vscode"));
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
      localResourceRoots: [vscode16.Uri.joinPath(this._context.extensionUri, "src")]
    };
    webviewView.webview.html = this._loadHtml("base-context.html");
    webviewView.webview.onDidReceiveMessage(
      (msg) => void this._onMessage(msg),
      void 0,
      this._context.subscriptions
    );
    this._postState();
  }
  async promptAndAddFile(uri) {
    const target = uri ?? vscode16.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== "file") {
      vscode16.window.showWarningMessage("Blacksite: No workspace file is available to add to Base Context.");
      return;
    }
    const relative8 = path18.relative(this._workspaceRoot, target.fsPath).replace(/\\/g, "/");
    if (!relative8 || relative8.startsWith("..")) {
      vscode16.window.showWarningMessage("Blacksite: Only files inside the current workspace can be added to Base Context.");
      return;
    }
    const document = this._store.read();
    const picks = document.topics.map((topic) => ({
      label: topic.title,
      description: topic.enabled ? "Included" : "Excluded",
      id: topic.id
    }));
    picks.unshift({ label: "+ New topic", description: "Create a new Base Context topic", id: "__new__" });
    const pick = await vscode16.window.showQuickPick(picks, {
      title: "Add File To Base Context",
      placeHolder: `Choose a topic for ${relative8}`
    });
    if (!pick) return;
    let topicId = pick.id;
    if (topicId === "__new__") {
      const title = await vscode16.window.showInputBox({
        title: "New Base Context Topic",
        prompt: "Enter a topic title",
        value: path18.basename(target.fsPath)
      });
      if (!title) return;
      topicId = this._store.createTopic(title).id;
    }
    try {
      this._store.addFile(topicId, target.fsPath);
      vscode16.window.showInformationMessage(`Blacksite: Added ${relative8} to Base Context.`);
      this._postState();
    } catch (err) {
      vscode16.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
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
        await this.promptAndAddFile(vscode16.window.activeTextEditor?.document.uri);
        break;
      case "add_file_to_topic": {
        const target = vscode16.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== "file") {
          vscode16.window.showWarningMessage("Blacksite: Open a workspace file first.");
          break;
        }
        try {
          this._store.addFile(String(msg.topicId ?? ""), target.fsPath);
          this._postState();
        } catch (err) {
          vscode16.window.showWarningMessage(`Blacksite: ${err instanceof Error ? err.message : String(err)}`);
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
    const absolute = path18.join(this._workspaceRoot, relativePath);
    if (!fs13.existsSync(absolute)) {
      vscode16.window.showWarningMessage(`Blacksite: ${relativePath} no longer exists in this workspace.`);
      return;
    }
    const document = await vscode16.workspace.openTextDocument(absolute);
    await vscode16.window.showTextDocument(document, { preview: false });
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
    const uri = vscode16.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file") return null;
    const relative8 = path18.relative(this._workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    return relative8 && !relative8.startsWith("..") ? relative8 : null;
  }
  _loadHtml(fileName) {
    const htmlPath = path18.join(this._context.extensionUri.fsPath, "src", "webview", fileName);
    try {
      return fs13.readFileSync(htmlPath, "utf8");
    } catch {
      return "<h1>Blacksite \u2014 Base Context view not found</h1>";
    }
  }
};

// src/planning-provider.ts
var fs14 = __toESM(require("fs"));
var path19 = __toESM(require("path"));
var vscode17 = __toESM(require("vscode"));
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
      localResourceRoots: [vscode17.Uri.joinPath(this._context.extensionUri, "src")]
    };
    webviewView.webview.html = this._loadHtml("planning.html");
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
  _loadHtml(fileName) {
    const htmlPath = path19.join(this._context.extensionUri.fsPath, "src", "webview", fileName);
    try {
      return fs14.readFileSync(htmlPath, "utf8");
    } catch {
      return "<h1>Blacksite \u2014 Planning view not found</h1>";
    }
  }
};

// src/extension.ts
var chatProvider;
function activate(context) {
  const workspaceRoot = vscode18.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode18.workspace.getConfiguration("blacksite").get("workspaceRoot") ?? process.cwd();
  const runtime = new LocalRuntime(workspaceRoot);
  const secrets = new SecretStore(context.secrets);
  const sessionStore = new SessionStore(context);
  const memory = new MemoryStore(workspaceRoot);
  const baseContext = new BaseContextStore(workspaceRoot);
  const planning = new PlanningStore(workspaceRoot);
  memory.ensureInitialized();
  baseContext.ensureInitialized();
  planning.ensureInitialized();
  context.subscriptions.push(baseContext, planning);
  const diagnostics = new DiagnosticsPublisher(workspaceRoot);
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });
  chatProvider = new ChatProvider(context, runtime, secrets, sessionStore, workspaceRoot, memory, diagnostics, planning);
  const baseContextProvider = new BaseContextProvider(context, workspaceRoot, baseContext);
  const planningProvider = new PlanningProvider(context, planning);
  context.subscriptions.push(baseContextProvider, planningProvider);
  context.subscriptions.push(
    vscode18.window.registerWebviewViewProvider("blacksite.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode18.window.registerWebviewViewProvider("blacksite.plans", planningProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode18.window.registerWebviewViewProvider("blacksite.baseContext", baseContextProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode18.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new BlacksiteCodeActionProvider(),
      { providedCodeActionKinds: BlacksiteCodeActionProvider.providedCodeActionKinds }
    )
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.openChat", () => {
      void vscode18.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.clearChat", () => {
      chatProvider?.clearMessages();
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.cancelRun", () => {
      chatProvider?.cancelCurrentRun();
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.setApiKey", async () => {
      const provider = await vscode18.window.showQuickPick(
        ["anthropic", "openrouter", "openai", "github", "gitlab", "jira", "confluence", "salesforce"],
        { placeHolder: "Select provider", title: "Blacksite: Set API Key" }
      );
      if (!provider) return;
      await secrets.promptForApiKey(provider);
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.explainSelection", () => {
      const ctx = getSelectionContext();
      if (!ctx) {
        vscode18.window.showWarningMessage("Blacksite: Select some code first.");
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode18.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.askAboutFile", (uri) => {
      const target = uri ?? vscode18.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode18.window.showWarningMessage("Blacksite: No file selected.");
        return;
      }
      const ctx = getFileContext(target);
      if (!ctx) {
        vscode18.window.showWarningMessage(`Blacksite: Could not read ${path20.basename(target.fsPath)}.`);
        return;
      }
      chatProvider?.injectContext(ctx.text, ctx.label);
      void vscode18.commands.executeCommand("blacksite.chat.focus");
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand(
      "blacksite.fixDiagnostic",
      async (uri, diagnostic) => {
        const base = getDiagnosticContext(uri, diagnostic);
        let ctx = base;
        try {
          const doc = await vscode18.workspace.openTextDocument(uri);
          const startLine = Math.max(0, diagnostic.range.start.line - 3);
          const endLine = Math.min(doc.lineCount - 1, diagnostic.range.end.line + 3);
          const snippet = doc.getText(new vscode18.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length));
          ctx = { ...base, text: `${base.text}

\`\`\`${doc.languageId}
${snippet}
\`\`\`` };
        } catch {
        }
        chatProvider?.injectContext(ctx.text, ctx.label);
        void vscode18.commands.executeCommand("blacksite.chat.focus");
      }
    )
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.manageMcp", () => {
      McpPanel.show(context);
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.clearProblems", () => {
      diagnostics.clear();
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.closeBrowser", async () => {
      await chatProvider?.closeBrowser();
    })
  );
  context.subscriptions.push(
    vscode18.commands.registerCommand("blacksite.addFileToBaseContext", async (uri) => {
      await baseContextProvider.promptAndAddFile(uri);
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
