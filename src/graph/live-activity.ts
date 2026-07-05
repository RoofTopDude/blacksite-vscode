/* Pure tracker for the agent's *in-flight* tool operations on the Codebase
   Map. Unlike the fading trace trail (which is fire-and-forget the moment a
   tool starts), this models the span between a tool_call_start and its
   tool_call_result, so the map can show a sustained "the agent is working
   here right now" marker that clears the instant the call completes.

   No vscode imports — the graph provider feeds it start/result events and asks
   for a snapshot to ship to the webview; everything here is unit-testable. */

import type { TraceKind } from "./trace-extract.js";

/** One node currently being operated on, for the webview's live layer. */
export interface LiveActivity {
  /** Map node id (workspace-relative path). Only known nodes are tracked. */
  path: string;
  kind: TraceKind;
  /** Receipt time of the most recent start touching this path. */
  at: number;
  /** Present when the live operation belongs to a delegated subagent lane. */
  laneId?: string;
}

interface InFlightOp {
  paths: string[];
  kind: TraceKind;
  at: number;
  laneId?: string;
}

/** Default: a tool that never reports a result (crash, dropped event) stops
    showing a live marker after this long, so nothing gets stuck "working"
    forever. Real tool calls resolve far sooner. */
export const LIVE_OP_MAX_AGE_MS = 30_000;

export class LiveActivityTracker {
  private readonly _ops = new Map<string, InFlightOp>();

  /** Record a tool call beginning to touch `paths` (already filtered to known
      map nodes). A call touching no known node is ignored — nothing to show. */
  start(toolCallId: string, paths: readonly string[], kind: TraceKind, at: number, laneId?: string): void {
    if (paths.length === 0) return;
    this._ops.set(toolCallId, { paths: [...paths], kind, at, laneId });
  }

  /** Record a tool call finishing — its live marker clears immediately. */
  result(toolCallId: string): void {
    this._ops.delete(toolCallId);
  }

  clear(): void {
    this._ops.clear();
  }

  /** True if any operation is currently in flight (after pruning stale ones). */
  get active(): boolean {
    return this._ops.size > 0;
  }

  /** Current in-flight nodes, one entry per unique path (most recent kind/time
      wins when several ops touch the same file). Prunes ops older than
      `maxAgeMs` as a safety net against missed result events. */
  snapshot(now: number, maxAgeMs = LIVE_OP_MAX_AGE_MS): LiveActivity[] {
    const byPath = new Map<string, LiveActivity>();
    for (const [id, op] of this._ops) {
      if (now - op.at > maxAgeMs) {
        this._ops.delete(id);
        continue;
      }
      for (const path of op.paths) {
        const existing = byPath.get(path);
        if (!existing || op.at >= existing.at) {
          byPath.set(path, { path, kind: op.kind, at: op.at, laneId: op.laneId });
        }
      }
    }
    return [...byPath.values()].sort((a, b) => b.at - a.at);
  }
}
