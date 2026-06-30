import * as path from "path";

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

export function isWithinWorkspace(targetPath: string, workspaceRoots: string[]): boolean {
  const resolvedTarget = path.resolve(targetPath);
  return workspaceRoots
    .map(normalizeRoot)
    .some((root) => {
      const relative = path.relative(root, resolvedTarget);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
}

export function resolveWorkspacePath(targetPath: string, workspaceRoots: string[]): string | null {
  const trimmed = targetPath.trim();
  if (!trimmed || workspaceRoots.length === 0) return null;

  if (path.isAbsolute(trimmed)) {
    const absolute = path.resolve(trimmed);
    return isWithinWorkspace(absolute, workspaceRoots) ? absolute : null;
  }

  const baseRoot = normalizeRoot(workspaceRoots[0]!);
  const candidate = path.resolve(baseRoot, trimmed);
  return isWithinWorkspace(candidate, [baseRoot]) ? candidate : null;
}
