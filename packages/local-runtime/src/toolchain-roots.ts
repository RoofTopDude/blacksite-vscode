import fs from "fs";
import os from "os";
import path from "path";

/**
 * Installed toolchains the agent may read outside the workspace without asking.
 *
 * The workspace boundary exists to keep the agent away from the user's own data — keys, cloud
 * credentials, other projects. An interpreter, its standard library and its globally installed
 * packages are none of those, and refusing them made globally installed software unusable: the
 * agent could run `python`, but not read the module it was calling or pass its install path.
 *
 * The roots are derived from the PATH commands are spawned with, because that is exactly the set
 * of toolchains the agent can already run:
 *
 * 1. Every PATH directory itself.
 * 2. For a PATH directory named `bin`, `sbin` or `Scripts`, the library directories of the
 *    installation above it — where `lib/python3.x`, `Lib\site-packages`, a global
 *    `node_modules` or a Go module cache live. Only named library directories are taken, never
 *    the whole prefix, so `/opt/homebrew/var` (database files) and `/usr/local/etc` (service
 *    configuration) stay out. Inside the home directory the list is shorter still: there,
 *    `share` and `src` are the user's own data (`~/.local/share`), not an installation's.
 * 3. Directories the user adds in user settings.
 *
 * Never a root: a filesystem root, the home directory or anything containing it, anything
 * containing the workspace (its sibling projects), and any path through a credential store.
 */

/** Library directories of an installation prefix, safe wherever the prefix lives. */
const PREFIX_LIBRARY_DIRS = ["lib", "lib64", "Lib", "DLLs", "include", "libexec", "pkg", "node_modules"];
/** Also taken for an installation outside the home directory, where they hold installed files. */
const SYSTEM_PREFIX_EXTRA_DIRS = ["share", "src", "Cellar", "opt", "Frameworks"];
const BIN_DIR_NAMES = new Set(["bin", "sbin", "scripts"]);

/** Directory and file names that hold credentials. A root through one, or a read below a root
 *  that passes through one, is never treated as an installed toolchain. */
const CREDENTIAL_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".docker", ".kube", ".gcloud", "gcloud", ".netrc", ".npmrc",
  ".pypirc", ".git-credentials", ".password-store", "keyrings", "credentials", "credentials.json",
  "credentials.toml",
]);

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` or lies beneath it. */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function passesThroughCredentials(candidate: string): boolean {
  return path.resolve(candidate).split(/[\\/]+/).some((segment) => CREDENTIAL_SEGMENTS.has(segment.toLowerCase()));
}

function realDirectory(candidate: string): string | null {
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export interface ToolchainRootOptions {
  workspaceRoot: string;
  /** The PATH value commands are spawned with. */
  pathValue: string | undefined;
  /** Extra user-configured roots, trusted as given (subject to the same exclusions). */
  extraRoots?: readonly string[];
  /** false leaves only `extraRoots` — the user turned automatic toolchain access off. */
  includePath?: boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface ToolchainRoots {
  /** Directories whose whole subtree may be read (canonical, deduplicated). */
  readable: string[];
  /** The canonical PATH directories alone: an executable named by its full path inside one of
   *  these is the same installed tool a bare command name would find. */
  executableDirs: string[];
}

export function computeToolchainRoots(options: ToolchainRootOptions): ToolchainRoots {
  const platform = options.platform ?? process.platform;
  const home = realDirectory(options.homeDir ?? os.homedir()) ?? path.resolve(options.homeDir ?? os.homedir());
  const workspace = realDirectory(options.workspaceRoot) ?? path.resolve(options.workspaceRoot);

  const acceptable = (root: string): boolean =>
    path.parse(root).root !== root                // not a filesystem root
    && !isInsideDirectory(root, home)             // not home, nor anything containing it
    && !isInsideDirectory(root, workspace)        // not the workspace's parents (sibling projects)
    && !isInsideDirectory(workspace, root)        // inside the workspace it is already readable
    && !passesThroughCredentials(root);

  const readable = new Map<string, string>();
  const executableDirs = new Map<string, string>();
  const add = (target: Map<string, string>, candidate: string): void => {
    const real = realDirectory(candidate);
    if (real && acceptable(real)) target.set(comparable(real), real);
  };

  if (options.includePath !== false) {
    const separator = platform === "win32" ? ";" : ":";
    for (const rawEntry of String(options.pathValue ?? "").split(separator)) {
      const entry = rawEntry.replace(/^"|"$/g, "").trim();
      if (!entry || !path.isAbsolute(entry)) continue;
      add(executableDirs, entry);
      add(readable, entry);
      if (!BIN_DIR_NAMES.has(path.basename(entry).toLowerCase())) continue;
      const prefix = path.dirname(path.resolve(entry));
      const insideHome = isInsideDirectory(home, prefix);
      const names = insideHome ? PREFIX_LIBRARY_DIRS : [...PREFIX_LIBRARY_DIRS, ...SYSTEM_PREFIX_EXTRA_DIRS];
      for (const name of names) add(readable, path.join(prefix, name));
    }
  }
  for (const extra of options.extraRoots ?? []) {
    const trimmed = String(extra ?? "").trim();
    if (!trimmed) continue;
    const expanded = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? path.join(home, trimmed.slice(1))
      : trimmed;
    if (path.isAbsolute(expanded)) add(readable, expanded);
  }

  return { readable: [...readable.values()], executableDirs: [...executableDirs.values()] };
}

/** True when the canonical `candidate` lies inside one of `roots` and not through a credential store. */
export function isInsideToolchainRoot(candidate: string, roots: readonly string[]): boolean {
  if (passesThroughCredentials(candidate)) return false;
  return roots.some((root) => isInsideDirectory(root, candidate));
}
