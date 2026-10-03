/* What each project in the workspace needs to build and run: toolchains, the versions it asks
   for (and where it says so), the step that installs its dependencies, and the editor extensions
   that make its language work.

   ── Why this exists ─────────────────────────────────────────────────────────
   Setting up a machine for a workspace is the part people find hardest: which Python does this
   repo want, is the one I have new enough, why are there import errors everywhere. In a window
   holding twenty codebases the question is asked twenty times with twenty answers. Reading the
   answers out of the files the projects already contain — and citing the file and line — turns
   it into a list a person can check, instead of guesswork.

   ── Bounds ──────────────────────────────────────────────────────────────────
   The scan walks each workspace folder to a fixed depth, skips dependency and build folders and
   dot-directories, and stops at a fixed number of projects, so a huge monorepo costs a bounded
   amount of disk reads. Nothing here runs a command or touches the network.

   Kept free of `vscode` so it can be tested directly. */

import fs from "fs";
import path from "path";
import { lineSpec, minimumSpec, parseVersion, parseVersionSpec, type VersionSpec } from "./version-spec.js";

import type { Evidence, Toolchain } from "./setup-types.js";

export type { Evidence, Toolchain } from "./setup-types.js";

export const TOOLCHAINS: Toolchain[] = ["Python", "Node", "Java", "Go", ".NET", "Rust", "C/C++"];

export interface Requirement {
  toolchain: Toolchain;
  spec: VersionSpec;
  evidence: Evidence;
  /** Declared by a folder above the project rather than the project itself. */
  inherited?: boolean;
}

export interface DependencyStep {
  toolchain: Toolchain;
  /** Program and arguments. `python` and `pip` mean the project's own environment's copies. */
  argv: string[];
  label: string;
  evidence: Evidence;
  /** Whether what it installs is already there (node_modules, a populated environment), when that can be told. */
  installed?: boolean;
}

export interface ProjectNeeds {
  /** Absolute project directory. */
  dir: string;
  /** Workspace-relative path shown to the user ("." for a folder root), prefixed with the
   *  folder name in a multi-root workspace. */
  display: string;
  name: string;
  /** The workspace folder this project is in. */
  workspaceFolder: string;
  toolchains: Toolchain[];
  requirements: Requirement[];
  dependencies: DependencyStep[];
  /** An existing virtualenv inside the project, relative to it. */
  venv?: string;
  /** Extensions the repository itself recommends (.vscode/extensions.json). */
  recommendedExtensions: string[];
}

/** The extension that gives each toolchain's language real editor support. Node needs none:
 *  VS Code's own TypeScript service covers JavaScript and TypeScript. */
export const TOOLCHAIN_EXTENSIONS: Partial<Record<Toolchain, string>> = {
  Python: "ms-python.python",
  Go: "golang.go",
  Rust: "rust-lang.rust-analyzer",
  Java: "redhat.java",
  ".NET": "ms-dotnettools.csharp",
  "C/C++": "ms-vscode.cpptools",
};

const MAX_DEPTH = 6;
const MAX_PROJECTS = 500;
const SKIP_DIRS = new Set([
  "node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "bin", "obj", "coverage",
  "venv", "env", "__pycache__", "site-packages", "Pods", "DerivedData", "tmp", "temp",
]);

/** Which toolchain a manifest file name implies. */
function toolchainsOfManifest(name: string): Toolchain[] {
  switch (name) {
    case "pyproject.toml": case "setup.py": case "setup.cfg": case "requirements.txt": case "Pipfile": return ["Python"];
    case "package.json": return ["Node"];
    case "go.mod": return ["Go"];
    case "Cargo.toml": return ["Rust"];
    case "pom.xml": case "build.gradle": case "build.gradle.kts": return ["Java"];
    case "CMakeLists.txt": case "meson.build": return ["C/C++"];
    default:
      return /\.(csproj|fsproj|vbproj|sln)$/i.test(name) ? [".NET"] : [];
  }
}

function readText(file: string, limit = 512 * 1024): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function lineOf(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split("\n").length;
}

/** A regex match in a file, with its line. */
function find(file: string, pattern: RegExp): { match: RegExpExecArray; line: number } | undefined {
  const text = readText(file);
  if (!text) return undefined;
  const match = pattern.exec(text);
  return match ? { match, line: lineOf(text, match.index) } : undefined;
}

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_whole: string, quoted: string | undefined) => quoted ?? "");
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file);
  if (!text) return undefined;
  try {
    const value = JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

interface ScanContext {
  folder: string;
  multiRoot: boolean;
}

function relative(ctx: ScanContext, file: string): string {
  const rel = path.relative(ctx.folder, file).split(path.sep).join("/") || ".";
  return ctx.multiRoot ? `${path.basename(ctx.folder)}/${rel === "." ? "" : rel}`.replace(/\/$/, "") : rel;
}

/** Directories from `dir` up to (and including) the workspace folder. */
function selfAndAncestors(dir: string, folder: string): string[] {
  const chain: string[] = [];
  let current = dir;
  for (;;) {
    chain.push(current);
    if (path.resolve(current) === path.resolve(folder)) break;
    const parent = path.dirname(current);
    if (parent === current || path.relative(folder, parent).startsWith("..")) break;
    current = parent;
  }
  return chain;
}

/** `.tool-versions` (asdf, mise) names toolchains its own way. */
const TOOL_VERSIONS_NAMES: Record<string, Toolchain> = {
  python: "Python", nodejs: "Node", node: "Node", golang: "Go", go: "Go", java: "Java", dotnet: ".NET", "dotnet-core": ".NET", rust: "Rust",
};

function toolVersions(file: string, toolchain: Toolchain): { version: string; line: number } | undefined {
  const text = readText(file);
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const [name, ...versions] = lines[index]!.replace(/#.*$/, "").trim().split(/\s+/);
    if (name && TOOL_VERSIONS_NAMES[name] === toolchain && versions[0]) {
      const version = /(\d+(?:\.\d+){0,2})/.exec(versions[0])?.[1];
      if (version) return { version, line: index + 1 };
    }
  }
  return undefined;
}

/** Java writes "1.8" for 8; everything from 9 on is just the major. */
export function javaMajor(version: string): string {
  const parts = parseVersion(version);
  if (!parts) return version;
  return String(parts[0] === 1 && parts[1] !== undefined ? parts[1] : parts[0]);
}

/** Version pins that apply to every project under the folder holding them. */
function inheritableRequirement(ctx: ScanContext, dir: string, toolchain: Toolchain): Omit<Requirement, "inherited"> | undefined {
  const at = (name: string): string => path.join(dir, name);
  const pinFile = (name: string): Omit<Requirement, "inherited"> | undefined => {
    const text = readText(at(name));
    const version = text?.split(/\r?\n/).map((line) => line.trim()).find((line) => /^v?\d/.test(line));
    return version ? { toolchain, spec: lineSpec(version, version.replace(/^v/, "")), evidence: { file: relative(ctx, at(name)), line: 1 } } : undefined;
  };
  const fromToolVersions = (): Omit<Requirement, "inherited"> | undefined => {
    const hit = toolVersions(at(".tool-versions"), toolchain);
    if (!hit) return undefined;
    const version = toolchain === "Java" ? javaMajor(hit.version) : hit.version;
    return { toolchain, spec: toolchain === "Java" ? minimumSpec(hit.version, version) : lineSpec(hit.version, version), evidence: { file: relative(ctx, at(".tool-versions")), line: hit.line } };
  };
  switch (toolchain) {
    case "Python": return pinFile(".python-version") ?? fromToolVersions();
    case "Node": return pinFile(".nvmrc") ?? pinFile(".node-version") ?? fromToolVersions();
    case ".NET": {
      const hit = find(at("global.json"), /"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
      if (hit) {
        const version = hit.match[1]!;
        const [major] = parseVersion(version)!;
        return {
          toolchain,
          spec: { raw: version, anyOf: [[{ op: ">=", version: parseVersion(version)! }, { op: "~", version: [major!] }]] },
          evidence: { file: relative(ctx, at("global.json")), line: hit.line },
        };
      }
      return fromToolVersions();
    }
    case "Rust": {
      const toml = find(at("rust-toolchain.toml"), /channel\s*=\s*"([^"]+)"/);
      if (toml) return { toolchain, spec: /^\d/.test(toml.match[1]!) ? lineSpec(toml.match[1]!, toml.match[1]!) : { raw: toml.match[1]!, anyOf: [] }, evidence: { file: relative(ctx, at("rust-toolchain.toml")), line: toml.line } };
      const plain = readText(at("rust-toolchain"))?.trim();
      if (plain) return { toolchain, spec: /^\d/.test(plain) ? lineSpec(plain, plain) : { raw: plain, anyOf: [] }, evidence: { file: relative(ctx, at("rust-toolchain")), line: 1 } };
      return fromToolVersions();
    }
    case "Go": case "Java": return fromToolVersions();
    default: return undefined;
  }
}

/** Requirements the project's own manifests declare (ranges and minimums, not pins). */
function manifestRequirement(ctx: ScanContext, dir: string, toolchain: Toolchain, manifests: readonly string[]): Omit<Requirement, "inherited"> | undefined {
  const at = (name: string): string => path.join(dir, name);
  switch (toolchain) {
    case "Python": {
      const pyproject = find(at("pyproject.toml"), /requires-python\s*=\s*["']([^"']+)["']/);
      if (pyproject) return { toolchain, spec: parseVersionSpec(pyproject.match[1]!), evidence: { file: relative(ctx, at("pyproject.toml")), line: pyproject.line } };
      const pipfile = find(at("Pipfile"), /python_(?:full_)?version\s*=\s*["']([^"']+)["']/);
      if (pipfile) return { toolchain, spec: lineSpec(pipfile.match[1]!, pipfile.match[1]!), evidence: { file: relative(ctx, at("Pipfile")), line: pipfile.line } };
      return undefined;
    }
    case "Node": {
      const volta = find(at("package.json"), /"volta"\s*:\s*\{[^}]*"node"\s*:\s*"([^"]+)"/);
      if (volta) return { toolchain, spec: lineSpec(volta.match[1]!, volta.match[1]!), evidence: { file: relative(ctx, at("package.json")), line: volta.line } };
      const engines = find(at("package.json"), /"engines"\s*:\s*\{[^}]*?"node"\s*:\s*"([^"]+)"/);
      if (engines) return { toolchain, spec: parseVersionSpec(engines.match[1]!), evidence: { file: relative(ctx, at("package.json")), line: engines.line } };
      return undefined;
    }
    case "Go": {
      const toolchainLine = find(at("go.mod"), /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m);
      if (toolchainLine) return { toolchain, spec: minimumSpec(toolchainLine.match[1]!, toolchainLine.match[1]!), evidence: { file: relative(ctx, at("go.mod")), line: toolchainLine.line } };
      const goLine = find(at("go.mod"), /^go\s+(\d+\.\d+(?:\.\d+)?)/m);
      if (goLine) return { toolchain, spec: minimumSpec(`go ${goLine.match[1]!}`, goLine.match[1]!), evidence: { file: relative(ctx, at("go.mod")), line: goLine.line } };
      return undefined;
    }
    case ".NET": {
      let best: { major: number; file: string; line: number; raw: string } | undefined;
      for (const name of manifests.filter((manifest) => /\.(csproj|fsproj|vbproj)$/i.test(manifest))) {
        const hit = find(at(name), /<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/);
        if (!hit) continue;
        for (const framework of hit.match[1]!.split(";")) {
          const major = /^net(\d+)\.\d/.exec(framework.trim())?.[1];
          if (major && (!best || Number(major) > best.major)) best = { major: Number(major), file: at(name), line: hit.line, raw: framework.trim() };
        }
      }
      return best ? { toolchain, spec: minimumSpec(best.raw, String(best.major)), evidence: { file: relative(ctx, best.file), line: best.line } } : undefined;
    }
    case "Java": {
      const pom = find(at("pom.xml"), /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>\s*([0-9.]+)\s*</);
      if (pom) return { toolchain, spec: minimumSpec(pom.match[1]!, javaMajor(pom.match[1]!)), evidence: { file: relative(ctx, at("pom.xml")), line: pom.line } };
      for (const name of ["build.gradle.kts", "build.gradle"]) {
        const gradle = find(at(name), /JavaLanguageVersion\.of\(\s*(\d+)\s*\)|sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([0-9._]+)/);
        if (gradle) {
          const raw = (gradle.match[1] ?? gradle.match[2] ?? "").replace(/_/g, ".");
          if (raw) return { toolchain, spec: minimumSpec(raw, javaMajor(raw)), evidence: { file: relative(ctx, at(name)), line: gradle.line } };
        }
      }
      return undefined;
    }
    default: return undefined;
  }
}

function requirementFor(ctx: ScanContext, dir: string, toolchain: Toolchain, manifests: readonly string[]): Requirement | undefined {
  // A pin in the project itself, then what its manifests declare, then a pin further up the tree.
  // .NET is the exception: the nearest global.json, wherever it is, decides which SDK builds the
  // project, so it outranks the minimum a TargetFramework implies.
  const pinned = inheritableRequirement(ctx, dir, toolchain);
  if (pinned) return pinned;
  if (toolchain === ".NET") {
    for (const ancestor of selfAndAncestors(dir, ctx.folder).slice(1)) {
      const inherited = inheritableRequirement(ctx, ancestor, toolchain);
      if (inherited) return { ...inherited, inherited: true };
    }
  }
  const own = manifestRequirement(ctx, dir, toolchain, manifests);
  if (own) return own;
  for (const ancestor of selfAndAncestors(dir, ctx.folder).slice(1)) {
    const inherited = inheritableRequirement(ctx, ancestor, toolchain);
    if (inherited) return { ...inherited, inherited: true };
  }
  return undefined;
}

/** True when a folder above `dir` manages its dependencies for it (an npm/pnpm/yarn workspace,
 *  a Cargo workspace, a uv workspace): installing in the member would be wrong. */
function managedByAncestor(dir: string, folder: string, toolchain: Toolchain): boolean {
  for (const ancestor of selfAndAncestors(dir, folder).slice(1)) {
    if (toolchain === "Node") {
      if (fs.existsSync(path.join(ancestor, "pnpm-workspace.yaml"))) return true;
      if (readJson(path.join(ancestor, "package.json"))?.workspaces) return true;
    }
    if (toolchain === "Rust" && /^\s*\[workspace\]/m.test(readText(path.join(ancestor, "Cargo.toml")) ?? "")) return true;
    if (toolchain === "Python" && /\[tool\.uv\.workspace\]/.test(readText(path.join(ancestor, "pyproject.toml")) ?? "")) return true;
  }
  return false;
}

function dependencySteps(ctx: ScanContext, dir: string, toolchains: readonly Toolchain[], manifests: readonly string[]): DependencyStep[] {
  const has = (name: string): boolean => fs.existsSync(path.join(dir, name));
  const evidence = (name: string): Evidence => ({ file: relative(ctx, path.join(dir, name)) });
  const steps: DependencyStep[] = [];
  const venvPresent = existingVenv(dir) !== undefined;
  const nodeModules = has("node_modules");
  for (const toolchain of toolchains) {
    if (managedByAncestor(dir, ctx.folder, toolchain)) continue;
    switch (toolchain) {
      case "Python":
        if (has("uv.lock")) steps.push({ toolchain, argv: ["uv", "sync"], label: "Install dependencies with uv", evidence: evidence("uv.lock") });
        else if (has("poetry.lock")) steps.push({ toolchain, argv: ["poetry", "install"], label: "Install dependencies with Poetry", evidence: evidence("poetry.lock") });
        else if (has("Pipfile")) steps.push({ toolchain, argv: ["pipenv", "install"], label: "Install dependencies with Pipenv", evidence: evidence("Pipfile") });
        else if (has("requirements.txt")) steps.push({ toolchain, argv: ["python", "-m", "pip", "install", "-r", "requirements.txt"], label: "Install requirements.txt into the project environment", evidence: evidence("requirements.txt") });
        break;
      case "Node": {
        const pkg = readJson(path.join(dir, "package.json"));
        if (!pkg || (!pkg.dependencies && !pkg.devDependencies)) break;
        if (has("pnpm-lock.yaml")) steps.push({ toolchain, argv: ["pnpm", "install", "--frozen-lockfile"], label: "Install packages with pnpm", evidence: evidence("pnpm-lock.yaml") });
        else if (has("yarn.lock")) steps.push({ toolchain, argv: ["yarn", "install"], label: "Install packages with Yarn", evidence: evidence("yarn.lock") });
        else if (has("bun.lockb") || has("bun.lock")) steps.push({ toolchain, argv: ["bun", "install"], label: "Install packages with Bun", evidence: evidence(has("bun.lock") ? "bun.lock" : "bun.lockb") });
        else if (has("package-lock.json")) steps.push({ toolchain, argv: ["npm", "ci"], label: "Install packages from package-lock.json", evidence: evidence("package-lock.json") });
        else steps.push({ toolchain, argv: ["npm", "install"], label: "Install packages with npm", evidence: evidence("package.json") });
        break;
      }
      case "Go": steps.push({ toolchain, argv: ["go", "mod", "download"], label: "Download Go modules", evidence: evidence("go.mod") }); break;
      case ".NET": {
        const project = manifests.find((name) => /\.sln$/i.test(name)) ?? manifests.find((name) => /\.(csproj|fsproj|vbproj)$/i.test(name));
        if (project) steps.push({ toolchain, argv: ["dotnet", "restore"], label: "Restore NuGet packages", evidence: evidence(project) });
        break;
      }
      case "Rust": steps.push({ toolchain, argv: ["cargo", "fetch"], label: "Fetch crates", evidence: evidence("Cargo.toml") }); break;
      case "Java":
        if (has("pom.xml")) {
          const wrapper = process.platform === "win32" ? "mvnw.cmd" : "mvnw";
          steps.push({ toolchain, argv: [has(wrapper) ? (process.platform === "win32" ? ".\\mvnw.cmd" : "./mvnw") : "mvn", "-q", "dependency:resolve"], label: "Resolve Maven dependencies", evidence: evidence("pom.xml") });
        }
        break;
      default: break;
    }
  }
  for (const step of steps) {
    if (step.toolchain === "Node") step.installed = nodeModules;
    else if (step.toolchain === "Python") step.installed = venvPresent;
  }
  return steps;
}

function existingVenv(dir: string): string | undefined {
  for (const name of [".venv", "venv", "env"]) {
    if (fs.existsSync(path.join(dir, name, "pyvenv.cfg"))) return name;
  }
  return undefined;
}

function recommendedExtensions(dir: string, folder: string): string[] {
  for (const ancestor of selfAndAncestors(dir, folder)) {
    const json = readJson(path.join(ancestor, ".vscode", "extensions.json"));
    if (json && Array.isArray(json.recommendations)) return json.recommendations.filter((value): value is string => typeof value === "string" && /^[\w-]+\.[\w.-]+$/.test(value));
  }
  return [];
}

/** Directories that hold at least one manifest, breadth-first, bounded. */
function findProjectDirs(folder: string, budget: { left: number }): Array<{ dir: string; manifests: string[] }> {
  const found: Array<{ dir: string; manifests: string[] }> = [];
  let level: string[] = [folder];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && budget.left > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const manifests = entries.filter((entry) => entry.isFile() && toolchainsOfManifest(entry.name).length > 0).map((entry) => entry.name);
      if (manifests.length > 0 && budget.left > 0) {
        found.push({ dir, manifests });
        budget.left -= 1;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    level = next;
  }
  return found;
}

function buildProject(ctx: ScanContext, dir: string, manifests: readonly string[]): ProjectNeeds {
  const toolchains = TOOLCHAINS.filter((toolchain) => manifests.some((name) => toolchainsOfManifest(name).includes(toolchain)));
  const requirements = toolchains
    .map((toolchain) => requirementFor(ctx, dir, toolchain, manifests))
    .filter((requirement): requirement is Requirement => !!requirement);
  return {
    dir,
    display: relative(ctx, dir),
    name: path.basename(dir),
    workspaceFolder: ctx.folder,
    toolchains,
    requirements,
    dependencies: dependencySteps(ctx, dir, toolchains, manifests),
    venv: toolchains.includes("Python") ? existingVenv(dir) : undefined,
    recommendedExtensions: recommendedExtensions(dir, ctx.folder),
  };
}

/** Every project under the workspace folders, with what it needs. */
export function scanProjectNeeds(workspaceFolders: readonly string[]): { projects: ProjectNeeds[]; truncated: boolean } {
  const budget = { left: MAX_PROJECTS };
  const projects: ProjectNeeds[] = [];
  const multiRoot = workspaceFolders.length > 1;
  for (const folder of workspaceFolders) {
    const ctx: ScanContext = { folder, multiRoot };
    for (const { dir, manifests } of findProjectDirs(folder, budget)) projects.push(buildProject(ctx, dir, manifests));
  }
  return { projects, truncated: budget.left <= 0 };
}

/** Just the projects owning these files (the nearest folder above each with a manifest), without
 *  scanning the workspace — cheap enough for the agent's per-turn context. */
export function needsForFiles(workspaceFolders: readonly string[], files: readonly string[]): ProjectNeeds[] {
  const multiRoot = workspaceFolders.length > 1;
  const byDir = new Map<string, ProjectNeeds>();
  for (const file of files) {
    const folder = workspaceFolders
      .filter((candidate) => { const rel = path.relative(candidate, file); return !rel.startsWith("..") && !path.isAbsolute(rel); })
      .sort((a, b) => b.length - a.length)[0];
    if (!folder) continue;
    for (const dir of selfAndAncestors(path.dirname(file), folder)) {
      if (byDir.has(dir)) break;
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const manifests = names.filter((name) => toolchainsOfManifest(name).length > 0);
      if (manifests.length === 0) continue;
      byDir.set(dir, buildProject({ folder, multiRoot }, dir, manifests));
      break;
    }
  }
  return [...byDir.values()];
}

/** The projects that own the given absolute paths: the deepest project directory containing each. */
export function projectsOwning(projects: readonly ProjectNeeds[], files: readonly string[]): ProjectNeeds[] {
  const owners = new Set<ProjectNeeds>();
  for (const file of files) {
    let best: ProjectNeeds | undefined;
    for (const project of projects) {
      const rel = path.relative(project.dir, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!best || project.dir.length > best.dir.length) best = project;
    }
    if (best) owners.add(best);
  }
  return [...owners];
}
