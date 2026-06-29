// Resolve where the extension-private database and large-object stores live.
//
// Per the locked BLA-80 decision, internal platform state moves OFF ad hoc
// workspace `.blacksite/*` JSON and under VS Code's extension storage:
//   - `storageUri`        — workspace-scoped (preferred when a folder is open)
//   - `globalStorageUri`  — cross-workspace fallback (no folder open)
//   - `.blacksite/data`   — last-resort fallback so the feature still works
//
// This module takes only the path strings it needs (not a live `vscode` import) so
// it stays unit-testable and free of editor host coupling.

import * as fs from "fs";
import * as path from "path";

export const DATABASE_FILE = "blacksite.db";

export interface StorageLocations {
  /** Directory that holds blacksite.db, blobs/, and indexes/. */
  root: string;
  /** Absolute path to the SQLite database file. */
  databaseFile: string;
  /** Directory for raw document bodies / cached extracts. */
  blobsDir: string;
  /** Directory for derived index artifacts. */
  indexesDir: string;
  /** Which candidate location was selected — surfaced for diagnostics. */
  source: "storageUri" | "globalStorageUri" | "workspace";
}

export interface StoragePathInputs {
  /** `context.storageUri?.fsPath` — undefined when no workspace folder is open. */
  storageFsPath?: string;
  /** `context.globalStorageUri.fsPath` — always present. */
  globalStorageFsPath?: string;
  /** First workspace folder path, used only for the last-resort fallback. */
  workspaceRoot?: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Pick the best available storage root and return the full set of derived paths.
 * Directories are created eagerly so callers can open files immediately.
 */
export function resolveStorageLocations(inputs: StoragePathInputs): StorageLocations {
  let root: string;
  let source: StorageLocations["source"];

  if (inputs.storageFsPath) {
    root = inputs.storageFsPath;
    source = "storageUri";
  } else if (inputs.globalStorageFsPath) {
    root = path.join(inputs.globalStorageFsPath, "data");
    source = "globalStorageUri";
  } else if (inputs.workspaceRoot) {
    root = path.join(inputs.workspaceRoot, ".blacksite", "data");
    source = "workspace";
  } else {
    throw new Error("No storage location available: provide storageUri, globalStorageUri, or workspaceRoot.");
  }

  const blobsDir = path.join(root, "blobs");
  const indexesDir = path.join(root, "indexes");

  ensureDir(root);
  ensureDir(blobsDir);
  ensureDir(indexesDir);

  return {
    root,
    databaseFile: path.join(root, DATABASE_FILE),
    blobsDir,
    indexesDir,
    source,
  };
}
