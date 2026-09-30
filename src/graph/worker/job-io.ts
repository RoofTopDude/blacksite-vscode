/* Node filesystem implementation of the job IO seam (index-job.ts /
   relationship-job.ts), shared by the worker and the inline fallback so the
   two paths read files identically. Node ids map to absolute paths through the
   same workspace-root rules the rest of the map uses. */

import * as fs from "fs";
import * as path from "path";
import { fromNodeId, type WorkspaceRoot } from "../workspace-roots.js";
import type { FileStat, IndexPhase, JobIO } from "../index-job.js";

export interface FsJobIOOptions {
  roots: readonly WorkspaceRoot[];
  /** Absolute cache file path, or null to skip caching. */
  cachePath: string | null;
  onProgress?: (phase: IndexPhase, fraction: number) => void;
  isCancelled?: () => boolean;
  /** True when running inline on the extension host: yield between batches. */
  cooperative: boolean;
}

export function createFsJobIO(options: FsJobIOOptions): JobIO {
  const roots = [...options.roots];
  const resolve = (rel: string): string | null => fromNodeId(roots, rel);
  return {
    async stat(rel: string): Promise<FileStat | null> {
      const abs = resolve(rel);
      if (!abs) return null;
      try {
        const stat = await fs.promises.stat(abs);
        return stat.isFile() ? { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size } : null;
      } catch {
        return null;
      }
    },
    async read(rel: string): Promise<string | null> {
      const abs = resolve(rel);
      if (!abs) return null;
      try {
        return await fs.promises.readFile(abs, "utf8");
      } catch {
        return null;
      }
    },
    async readCache(): Promise<unknown> {
      if (!options.cachePath) return null;
      try {
        return JSON.parse(await fs.promises.readFile(options.cachePath, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    async writeCache(text: string): Promise<void> {
      if (!options.cachePath) return;
      try {
        await fs.promises.mkdir(path.dirname(options.cachePath), { recursive: true });
        /* Write-then-rename so a crash mid-write never leaves a truncated cache
           that parses as "valid but empty". */
        const temp = `${options.cachePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, text, "utf8");
        await fs.promises.rename(temp, options.cachePath);
      } catch {
        /* best-effort derived cache */
      }
    },
    progress(phase, fraction) {
      options.onProgress?.(phase, fraction);
    },
    yieldNow(): Promise<void> {
      return options.cooperative ? new Promise((done) => setImmediate(done)) : Promise.resolve();
    },
    cancelled(): boolean {
      return options.isCancelled?.() ?? false;
    },
  };
}
