/* Checks Mermaid source from the extension host without loading Mermaid into it.
 *
 * The parser lives in out/diagram-check-worker.js (see diagram-check-core.ts for why). One
 * worker is started on the first check, serves requests one at a time, and is shut down after
 * a minute of silence: diagrams are checked in bursts while the agent iterates on one, and
 * the loaded library is tens of megabytes the host should give back between bursts.
 *
 * A check that cannot run — no worker script, a crash, a hang — reports `checked: false`
 * rather than failing. The agent is told the diagram is unchecked; it is never told a diagram
 * is wrong because the checker was.
 */

import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import type { ParseOutcome } from "./diagram-check-core.js";
import type { CheckRequest, CheckResponse } from "./diagram-check-worker.js";

export interface DiagramCheck extends ParseOutcome {
  /** false when the checker could not run; `ok` then means "not shown to be wrong". */
  checked: boolean;
  /** Why it could not run, when `checked` is false. */
  note?: string;
}

const IDLE_MS = 60_000;
const TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (check: DiagramCheck) => void;
  timer: NodeJS.Timeout;
}

export class DiagramChecker {
  private _worker: Worker | undefined;
  private _seq = 0;
  private _idle: NodeJS.Timeout | undefined;
  private readonly _pending = new Map<number, Pending>();
  /** Set when the worker could not be started; later checks skip straight to unavailable. */
  private _broken: string | undefined;

  constructor(
    private readonly _workerScript: string,
    private readonly _libraryPath: string,
  ) {}

  check(source: string): Promise<DiagramCheck> {
    if (this._broken) return Promise.resolve(unchecked(this._broken));
    if (!fs.existsSync(this._workerScript) || !fs.existsSync(this._libraryPath)) {
      return Promise.resolve(unchecked("the diagram checker is not part of this build"));
    }
    const worker = this._start();
    if (!worker) return Promise.resolve(unchecked(this._broken ?? "the diagram checker could not start"));
    this._clearIdle();

    const id = ++this._seq;
    return new Promise<DiagramCheck>((resolve) => {
      const timer = setTimeout(() => {
        // A hung parse cannot be interrupted, so the worker goes with it.
        this._settle(id, unchecked("the diagram checker timed out"));
        this._stop();
      }, TIMEOUT_MS);
      this._pending.set(id, { resolve, timer });
      worker.postMessage({ id, libraryPath: this._libraryPath, source } satisfies CheckRequest);
    });
  }

  dispose(): void {
    this._stop();
  }

  private _start(): Worker | undefined {
    if (this._worker) return this._worker;
    try {
      const worker = new Worker(this._workerScript);
      worker.on("message", (response: CheckResponse) => {
        this._settle(response.id, "unavailable" in response
          ? unchecked(response.unavailable)
          : { ...response.outcome, checked: true });
        if (this._pending.size === 0) this._scheduleIdle();
      });
      // A worker that was stopped reports its exit later, by which time a newer one may be
      // serving requests; only the current worker's failure is a failure of pending checks.
      worker.on("error", (error) => {
        if (this._worker !== worker) return;
        this._worker = undefined;
        this._failAll(unchecked(`the diagram checker failed: ${error.message}`));
      });
      worker.on("exit", () => {
        if (this._worker !== worker) return;
        this._worker = undefined;
        this._failAll(unchecked("the diagram checker stopped"));
      });
      this._worker = worker;
      return worker;
    } catch (error) {
      this._broken = `the diagram checker could not start: ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    }
  }

  private _settle(id: number, check: DiagramCheck): void {
    const pending = this._pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(id);
    pending.resolve(check);
  }

  private _failAll(check: DiagramCheck): void {
    for (const id of [...this._pending.keys()]) this._settle(id, check);
  }

  private _scheduleIdle(): void {
    this._clearIdle();
    this._idle = setTimeout(() => this._stop(), IDLE_MS);
    this._idle.unref?.();
  }

  private _clearIdle(): void {
    if (this._idle) clearTimeout(this._idle);
    this._idle = undefined;
  }

  private _stop(): void {
    this._clearIdle();
    const worker = this._worker;
    this._worker = undefined;
    this._failAll(unchecked("the diagram checker stopped"));
    void worker?.terminate();
  }
}

function unchecked(note: string): DiagramCheck {
  return { ok: true, checked: false, note };
}
