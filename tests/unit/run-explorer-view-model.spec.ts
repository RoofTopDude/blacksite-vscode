import { describe, expect, it } from "vitest";

import {
  buildEventTracks,
  eventsForObservation,
  isTicketableEvent,
  navigationAnchors,
  nextAnchor,
  observationForSequence,
  runCoverage,
  visualObservationForSequence,
  windowAround,
} from "../../src/webview/react/apps/runs/view-model";
import { isRunsHostMessage, type ExecutionRun, type ObservationBundle, type RunEvent, type RunStep, type RunsWebviewMessage } from "../../src/webview/react/apps/runs/protocol";

const run: ExecutionRun = {
  id: "run-1",
  status: "partial",
  retentionClass: "standard",
  summary: {
    title: "Checkout review",
    completedSteps: 1,
    totalSteps: 3,
    eventCount: 1_000,
    observationCount: 2,
    artifactCount: 1,
    warningCount: 1,
    errorCount: 1,
  },
};

const steps: RunStep[] = [
  {
    id: "step-1",
    runId: run.id,
    ordinal: 0,
    status: "succeeded",
    targetEntityRefs: [],
    assertionResults: [],
    startCursor: { sequenceNumber: 1 },
    endCursor: { sequenceNumber: 10 },
    checkpointId: "checkpoint-1",
  },
  {
    id: "step-2",
    runId: run.id,
    ordinal: 1,
    status: "failed",
    targetEntityRefs: [],
    assertionResults: [],
    startCursor: { sequenceNumber: 11 },
    endCursor: { sequenceNumber: 20 },
    failure: {
      category: "application_error",
      message: "Checkout crashed",
      failedStepId: "step-2",
    },
  },
  {
    id: "step-3",
    runId: run.id,
    ordinal: 2,
    status: "skipped",
    targetEntityRefs: [],
    assertionResults: [],
  },
];

const observations: ObservationBundle[] = [
  {
    id: "observation-1",
    runId: run.id,
    stepId: "step-1",
    cursor: { sequenceNumber: 10 },
    visualArtifactIds: [],
    structuralArtifactIds: [],
    stateArtifactIds: [],
    eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 10 },
    entityRefs: [],
  },
  {
    id: "observation-2",
    runId: run.id,
    stepId: "step-2",
    cursor: { sequenceNumber: 20 },
    visualArtifactIds: [],
    structuralArtifactIds: [],
    stateArtifactIds: [],
    eventRange: { firstSequenceNumber: 11, lastSequenceNumber: 20 },
    entityRefs: [],
  },
];

const events: RunEvent[] = [
  {
    id: "event-log",
    runId: run.id,
    stepId: "step-1",
    sequenceNumber: 9,
    channel: "log",
    type: "console_info",
    entityRefs: [],
  },
  {
    id: "event-error",
    runId: run.id,
    stepId: "step-2",
    sequenceNumber: 18,
    channel: "diagnostic",
    type: "uncaught_exception",
    severity: "error",
    entityRefs: [],
  },
];

describe("Run Explorer view model", () => {
  it("centers one-based bounded event windows and clamps both edges", () => {
    expect(windowAround(1, 1_000, 240)).toEqual({ from: 1, to: 240 });
    expect(windowAround(500, 1_000, 240)).toEqual({ from: 380, to: 619 });
    expect(windowAround(1_000, 1_000, 240)).toEqual({ from: 761, to: 1_000 });
    expect(windowAround(1, 0, 240)).toEqual({ from: 0, to: 0 });
  });

  it("resolves observations by range and then nearest cursor", () => {
    expect(observationForSequence(observations, 14)?.id).toBe("observation-2");
    expect(observationForSequence(observations, 30)?.id).toBe("observation-2");
    expect(eventsForObservation(observations[0], events).map((event) => event.id)).toEqual(["event-log"]);
  });

  it("builds ordered channel tracks without changing event order semantics", () => {
    const tracks = buildEventTracks([...events].reverse());
    expect(tracks.map((track) => track.channel)).toEqual(["log", "diagnostic"]);
    expect(tracks[0]?.events.map((event) => event.sequenceNumber)).toEqual([9]);
  });

  it("derives coverage and wraparound anomaly/checkpoint navigation", () => {
    expect(runCoverage(run, steps)).toEqual({ completed: 1, failed: 1, skipped: 1, total: 3 });
    const anchors = navigationAnchors(steps, observations, events);
    expect(anchors.some((anchor) => anchor.kind === "checkpoint" && anchor.sequenceNumber === 10)).toBe(true);
    expect(anchors.some((anchor) => anchor.kind === "anomaly" && anchor.sequenceNumber === 18)).toBe(true);
    expect(nextAnchor(anchors, "anomaly", 20, 1)?.sequenceNumber).toBe(18);
    expect(nextAnchor(anchors, "checkpoint", 1, -1)?.sequenceNumber).toBe(10);
  });

  it("allows diagnostics and anomalies, but not routine events, to file tickets", () => {
    expect(isTicketableEvent(events[1]!)).toBe(true);
    expect(isTicketableEvent({ ...events[0]!, channel: "diagnostic", severity: "info" })).toBe(true);
    expect(isTicketableEvent(events[0]!)).toBe(false);
  });
});

describe("Run Explorer protocol boundary", () => {
  it("accepts bounded state messages and rejects incomplete event windows", () => {
    expect(isRunsHostMessage({
      type: "runs_state",
      runs: [run],
      selectedRun: run,
      steps,
      observations,
      events,
      totalEvents: 1_000,
      artifacts: [],
    })).toBe(true);
    expect(isRunsHostMessage({
      type: "run_event_window",
      runId: run.id,
      events,
      totalEvents: 1_000,
      from: 1,
    })).toBe(false);
  });

  it("carries the selected event and observation in ticket requests", () => {
    const message = {
      type: "file_anomaly_ticket",
      runId: run.id,
      eventId: "event-error",
      observationId: "observation-2",
    } satisfies RunsWebviewMessage;
    expect(message).toEqual({
      type: "file_anomaly_ticket",
      runId: "run-1",
      eventId: "event-error",
      observationId: "observation-2",
    });
  });
});

/** The theater stage used the *nearest* observation, which is often one with nothing to show, so
 *  it went blank between most frames. It now holds the last captured image, like a recording. */
describe("visualObservationForSequence", () => {
  const at = (id: string, first: number, last: number, visual: boolean): ObservationBundle => ({
    id,
    runId: "run-1",
    cursor: { sequenceNumber: last },
    visualArtifactIds: visual ? [`${id}-shot`] : [],
    structuralArtifactIds: [],
    stateArtifactIds: [],
    eventRange: { firstSequenceNumber: first, lastSequenceNumber: last },
    entityRefs: [],
    captureProfile: "standard",
  });
  const observations = [at("home", 3, 5, true), at("logical", 8, 8, false), at("checkout", 12, 14, true)];

  it("holds the last image between captures instead of the nearest empty observation", () => {
    expect(visualObservationForSequence(observations, 8)?.id).toBe("home");
    expect(visualObservationForSequence(observations, 11)?.id).toBe("home");
  });

  it("shows the capture whose range contains the playhead", () => {
    expect(visualObservationForSequence(observations, 13)?.id).toBe("checkout");
    expect(visualObservationForSequence(observations, 40)?.id).toBe("checkout");
  });

  it("shows the first image before any capture has happened", () => {
    expect(visualObservationForSequence(observations, 1)?.id).toBe("home");
  });

  it("returns nothing when the run has no images at all", () => {
    expect(visualObservationForSequence([at("logical", 1, 1, false)], 1)).toBeUndefined();
  });
});
