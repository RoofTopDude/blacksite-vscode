/* How each toolchain is installed, as a fixed table — the only source of command text for the
   setup terminal.

   ── Why a table ─────────────────────────────────────────────────────────────
   The installer runs commands with the user's privileges, sometimes elevated. Nothing a project or
   the agent wrote may reach it: package ids, flags and URLs come from here, versions must match a
   strict pattern, and paths are workspace directories quoted by the script writer. Anything the
   table does not cover is shown as a manual step with a link, never improvised.

   ── Scopes ──────────────────────────────────────────────────────────────────
   System: the platform's package manager (winget, Homebrew, apt/dnf) or the toolchain's official
   installer, for the user where the manager allows it.
   Project: each toolchain's own mechanism, inside the project — a virtualenv from an interpreter
   (or uv), Node and the JDK unpacked under `.toolchains/` from their official archives with a
   pinned SHA-256, .NET through Microsoft's dotnet-install script into `.dotnet/`. Go and rustup
   fetch the version a project pins by themselves, so they need no project install. */

import fs from "fs";
import path from "path";
import type { Toolchain } from "./project-needs.js";

export type Platform = "win32" | "darwin" | "linux";
export type Elevation = "none" | "admin" | "sudo";

/** One thing the script does. `run` executes a program with arguments; `shell` runs a fixed
 *  installer one-liner from this table (at most a quoted workspace path is appended); `download` fetches an archive,
 *  checks its SHA-256 and unpacks it; `append` adds a line to a file if it is not already there. */
export type ScriptCommand =
  | { kind: "run"; argv: string[]; cwd?: string }
  | { kind: "shell"; script: string }
  | { kind: "download"; url: string; sha256: string; fileName: string; into: string }
  | { kind: "append"; file: string; line: string };

export interface InstallStep {
  id: string;
  phase: "prerequisite" | "system" | "project" | "dependencies";
  /** Plain words for the step header, e.g. "Install Python 3.12 for your user". */
  title: string;
  toolchain?: Toolchain;
  /** Project display path for project-scoped steps. */
  project?: string;
  version?: string;
  /** Where files go, in words the user recognizes. */
  target: string;
  commands: ScriptCommand[];
  elevation: Elevation;
  /** How to take it back out. */
  undo: string;
  /** A failure stops the whole run (prerequisites, system installs); a project step only stops itself. */
  critical: boolean;
}

/** Version lines worth offering, newest first, as of this release. "Latest" means the first. */
export const VERSION_LINES: Partial<Record<Toolchain, string[]>> = {
  Python: ["3.14", "3.13", "3.12", "3.11"],
  Node: ["24", "22"],
  Java: ["25", "21", "17", "11", "8"],
  ".NET": ["10", "8"],
};

/** Lines past their end of life as of this release: worth a note, never a reason to block. */
const END_OF_LIFE: Partial<Record<Toolchain, RegExp>> = {
  Python: /^(2\.|3\.[0-9](\.|$)|3\.10(\.|$))/,
  Node: /^(1[0-9]|20|[0-9])(\.|$)/,
  ".NET": /^(5|6|7|9)(\.|$)/,
};

export function isEndOfLife(toolchain: Toolchain, version: string | undefined): boolean {
  return !!version && !!END_OF_LIFE[toolchain]?.test(version);
}

const VERSION_PATTERN = /^(latest|\d+(\.\d+){0,2})$/;

export function validVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

function majorMinor(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function major(version: string): string {
  return version.split(".")[0]!;
}

/** Paths reach the script quoted, but a newline or NUL could still break out of a line. */
export function safePath(value: string): boolean {
  return path.isAbsolute(value) && !/[\0\r\n]/.test(value);
}

export interface RecipeEnvironment {
  platform: Platform;
  /** Package managers present (from the machine inventory). */
  managers: readonly string[];
}

const RUSTUP_SCRIPT = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y";
const UV_SCRIPT = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const HOMEBREW_SCRIPT = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

function linuxManager(env: RecipeEnvironment): "apt" | "dnf" | undefined {
  if (env.managers.includes("apt-get")) return "apt";
  if (env.managers.includes("dnf")) return "dnf";
  return undefined;
}

/** Why a system install cannot be offered here, in words, or undefined when it can. */
export function systemInstallBlocker(toolchain: Toolchain, env: RecipeEnvironment): string | undefined {
  if (env.platform === "win32" && !env.managers.includes("winget")) {
    return "winget is not available. Install \"App Installer\" from the Microsoft Store, then scan again.";
  }
  if (env.platform === "linux" && !linuxManager(env) && toolchain !== "Rust") {
    return "No supported package manager (apt or dnf) was found. Install it with your distribution's tools.";
  }
  return undefined;
}

/** The step that makes the platform's package manager usable, when one is needed first. */
export function managerPrerequisite(env: RecipeEnvironment): InstallStep | undefined {
  if (env.platform === "darwin" && !env.managers.includes("brew")) {
    return {
      id: "prereq-homebrew", phase: "prerequisite", title: "Install Homebrew, the macOS package manager",
      target: "/opt/homebrew (Apple silicon) or /usr/local (Intel)", commands: [{ kind: "shell", script: HOMEBREW_SCRIPT }],
      elevation: "sudo", undo: "Homebrew's uninstall script: https://github.com/Homebrew/install#uninstall-homebrew", critical: true,
    };
  }
  if (env.platform === "linux" && linuxManager(env) === "apt") {
    return {
      id: "prereq-apt-update", phase: "prerequisite", title: "Refresh the package lists",
      target: "apt's package index", commands: [{ kind: "run", argv: ["sudo", "apt-get", "update"] }],
      elevation: "sudo", undo: "Nothing to undo.", critical: true,
    };
  }
  return undefined;
}

/** System-wide (or per-user) install of a toolchain line. Undefined when the platform has no recipe. */
export function systemInstall(toolchain: Toolchain, version: string, env: RecipeEnvironment): InstallStep | undefined {
  if (!validVersion(version) || systemInstallBlocker(toolchain, env)) return undefined;
  const id = `system-${toolchain.replace(/[^a-z]/gi, "").toLowerCase()}-${version}`;
  const base = { id, phase: "system" as const, toolchain, version, critical: true };
  const winget = (packageId: string, scope: "user" | "machine", title: string, target: string, undo: string): InstallStep => ({
    ...base, title, target,
    commands: [{ kind: "run", argv: ["winget", "install", "--id", packageId, "--exact", "--source", "winget", ...(scope === "user" ? ["--scope", "user"] : []), "--accept-package-agreements", "--accept-source-agreements"] }],
    elevation: scope === "machine" ? "admin" : "none",
    undo: `winget uninstall --id ${packageId}${undo ? `; ${undo}` : ""}`,
  });
  const brew = (args: string[], title: string, target: string, elevation: Elevation = "none"): InstallStep => ({
    ...base, title, target, commands: [{ kind: "run", argv: ["brew", ...args] }], elevation,
    undo: `brew uninstall ${args.filter((arg) => !arg.startsWith("-") && arg !== "install").join(" ")}`,
  });
  const linux = linuxManager(env);
  const pkg = (aptPackages: string[], dnfPackages: string[], title: string): InstallStep | undefined => {
    if (!linux) return undefined;
    const packages = linux === "apt" ? aptPackages : dnfPackages;
    return {
      ...base, title, target: "system packages (/usr)", elevation: "sudo",
      commands: [{ kind: "run", argv: linux === "apt" ? ["sudo", "apt-get", "install", "-y", ...packages] : ["sudo", "dnf", "install", "-y", ...packages] }],
      undo: linux === "apt" ? `sudo apt-get remove ${packages.join(" ")}` : `sudo dnf remove ${packages.join(" ")}`,
    };
  };
  const line = version === "latest" ? (VERSION_LINES[toolchain]?.[0] ?? "latest") : version;

  switch (toolchain) {
    case "Python": {
      const mm = majorMinor(line);
      if (env.platform === "win32") return winget(`Python.Python.${mm}`, "user", `Install Python ${mm} for your user`, "%LOCALAPPDATA%\\Programs\\Python", "");
      if (env.platform === "darwin") return brew(["install", `python@${mm}`], `Install Python ${mm} with Homebrew`, "Homebrew (python3 on PATH)");
      return pkg([`python${mm}`, `python${mm}-venv`], [`python${mm}`], `Install Python ${mm} from your distribution`);
    }
    case "Node": {
      const nodeMajor = major(line);
      if (env.platform === "win32") return winget("OpenJS.NodeJS.LTS", "machine", "Install the current Node.js LTS", "C:\\Program Files\\nodejs", "");
      if (env.platform === "darwin") {
        const step = brew(["install", `node@${nodeMajor}`], `Install Node.js ${nodeMajor} with Homebrew`, "Homebrew");
        step.commands.push({ kind: "run", argv: ["brew", "link", "--overwrite", "--force", `node@${nodeMajor}`] });
        return step;
      }
      return pkg(["nodejs", "npm"], ["nodejs", "npm"], "Install Node.js from your distribution (its packaged version)");
    }
    case "Java": {
      const javaMajor = major(line);
      if (env.platform === "win32") return winget(`EclipseAdoptium.Temurin.${javaMajor}.JDK`, "machine", `Install the Temurin JDK ${javaMajor}`, "C:\\Program Files\\Eclipse Adoptium", "");
      if (env.platform === "darwin") return brew(["install", "--cask", `temurin@${javaMajor}`], `Install the Temurin JDK ${javaMajor} with Homebrew`, "/Library/Java/JavaVirtualMachines", "sudo");
      return pkg([`openjdk-${javaMajor}-jdk`], [`java-${javaMajor}-openjdk-devel`], `Install OpenJDK ${javaMajor} from your distribution`);
    }
    case "Go":
      if (env.platform === "win32") return winget("GoLang.Go", "machine", "Install the latest Go", "C:\\Program Files\\Go", "");
      if (env.platform === "darwin") return brew(["install", "go"], "Install the latest Go with Homebrew", "Homebrew");
      return pkg(["golang-go"], ["golang"], "Install Go from your distribution (its packaged version)");
    case ".NET": {
      const dotnetMajor = major(line);
      if (env.platform === "win32") return winget(`Microsoft.DotNet.SDK.${dotnetMajor}`, "machine", `Install the .NET ${dotnetMajor} SDK`, "C:\\Program Files\\dotnet", "");
      if (env.platform === "darwin") return brew(["install", "--cask", "dotnet-sdk"], "Install the latest .NET SDK with Homebrew", "/usr/local/share/dotnet", "sudo");
      return pkg([`dotnet-sdk-${dotnetMajor}.0`], [`dotnet-sdk-${dotnetMajor}.0`], `Install the .NET ${dotnetMajor} SDK from your distribution`);
    }
    case "Rust":
      if (env.platform === "win32") return winget("Rustlang.Rustup", "user", "Install Rust with rustup (stable toolchain)", "%USERPROFILE%\\.cargo and .rustup", "");
      return { ...base, title: "Install Rust with rustup (stable toolchain)", target: "~/.cargo and ~/.rustup", commands: [{ kind: "shell", script: RUSTUP_SCRIPT }], elevation: "none", undo: "rustup self uninstall" };
    case "C/C++":
      if (env.platform === "win32") {
        return {
          ...base, title: "Install the Visual Studio C++ Build Tools", target: "C:\\Program Files (x86)\\Microsoft Visual Studio", elevation: "admin",
          commands: [{ kind: "run", argv: ["winget", "install", "--id", "Microsoft.VisualStudio.2022.BuildTools", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--override", "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"] }],
          undo: "Visual Studio Installer → Build Tools → Uninstall",
        };
      }
      if (env.platform === "darwin") return { ...base, title: "Install the Xcode Command Line Tools (a macOS dialog opens)", target: "/Library/Developer/CommandLineTools", commands: [{ kind: "run", argv: ["xcode-select", "--install"] }], elevation: "none", undo: "sudo rm -rf /Library/Developer/CommandLineTools" };
      return pkg(["build-essential"], ["gcc", "gcc-c++", "make"], "Install the C/C++ compilers and make");
  }
}

/** A helper tool a setup step needs (uv for Python environments, pnpm/yarn through corepack). */
export function toolInstall(tool: "uv" | "pnpm" | "yarn" | "poetry" | "pipenv", env: RecipeEnvironment): InstallStep | undefined {
  const base = { id: `prereq-${tool}`, phase: "prerequisite" as const, critical: true, elevation: "none" as const };
  switch (tool) {
    case "uv":
      if (env.platform === "win32") {
        if (!env.managers.includes("winget")) return undefined;
        return { ...base, title: "Install uv (Python versions and environments)", target: "your user profile", commands: [{ kind: "run", argv: ["winget", "install", "--id", "astral-sh.uv", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"] }], undo: "winget uninstall --id astral-sh.uv" };
      }
      if (env.platform === "darwin" && env.managers.includes("brew")) return { ...base, title: "Install uv with Homebrew", target: "Homebrew", commands: [{ kind: "run", argv: ["brew", "install", "uv"] }], undo: "brew uninstall uv" };
      return { ...base, title: "Install uv (official installer)", target: "~/.local/bin", commands: [{ kind: "shell", script: UV_SCRIPT }], undo: "rm ~/.local/bin/uv ~/.local/bin/uvx" };
    case "pnpm": case "yarn":
      return { ...base, title: `Enable ${tool} through Node's corepack`, target: "your Node installation", commands: [{ kind: "run", argv: ["corepack", "enable", tool] }], undo: `corepack disable ${tool}` };
    case "poetry": case "pipenv":
      if (!env.managers.includes("uv")) return undefined;
      return { ...base, title: `Install ${tool === "poetry" ? "Poetry" : "Pipenv"} as a uv tool`, target: "uv's tool directory", commands: [{ kind: "run", argv: ["uv", "tool", "install", tool] }], undo: `uv tool uninstall ${tool}` };
  }
}

/** Add `entry` to the project's .gitignore unless something there already covers it. */
export function gitignoreCommand(projectDir: string, entry: string): ScriptCommand | undefined {
  const name = entry.replace(/\/$/, "");
  for (let dir = projectDir; ; dir = path.dirname(dir)) {
    try {
      const text = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
      if (text.split(/\r?\n/).some((line) => line.trim().replace(/^\//, "").replace(/\/$/, "") === name)) return undefined;
    } catch { /* no .gitignore at this level */ }
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break;
  }
  return { kind: "append", file: path.join(projectDir, ".gitignore"), line: entry };
}

/** A virtualenv inside the project, from an interpreter that satisfies it. */
export function venvFromInterpreter(project: { dir: string; display: string }, interpreter: string, version: string | undefined): InstallStep | undefined {
  if (!safePath(project.dir) || !safePath(interpreter)) return undefined;
  const venv = path.join(project.dir, ".venv");
  const commands: ScriptCommand[] = [{ kind: "run", argv: [interpreter, "-m", "venv", venv] }];
  const ignore = gitignoreCommand(project.dir, ".venv/");
  if (ignore) commands.push(ignore);
  return {
    id: `venv-${project.display}`, phase: "project", toolchain: "Python", project: project.display, version,
    title: `Create .venv from Python ${version ?? ""}`.trim(), target: `${project.display}/.venv`,
    commands, elevation: "none", undo: `Delete ${project.display}/.venv`, critical: false,
  };
}

/** A Python the machine does not have, fetched by uv, and a virtualenv from it. */
export function venvWithUv(project: { dir: string; display: string }, version: string): InstallStep | undefined {
  if (!safePath(project.dir) || !validVersion(version) || version === "latest") return undefined;
  const venv = path.join(project.dir, ".venv");
  const commands: ScriptCommand[] = [
    { kind: "run", argv: ["uv", "python", "install", version] },
    { kind: "run", argv: ["uv", "venv", "--python", version, venv] },
  ];
  const ignore = gitignoreCommand(project.dir, ".venv/");
  if (ignore) commands.push(ignore);
  return {
    id: `venv-uv-${project.display}`, phase: "project", toolchain: "Python", project: project.display, version,
    title: `Fetch Python ${version} with uv and create .venv from it`, target: `${project.display}/.venv (Python kept in uv's cache)`,
    commands, elevation: "none", undo: `Delete ${project.display}/.venv; uv python uninstall ${version}`, critical: false,
  };
}

/** A resolved archive for a project-scope Node or JDK: exact URL and SHA-256, known before the script runs. */
export interface ResolvedArchive {
  url: string;
  sha256: string;
  fileName: string;
  version: string;
}

export function archiveInstall(toolchain: "Node" | "Java", project: { dir: string; display: string }, archive: ResolvedArchive): InstallStep | undefined {
  if (!safePath(project.dir) || !/^[a-f0-9]{64}$/.test(archive.sha256) || !/^https:\/\/(nodejs\.org|github\.com|api\.adoptium\.net|objects\.githubusercontent\.com)\//.test(archive.url) || !/^[\w.+-]+$/.test(archive.fileName)) return undefined;
  const into = path.join(project.dir, ".toolchains");
  const commands: ScriptCommand[] = [{ kind: "download", url: archive.url, sha256: archive.sha256, fileName: archive.fileName, into }];
  const ignore = gitignoreCommand(project.dir, ".toolchains/");
  if (ignore) commands.push(ignore);
  const label = toolchain === "Node" ? `Node.js ${archive.version}` : `the Temurin JDK ${archive.version}`;
  return {
    id: `archive-${toolchain.toLowerCase()}-${project.display}`, phase: "project", toolchain, project: project.display, version: archive.version,
    title: `Unpack ${label} into .toolchains (checksum verified)`, target: `${project.display}/.toolchains`,
    commands, elevation: "none", undo: `Delete ${project.display}/.toolchains`, critical: false,
  };
}

/** .NET SDK for one project, through Microsoft's dotnet-install script, into `<project>/.dotnet`. */
export function dotnetProjectInstall(project: { dir: string; display: string }, version: string, env: RecipeEnvironment): InstallStep | undefined {
  if (!safePath(project.dir) || !/^\d+$/.test(major(version))) return undefined;
  const channel = `${major(version)}.0`;
  const into = path.join(project.dir, ".dotnet");
  const script = env.platform === "win32"
    ? `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://dot.net/v1/dotnet-install.ps1').Content)) -Channel ${channel} -InstallDir`
    : `curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel ${channel} --install-dir`;
  const commands: ScriptCommand[] = [{ kind: "shell", script: `${script} ${quoteFor(env.platform, into)}` }];
  const ignore = gitignoreCommand(project.dir, ".dotnet/");
  if (ignore) commands.push(ignore);
  return {
    id: `dotnet-${project.display}`, phase: "project", toolchain: ".NET", project: project.display, version: channel,
    title: `Install the .NET ${channel} SDK into .dotnet (Microsoft's dotnet-install script)`, target: `${project.display}/.dotnet`,
    commands, elevation: "none", undo: `Delete ${project.display}/.dotnet`, critical: false,
  };
}

/** A project's dependency install, run in the project. `python`/`pip` resolve to its .venv. */
export function dependencyInstall(project: { dir: string; display: string }, argv: readonly string[], label: string, platform: Platform): InstallStep | undefined {
  if (!safePath(project.dir)) return undefined;
  const resolved = [...argv];
  if (resolved[0] === "python") {
    resolved[0] = platform === "win32" ? path.join(project.dir, ".venv", "Scripts", "python.exe") : path.join(project.dir, ".venv", "bin", "python");
  }
  return {
    id: `deps-${project.display}-${argv[0]}`, phase: "dependencies", project: project.display, title: label,
    target: project.display, commands: [{ kind: "run", argv: resolved, cwd: project.dir }],
    elevation: "none", undo: "Delete the installed dependency folder (node_modules, .venv packages…) to undo.", critical: false,
  };
}

/** Quote one argument for the script's shell: PowerShell single quotes, or POSIX single quotes. */
export function quoteFor(platform: Platform, value: string): string {
  return platform === "win32" ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Node's archive name and the URL of the official build for this machine. */
export function nodeArchiveName(version: string, platform: Platform, arch: string): string {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  const extension = platform === "win32" ? "zip" : platform === "darwin" ? "tar.gz" : "tar.xz";
  return `node-v${version}-${os}-${cpu}.${extension}`;
}
