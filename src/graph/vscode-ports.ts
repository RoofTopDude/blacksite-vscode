/* VS Code implementations of the indexer ports (indexer-ports.ts) that need the editor:
   enumerating files git doesn't cover, watching the workspace, and workspace-folder changes. */

import * as vscode from "vscode";
import type { Event } from "./events.js";
import type { FileEnumerator, FileWatcher } from "./indexer-ports.js";

export const vscodeFileEnumerator: FileEnumerator = async (rootPath, excludeGlob, maxResults) => {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(rootPath, "**/*"), excludeGlob, maxResults);
  return uris.map((uri) => uri.fsPath);
};

export const vscodeFileWatcher: FileWatcher = {
  watch(onTouch) {
    /* A bare string pattern (not anchored via RelativePattern) watches every
       open workspace folder, current and future. */
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
    const touch = (uri: vscode.Uri): void => onTouch(uri.fsPath);
    watcher.onDidCreate(touch);
    watcher.onDidChange(touch);
    watcher.onDidDelete(touch);
    return watcher;
  },
};

export const onDidChangeWorkspaceRoots: Event<void> = (listener, thisArgs, disposables) =>
  vscode.workspace.onDidChangeWorkspaceFolders(
    () => listener.call(thisArgs, undefined),
    undefined,
    disposables as vscode.Disposable[] | undefined,
  );
