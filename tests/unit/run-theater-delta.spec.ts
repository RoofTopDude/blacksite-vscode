/**
 * Applying incremental trace updates in the run theater.
 *
 * The contract under test: the view either holds a contiguous run of events from a known
 * baseline, or it knows it does not. A timeline silently missing events in the middle is worse
 * than one that admits it lost its place — the first misleads, the second is repairable.
 */
import { describe, expect, it } from "vitest";
import {
  applyDelta,
  mergeById,
  MAX_LIVE_EVENTS,
  type TraceWindow,
} from "../../src/webview/react/apps/run-theater/delta.js";
import type { RunEvent } from "../../src/webview/react/apps/runs/protocol.js";

function ev(sequenceNumber: number): RunEvent {
  return {
    id: `e${sequenceNumber}`,
    runId: "run-1",
    sequenceNumber,
    monotonicTimestampNs: String(sequenceNumber * 1000),
    wallClockTimestamp: "2026-07-31T00:00:00.000Z",
    channel: "log",
    type: "console",
    source: { adapterId: "browser", producer: "test" },
    entityRefs: [],
  } as unknown as RunEvent;
}

function windowOf(sequences: number[], generation = 1, truncatedBefore?: number): TraceWindow {
  return {
    events: sequences.map(ev),
    lastSequence: sequences.at(-1) ?? 0,
    generation,
    ...(truncatedBefore !== undefined ? { truncatedBefore } : {}),
  };
}

describe("applyDelta", () => {
  it("appends a contiguous batch", () => {
    const out = applyDelta(windowOf([1, 2, 3]), { generation: 1, events: [ev(4), ev(5)] });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(out.lastSequence).toBe(5);
  });

  /** A flush already in flight when a resync happens must not land on top of the new baseline. */
  it("discards a batch from a superseded generation", () => {
    expect(applyDelta(windowOf([1, 2], 2), { generation: 1, events: [ev(3)] }).kind).toBe("stale");
  });

  it("refuses a batch that skips ahead, so the gap is visible rather than silent", () => {
    const out = applyDelta(windowOf([1, 2, 3]), { generation: 1, events: [ev(7), ev(8)] });
    expect(out).toEqual({ kind: "gap", expected: 4, received: 7 });
  });

  /** Redelivery has to be idempotent — a resync that overlaps must not duplicate rows. */
  it("trims an already-seen prefix instead of duplicating it", () => {
    const out = applyDelta(windowOf([1, 2, 3]), { generation: 1, events: [ev(2), ev(3), ev(4)] });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4]);
  });

  it("accepts an out-of-order batch by sequence, not arrival", () => {
    const out = applyDelta(windowOf([1]), { generation: 1, events: [ev(3), ev(2)] });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.events.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
  });

  /**
   * A host-declared truncation is not a client-side gap: the host capped an oversized burst and
   * said exactly where the batch begins, so applying it is correct — it just is not contiguous.
   */
  it("applies a host-truncated batch and records where memory now starts", () => {
    const out = applyDelta(windowOf([1, 2]), { generation: 1, events: [ev(90), ev(91)], droppedBefore: 90 });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.truncatedBefore).toBe(90);
    expect(out.lastSequence).toBe(91);
  });

  it("treats the very first batch as a baseline rather than a gap", () => {
    const out = applyDelta(windowOf([]), { generation: 1, events: [ev(500), ev(501)] });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.lastSequence).toBe(501);
  });

  it("is a no-op for an empty batch", () => {
    const out = applyDelta(windowOf([1, 2]), { generation: 1, events: [] });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.events.map((e) => e.sequenceNumber)).toEqual([1, 2]);
    expect(out.lastSequence).toBe(2);
  });

  it("bounds memory and reports the new floor once the ring buffer wraps", () => {
    const start = windowOf(Array.from({ length: MAX_LIVE_EVENTS }, (_, i) => i + 1));
    const out = applyDelta(start, {
      generation: 1,
      events: [ev(MAX_LIVE_EVENTS + 1), ev(MAX_LIVE_EVENTS + 2)],
    });
    expect(out.kind).toBe("applied");
    if (out.kind !== "applied") return;
    expect(out.events).toHaveLength(MAX_LIVE_EVENTS);
    expect(out.events.at(-1)?.sequenceNumber).toBe(MAX_LIVE_EVENTS + 2);
    expect(out.truncatedBefore).toBe(3);
  });

  it("does not mutate the window it was given", () => {
    const start = windowOf([1, 2]);
    const before = start.events.length;
    applyDelta(start, { generation: 1, events: [ev(3)] });
    expect(start.events).toHaveLength(before);
    expect(start.lastSequence).toBe(2);
  });
});

describe("mergeById", () => {
  it("replaces by id and keeps new records", () => {
    const merged = mergeById(
      [{ id: "a", n: 1 }, { id: "b", n: 2 }],
      [{ id: "b", n: 20 }, { id: "c", n: 3 }],
    );
    expect(merged).toEqual([{ id: "a", n: 1 }, { id: "b", n: 20 }, { id: "c", n: 3 }]);
  });

  it("returns the original array when there is nothing incoming", () => {
    const current = [{ id: "a" }];
    expect(mergeById(current, undefined)).toBe(current);
    expect(mergeById(current, [])).toBe(current);
  });
});
