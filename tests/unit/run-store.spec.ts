import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RunSegmentCorruptionError,
  RunStore,
} from "../../src/runs/run-store";
import {
  type ExecutionRun,
  type RunEventInput,
  type RunStep,
} from "../../src/runs/run-model";

function makeRun(
  id: string,
  patch: Partial<ExecutionRun> = {},
): ExecutionRun {
  return {
    id,
    sequenceId: `sequence-${id}`,
    sequenceVersion: 1,
    status: "created",
    target: {
      adapterId: "browser",
      type: "route",
      id: "/settings",
      workspacePath: "src\\settings.tsx",
    },
    adapterIds: ["browser"],
    ticketIds: ["BLK-42"],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: [],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
    ...patch,
  };
}

function event(index: number, patch: Partial<RunEventInput> = {}): RunEventInput {
  return {
    channel: "log",
    type: "console",
    severity: index % 10 === 0 ? "warning" : "info",
    source: { adapterId: "browser", producer: "unit-test" },
    entityRefs: [{
      scheme: "workspace-file",
      id: "src/settings.tsx",
      workspacePath: "src/settings.tsx",
    }],
    inlinePayload: { index },
    ...patch,
  };
}

function step(runId: string): RunStep {
  return {
    id: "step-1",
    runId,
    ordinal: 0,
    declaredAction: { type: "navigate", input: { url: "/settings" } },
    targetEntityRefs: [{ scheme: "route", id: "/settings" }],
    status: "pending",
    assertionResults: [],
    sideEffects: [],
  };
}

describe("RunStore metadata and records", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-runs-"));
    store = new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 100,
    }).open();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates, updates, persists, and emits changes for a run", () => {
    const changes: string[] = [];
    store.onDidChange((change) => changes.push(change.kind));
    store.createRun(makeRun("run-1", { planId: "plan-1", phaseId: "phase-2" }));
    store.updateRun("run-1", { status: "running", startedAt: "2026-07-29T12:00:00.000Z" });

    expect(store.getRun("run-1")).toMatchObject({
      id: "run-1",
      status: "running",
      planId: "plan-1",
    });
    expect(changes).toEqual(["run", "run"]);
    expect(fs.existsSync(path.join(root, ".blacksite", "runs", "index.json"))).toBe(true);
  });

  it("recovers metadata from the atomic JSON backup when the primary is corrupt", () => {
    store.createRun(makeRun("run-1"));
    store.dispose();
    fs.writeFileSync(path.join(root, ".blacksite", "runs", "index.json"), "{broken");
    store = new RunStore(root, { metadataMode: "json" }).open();
    expect(store.getRun("run-1")?.sequenceId).toBe("sequence-run-1");
  });

  it("stores steps and observations and updates them independently", () => {
    store.createRun(makeRun("run-1"));
    store.putSteps("run-1", [step("run-1")]);
    store.updateStep("run-1", "step-1", { status: "running" });
    store.putObservation({
      id: "observation-1",
      runId: "run-1",
      stepId: "step-1",
      cursor: { sequenceNumber: 1, monotonicTimestampNs: "1" },
      visualArtifactIds: [],
      structuralArtifactIds: [],
      stateArtifactIds: [],
      eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 },
      entityRefs: [{ scheme: "route", id: "/settings" }],
      captureProfile: "default",
    });

    expect(store.getSteps("run-1")).toHaveLength(1);
    expect(store.getSteps("run-1")[0]?.status).toBe("running");
    expect(store.getObservation("observation-1")?.stepId).toBe("step-1");
    expect(store.listObservations("run-1")).toHaveLength(1);
  });

  it("indexes status, plan, ticket, file, surface, date, and free text", () => {
    store.createRun(makeRun("run-matching", {
      status: "failed",
      planId: "plan-1",
      startedAt: "2026-07-29T12:00:00.000Z",
      summary: {
        title: "Settings regression",
        outcome: "failed",
        completedSteps: 0,
        totalSteps: 1,
        eventCount: 0,
        observationCount: 0,
        artifactCount: 0,
        warningCount: 0,
        errorCount: 1,
        replayability: "R1",
      },
    }));
    store.createRun(makeRun("run-other", {
      status: "succeeded",
      target: { adapterId: "browser", type: "route", id: "/home" },
      ticketIds: [],
      startedAt: "2026-06-01T12:00:00.000Z",
    }));

    expect(store.searchRuns({ status: "failed" }).runs.map((run) => run.id))
      .toEqual(["run-matching"]);
    expect(store.searchRuns({ planId: "plan-1", ticketId: "BLK-42" }).matched).toBe(1);
    expect(store.searchRuns({ filePath: "src\\settings.tsx" }).matched).toBe(1);
    expect(store.searchRuns({ surfaceId: "/settings" }).matched).toBe(1);
    expect(store.searchRuns({ startedAfter: "2026-07-01T00:00:00.000Z" }).matched).toBe(1);
    expect(store.searchRuns({ query: "settings regression" }).matched).toBe(1);
  });

  it("deduplicates artifact bytes while retaining per-run metadata", () => {
    store.createRun(makeRun("run-1"));
    store.createRun(makeRun("run-2"));
    const first = store.putArtifact("run-1", Buffer.from("image"), {
      mediaType: "image/png",
      role: "after",
    });
    const second = store.putArtifact("run-2", Buffer.from("image"), {
      mediaType: "image/png",
      role: "baseline",
    });

    expect(second.id).toBe(first.id);
    expect(store.readArtifact(first.id).toString("utf8")).toBe("image");
    expect(store.listArtifacts("run-1")[0]?.role).toBe("after");
    expect(store.listArtifacts("run-2")[0]?.role).toBe("baseline");
    expect(store.artifactPath(first.id)).toBe(store.getArtifactPath(first.id));
  });

  it("finalizes active evidence with an aggregate summary", () => {
    store.createRun(makeRun("run-1", {
      status: "running",
      startedAt: "2026-07-29T12:00:00.000Z",
    }));
    store.putSteps("run-1", [{ ...step("run-1"), status: "succeeded" }]);
    store.appendEvents("run-1", [event(0), event(1)]);
    const finalized = store.finalizeRun("run-1", {
      status: "succeeded",
      endedAt: "2026-07-29T12:00:01.000Z",
    });

    expect(finalized.summary).toMatchObject({
      outcome: "succeeded",
      completedSteps: 1,
      totalSteps: 1,
      eventCount: 2,
      warningCount: 1,
      errorCount: 0,
      durationMs: 1_000,
    });
    expect(store.listEventSegments("run-1")).toMatchObject([{ codec: "gzip" }]);
  });

  it("never prunes pinned runs or their referenced artifacts", () => {
    store.createRun(makeRun("temporary", {
      retentionClass: "temporary",
      status: "succeeded",
      endedAt: "2020-01-01T00:00:00.000Z",
    }));
    store.createRun(makeRun("baseline", {
      retentionClass: "pinned",
      status: "succeeded",
      endedAt: "2020-01-01T00:00:00.000Z",
    }));
    const temporaryArtifact = store.putArtifact("temporary", "temporary");
    const pinnedArtifact = store.putArtifact("baseline", "pinned");

    const result = store.pruneRuns({
      temporaryOlderThan: "2026-01-01T00:00:00.000Z",
      standardOlderThan: "2026-01-01T00:00:00.000Z",
    });
    expect(result.deletedRunIds).toEqual(["temporary"]);
    expect(result.deletedArtifactIds).toEqual([temporaryArtifact.id]);
    expect(store.getRun("baseline")).toBeDefined();
    expect(store.getArtifact(pinnedArtifact.id)).toBeDefined();
  });

  it("preserves active and externally protected runs during age and count pruning", () => {
    store.createRun(makeRun("active", {
      retentionClass: "temporary",
      status: "running",
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    store.createRun(makeRun("linked", {
      retentionClass: "standard",
      status: "succeeded",
      endedAt: "2020-01-01T00:00:00.000Z",
    }));
    store.createRun(makeRun("expired", {
      retentionClass: "standard",
      status: "succeeded",
      endedAt: "2020-01-01T00:00:00.000Z",
    }));

    const result = store.pruneRuns({
      temporaryOlderThan: "2026-01-01T00:00:00.000Z",
      standardOlderThan: "2026-01-01T00:00:00.000Z",
      maxRuns: 1,
      protectedRunIds: ["linked"],
    });

    expect(result.deletedRunIds).toEqual(["expired"]);
    expect(store.getRun("active")).toBeDefined();
    expect(store.getRun("linked")).toBeDefined();
  });

  it("counts only eligible unpinned runs against maxRuns", () => {
    store.createRun(makeRun("pinned", {
      retentionClass: "pinned",
      status: "succeeded",
      endedAt: "2020-01-01T00:00:00.000Z",
    }));
    store.createRun(makeRun("protected", {
      retentionClass: "standard",
      status: "succeeded",
      endedAt: "2020-01-02T00:00:00.000Z",
    }));
    store.createRun(makeRun("oldest-unpinned", {
      retentionClass: "standard",
      status: "succeeded",
      endedAt: "2020-01-03T00:00:00.000Z",
    }));
    store.createRun(makeRun("newest-unpinned", {
      retentionClass: "standard",
      status: "succeeded",
      endedAt: "2020-01-04T00:00:00.000Z",
    }));

    const result = store.pruneRuns({
      temporaryOlderThan: "2010-01-01T00:00:00.000Z",
      maxRuns: 1,
      protectedRunIds: ["protected"],
    });

    expect(result.deletedRunIds).toEqual(["oldest-unpinned"]);
    expect(store.getRun("pinned")).toBeDefined();
    expect(store.getRun("protected")).toBeDefined();
    expect(store.getRun("newest-unpinned")).toBeDefined();
  });
});

describe("RunStore event segments", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-events-"));
    store = new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 100,
    }).open();
    store.createRun(makeRun("run-1", { status: "running" }));
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("assigns contiguous sequence numbers and monotonic decimal timestamps", () => {
    const assigned = store.appendEvents("run-1", [
      event(0),
      event(1, { channel: "network" }),
      event(2),
    ]);
    expect(assigned.map((item) => item.sequenceNumber)).toEqual([1, 2, 3]);
    expect(assigned.every((item) => /^\d+$/.test(item.monotonicTimestampNs))).toBe(true);
    expect(BigInt(assigned[1]?.monotonicTimestampNs ?? "0"))
      .toBeGreaterThan(BigInt(assigned[0]?.monotonicTimestampNs ?? "0"));

    const window = store.readEvents("run-1", {
      fromSequence: 2,
      toSequence: 3,
      channels: ["network"],
    });
    expect(window.map((item) => item.sequenceNumber)).toEqual([2]);
  });

  it("compresses full segments and honors bounded window limits", () => {
    const assigned = store.appendEvents(
      "run-1",
      Array.from({ length: 250 }, (_, index) => event(index)),
    );
    const segments = store.listEventSegments("run-1");
    expect(segments).toHaveLength(3);
    expect(segments.slice(0, 2).every((segment) => (
      segment.codec === "gzip" && segment.fileName.endsWith(".jsonl.gz")
    ))).toBe(true);
    expect(store.readEvents("run-1", { fromSequence: 95, toSequence: 205, limit: 7 })
      .map((item) => item.sequenceNumber)).toEqual([95, 96, 97, 98, 99, 100, 101]);
    expect(store.readEventsEndingAt("run-1", {
      fromSequence: 95,
      toSequence: 205,
      limit: 4,
    }).map((item) => item.sequenceNumber)).toEqual([202, 203, 204, 205]);
    expect(store.getEventStats("run-1")).toEqual({
      eventCount: 250,
      warningCount: 25,
      errorCount: 0,
    });
    expect(store.findEvent("run-1", assigned[224]!.id)?.sequenceNumber).toBe(225);
    expect(store.findLastEvents(
      "run-1",
      (item) => item.severity === "warning",
      3,
      { channels: ["log"] },
    ).map((item) => item.sequenceNumber)).toEqual([221, 231, 241]);

    const origin = BigInt(assigned[0]?.monotonicTimestampNs ?? "0");
    const event120 = BigInt(assigned[119]?.monotonicTimestampNs ?? "0");
    const event125 = BigInt(assigned[124]?.monotonicTimestampNs ?? "0");
    const elapsedWindow = store.readEventsByElapsedMs(
      "run-1",
      Number(event120 - origin - 1n) / 1_000_000,
      Number(event125 - origin + 1n) / 1_000_000,
      { limit: 20 },
    );
    expect(elapsedWindow.map((item) => item.sequenceNumber)).toEqual([120, 121, 122, 123, 124, 125]);
  });

  it("recovers an unfinalized active segment and marks the run partial", () => {
    store.appendEvents("run-1", [event(0), event(1), event(2)]);
    const traceRoot = path.join(root, ".blacksite", "runs", "traces");
    const activePath = fs.readdirSync(traceRoot)
      .map((entry) => path.join(traceRoot, entry))
      .flatMap((directory) => (
        fs.readdirSync(directory)
          .filter((entry) => entry.endsWith(".open.jsonl"))
          .map((entry) => path.join(directory, entry))
      ))[0];
    expect(activePath).toBeDefined();
    // Simulate the extension host stopping halfway through the next JSONL write.
    fs.appendFileSync(activePath ?? "", "{\"id\":\"partial");

    const recovered = new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 100,
    }).open();
    // The first instance represents an abruptly stopped host and must not flush
    // its stale in-memory metadata after recovery.
    store = recovered;
    expect(recovered.getRun("run-1")?.status).toBe("partial");
    expect(recovered.readEvents("run-1", { limit: 10 }).map((item) => item.sequenceNumber))
      .toEqual([1, 2, 3]);
    expect(recovered.listEventSegments("run-1")).toMatchObject([{
      codec: "gzip",
      firstSequence: 1,
      lastSequence: 3,
    }]);
  });

  it("fails loudly when a retained compressed segment is corrupt", () => {
    store.appendEvents("run-1", Array.from({ length: 100 }, (_, index) => event(index)));
    const traceRoot = path.join(root, ".blacksite", "runs", "traces");
    const runDirectory = fs.readdirSync(traceRoot)
      .map((entry) => path.join(traceRoot, entry))
      .find((entry) => fs.statSync(entry).isDirectory());
    expect(runDirectory).toBeDefined();
    const gzipFile = fs.readdirSync(runDirectory ?? "")
      .find((entry) => entry.endsWith(".jsonl.gz"));
    expect(gzipFile).toBeDefined();
    fs.writeFileSync(path.join(runDirectory ?? "", gzipFile ?? ""), "not gzip");

    expect(() => store.readEvents("run-1", { limit: 1 }))
      .toThrow(RunSegmentCorruptionError);
  });

  it("fails loudly when the initial retained event segment is missing", () => {
    store.appendEvents("run-1", Array.from({ length: 200 }, (_, index) => event(index)));
    const traceRoot = path.join(root, ".blacksite", "runs", "traces");
    const runDirectory = fs.readdirSync(traceRoot)
      .map((entry) => path.join(traceRoot, entry))
      .find((entry) => fs.statSync(entry).isDirectory());
    const firstSegment = fs.readdirSync(runDirectory ?? "")
      .filter((entry) => entry.endsWith(".jsonl.gz"))
      .sort()[0];
    expect(firstSegment).toBeDefined();
    fs.rmSync(path.join(runDirectory ?? "", firstSegment ?? ""));

    expect(() => new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 100,
    }).open()).toThrow(/missing initial event range/i);
  });

  it("fails loudly when an interior retained event segment is missing", () => {
    store.appendEvents("run-1", Array.from({ length: 300 }, (_, index) => event(index)));
    const traceRoot = path.join(root, ".blacksite", "runs", "traces");
    const runDirectory = fs.readdirSync(traceRoot)
      .map((entry) => path.join(traceRoot, entry))
      .find((entry) => fs.statSync(entry).isDirectory());
    const segments = fs.readdirSync(runDirectory ?? "")
      .filter((entry) => entry.endsWith(".jsonl.gz"))
      .sort();
    expect(segments).toHaveLength(3);
    fs.rmSync(path.join(runDirectory ?? "", segments[1] ?? ""));

    expect(() => new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 100,
    }).open()).toThrow(/missing event range/i);
  });

  it("writes and window-reads 100,000 events without materializing the trace on read", () => {
    const inputs = Array.from({ length: 100_000 }, (_, index) => event(index));
    store.appendEvents("run-1", inputs);
    const segments = store.listEventSegments("run-1");
    expect(segments).toHaveLength(1_000);
    expect(segments.every((segment) => segment.codec === "gzip")).toBe(true);

    const window = store.readEvents("run-1", {
      fromSequence: 50_001,
      toSequence: 50_020,
      limit: 20,
    });
    expect(window).toHaveLength(20);
    expect(window[0]?.sequenceNumber).toBe(50_001);
    expect(window[19]?.sequenceNumber).toBe(50_020);
    expect((window[0]?.inlinePayload as { index: number }).index).toBe(50_000);
  }, 30_000);
});

describe("RunStore SQLite compatibility", () => {
  it("keeps a complete JSON fallback even when SQLite is available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-sqlite-"));
    const store = new RunStore(root).open();
    try {
      store.createRun(makeRun("run-1"));
      expect(["sqlite", "json"]).toContain(store.metadataEngine);
      expect(fs.existsSync(path.join(root, ".blacksite", "runs", "index.json"))).toBe(true);
      store.dispose();
      const reopened = new RunStore(root).open();
      try {
        expect(reopened.getRun("run-1")?.sequenceId).toBe("sequence-run-1");
      } finally {
        reopened.dispose();
      }
    } finally {
      store.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
