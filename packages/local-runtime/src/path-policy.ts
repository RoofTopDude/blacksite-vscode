import path from "path";

function normalizeRoot(rootPath: string): string {
  const raw = String(rootPath ?? "").trim();
  return path.resolve(raw || ".");
}

export function isWithinWorkspace(rootPath: string, candidatePath: string): boolean {
  const root = normalizeRoot(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(
  rootPath: string,
  target: string,
  options: { label?: string; defaultToRoot?: boolean } = {},
): string {
  const root = normalizeRoot(rootPath);
  const raw = String(target ?? "").trim();
  if (!raw) {
    if (options.defaultToRoot) return root;
    throw new Error(`Missing ${options.label ?? "path"}.`);
  }

  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
  if (!isWithinWorkspace(root, resolved)) {
    throw new Error(`${options.label ?? "path"} escapes the workspace root: ${raw}`);
  }
  return resolved;
}

export function resolveWorkspaceCwd(rootPath: string, requested?: string): string {
  const raw = String(requested ?? "").trim();
  return raw
    ? resolveWorkspacePath(rootPath, raw, { label: "cwd" })
    : normalizeRoot(rootPath);
}

export function normalizeWorkspaceRoot(rootPath: string): string {
  return normalizeRoot(rootPath);
}
