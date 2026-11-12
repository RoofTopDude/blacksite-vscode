/* Node implementations of the indexer ports (indexer-ports.ts): the filesystem, git through the
   git CLI, the background worker, and caches as files in a directory under the first root. */

import * as fs from "fs";
import * as path from "path";
import { gitToplevel, ignoredPaths, listRepoFiles } from "./git-discovery.js";
import { collectGitHistory, normalizeAbsPath } from "./git-log.js";
import { GraphWorkerClient } from "./graph-worker-client.js";
import type { FileReader, GitPort, GraphIndexerPorts, MapStorage } from "./indexer-ports.js";
import type { WorkspaceRoot } from "./workspace-roots.js";

export const nodeFileReader: FileReader = {
  async stat(absolutePath) {
    try {
      const stat = await fs.promises.stat(absolutePath);
      return stat.isFile() ? { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size } : null;
    } catch {
      return null;
    }
  },
  async read(absolutePath) {
    try {
      return await fs.promises.readFile(absolutePath, "utf8");
    } catch {
      return null;
    }
  },
};

export const nodeGit: GitPort = {
  toplevel: gitToplevel,
  listFiles: listRepoFiles,
  ignored: ignoredPaths,
  history: (rootPath, maxCommits) => collectGitHistory(rootPath, maxCommits),
  normalize: normalizeAbsPath,
};

/** Caches as files in `dirName` under the first workspace root. They are derived data, so it is
    fine if that choice shifts across sessions when folders are reordered. */
export function directoryStorage(roots: () => readonly WorkspaceRoot[], dirName: string): MapStorage {
  const pathOf = (name: string): string | null => {
    const root = roots()[0];
    return root ? path.join(root.path, dirName, name) : null;
  };
  return {
    path: pathOf,
    read(name) {
      const location = pathOf(name);
      if (!location) return null;
      try {
        return fs.readFileSync(location, "utf8");
      } catch {
        return null;
      }
    },
    write(name, text) {
      const location = pathOf(name);
      if (!location) return;
      const dir = path.dirname(location);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(location, text, "utf8");
    },
  };
}

export function setImmediateYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface NodeIndexerPortOptions {
  roots: () => readonly WorkspaceRoot[];
  /** Directory under the first root that holds the caches (e.g. ".blacksite"). */
  cacheDirName: string;
  /** Absolute path of the bundled worker script, or null to run jobs inline. */
  workerScript: string | null;
}

/** Filesystem, git, worker and on-disk caches. A host adds its own enumerator, watcher and
    roots-changed event (vscode-ports.ts for the extension). */
export function nodeIndexerPorts(options: NodeIndexerPortOptions): GraphIndexerPorts {
  return {
    files: nodeFileReader,
    git: nodeGit,
    storage: directoryStorage(options.roots, options.cacheDirName),
    jobs: new GraphWorkerClient(options.workerScript),
    yieldNow: setImmediateYield,
  };
}
