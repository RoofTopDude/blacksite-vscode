/* Runs Codebase Map jobs in the background worker (out/graph-worker.js), or
   inline on the calling thread when no worker script is available — unit tests,
   and any host where `worker_threads` cannot start. Both paths execute the same
   job functions with the same filesystem IO, so the only difference is which
   thread pays for it.

   Each job gets a fresh worker: jobs are minutes apart, a fresh worker means a
   crash or leak in one never poisons the next, and cancelling is simply
   terminating it. */

import * as fs from "fs";
import { Worker } from "worker_threads";
import { runIndexJob, type IndexJobInput, type IndexJobResult, type IndexPhase } from "./index-job.js";
import { runRelationshipJob, type RelationshipJobInput, type RelationshipJobResult } from "./relationship-job.js";
import { createFsJobIO } from "./worker/job-io.js";
import type { WorkspaceRoot } from "./workspace-roots.js";

export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

interface JobKinds {
  index: { input: IndexJobInput; result: IndexJobResult };
  relationships: { input: RelationshipJobInput; result: RelationshipJobResult };
}

export interface RunJobOptions {
  roots: readonly WorkspaceRoot[];
  cachePath: string | null;
  onProgress?: (phase: IndexPhase, fraction: number) => void;
}

export interface RunningJob<T> {
  promise: Promise<T>;
  cancel(): void;
}

export class GraphWorkerClient {
  private _seq = 0;
  /** Set when a worker failed to start; later jobs go inline for the session. */
  private _workerBroken = false;

  constructor(private readonly _workerScript: string | null) {}

  get usesWorker(): boolean {
    return Boolean(this._workerScript) && !this._workerBroken && fs.existsSync(this._workerScript!);
  }

  run<K extends keyof JobKinds>(kind: K, input: JobKinds[K]["input"], options: RunJobOptions): RunningJob<JobKinds[K]["result"]> {
    return this.usesWorker
      ? this._runInWorker(kind, input, options)
      : this._runInline(kind, input, options);
  }

  private _runInline<K extends keyof JobKinds>(kind: K, input: JobKinds[K]["input"], options: RunJobOptions): RunningJob<JobKinds[K]["result"]> {
    let cancelled = false;
    const io = createFsJobIO({
      roots: options.roots,
      cachePath: options.cachePath,
      cooperative: true,
      onProgress: options.onProgress,
      isCancelled: () => cancelled,
    });
    const promise = (async () => {
      const result = kind === "index"
        ? await runIndexJob(input as IndexJobInput, io)
        : await runRelationshipJob(input as RelationshipJobInput, io);
      if (cancelled) throw new JobCancelledError();
      return result as JobKinds[K]["result"];
    })().catch((error: unknown) => {
      if (cancelled) throw new JobCancelledError();
      throw error;
    });
    return { promise, cancel: () => { cancelled = true; } };
  }

  private _runInWorker<K extends keyof JobKinds>(kind: K, input: JobKinds[K]["input"], options: RunJobOptions): RunningJob<JobKinds[K]["result"]> {
    const id = ++this._seq;
    let worker: Worker;
    try {
      worker = new Worker(this._workerScript!);
    } catch {
      this._workerBroken = true;
      return this._runInline(kind, input, options);
    }
    let settled = false;
    let cancelInline: (() => void) | null = null;
    let rejectJob: (error: Error) => void = () => undefined;
    const promise = new Promise<JobKinds[K]["result"]>((resolve, reject) => {
      rejectJob = reject;
      worker.on("message", (message: { id: number; type: string; phase?: IndexPhase; fraction?: number; result?: unknown; message?: string }) => {
        if (message.id !== id) return;
        if (message.type === "progress" && message.phase) {
          options.onProgress?.(message.phase, message.fraction ?? 0);
          return;
        }
        settled = true;
        void worker.terminate();
        if (message.type === "result") resolve(message.result as JobKinds[K]["result"]);
        else reject(new Error(message.message ?? "graph worker failed"));
      });
      /* The worker itself failed (a load error, an OOM, an unexpected exit) —
         as opposed to the job throwing, which arrives as an "error" message.
         Fall back to running inline for the rest of the session rather than
         leaving the map without an index. */
      const fallBack = (): void => {
        if (settled) return;
        settled = true;
        this._workerBroken = true;
        void worker.terminate();
        const inline = this._runInline(kind, input, options);
        cancelInline = inline.cancel;
        inline.promise.then(resolve, reject);
      };
      worker.on("error", fallBack);
      worker.on("exit", fallBack);
    });
    worker.postMessage({ id, kind, input, roots: [...options.roots], cachePath: options.cachePath });
    return {
      promise,
      cancel: () => {
        cancelInline?.();
        if (settled) return;
        settled = true;
        rejectJob(new JobCancelledError());
        void worker.terminate();
      },
    };
  }
}
