/**
 * Applying an incremental update to a locally-held trace.
 *
 * Pure, and separated from the store for the same reason apps/runs/view-model.ts is separated
 * from apps/runs/store.ts: this is the logic most likely to be subtly wrong (ordering, overlap,
 * gaps, a stale in-flight message landing after a resync) and least pleasant to exercise through
 * a live webview.
 *
 * The contract this exists to keep: the view either holds a contiguous run of events from a known
 * baseline, or it knows that it does not and says so. It never silently renders a trace with a
 * hole in it, because a timeline missing events in the middle is worse than one that admits it
 * lost its place — the first misleads, the second can be repaired with a resync.
 */
import type { RunEvent } from "../runs/protocol";

/** Events the view keeps in memory. Bounded because a long run's trace is unbounded; the sidebar
 *  caps its window at 500 and an editor tab can afford more, but not everything. */
export const MAX_LIVE_EVENTS = 1500;

export type DeltaOutcome =
  /** Applied cleanly; the view is still contiguous. */
  | { kind: "applied"; events: RunEvent[]; lastSequence: number; truncatedBefore?: number }
  /** Ignored: the message belongs to a superseded attach. */
  | { kind: "stale" }
  /** A gap was detected. The caller must request a fresh baseline; nothing is applied. */
  | { kind: "gap"; expected: number; received: number };

export interface TraceWindow {
  events: RunEvent[];
  lastSequence: number;
  generation: number;
  /** Local memory starts here because the ring buffer dropped older events. */
  truncatedBefore?: number;
}

/**
 * Fold an incoming batch into the window.
 *
 * Four cases, in the order they matter:
 *  - a superseded generation is dropped outright, which is what stops a flush that was already in
 *    flight from landing on top of a fresh attach;
 *  - a batch the host truncated (`droppedBefore`) is a declared gap — applied, but the caller is
 *    told memory is no longer contiguous;
 *  - an overlapping batch has its already-seen prefix trimmed, so a redelivery is idempotent
 *    rather than duplicating rows;
 *  - a batch starting past the next expected sequence is a real gap and is refused.
 */
export function applyDelta(
  window: TraceWindow,
  batch: { generation: number; events: RunEvent[]; droppedBefore?: number },
): DeltaOutcome {
  if (batch.generation !== window.generation) return { kind: "stale" };

  const incoming = [...batch.events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (incoming.length === 0) {
    return { kind: "applied", events: window.events, lastSequence: window.lastSequence, ...(window.truncatedBefore !== undefined ? { truncatedBefore: window.truncatedBefore } : {}) };
  }

  const first = incoming[0]!.sequenceNumber;
  const expected = window.lastSequence + 1;

  // A host-declared truncation: honour it rather than treating it as a client-side gap, because
  // the host already knows precisely where the batch begins.
  if (batch.droppedBefore === undefined && first > expected && window.lastSequence > 0) {
    return { kind: "gap", expected, received: first };
  }

  const fresh = incoming.filter((event) => event.sequenceNumber > window.lastSequence);
  const merged = [...window.events, ...fresh];
  const overflow = Math.max(0, merged.length - MAX_LIVE_EVENTS);
  const kept = overflow > 0 ? merged.slice(overflow) : merged;

  const truncatedBefore = overflow > 0
    ? kept[0]?.sequenceNumber
    : batch.droppedBefore ?? window.truncatedBefore;

  return {
    kind: "applied",
    events: kept,
    lastSequence: Math.max(window.lastSequence, incoming.at(-1)!.sequenceNumber),
    ...(truncatedBefore !== undefined ? { truncatedBefore } : {}),
  };
}

/** Merge a keyed record set, replacing by id and preserving a stable order. Used for steps,
 *  observations and artifacts, which arrive as whole records rather than as a sequence. */
export function mergeById<T extends { id: string }>(current: T[], incoming: T[] | undefined): T[] {
  if (!incoming?.length) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}
