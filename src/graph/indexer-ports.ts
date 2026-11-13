/* Everything GraphIndexer needs from outside itself, as ports. The indexer orchestrates —
   discovery, git, the full rebuild, incremental passes, caching — and the host supplies the IO:
   node-ports.ts for the filesystem, git, the worker and on-disk caches; vscode-ports.ts for
   VS Code's file enumeration, watcher and workspace-folder events. A host without git, a watcher
   or storage leaves those out and the indexer does without. */

import type { Disposable, Event } from "./events.js";
import type { GitHistory, RepoGroup } from "./git-parse.js";
import type { FileStat } from "./index-job.js";
import type { JobRunner } from "./jobs.js";

/** Reads files by absolute path. Null when the path is missing, is not a file, or can't be read. */
export interface FileReader {
  stat(absolutePath: string): Promise<FileStat | null>;
  read(absolutePath: string): Promise<string | null>;
}

/** Git, for .gitignore-aware discovery, churn and recency, and co-change. */
export interface GitPort {
  /** The repository toplevel containing `rootPath` (forward slashes), or null outside a repo. */
  toplevel(rootPath: string): Promise<string | null>;
  /** Tracked plus untracked-but-not-ignored files under the group's roots, as absolute paths.
      Null when git fails, so the caller can fall back to enumerating. */
  listFiles(group: RepoGroup): Promise<string[] | null>;
  /** Which of `absolutePaths` (inside `toplevel`) git ignores, as lowercased forward-slash paths. */
  ignored(toplevel: string, absolutePaths: readonly string[]): Promise<Set<string>>;
  /** One history pass for the repository containing `rootPath`, keyed by normalize(). */
  history(rootPath: string, maxCommits: number): Promise<GitHistory | null>;
  /** The key history() uses for a path, so the caller can match its own files against it. */
  normalize(absolutePath: string): string;
}

/** Lists files under a root that git doesn't cover (a root outside any repository, or
    .gitignore not honoured), as absolute paths. `excludeGlob` is exclusions.ts' brace glob. */
export type FileEnumerator = (rootPath: string, excludeGlob: string, maxResults: number) => Promise<string[]>;

/** Reports created, changed and deleted files (absolute paths) under every root, current and future. */
export interface FileWatcher {
  watch(onTouch: (absolutePath: string) => void): Disposable;
}

/** Named, best-effort storage for the index's derived caches. read() is null when absent or
    unreadable; write() may throw, and the indexer treats a failed write as "no cache". */
export interface MapStorage {
  read(name: string): string | null;
  write(name: string, text: string): void;
  /** A filesystem location for `name`, for jobs that keep their own cache (the worker), or null. */
  path(name: string): string | null;
}

export interface GraphIndexerPorts {
  files: FileReader;
  jobs: JobRunner;
  /** Cooperative yield between files of an incremental pass on the host thread. */
  yieldNow(): Promise<void>;
  git?: GitPort;
  enumerate?: FileEnumerator;
  watcher?: FileWatcher;
  /** Fires when workspace roots are added or removed; the indexer rebuilds. */
  onDidChangeRoots?: Event<void>;
  storage?: MapStorage;
}
