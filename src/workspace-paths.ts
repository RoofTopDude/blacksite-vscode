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
