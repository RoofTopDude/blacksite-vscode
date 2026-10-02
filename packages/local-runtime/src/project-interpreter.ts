/* The Python environment a command belongs to.

   ── Why this exists ─────────────────────────────────────────────────────────
   A project's tools usually live in its own virtualenv (`services/billing/.venv/bin/pytest`), not
   on PATH. Commands are spawned with the editor's PATH, and PATH entries inside the workspace are
   deliberately never searched (a repository must not be able to shadow `git`). So a bare `pytest`
   or `mypy` reported "not installed" while the project had it, and the agent fell back to ad-hoc
   interpreters and hand-built PYTHONPATHs.

   This resolves a short, fixed list of Python tool names through the nearest virtualenv above the
   command's working directory — the one an activated shell in that directory would use. Only these
   names, so the shadowing rule still holds for everything else; and only the nearest environment
   upward, so a project never picks up a sibling project's environment. */

import fs from "fs";
import path from "path";

/** Tools that belong to a project's Python environment rather than to the machine. */
export const PROJECT_PYTHON_TOOLS: ReadonlySet<string> = new Set([
  "python", "python3", "pip", "pip3",
  "pytest", "py.test", "mypy", "ruff", "pyright", "basedpyright", "black", "isort", "flake8", "pylint",
]);

const VENV_DIR_NAMES = [".venv", "venv"];

function isVenv(dir: string): boolean {
  try { return fs.statSync(path.join(dir, "pyvenv.cfg")).isFile(); } catch { return false; }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The nearest virtualenv (`.venv` or `venv` holding a `pyvenv.cfg`) in `startDir` or any folder
 * above it, up to and including `boundary`. Undefined when there is none.
 */
export function findProjectVenv(startDir: string, boundary: string): string | undefined {
  const root = path.resolve(boundary);
  let dir = path.resolve(startDir);
  if (!isInside(root, dir)) return undefined;
  for (;;) {
    for (const name of VENV_DIR_NAMES) {
      const candidate = path.join(dir, name);
      if (isVenv(candidate)) return candidate;
    }
    if (dir === root) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A tool inside a virtualenv, by the layout of this platform (`bin/x` or `Scripts\\x.exe`). */
export function venvExecutable(venv: string, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = platform === "win32"
    ? [path.join(venv, "Scripts", `${name}.exe`), ...(name === "python3" ? [path.join(venv, "Scripts", "python.exe")] : [])]
    : [path.join(venv, "bin", name)];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try the next layout */ }
  }
  return undefined;
}

/** The Python version a virtualenv was created with, from its `pyvenv.cfg`. */
export function venvPythonVersion(venv: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(venv, "pyvenv.cfg"), "utf8");
    const match = /^\s*(?:version|version_info)\s*=\s*([0-9][0-9.]*)/m.exec(text);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Where a bare Python tool name should run from for a command started in `cwd`: the nearest
 * project virtualenv's copy, when that environment has it. From the workspace root, the first
 * argument that names a path inside the workspace anchors the search instead
 * (`pytest services/billing/tests` runs billing's pytest).
 */
export function resolveProjectPythonTool(
  command: string,
  args: readonly string[],
  cwd: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; venv: string } | undefined {
  const name = command.trim();
  if (!PROJECT_PYTHON_TOOLS.has(name)) return undefined;
  const root = path.resolve(workspaceRoot);
  const anchors: string[] = [];
  if (path.resolve(cwd) !== root) anchors.push(cwd);
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    const absolute = path.resolve(cwd, arg.split("::")[0]!);
    if (!isInside(root, absolute) || absolute === root) continue;
    try {
      anchors.push(fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute));
      break;
    } catch { /* not a path */ }
  }
  anchors.push(cwd);
  for (const anchor of anchors) {
    const venv = findProjectVenv(anchor, root);
    if (!venv) continue;
    const executable = venvExecutable(venv, name, platform);
    if (executable) return { executable, venv };
  }
  return undefined;
}
