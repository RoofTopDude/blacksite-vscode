/* Background worker for the Codebase Map's heavy passes (bundled by esbuild to
   out/graph-worker.js). The extension host thread also runs chat and the agent,
   so a full rebuild over tens of thousands of files belongs here: reads,
   extraction, resolution, relationship detection, and layout all happen off
   that thread, and only the results cross back.

   Protocol: the parent posts one { id, kind, input, roots, cachePath } job and
   receives { id, type: "progress", phase, fraction }* then exactly one
   { id, type: "result", result } or { id, type: "error", message }. The parent
   terminates the worker to cancel, so there is no cancel message. */

import { parentPort } from "worker_threads";
import { runIndexJob, type IndexJobInput } from "../index-job.js";
import { runRelationshipJob, type RelationshipJobInput } from "../relationship-job.js";
import { createFsJobIO } from "./job-io.js";
import type { WorkspaceRoot } from "../workspace-roots.js";

interface JobMessage {
  id: number;
  kind: "index" | "relationships";
  input: unknown;
  roots: WorkspaceRoot[];
  cachePath: string | null;
}

parentPort?.on("message", (message: JobMessage) => {
  void (async () => {
    const io = createFsJobIO({
      roots: message.roots,
      cachePath: message.cachePath,
      cooperative: false,
      onProgress: (phase, fraction) => parentPort?.postMessage({ id: message.id, type: "progress", phase, fraction }),
    });
    try {
      const result = message.kind === "index"
        ? await runIndexJob(message.input as IndexJobInput, io)
        : await runRelationshipJob(message.input as RelationshipJobInput, io);
      parentPort?.postMessage({ id: message.id, type: "result", result });
    } catch (error) {
      parentPort?.postMessage({ id: message.id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
