/* Pure multi-root helpers for the Codebase Map. Node ids stay plain
   workspace-relative paths ("src/foo.ts") for the common single-folder case;
   with two or more workspace folders open, ids are folder-qualified
   ("my-app/src/foo.ts") so files from different roots never collide. No
   vscode import — the indexer/provider/annotation store compute the current
   roots from vscode.workspace.workspaceFolders and pass them in. */

export interface WorkspaceRoot {
  /** Prefix used on node ids when there is more than one root; unique. */
  name: string;
  /** Absolute path, forward slashes, no trailing slash. */
  path: string;
}

export function normalizeAbsolutePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Build a roots list from raw folder descriptors, de-duplicating names that
    collide (VS Code allows two workspace folders with the same basename). */
export function buildWorkspaceRoots(folders: readonly { name: string; path: string }[]): WorkspaceRoot[] {
  const seen = new Map<string, number>();
  return folders.map((folder) => {
    const p = normalizeAbsolutePath(folder.path);
    const base = folder.name.trim() || p.split("/").pop() || "workspace";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { name: count === 0 ? base : `${base}-${count + 1}`, path: p };
  });
}

/** Join `relPath` onto `rootPath`, rejecting any ".." that would climb above
    the root (unlike a plain path.resolve, which would happily escape it). */
function resolveWithinRoot(rootPath: string, relPath: string): string | null {
  const posixAbsolute = rootPath.startsWith("/"); // vs. a Windows "C:/..." root
  const rootParts = rootPath.split("/").filter(Boolean);
  const parts: string[] = [];
  for (const seg of relPath.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null; // would climb above the root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const joined = [...rootParts, ...parts].join("/");
  return posixAbsolute ? `/${joined}` : joined;
}

/** Node id for an absolute filesystem path, or null when it falls outside
    every root. Case-insensitive prefix match (Windows-safe). */
export function toNodeId(roots: readonly WorkspaceRoot[], absolutePath: string): string | null {
  const normalized = normalizeAbsolutePath(absolutePath);
  const lower = normalized.toLowerCase();
  for (const root of roots) {
    const rootLower = root.path.toLowerCase();
    if (!lower.startsWith(`${rootLower}/`)) continue;
    const rel = normalized.slice(root.path.length + 1);
    if (!rel) continue;
    return roots.length > 1 ? `${root.name}/${rel}` : rel;
  }
  return null;
}

/** Absolute filesystem path for a node id, or null when it doesn't resolve
    to a known root (unknown folder prefix, or a ".." escape). */
export function fromNodeId(roots: readonly WorkspaceRoot[], id: string): string | null {
  const normalized = id.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) return null;
  if (roots.length <= 1) {
    const root = roots[0];
    return root ? resolveWithinRoot(root.path, normalized) : null;
  }
  const slash = normalized.indexOf("/");
  if (slash <= 0) return null;
  const folderName = normalized.slice(0, slash);
  const rest = normalized.slice(slash + 1);
  if (!rest) return null;
  const root = roots.find((r) => r.name === folderName);
  return root ? resolveWithinRoot(root.path, rest) : null;
}

/** Best-effort node id for an agent- or user-supplied path, without throwing.
    Accepts an absolute path under any root, an already folder-qualified id, or
    a plain relative path (assumed under the first root — the common single-root
    shape). Returns null when it can't be mapped into any workspace root. Mirrors
    GraphAnnotationStore._validatePath's resolution so the map_relationships tool
    and note tools agree on how a path becomes an id. */
export function resolveToNodeId(roots: readonly WorkspaceRoot[], value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) return null;
  const root0 = roots[0];
  if (!root0) return null;
  const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  if (isAbsolute) return toNodeId(roots, normalized);
  const asAbsolute = (roots.length > 1 ? fromNodeId(roots, normalized) : null) ?? fromNodeId([root0], normalized);
  return asAbsolute ? toNodeId(roots, asAbsolute) : null;
}
