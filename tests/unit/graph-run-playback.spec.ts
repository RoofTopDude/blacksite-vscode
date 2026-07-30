import { describe, expect, it } from "vitest";
import {
  MAX_RUN_PLAYBACK_WINDOW_MS,
  applyMessage,
  exitRunPlayback,
  initialState,
  requestedRunPlaybackWindow,
  runPlaybackClock,
  runPlaybackEvents,
  seekRunPlayback,
  selectRunPlayback,
} from "../../src/webview/react/lib/graph/view-model.js";
import { TRACE_COLORS } from "../../src/webview/react/lib/graph/colors.js";
import type { MapRunSummary } from "../../src/webview/react/lib/graph/protocol.js";

const START = Date.parse("2026-07-29T12:00:00.000Z");

function summary(overrides: Partial<MapRunSummary> = {}): MapRunSummary {
  return {
    id: "run-1",
    title: "Checkout review",
    status: "succeeded",
    startedAt: new Date(START).toISOString(),
    endedAt: new Date(START + 10 * 60_000).toISOString(),
    eventCount: 3,
    ...overrides,
  };
}

describe("Codebase Map run playback", () => {
  it("keeps live traces isolated and restores them unchanged after playback", () => {
    let state = applyMessage(initialState(), {
      type: "trace_batch",
      events: [{ id: "live-1", path: "src/live.ts", kind: "edit", at: START }],
    }, START);
    state = applyMessage(state, {
      type: "run_playback_state",
      state: {
        mode: "playback",
        summaries: [summary()],
        selectedRunId: "run-1",
        cursor: { at: 5000 },
        range: { from: 0, to: 10 * 60_000 },
      },
    }, START);
    state = applyMessage(state, {
      type: "trace_batch",
      events: [{ id: "live-2", path: "src/still-live.ts", kind: "read", at: START + 1000 }],
    }, START + 1000);
    state = applyMessage(state, {
      type: "run_event_window",
      runId: "run-1",
      from: 0,
      to: 20_000,
      events: [{
        id: "run-event",
        path: "packages app/src/raw id.ts",
        kind: "diagnostic",
        at: 4000,
        laneId: "lane-review",
      }],
    }, START + 5000);

    expect(runPlaybackEvents(state)).toEqual([{
      id: "run-event",
      path: "packages app/src/raw id.ts",
      kind: "diagnostic",
      at: 4000,
      laneId: "lane-review",
    }]);
    expect(runPlaybackClock(state, START + 99_000)).toBe(5000);
    expect(state.traces.map((event) => event.id)).toEqual(["live-1", "live-2"]);

    state = exitRunPlayback(state);
    expect(runPlaybackEvents(state).map((event) => event.id)).toEqual(["live-1", "live-2"]);
    expect(runPlaybackClock(state, START + 99_000)).toBe(START + 99_000);
  });

  it("rejects windows for another run and filters malformed/out-of-range events", () => {
    let state = applyMessage(initialState(), {
      type: "run_playback_state",
      state: {
        mode: "playback",
        summaries: [summary()],
        selectedRunId: "run-1",
        cursor: { at: 0 },
        range: { from: 0, to: 10_000 },
      },
    }, START);
    const unchanged = applyMessage(state, {
      type: "run_event_window",
      runId: "run-2",
      from: 0,
      to: 10_000,
      events: [{ id: "wrong", path: "src/wrong.ts", kind: "read", at: 0 }],
    }, START);
    expect(unchanged).toBe(state);

    state = applyMessage(state, {
      type: "run_event_window",
      runId: "run-1",
      from: 0,
      to: 10_000,
      events: [
        { id: "late", path: "src/late.ts", kind: "render", at: 20_000 },
        { id: "valid", path: "src/view.tsx", kind: "render", at: 9000 },
      ],
    }, START);
    expect(state.runPlayback.window?.events.map((event) => event.id)).toEqual(["valid"]);
  });

  it("clamps seeks and requests only a bounded decay-sized event window", () => {
    const long = summary({ endedAt: new Date(START + 60 * 60_000).toISOString() });
    let state = {
      ...initialState(),
      runPlayback: { ...initialState().runPlayback, summaries: [long] },
    };
    state = selectRunPlayback(state, long.id);
    state = seekRunPlayback(state, 40 * 60_000);
    const window = requestedRunPlaybackWindow(state);
    expect(window).not.toBeNull();
    expect(window!.to - window!.from).toBeLessThanOrEqual(MAX_RUN_PLAYBACK_WINDOW_MS);
    expect(window!.from).toBeLessThanOrEqual(state.runPlayback.cursorAt!);
    expect(window!.to).toBeGreaterThanOrEqual(state.runPlayback.cursorAt!);

    state = seekRunPlayback(state, Number.POSITIVE_INFINITY);
    expect(state.runPlayback.cursorAt).toBe(40 * 60_000);
    state = seekRunPlayback(state, -1);
    expect(state.runPlayback.cursorAt).toBe(0);
  });

  it("upserts summary updates without discarding playback state", () => {
    let state = applyMessage(initialState(), {
      type: "run_playback_state",
      state: { mode: "live", summaries: [summary()] },
    }, START);
    state = applyMessage(state, {
      type: "run_playback_summary",
      summary: summary({ status: "failed", eventCount: 9 }),
    }, START);
    expect(state.runPlayback.summaries).toHaveLength(1);
    expect(state.runPlayback.summaries[0]).toMatchObject({ status: "failed", eventCount: 9 });
  });

  it("gives read, edit, execute, diagnostic, and render activity distinct colors", () => {
    const colors = [
      TRACE_COLORS.read,
      TRACE_COLORS.edit,
      TRACE_COLORS.execute,
      TRACE_COLORS.diagnostic,
      TRACE_COLORS.render,
    ];
    expect(new Set(colors).size).toBe(colors.length);
  });
});
