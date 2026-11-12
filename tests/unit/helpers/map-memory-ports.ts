/* In-memory indexer ports (src/graph/indexer-ports.ts) for unit tests: files live in a Map keyed
   by absolute path, jobs run inline over the same Map, storage is a Map. No disk, git or worker. */

import { Emitter, type Disposable } from "../../../src/graph/events.js";
import type { FileEnumerator, FileReader, FileWatcher, GraphIndexerPorts, MapStorage } from "../../../src/graph/indexer-ports.js";
import { runIndexJob, type JobIO } from "../../../src/graph/index-job.js";
import { runRelationshipJob } from "../../../src/graph/relationship-job.js";
import type { IndexJobInput } from "../../../src/graph/index-job.js";
import type { RelationshipJobInput } from "../../../src/graph/relationship-job.js";
import type { JobRunner } from "../../../src/graph/jobs.js";
import { fromNodeId, type WorkspaceRoot } from "../../../src/graph/workspace-roots.js";

export class MemoryFiles implements FileReader {
  readonly contents = new Map<string, string>();

  constructor(files: Record<string, string> = {}) {
    for (const [absolute, text] of Object.entries(files)) this.contents.set(absolute, text);
  }

  async stat(absolutePath: string) {
    const text = this.contents.get(absolutePath);
    return text === undefined ? null : { mtimeMs: 1, size: text.length };
  }

  async read(absolutePath: string) {
    return this.contents.get(absolutePath) ?? null;
  }
}

export class MemoryStorage implements MapStorage {
  readonly entries = new Map<string, string>();
  read(name: string) {
    return this.entries.get(name) ?? null;
  }
  write(name: string, text: string) {
    this.entries.set(name, text);
  }
  path() {
    return null;
  }
}

export class FakeWatcher implements FileWatcher {
  onTouch: ((absolutePath: string) => void) | null = null;
  disposed = false;
  watch(onTouch: (absolutePath: string) => void): Disposable {
    this.onTouch = onTouch;
    return { dispose: () => { this.disposed = true; } };
  }
}

/** Jobs run inline over the in-memory files; job caches are not kept. */
export function memoryJobs(files: MemoryFiles): JobRunner {
  return {
    usesWorker: false,
    run(kind, input, options) {
      const io: JobIO = {
        stat: (rel) => {
          const absolute = fromNodeId(options.roots, rel);
          return absolute ? files.stat(absolute) : Promise.resolve(null);
        },
        read: (rel) => {
          const absolute = fromNodeId(options.roots, rel);
          return absolute ? files.read(absolute) : Promise.resolve(null);
        },
        readCache: async () => null,
        writeCache: async () => undefined,
        progress: (phase, fraction) => options.onProgress?.(phase, fraction),
        yieldNow: async () => undefined,
        cancelled: () => false,
      };
      const promise = kind === "index"
        ? runIndexJob(input as IndexJobInput, io)
        : runRelationshipJob(input as RelationshipJobInput, io);
      return { promise: promise as never, cancel: () => undefined };
    },
  };
}

/** Lists every in-memory file under the root. */
export function memoryEnumerator(files: MemoryFiles): FileEnumerator {
  return async (rootPath) => [...files.contents.keys()].filter((absolute) => absolute.startsWith(`${rootPath}/`));
}

export interface MemoryPorts extends GraphIndexerPorts {
  files: MemoryFiles;
}

export function memoryPorts(files: MemoryFiles, extra: Partial<GraphIndexerPorts> = {}): MemoryPorts {
  return {
    files,
    jobs: memoryJobs(files),
    yieldNow: async () => undefined,
    enumerate: memoryEnumerator(files),
    ...extra,
  } as MemoryPorts;
}

export function rootsOf(path: string): () => WorkspaceRoot[] {
  const roots = [{ name: "ws", path }];
  return () => roots;
}

export { Emitter };
