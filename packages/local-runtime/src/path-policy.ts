import fs from "fs";
import path from "path";
import { isInsideToolchainRoot } from "./toolchain-roots.js";

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

/**
 * Symlink-resolved form of `candidate`, which need not exist yet: the deepest ancestor that
 * does exist is canonicalized with realpath and the not-yet-created remainder re-appended, so
 * a file about to be created is judged by where its bytes would actually land. Null when that
 * ancestor exists but cannot be canonicalized — a dangling link, a permissions failure — so
 * callers fail closed rather than guess.
 */
function physicalPath(candidate: string): string | null {
  const tail: string[] = [];
  let current = candidate;
  for (;;) {
    let exists = true;
    try { fs.lstatSync(current); } catch { exists = false; }
    if (exists) {
      try {
        return path.join(fs.realpathSync.native(current), ...tail);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    // Nothing on the path exists at all (a root that was never created): lexical is all there is.
    if (parent === current) return candidate;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * The lexical check alone answers "does this string sit under that string". A symlink inside
 * the workspace that points outside it passes that check while the bytes live elsewhere — a
 * repository can ship `docs -> ~/.ssh` — so the physical location is checked too. With
 * `followFinalLink: false` the last component itself is not followed: deleting a link removes
 * the link, never its target, so only where the link lives matters.
 */
function assertPhysicallyWithinWorkspace(
  root: string,
  resolved: string,
  label: string,
  raw: string,
  followFinalLink: boolean,
): void {
  const physicalRoot = physicalPath(root);
  const physicalTarget = followFinalLink
    ? physicalPath(resolved)
    : (() => {
        const parent = physicalPath(path.dirname(resolved));
        return parent === null ? null : path.join(parent, path.basename(resolved));
      })();
  if (physicalRoot === null || physicalTarget === null) {
    throw new Error(`${label} cannot be resolved to a real location inside the workspace: ${raw}`);
  }
  if (!isWithinWorkspace(physicalRoot, physicalTarget)) {
    throw new Error(`${label} resolves through a symbolic link to outside the workspace root: ${raw}`);
  }
}

/**
 * True when `candidate` (which need not exist yet) physically lives inside `rootPath` once
 * symbolic links are resolved — the check behind {@link resolveWorkspacePath}, for callers
 * that resolve paths their own way but must not follow a link out of the workspace.
 */
export function isPhysicallyWithinWorkspace(rootPath: string, candidate: string): boolean {
  const physicalRoot = physicalPath(normalizeRoot(rootPath));
  const physicalTarget = physicalPath(path.resolve(candidate));
  return physicalRoot !== null && physicalTarget !== null && isWithinWorkspace(physicalRoot, physicalTarget);
}

export function resolveWorkspacePath(
  rootPath: string,
  target: string,
  options: { label?: string; defaultToRoot?: boolean; followFinalLink?: boolean } = {},
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
  assertPhysicallyWithinWorkspace(root, resolved, options.label ?? "path", raw, options.followFinalLink !== false);
  return resolved;
}

/** Where a path being *read* actually lives. */
export type ReadLocation = "workspace" | "toolchain" | "external";

export interface ReadPathResolution {
  /** The absolute path as requested (links not followed). */
  resolved: string;
  /** Where the bytes are, once links are followed; differs from `resolved` only through a link. */
  physical: string;
  location: ReadLocation;
}

/**
 * Resolve a path for reading. Unlike {@link resolveWorkspacePath} this does not refuse a path
 * outside the workspace; it says where the path really leads, so a read tool can go ahead in the
 * workspace or an installed toolchain (`readableRoots`, see toolchain-roots.ts) and ask the user
 * before reading anywhere else. Judged by physical location, so a workspace link into a
 * toolchain (`.venv/bin/python`) reads like the toolchain and one into `~/.ssh` does not pass.
 */
export function resolveReadPath(
  rootPath: string,
  target: string,
  options: { label?: string; defaultToRoot?: boolean; readableRoots?: readonly string[] } = {},
): ReadPathResolution {
  const root = normalizeRoot(rootPath);
  const raw = String(target ?? "").trim();
  if (!raw && !options.defaultToRoot) throw new Error(`Missing ${options.label ?? "path"}.`);
  const resolved = raw ? path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw)) : root;
  const physicalRoot = physicalPath(root) ?? root;
  const physical = physicalPath(resolved);
  if (physical === null) {
    // A dangling link or an unreadable ancestor: nothing to read, and nothing trustworthy to
    // report — ask rather than guess where it would lead.
    return { resolved, physical: resolved, location: "external" };
  }
  if (isWithinWorkspace(root, resolved) && isWithinWorkspace(physicalRoot, physical)) {
    return { resolved, physical, location: "workspace" };
  }
  const trusted = options.readableRoots && isInsideToolchainRoot(physical, options.readableRoots);
  return { resolved, physical, location: trusted ? "toolchain" : "external" };
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
