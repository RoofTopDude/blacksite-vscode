import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface WorkspacePath {
  rootId: string;
  path: string;
  uri: vscode.Uri;
}

export type WorkspaceResolution =
  | { ok: true; value: WorkspacePath }
  | { ok: false; error: string; ambiguous?: boolean; candidates?: Array<{ rootId: string; path: string }> };

interface RootInfo {
  id: string;
  fsPath: string;
}

export class WorkspaceIdentity {
  constructor(private readonly _fallbackRoot: string) {}

  resolve(input: string, rootId?: string): WorkspaceResolution {
    const raw = input.trim();
    if (!raw) return { ok: false, error: "A non-empty workspace path is required." };
    const roots = this.roots();

    if (path.isAbsolute(raw)) {
      const absolute = path.resolve(raw);
      const root = bestContainingRoot(absolute, roots);
      if (!root) return { ok: false, error: `Path is outside the open workspace: ${input}` };
      return { ok: true, value: toWorkspacePath(absolute, root) };
    }

    const selectedRoots = rootId ? roots.filter((root) => root.id === rootId) : roots;
    if (rootId && selectedRoots.length === 0) {
      return { ok: false, error: `Unknown workspace root '${rootId}'.` };
    }

    const safeCandidates = selectedRoots
      .map((root) => ({ root, absolute: path.resolve(root.fsPath, raw) }))
      .filter(({ root, absolute }) => isWithin(absolute, root.fsPath));
    if (safeCandidates.length === 0) {
      return { ok: false, error: `Path escapes the open workspace: ${input}` };
    }

    const existing = safeCandidates.filter(({ absolute }) => fs.existsSync(absolute));
    if (existing.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        error: `'${input}' exists in ${existing.length} workspace roots. Pass target.rootId to disambiguate.`,
        candidates: existing.map(({ root, absolute }) => ({ rootId: root.id, path: relativeToRoot(absolute, root.fsPath) })),
      };
    }

    const chosen = existing[0] ?? safeCandidates[0]!;
    return { ok: true, value: toWorkspacePath(chosen.absolute, chosen.root) };
  }

  fromUri(uri: vscode.Uri): WorkspaceResolution {
    if (uri.scheme !== "file") return { ok: false, error: `Unsupported non-file URI: ${uri.toString()}` };
    const absolute = path.resolve(uri.fsPath);
    const root = bestContainingRoot(absolute, this.roots());
    if (!root) return { ok: false, error: `URI is outside the open workspace: ${uri.fsPath}` };
    return { ok: true, value: toWorkspacePath(absolute, root) };
  }

  contains(uri: vscode.Uri): boolean {
    return this.fromUri(uri).ok;
  }

  roots(): RootInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return [{ id: path.basename(this._fallbackRoot) || "workspace", fsPath: path.resolve(this._fallbackRoot) }];
    const seen = new Map<string, number>();
    return folders.map((folder, index) => {
      const base = folder.name || path.basename(folder.uri.fsPath) || `root-${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return { id: count === 1 ? base : `${base}-${count}`, fsPath: path.resolve(folder.uri.fsPath) };
    });
  }

  display(value: WorkspacePath): { path: string; rootId?: string } {
    return { path: value.path, rootId: this.roots().length > 1 ? value.rootId : undefined };
  }
}

function bestContainingRoot(absolute: string, roots: RootInfo[]): RootInfo | undefined {
  return roots
    .filter((root) => isWithin(absolute, root.fsPath))
    .sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
}

function isWithin(absolute: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeToRoot(absolute: string, root: string): string {
  return path.relative(root, absolute).replace(/\\/g, "/") || ".";
}

function toWorkspacePath(absolute: string, root: RootInfo): WorkspacePath {
  return { rootId: root.id, path: relativeToRoot(absolute, root.fsPath), uri: vscode.Uri.file(absolute) };
}
