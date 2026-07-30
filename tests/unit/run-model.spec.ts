import { describe, expect, it } from "vitest";
import {
  compareRunCursors,
  cursorForEvent,
  isTerminalRunStatus,
  type ExecutionRun,
  type RunEvent,
} from "../../src/runs/run-model";
import { buildRunSummary } from "../../src/runs/run-summary";

describe("run model", () => {
  it("uses host sequence numbers as the only cursor ordering authority", () => {
    expect(compareRunCursors(
      { sequenceNumber: 8, monotonicTimestampNs: "999999999999999999" },
      { sequenceNumber: 9, monotonicTimestampNs: "1" },
    )).toBeLessThan(0);
  });

  it("preserves nanosecond timestamps as decimal strings in cursors", () => {
    const event: RunEvent = {
      id: "event-1",
      runId: "run-1",
      sequenceNumber: 1,
      monotonicTimestampNs: "18446744073709551615",
      wallClockTimestamp: "2026-07-29T12:00:00.000Z",
      channel: "action",
      type: "step.started",
      source: { adapterId: "browser", producer: "test" },
      entityRefs: [],
    };
    expect(cursorForEvent(event)).toEqual({
      sequenceNumber: 1,
      monotonicTimestampNs: "18446744073709551615",
      eventId: "event-1",
    });
  });

  it("distinguishes terminal and recoverable in-progress states", () => {
    expect(isTerminalRunStatus("partial")).toBe(true);
    expect(isTerminalRunStatus("timed_out")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("awaiting_approval")).toBe(false);
  });
});

describe("buildRunSummary", () => {
  it("summarizes an already-windowed event iterable without requiring a full trace", () => {
    const run: ExecutionRun = {
      id: "run-1",
      sequenceId: "sequence-1",
      sequenceVersion: 1,
      status: "failed",
      target: { adapterId: "browser", type: "route", id: "/" },
      adapterIds: ["browser"],
      ticketIds: [],
      workspaceFingerprint: "workspace",
      environmentFingerprint: "environment",
      startedAt: "2026-07-29T12:00:00.000Z",
      endedAt: "2026-07-29T12:00:01.250Z",
      stepIds: ["step-1"],
      checkpointIds: [],
      keyObservationIds: [],
      retentionClass: "standard",
    };
    const events: RunEvent[] = [
      {
        id: "event-1",
        runId: run.id,
        sequenceNumber: 1,
        monotonicTimestampNs: "1",
        wallClockTimestamp: run.startedAt ?? "",
        channel: "log",
        type: "console",
        severity: "warning",
        source: { adapterId: "browser", producer: "test" },
        entityRefs: [],
      },
      {
        id: "event-2",
        runId: run.id,
        sequenceNumber: 2,
        monotonicTimestampNs: "2",
        wallClockTimestamp: run.endedAt ?? "",
        channel: "diagnostic",
        type: "exception",
        severity: "error",
        source: { adapterId: "browser", producer: "test" },
        entityRefs: [],
      },
    ];
    const summary = buildRunSummary({
      run,
      steps: [{
        id: "step-1",
        runId: run.id,
        ordinal: 0,
        declaredAction: { type: "navigate" },
        targetEntityRefs: [],
        status: "failed",
        assertionResults: [],
        sideEffects: [],
      }],
      events,
      replayability: "R1",
      anomalyTypes: ["console-error", "console-error"],
    });
    expect(summary).toMatchObject({
      outcome: "failed",
      eventCount: 2,
      warningCount: 1,
      errorCount: 1,
      durationMs: 1_250,
      replayability: "R1",
      anomalyTypes: ["console-error"],
    });
  });
});
