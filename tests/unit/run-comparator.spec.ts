import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ExecutionRun,
  ObservationBundle,
  RunEvent,
  RunEventChannel,
  RunStep,
  RunStepStatus,
} from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";
import { compareRuns } from "../../src/sequences/run-comparator";

function run(id: string): ExecutionRun {
  return {
    id,
    sequenceId: "sequence-1",
    sequenceVersion: 1,
    status: "running",
    target: { adapterId: "browser", type: "application_surface" },
    adapterIds: ["browser"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: [],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

function step(
  runId: string,
  id: string,
  ordinal: number,
  route: string,
  status: RunStepStatus,
): RunStep {
  return {
    id,
    runId,
    ordinal,
    declaredAction: {
      adapterId: "browser",
      type: "navigate",
      input: { url: `http://localhost:4173${route}` },
    },
    targetEntityRefs: [{ scheme: "route", id: route }],
    status,
    assertionResults: [],
    sideEffects: [],
  };
}

function observation(
  runId: string,
  id: string,
  stepId: string,
  event: RunEvent,
): ObservationBundle {
  return {
    id,
    runId,
    stepId,
    cursor: {
      sequenceNumber: event.sequenceNumber,
      monotonicTimestampNs: event.monotonicTimestampNs,
      eventId: event.id,
    },
    visualArtifactIds: [],
    structuralArtifactIds: [],
    stateArtifactIds: [],
    eventRange: {
      firstSequenceNumber: event.sequenceNumber,
      lastSequenceNumber: event.sequenceNumber,
    },
    entityRefs: [],
    captureProfile: "visual",
  };
}

describe("compareRuns filtering", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-compare-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
    store.createRun(run("left"));
    store.createRun(run("right"));
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function append(runId: string, channel: RunEventChannel, type: string): void {
    store.appendEvent(runId, {
      channel,
      type,
      source: { adapterId: "browser", producer: "unit-test" },
      entityRefs: [],
    });
  }

  it("reports and returns evidence only for requested comparison channels", async () => {
    store.putSteps("left", [step("left", "open", 0, "/checkout", "succeeded")]);
    store.putSteps("right", [step("right", "open", 0, "/checkout", "failed")]);
    append("left", "log", "console");
    append("left", "filesystem", "read");
    append("right", "log", "console");
    append("right", "log", "console");
    append("right", "filesystem", "read");
    append("right", "filesystem", "read");

    const filesystem = await compareRuns(store, store.getRun("left")!, store.getRun("right")!, "semantic", {
      channels: ["filesystem"],
    });
    expect(filesystem.summary).toMatchObject({ changed: 1, unchanged: 0 });
    expect(filesystem.alignments[0]?.changes).toEqual([
      expect.objectContaining({ channel: "filesystem", kind: "changed" }),
    ]);
    expect(filesystem.alignments[0]?.left?.events.map((event) => event.channel)).toEqual(["filesystem"]);
    expect(filesystem.alignments[0]?.right?.events.map((event) => event.channel))
      .toEqual(["filesystem", "filesystem"]);

    const visual = await compareRuns(store, store.getRun("left")!, store.getRun("right")!, "semantic", {
      channels: ["visual"],
    });
    expect(visual.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(visual.alignments[0]?.changes).toEqual([]);
    expect(visual.alignments[0]?.left?.events).toEqual([]);

    const behavior = await compareRuns(store, store.getRun("left")!, store.getRun("right")!, "semantic", {
      channels: ["behavior"],
    });
    expect(behavior.alignments[0]?.changes).toEqual([
      expect.objectContaining({
        channel: "behavior",
        summary: expect.stringMatching(/status changed/i),
      }),
    ]);
  });

  it("limits alignment to the requested stable surface", async () => {
    store.putSteps("left", [
      step("left", "checkout", 0, "/checkout", "succeeded"),
      step("left", "account", 1, "/account", "succeeded"),
    ]);
    store.putSteps("right", [
      step("right", "checkout", 0, "/checkout", "failed"),
      step("right", "account", 1, "/account", "succeeded"),
    ]);

    const checkout = await compareRuns(store, store.getRun("left")!, store.getRun("right")!, "semantic", {
      surface: "route:/checkout",
      channels: ["behavior"],
    });
    expect(checkout.alignments).toHaveLength(1);
    expect(checkout.alignments[0]).toMatchObject({
      left: { step: { id: "checkout" } },
      right: { step: { id: "checkout" } },
      changes: [expect.objectContaining({ channel: "behavior" })],
    });

    const account = await compareRuns(store, store.getRun("left")!, store.getRun("right")!, "semantic", {
      surface: "http://localhost:4173/account",
      channels: ["behavior"],
    });
    expect(account.alignments).toHaveLength(1);
    expect(account.alignments[0]).toMatchObject({
      left: { step: { id: "account" } },
      right: { step: { id: "account" } },
      changes: [],
    });
  });

  it("compares the explicit after observation without pooling before artifacts", async () => {
    const leftEvents = store.appendEvents("left", [
      {
        channel: "visual",
        type: "before",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
      },
      {
        channel: "visual",
        type: "after",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
      },
    ]);
    const rightEvents = store.appendEvents("right", [
      {
        channel: "visual",
        type: "before",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
      },
      {
        channel: "visual",
        type: "after",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
      },
    ]);
    const leftStep = step("left", "open", 0, "/checkout", "succeeded");
    const rightStep = step("right", "open", 0, "/checkout", "succeeded");
    leftStep.beforeObservationId = "left-before";
    leftStep.afterObservationId = "left-after";
    rightStep.beforeObservationId = "right-before";
    rightStep.afterObservationId = "right-after";
    store.putSteps("left", [leftStep]);
    store.putSteps("right", [rightStep]);
    for (const item of [
      observation("left", "left-before", "open", leftEvents[0]!),
      observation("left", "left-after", "open", leftEvents[1]!),
      observation("right", "right-before", "open", rightEvents[0]!),
      observation("right", "right-after", "open", rightEvents[1]!),
    ]) {
      store.putObservation(item);
    }
    store.putArtifact("left", "different left before", {
      mediaType: "image/png",
      kind: "screenshot",
      stepId: "open",
      observationId: "left-before",
    });
    store.putArtifact("right", "different right before", {
      mediaType: "image/png",
      kind: "screenshot",
      stepId: "open",
      observationId: "right-before",
    });
    store.putArtifact("left", "same after", {
      mediaType: "image/png",
      kind: "screenshot",
      stepId: "open",
      observationId: "left-after",
    });
    store.putArtifact("right", "same after", {
      mediaType: "image/png",
      kind: "screenshot",
      stepId: "open",
      observationId: "right-after",
    });

    const comparison = await compareRuns(
      store,
      store.getRun("left")!,
      store.getRun("right")!,
      "semantic",
      { channels: ["visual"] },
    );

    expect(comparison.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(comparison.alignments[0]?.left).toMatchObject({
      observation: { id: "left-after" },
      artifacts: [{ observationId: "left-after" }],
    });
    expect(comparison.alignments[0]?.right).toMatchObject({
      observation: { id: "right-after" },
      artifacts: [{ observationId: "right-after" }],
    });
  });

  it("detects changed event signatures after the old 2,000-event cutoff", async () => {
    const leftEvents = store.appendEvents(
      "left",
      Array.from({ length: 2_101 }, (_, index) => ({
        channel: "log" as const,
        type: "console",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
        inlinePayload: { index },
      })),
    );
    const rightEvents = store.appendEvents(
      "right",
      Array.from({ length: 2_101 }, (_, index) => ({
        channel: "log" as const,
        type: "console",
        source: { adapterId: "browser", producer: "unit-test" },
        entityRefs: [],
        inlinePayload: {
          index,
          ...(index === 2_050 ? { level: "error" } : {}),
        },
      })),
    );
    const leftStep = step("left", "open", 0, "/checkout", "succeeded");
    const rightStep = step("right", "open", 0, "/checkout", "succeeded");
    leftStep.startCursor = {
      sequenceNumber: leftEvents[0]!.sequenceNumber,
      monotonicTimestampNs: leftEvents[0]!.monotonicTimestampNs,
      eventId: leftEvents[0]!.id,
    };
    leftStep.endCursor = {
      sequenceNumber: leftEvents.at(-1)!.sequenceNumber,
      monotonicTimestampNs: leftEvents.at(-1)!.monotonicTimestampNs,
      eventId: leftEvents.at(-1)!.id,
    };
    rightStep.startCursor = {
      sequenceNumber: rightEvents[0]!.sequenceNumber,
      monotonicTimestampNs: rightEvents[0]!.monotonicTimestampNs,
      eventId: rightEvents[0]!.id,
    };
    rightStep.endCursor = {
      sequenceNumber: rightEvents.at(-1)!.sequenceNumber,
      monotonicTimestampNs: rightEvents.at(-1)!.monotonicTimestampNs,
      eventId: rightEvents.at(-1)!.id,
    };
    store.putSteps("left", [leftStep]);
    store.putSteps("right", [rightStep]);

    const comparison = await compareRuns(
      store,
      store.getRun("left")!,
      store.getRun("right")!,
      "semantic",
      { channels: ["log"] },
    );

    expect(comparison.alignments[0]?.left?.events).toHaveLength(2_101);
    expect(comparison.alignments[0]?.changes).toEqual([
      expect.objectContaining({
        channel: "log",
        summary: expect.stringMatching(/event details changed/i),
      }),
    ]);
  });
});
