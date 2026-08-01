/**
 * Timeline geometry.
 *
 * The transport this replaces was a range input over sequence numbers, which is the wrong axis
 * for a trace: sequence numbers are uniform and a run is not, so a four-second step and a
 * four-millisecond one occupied identical width. Everything here is measured in elapsed
 * nanoseconds from the first event, which is what makes the result convey where time went.
 */
import { describe, expect, it } from "vitest";
import {
  elapsedOf,
  filmstripFrames,
  formatElapsed,
  framesToPrefetch,
  laneSegments,
  overviewExtent,
  overviewOrigin,
  offsetIn,
  panScale,
  parseNs,
  runExtent,
  replayDelayMs,
  sequenceAtOffset,
  stepSpans,
  timeOrigin,
  timestampAtOffset,
  zoomScale,
  type TimeScale,
} from "../../src/webview/react/apps/run-theater/timeline.js";
import type { ObservationBundle, RunEvent, RunStep, TraceOverview } from "../../src/webview/react/apps/runs/protocol.js";

const T0 = 1_000_000_000;

function ev(sequenceNumber: number, offsetMs: number, over: Partial<RunEvent> = {}): RunEvent {
  return {
    id: `e${sequenceNumber}`, runId: "run-1", sequenceNumber,
    monotonicTimestampNs: String(T0 + offsetMs * 1_000_000),
    wallClockTimestamp: "2026-07-31T00:00:00.000Z",
    channel: "log", type: "console",
    source: { adapterId: "browser", producer: "t" }, entityRefs: [],
    ...over,
  } as unknown as RunEvent;
}

const full = (duration: number): TimeScale => ({ from: 0, to: duration, duration });

describe("time parsing", () => {
  /** 0 would silently pin an event to the start of the run, which is a lie the eye cannot catch. */
  it("returns null for an unparseable stamp rather than 0", () => {
    expect(parseNs(undefined)).toBeNull();
    expect(parseNs("not-a-number")).toBeNull();
    expect(parseNs("1500")).toBe(1500);
  });

  it("measures elapsed time from the first event", () => {
    const events = [ev(1, 0), ev(2, 250)];
    const origin = timeOrigin(events);
    expect(elapsedOf(events[0]!, origin)).toBe(0);
    expect(elapsedOf(events[1]!, origin)).toBe(250_000_000);
  });

  it("never reports a negative extent, even for an out-of-order trace", () => {
    expect(runExtent([ev(2, 500), ev(1, 0)])).toBe(500_000_000);
    expect(runExtent([])).toBe(1);
  });

  it("uses full-run overview geometry instead of the attached tail", () => {
    const overview: TraceOverview = {
      runId: "run-1", firstSequence: 1, lastSequence: 100_000,
      originMonotonicTimestampNs: String(T0), endMonotonicTimestampNs: String(T0 + 60_000_000_000),
      eventCount: 100_000, warningCount: 1, errorCount: 0, segments: [],
    };
    const tail = [ev(99_999, 59_900), ev(100_000, 60_000)];
    expect(overviewOrigin(overview, tail)).toBe(T0);
    expect(overviewExtent(overview, tail)).toBe(60_000_000_000);
    expect(timestampAtOffset(overview, full(60_000_000_000), 0.5)).toBe(String(T0 + 30_000_000_000));
  });
});

describe("zoom and pan", () => {
  /** Zooming to the centre is the detail that makes a timeline feel wrong: the thing you were
   *  looking at slides away exactly when you try to look closer. */
  it("keeps the focal point in place while zooming", () => {
    const focus = 500_000_000;
    const zoomed = zoomScale(full(1_000_000_000), 2, focus);
    const before = offsetIn(full(1_000_000_000), focus);
    const after = offsetIn(zoomed, focus);
    expect(after).toBeCloseTo(before, 5);
    expect(zoomed.to - zoomed.from).toBeCloseTo(500_000_000, 0);
  });

  it("clamps a zoom near the start to the run's bounds", () => {
    const zoomed = zoomScale(full(1_000), 4, 0);
    expect(zoomed.from).toBe(0);
    expect(zoomed.to).toBeLessThanOrEqual(1_000);
  });

  it("never zooms out past the whole run", () => {
    const out = zoomScale({ from: 100, to: 200, duration: 1_000 }, 0.001, 150);
    expect(out.to - out.from).toBeLessThanOrEqual(1_000);
  });

  it("pans without changing the span, and stops at the edges", () => {
    const start: TimeScale = { from: 100, to: 300, duration: 1_000 };
    const panned = panScale(start, 100);
    expect(panned.to - panned.from).toBe(200);
    expect(panScale(start, -9_999).from).toBe(0);
    expect(panScale(start, 9_999).to).toBe(1_000);
  });
});

describe("adaptive replay", () => {
  it("respects playback rate for active evidence and compresses long idle gaps", () => {
    expect(replayDelayMs("1000000000", "1500000000", 2)).toBe(250);
    expect(replayDelayMs("1000000000", "4000000000", 1)).toBe(500);
  });
});

describe("filmstripFrames", () => {
  const observations = [
    { id: "o1", runId: "run-1", cursor: { sequenceNumber: 1 }, visualArtifactIds: ["a1"], structuralArtifactIds: [], stateArtifactIds: [], eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 }, entityRefs: [], captureProfile: "diagnostic" },
    { id: "o2", runId: "run-1", cursor: { sequenceNumber: 3 }, visualArtifactIds: ["a2"], structuralArtifactIds: [], stateArtifactIds: [], eventRange: { firstSequenceNumber: 3, lastSequenceNumber: 3 }, entityRefs: [], captureProfile: "diagnostic" },
  ] as unknown as ObservationBundle[];
  const events = [ev(1, 0), ev(2, 100), ev(3, 400)];
  const artifacts = [{ id: "a1", url: "vs://a1" }, { id: "a2", url: "vs://a2" }];

  it("places each capture at the time of the event it points at", () => {
    const frames = filmstripFrames(observations, events, artifacts, full(400_000_000));
    expect(frames.map((f) => f.observationId)).toEqual(["o1", "o2"]);
    expect(frames[0]?.offset).toBeCloseTo(0, 5);
    expect(frames[1]?.offset).toBeCloseTo(1, 5);
    expect(frames[1]?.url).toBe("vs://a2");
  });

  /** A frame in the wrong place is worse than a missing one: it makes the strip lie about when
   *  something was captured. */
  it("drops an observation whose anchoring event is not loaded", () => {
    const orphan = [{ ...observations[0], id: "o9", cursor: { sequenceNumber: 999 } }] as unknown as ObservationBundle[];
    expect(filmstripFrames(orphan, events, artifacts, full(400_000_000))).toEqual([]);
  });

  it("keeps a capture with no resolvable URL, so the gap is visible", () => {
    const frames = filmstripFrames(observations, events, [], full(400_000_000));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.url).toBeUndefined();
  });
});

describe("framesToPrefetch", () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({
    id: `f${i}`, observationId: `o${i}`, sequenceNumber: i + 1,
    at: i * 1_000_000, offset: i / 29, url: `vs://${i}`,
  }));

  /** Decoding only once a frame is wanted is exactly the flash of nothing this removes. */
  it("warms frames on both sides of the playhead", () => {
    const urls = framesToPrefetch(frames, 15_000_000, 3);
    expect(urls).toEqual(["vs://12", "vs://13", "vs://14", "vs://15", "vs://16", "vs://17", "vs://18"]);
  });

  it("clamps at the ends instead of running off them", () => {
    expect(framesToPrefetch(frames, 0, 3)).toEqual(["vs://0", "vs://1", "vs://2", "vs://3"]);
  });

  it("returns nothing when there are no frames", () => {
    expect(framesToPrefetch([], 0)).toEqual([]);
  });
});

describe("laneSegments and stepSpans", () => {
  it("groups events into one lane per channel", () => {
    const events = [ev(1, 0), ev(2, 10, { channel: "network" }), ev(3, 20, { channel: "network" })];
    const lanes = laneSegments(events, full(20_000_000));
    expect([...lanes.keys()].sort()).toEqual(["log", "network"]);
    expect(lanes.get("network")).toHaveLength(2);
  });

  it("omits events outside the zoomed window", () => {
    const events = [ev(1, 0), ev(2, 1000)];
    const lanes = laneSegments(events, { from: 0, to: 10_000_000, duration: 1_000_000_000 });
    expect(lanes.get("log")).toHaveLength(1);
  });

  it("draws a still-running step to the right edge", () => {
    const events = [ev(1, 0), ev(2, 100)];
    const steps = [{
      id: "s1", runId: "run-1", ordinal: 0, status: "running",
      startCursor: { sequenceNumber: 1 }, targetEntityRefs: [], assertionResults: [], sideEffects: [],
    }] as unknown as RunStep[];
    const spans = stepSpans(steps, events, full(100_000_000));
    expect(spans[0]?.startOffset).toBeCloseTo(0, 5);
    expect(spans[0]?.endOffset).toBeCloseTo(1, 5);
  });
});

describe("sequenceAtOffset", () => {
  it("maps a click position to the nearest event in time", () => {
    const events = [ev(1, 0), ev(2, 100), ev(3, 900)];
    const scale = full(900_000_000);
    expect(sequenceAtOffset(events, scale, 0)).toBe(1);
    expect(sequenceAtOffset(events, scale, 1)).toBe(3);
    expect(sequenceAtOffset(events, scale, 0.1)).toBe(2);
  });

  it("returns null with no events to land on", () => {
    expect(sequenceAtOffset([], full(1), 0.5)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("scales its unit to the magnitude", () => {
    expect(formatElapsed(500_000)).toBe("500µs");
    expect(formatElapsed(12_000_000)).toBe("12ms");
    expect(formatElapsed(1_500_000_000)).toBe("1.50s");
    expect(formatElapsed(75_000_000_000)).toBe("1m 15s");
  });
});
