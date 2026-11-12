/* The contract between the Codebase Map index and whatever runs its heavy jobs (index-job.ts,
   relationship-job.ts): a background worker in the extension (graph-worker-client.ts), or inline.
   Types only, plus the cancellation error, so the index can depend on it without depending on
   worker_threads. */

import type { IndexJobInput, IndexJobResult, IndexPhase } from "./index-job.js";
import type { RelationshipJobInput, RelationshipJobResult } from "./relationship-job.js";
import type { WorkspaceRoot } from "./workspace-roots.js";

export class JobCancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface JobKinds {
  index: { input: IndexJobInput; result: IndexJobResult };
  relationships: { input: RelationshipJobInput; result: RelationshipJobResult };
}

export type JobKind = keyof JobKinds;

export interface RunJobOptions {
  roots: readonly WorkspaceRoot[];
  /** Where this job keeps its cache (MapStorage.path), or null to run without one. */
  cachePath: string | null;
  onProgress?: (phase: IndexPhase, fraction: number) => void;
}

export interface RunningJob<T> {
  promise: Promise<T>;
  cancel(): void;
}

export interface JobRunner {
  /** Whether jobs run off the calling thread. */
  readonly usesWorker: boolean;
  run<K extends JobKind>(kind: K, input: JobKinds[K]["input"], options: RunJobOptions): RunningJob<JobKinds[K]["result"]>;
}
