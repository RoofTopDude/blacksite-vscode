import * as fs from "fs";
import * as path from "path";

type PathModule = typeof path.posix | typeof path.win32;

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}

function pathModuleFor(value: string): PathModule {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

function normalizeWithModule(root: string, pathModule: PathModule): string {
  return pathModule.resolve(root.trim());
}

/**
 * Choose the single workspace root used by the extension host.
 *
 * A non-empty explicit setting is an override. Otherwise the first open VS Code
 * folder wins, with the extension-host cwd as the no-folder fallback.
 */
export function resolvePrimaryWorkspaceRoot(
  configuredRoot: string | undefined,
  workspaceFolders: readonly string[],
  fallbackRoot: string,
): string {
  const selected = configuredRoot?.trim()
    || workspaceFolders.find((folder) => folder.trim().length > 0)?.trim()
    || fallbackRoot.trim();
  return path.resolve(selected || ".");
}

export function isWithinWorkspace(targetPath: string, workspaceRoots: string[]): boolean {
  const trimmedTarget = targetPath.trim();
  if (!trimmedTarget) return false;

  const targetModule = pathModuleFor(trimmedTarget);
  const resolvedTarget = normalizeWithModule(trimmedTarget, targetModule);
  return workspaceRoots
    .map((root) => root.trim())
    .filter(Boolean)
    .some((root) => {
      const rootModule = pathModuleFor(root);
      if (rootModule !== targetModule) return false;
      const normalizedRoot = normalizeWithModule(root, rootModule);
      const relative = rootModule.relative(normalizedRoot, resolvedTarget);
      return relative === "" || (!relative.startsWith("..") && !rootModule.isAbsolute(relative));
    });
}

export function resolveWorkspacePath(targetPath: string, workspaceRoots: string[]): string | null {
  const trimmed = targetPath.trim();
  if (!trimmed || workspaceRoots.length === 0) return null;

  const rootModule = pathModuleFor(workspaceRoots[0]!);
  const targetModule = pathModuleFor(trimmed);

  if (targetModule.isAbsolute(trimmed)) {
    const absolute = normalizeWithModule(trimmed, targetModule);
    return isWithinWorkspace(absolute, workspaceRoots) ? absolute : null;
  }

  const baseRoot = normalizeWithModule(workspaceRoots[0]!, rootModule);
  const candidate = rootModule.resolve(baseRoot, trimmed);
  return isWithinWorkspace(candidate, [baseRoot]) ? candidate : null;
}

/**
 * Resolve a requested path to a real file inside the workspace, or null.
 *
 * `resolveWorkspacePath` above is purely lexical — it answers "does this string sit under
 * that string", which is the right question when no filesystem is involved and is what makes
 * it testable without one. But a symlink *inside* the workspace pointing outside satisfies the
 * lexical check while the bytes live elsewhere, so any caller about to actually open the file
 * needs the physical path checked too. That is what this adds, mirroring the containment the
 * agent runtime already does in packages/local-runtime (`canonicalDirectory`).
 *
 * Returns null when the path escapes the workspace lexically, does not exist, resolves through
 * a link to somewhere outside, or is not a regular file — so a caller can treat null as a
 * single "not an openable workspace file" answer rather than checking existence separately.
 */
export function resolveExistingWorkspaceFile(targetPath: string, workspaceRoots: string[]): string | null {
  const lexical = resolveWorkspacePath(targetPath, workspaceRoots);
  if (!lexical) return null;

  let physical: string;
  try {
    physical = fs.realpathSync(lexical);
    if (!fs.statSync(physical).isFile()) return null;
  } catch {
    return null;
  }

  // Canonicalize the roots too: a workspace opened through a symlinked path would otherwise
  // reject every file under it, since the real file path can never sit under the link path.
  const realRoots: string[] = [];
  for (const root of workspaceRoots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    try { realRoots.push(fs.realpathSync(trimmed)); } catch { /* unreadable root — skip it */ }
  }
  if (realRoots.length === 0) return null;

  return isWithinWorkspace(physical, realRoots) ? physical : null;
}
