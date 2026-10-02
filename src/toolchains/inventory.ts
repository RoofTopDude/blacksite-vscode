/* What is installed on this machine, and which environment each project in play uses.

   ── Why this exists ─────────────────────────────────────────────────────────
   Nothing told the agent what was installed, so every session found out the hard way: `python`
   "not installed" on a Mac that has `python3`, `pytest` "not installed" in a project whose
   virtualenv has it. Each discovery was forgotten when the turn ended, and the next session paid
   for it again. A short, current inventory in the per-turn context answers the question before
   the agent has to ask it with a failing command.

   ── Shape ───────────────────────────────────────────────────────────────────
   Machine: every install of each common toolchain found on PATH (all matches, not just the
   first), plus the usual side locations for Python (pyenv, Homebrew, the Windows `py` launcher),
   each with the version it reports. Probes are fixed, read-only `--version` style commands with a
   short timeout, deduplicated by real path, and cached against the PATH they were run with.

   Projects: for the projects the user and agent are working in, the virtualenv each would use and
   the Python tools in it. Read from disk on demand; cheap enough to do per turn.

   Kept free of `vscode` so it can be tested directly. */

import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { buildSanitizedProcessEnv, findProjectVenv, venvExecutable, venvPythonVersion } from "@blacksite/local-runtime";

export interface ToolchainInstall {
  toolchain: string;
  /** The name it answers to on PATH (`python3`), or the path when found off PATH. */
  command: string;
  path: string;
  version?: string;
  /** Where it came from, in a word: PATH, pyenv, Homebrew, py launcher. */
  source: string;
}

export interface MachineInventory {
  probedAt: number;
  /** Hash of the PATH the probes ran with: a different PATH is a different machine view. */
  pathKey: string;
  installs: ToolchainInstall[];
  /** Package and version managers present (brew, winget, uv, …). */
  managers: string[];
  /** Toolchains with no working install at all. */
  missing: string[];
}

interface Probe {
  toolchain: string;
  commands: string[];
  args: string[];
  /** First capture group (or the first defined one) is the version. */
  version: RegExp;
}

const PROBES: Probe[] = [
  { toolchain: "Python", commands: ["python3", "python"], args: ["--version"], version: /Python\s+([0-9][0-9.]*)/ },
  { toolchain: "Node", commands: ["node"], args: ["--version"], version: /v?([0-9]+\.[0-9]+\.[0-9]+)/ },
  { toolchain: "Java", commands: ["java"], args: ["-version"], version: /version\s+"([^"]+)"|openjdk\s+([0-9][0-9.]*)/ },
  { toolchain: "Go", commands: ["go"], args: ["version"], version: /go([0-9]+\.[0-9]+(?:\.[0-9]+)?)/ },
  { toolchain: ".NET", commands: ["dotnet"], args: ["--version"], version: /([0-9]+\.[0-9]+\.[0-9]+)/ },
  { toolchain: "Rust", commands: ["cargo"], args: ["--version"], version: /([0-9]+\.[0-9]+\.[0-9]+)/ },
  { toolchain: "C/C++", commands: ["clang", "gcc"], args: ["--version"], version: /([0-9]+\.[0-9]+\.[0-9]+)/ },
];

const MANAGERS = ["brew", "winget", "apt-get", "dnf", "uv", "rustup", "pyenv", "pipx", "volta", "fnm"];
const PROBE_TIMEOUT_MS = 3_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const separator = process.platform === "win32" ? ";" : ":";
  return String(env.PATH ?? env.Path ?? "").split(separator).map((entry) => entry.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

function executableNames(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [name];
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return extensions.map((extension) => `${name}${extension.toLowerCase()}`);
}

/** Every match for `name` on PATH, in PATH order, one per real file. */
export function whichAll(name: string, env: NodeJS.ProcessEnv = buildSanitizedProcessEnv()): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathEntries(env)) {
    for (const file of executableNames(name, env)) {
      const candidate = path.join(dir, file);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        const real = fs.realpathSync.native(candidate);
        if (seen.has(real)) continue;
        seen.add(real);
        found.push(candidate);
      } catch { /* not here */ }
    }
  }
  return found;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      // A non-zero exit, a timeout or a spawn failure is not a working install. Java and some
      // compilers print their version on stderr, so both streams are read.
      resolve(error ? undefined : `${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

/** Python installs off PATH: pyenv versions, Homebrew kegs. Paths to an interpreter. */
function sidePythonInstalls(): Array<{ path: string; source: string }> {
  const home = os.homedir();
  const results: Array<{ path: string; source: string }> = [];
  const add = (dir: string, source: string): void => {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const candidate = process.platform === "win32"
          ? path.join(dir, entry, "python.exe")
          : path.join(dir, entry, "bin", "python3");
        if (fs.existsSync(candidate)) results.push({ path: candidate, source });
      }
    } catch { /* not present */ }
  };
  add(path.join(home, ".pyenv", "versions"), "pyenv");
  if (process.platform === "darwin") {
    for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
      try {
        for (const entry of fs.readdirSync(prefix)) {
          if (!/^python@3\.\d+$/.test(entry)) continue;
          const candidate = path.join(prefix, entry, "bin", "python3");
          if (fs.existsSync(candidate)) results.push({ path: candidate, source: "Homebrew" });
        }
      } catch { /* no Homebrew here */ }
    }
  }
  return results;
}

/** `py -0p` on Windows: every Python the launcher knows, with its path. */
async function pyLauncherInstalls(env: NodeJS.ProcessEnv): Promise<Array<{ path: string; version?: string }>> {
  if (process.platform !== "win32") return [];
  const launcher = whichAll("py", env)[0];
  if (!launcher) return [];
  const output = await run(launcher, ["-0p"], env);
  if (!output) return [];
  return output.split(/\r?\n/)
    .map((line) => /-V:([0-9.]+)\S*\s+\*?\s*(.+\.exe)\s*$/i.exec(line.trim()))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({ version: match[1], path: match[2]!.trim() }));
}

function parseVersion(output: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(output);
  return match ? match.slice(1).find(Boolean) : undefined;
}

/** Probe the machine. Every probe runs in parallel and fails soft. */
export async function probeMachine(env: NodeJS.ProcessEnv = buildSanitizedProcessEnv()): Promise<MachineInventory> {
  const pathKey = createHash("sha256").update(String(env.PATH ?? env.Path ?? "")).digest("hex").slice(0, 16);
  const seenReal = new Set<string>();
  const unique = (file: string): boolean => {
    let real = file;
    try { real = fs.realpathSync.native(file); } catch { /* keep as is */ }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seenReal.has(key)) return false;
    seenReal.add(key);
    return true;
  };

  const tasks: Array<Promise<ToolchainInstall | undefined>> = [];
  for (const probe of PROBES) {
    for (const command of probe.commands) {
      for (const file of whichAll(command, env)) {
        // Windows' Store aliases for Python only offer to install one; they are not installs.
        if (process.platform === "win32" && /[\\/]WindowsApps[\\/]/i.test(file) && probe.toolchain === "Python") continue;
        if (!unique(file)) continue;
        tasks.push(run(file, probe.args, env).then((output) => output === undefined ? undefined : {
          toolchain: probe.toolchain, command, path: file, version: parseVersion(output, probe.version), source: "PATH",
        }));
      }
    }
  }
  const python = PROBES[0]!;
  for (const side of sidePythonInstalls()) {
    if (!unique(side.path)) continue;
    tasks.push(run(side.path, python.args, env).then((output) => output === undefined ? undefined : {
      toolchain: "Python", command: side.path, path: side.path, version: parseVersion(output, python.version), source: side.source,
    }));
  }
  const launched = pyLauncherInstalls(env).then((installs) => installs
    .filter((install) => unique(install.path))
    .map((install): ToolchainInstall => ({ toolchain: "Python", command: "py", path: install.path, version: install.version, source: "py launcher" })));

  const installs = [
    ...(await Promise.all(tasks)).filter((install): install is ToolchainInstall => !!install),
    ...await launched,
  ];
  const managers = MANAGERS.filter((name) => whichAll(name, env).length > 0);
  const present = new Set(installs.map((install) => install.toolchain));
  return {
    probedAt: Date.now(),
    pathKey,
    installs,
    managers,
    missing: PROBES.map((probe) => probe.toolchain).filter((toolchain) => !present.has(toolchain)),
  };
}

export function isStale(inventory: MachineInventory | undefined, env: NodeJS.ProcessEnv = buildSanitizedProcessEnv()): boolean {
  if (!inventory) return true;
  const pathKey = createHash("sha256").update(String(env.PATH ?? env.Path ?? "")).digest("hex").slice(0, 16);
  return inventory.pathKey !== pathKey || Date.now() - inventory.probedAt > STALE_AFTER_MS;
}

/** Python tools worth naming when a virtualenv has them. */
const VENV_TOOLS = ["pytest", "mypy", "ruff", "pyright", "black"];

export interface ProjectEnvironment {
  /** Workspace-relative project root ("" for the workspace root). */
  project: string;
  /** Workspace-relative virtualenv. */
  venv: string;
  pythonVersion?: string;
  tools: string[];
}

/** The virtualenv code in `anchorDir` would use (the nearest one above it), with its Python version
 *  and tools. The project is named after the folder that holds the environment. */
export function projectEnvironment(workspaceRoot: string, anchorDir: string): ProjectEnvironment | undefined {
  const venv = findProjectVenv(path.resolve(workspaceRoot, anchorDir), workspaceRoot);
  if (!venv) return undefined;
  const relative = (value: string): string => path.relative(workspaceRoot, value).split(path.sep).join("/");
  return {
    project: relative(path.dirname(venv)),
    venv: relative(venv),
    pythonVersion: venvPythonVersion(venv),
    tools: VENV_TOOLS.filter((tool) => !!venvExecutable(venv, tool)),
  };
}

/** The environments of the projects the given files belong to, one per environment. */
export function environmentsInPlay(workspaceRoot: string, files: readonly string[]): ProjectEnvironment[] {
  const byVenv = new Map<string, ProjectEnvironment>();
  for (const file of files) {
    const environment = projectEnvironment(workspaceRoot, path.dirname(path.resolve(workspaceRoot, file)));
    if (environment && !byVenv.has(environment.venv)) byVenv.set(environment.venv, environment);
  }
  return [...byVenv.values()];
}

const MAX_MACHINE_LINES = 6;
const MAX_PROJECT_LINES = 4;

/**
 * The inventory as a few lines for the per-turn context: each toolchain's installs with versions,
 * what is not installed, and the environment of each project in play.
 */
export function formatToolchainSummary(
  inventory: MachineInventory | undefined,
  environments: readonly ProjectEnvironment[],
): string {
  const lines: string[] = [];
  if (inventory) {
    const byToolchain = new Map<string, ToolchainInstall[]>();
    for (const install of inventory.installs) byToolchain.set(install.toolchain, [...(byToolchain.get(install.toolchain) ?? []), install]);
    for (const [toolchain, installs] of [...byToolchain].slice(0, MAX_MACHINE_LINES)) {
      const shown = installs.slice(0, 3).map((install) => {
        const name = install.source === "PATH" ? install.command : install.source;
        return `${name} ${install.version ?? "?"} (${install.path})`;
      });
      const extra = installs.length > 3 ? `, +${installs.length - 3} more` : "";
      let note = "";
      if (toolchain === "Python" && !installs.some((install) => install.command === "python" && install.source === "PATH")) {
        note = process.platform === "win32" ? " — no bare `python` on PATH; use `py` or the path" : " — no bare `python`; use `python3`";
      }
      lines.push(`- ${toolchain}: ${shown.join(", ")}${extra}${note}`);
    }
    if (inventory.missing.length > 0) lines.push(`- Not installed: ${inventory.missing.join(", ")}`);
    if (inventory.managers.length > 0) lines.push(`- Package managers: ${inventory.managers.join(", ")}`);
  }
  for (const environment of environments.slice(0, MAX_PROJECT_LINES)) {
    const tools = environment.tools.length > 0 ? `; has ${environment.tools.join(", ")}` : "";
    lines.push(`- Project ${environment.project || "(workspace root)"} uses ${environment.venv} (Python ${environment.pythonVersion ?? "?"}${tools}) — bare \`python\`, \`pytest\`, \`mypy\`… in that project run from it`);
  }
  if (environments.length > MAX_PROJECT_LINES) lines.push(`- (+${environments.length - MAX_PROJECT_LINES} more project environments)`);
  return lines.join("\n");
}

/** Where the last probe is kept between windows: VS Code's globalState, or anything shaped like it. */
export interface InventoryStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const STORE_KEY = "blacksite.toolchainInventory";

/**
 * The machine inventory, kept current without ever making a caller wait: `current()` answers from
 * the last probe and starts a fresh one in the background when that is stale. `refresh()` probes
 * now (after an install, or when the setup panel opens).
 */
export class ToolchainInventoryCache {
  private _inventory: MachineInventory | undefined;
  private _probing: Promise<MachineInventory> | undefined;
  private readonly _listeners = new Set<(inventory: MachineInventory) => void>();

  constructor(
    private readonly _store?: InventoryStore,
    private readonly _probe: () => Promise<MachineInventory> = () => probeMachine(),
  ) {
    this._inventory = _store?.get<MachineInventory>(STORE_KEY);
  }

  current(): MachineInventory | undefined {
    if (isStale(this._inventory) && !this._probing) void this.refresh().catch(() => undefined);
    return this._inventory;
  }

  refresh(): Promise<MachineInventory> {
    if (this._probing) return this._probing;
    this._probing = this._probe().then((inventory) => {
      this._inventory = inventory;
      void this._store?.update(STORE_KEY, inventory);
      for (const listener of this._listeners) listener(inventory);
      return inventory;
    }).finally(() => { this._probing = undefined; });
    return this._probing;
  }

  onDidChange(listener: (inventory: MachineInventory) => void): { dispose(): void } {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  }
}
