/* Worker-thread entry for diagram-checker.ts (bundled to out/diagram-check-worker.js).
 *
 * Kept separate from the extension bundle because it installs a fake DOM as globals, which
 * must never happen on the extension host thread, and because it loads a 3.5 MB library the
 * host should not carry unless an agent actually checks a diagram.
 */

import { parentPort } from "node:worker_threads";
import { loadMermaidParser, type MermaidParser, type ParseOutcome } from "./diagram-check-core.js";

export interface CheckRequest {
  id: number;
  libraryPath: string;
  source: string;
}

/** `unavailable` means the checker itself could not run, which says nothing about the diagram. */
export type CheckResponse =
  | { id: number; outcome: ParseOutcome }
  | { id: number; unavailable: string };

let parser: MermaidParser | undefined;

async function handle(request: CheckRequest): Promise<void> {
  let response: CheckResponse;
  try {
    parser ??= loadMermaidParser(request.libraryPath);
    response = { id: request.id, outcome: await parser.parse(request.source) };
  } catch (error) {
    response = { id: request.id, unavailable: error instanceof Error ? error.message : String(error) };
  }
  parentPort?.postMessage(response);
}

parentPort?.on("message", (request: CheckRequest) => { void handle(request); });
