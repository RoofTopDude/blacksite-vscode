/**
 * The delta channel.
 *
 * `RunStore.onDidChange` always emitted `{kind, runId, ids}` from every mutation site, and both
 * subscribers discarded the argument — so a consumer that wanted to update incrementally had no
 * choice but to re-query the store, which is exactly how the Run Explorer ended up re-serializing
 * its whole state (and re-reading an event window off disk) per mutation.
 *
 * The load-bearing property here is the last test: emitting must not touch the filesystem. At the
 * moment of a change the affected records are already in memory, and a delta path that reads them
 * back would reintroduce the cost it exists to remove.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRun, RunEventInput, RunStep } from "../../src/runs/run-model.js";
import { RunStore, type RunStoreChangeEvent } from "../../src/runs/run-store.js";

function makeRun(id = "run-1"): ExecutionRun {
  return {
    id, sequenceId: "sequence-1", sequenceVersion: 1, status: "running",
    target: { adapterId: "browser", type: "route", id: "/" },
    adapterIds: ["browser"], ticketIds: [],
    workspaceFingerprint: "w", environmentFingerprint: "e",
    stepIds: [], checkpointIds: [], keyObservationIds: [], retentionClass: "standard",
  };
}

function makeStep(id: string, ordinal: number): RunStep {
  return {
    id, runId: "run-1", ordinal,
    declaredAction: { type: "click", adapterId: "browser" },
    targetEntityRefs: [], status: "pending", assertionResults: [], sideEffects: [],
  };
}

function event(index: number, severity?: "warning" | "error"): RunEventInput {
  return {
    channel: "log", type: "console",
    ...(severity ? { severity } : {}),
    source: { adapterId: "browser", producer: "test" },
    entityRefs: [], inlinePayload: { index },
  };
}

describe("RunStore change payloads", () => {
  let root: string;
  let store: RunStore;
  let seen: RunStoreChangeEvent[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "run-store-delta-"));
    store = new RunStore(root, { metadataMode: "json", maxEventsPerSegment: 1_000 }).open();
    seen = [];
    store.onDidChange((change) => seen.push(change));
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("carries the appended events, in order, with a contiguous sequence range", () => {
    store.createRun(makeRun());
    seen.length = 0;

    store.appendEvents("run-1", [event(0), event(1), event(2)]);

    const change = seen.find((c) => c.kind === "event");
    expect(change?.events).toHaveLength(3);
    expect(change?.events?.map((e) => e.inlinePayload?.["index"])).toEqual([0, 1, 2]);
    const sequences = change!.events!.map((e) => e.sequenceNumber);
    expect(sequences).toEqual([sequences[0], sequences[0]! + 1, sequences[0]! + 2]);
    expect(change?.ids).toEqual(change?.events?.map((e) => e.id));
  });

  it("reports a watermark that tracks the trace position and severity counts", () => {
    store.createRun(makeRun());
    store.appendEvents("run-1", [event(0), event(1, "warning"), event(2, "error")]);

    const change = seen.filter((c) => c.kind === "event").at(-1);
    expect(change?.watermark).toMatchObject({
      lastSequenceNumber: 3, eventCount: 3, warningCount: 1, errorCount: 1,
    });
  });

  it("emits a watermark of zero before any events exist", () => {
    store.createRun(makeRun());
    expect(seen.find((c) => c.kind === "run")?.watermark)
      .toMatchObject({ lastSequenceNumber: 0, eventCount: 0 });
  });

  it("carries the record for run, step, observation and artifact changes", () => {
    store.createRun(makeRun());
    expect(seen.at(-1)?.run).toMatchObject({ id: "run-1", status: "running" });

    store.putSteps("run-1", [makeStep("step-1", 0), makeStep("step-2", 1)]);
    expect(seen.at(-1)?.steps?.map((s) => s.id)).toEqual(["step-1", "step-2"]);

    store.updateStep("run-1", "step-1", { status: "succeeded" });
    expect(seen.at(-1)?.steps).toHaveLength(1);
    expect(seen.at(-1)?.steps?.[0]).toMatchObject({ id: "step-1", status: "succeeded" });

    const artifact = store.putArtifact("run-1", Buffer.from("png"), { mediaType: "image/png" });
    expect(seen.at(-1)?.artifacts?.[0]).toMatchObject({ id: artifact.id, runId: "run-1" });

    store.putObservation({
      id: "observation-1", runId: "run-1", cursor: { sequenceNumber: 1 },
      visualArtifactIds: [artifact.id], structuralArtifactIds: [], stateArtifactIds: [],
      eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 },
      entityRefs: [], captureProfile: "diagnostic",
    });
    expect(seen.at(-1)?.observations?.[0]).toMatchObject({ id: "observation-1" });
  });

  /** The emitted array must not be the one handed back to the caller, or a caller that sorts or
   *  splices its result silently reorders what every listener already received. */
  it("does not share the events array with the caller's return value", () => {
    store.createRun(makeRun());
    const returned = store.appendEvents("run-1", [event(0), event(1)]);
    const emitted = seen.find((c) => c.kind === "event")!.events!;

    expect(emitted).not.toBe(returned);
    returned.length = 0;
    expect(emitted).toHaveLength(2);
  });

  it("does not let a listener mutating a run record corrupt the store", () => {
    store.createRun(makeRun());
    const change = seen.find((c) => c.kind === "run")!;
    change.run!.status = "failed";
    expect(store.getRun("run-1")?.status).toBe("running");
  });

  /**
   * The whole point of carrying payloads. `emit` runs synchronously inside the sequence execution
   * loop, so any disk read here lands on the critical path of the run itself.
   */
  it("builds the payload without calling back into any store read path", () => {
    store.createRun(makeRun());
    store.putSteps("run-1", [makeStep("step-1", 0)]);
    store.appendEvents("run-1", [event(0)]);

    // These are the reads that cost real work — readEvents in particular re-reads and re-parses a
    // trace segment off disk, which is what made per-mutation refreshes expensive.
    const spies = (["readEvents", "getSteps", "listObservations", "listArtifacts", "listEventSegments"] as const)
      .map((method) => vi.spyOn(RunStore.prototype, method));
    for (const spy of spies) spy.mockClear();

    store.appendEvents("run-1", [event(1), event(2)]);

    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  /** Everything a consumer needs to apply the change must be on the event itself — if any of this
   *  is missing, the consumer has to re-query and the delta channel has bought nothing. */
  it("carries enough to apply an append without consulting the store", () => {
    store.createRun(makeRun());
    seen.length = 0;
    store.appendEvents("run-1", [event(0), event(1)]);

    const change = seen.find((c) => c.kind === "event")!;
    expect(change.runId).toBe("run-1");
    expect(change.events?.every((e) => e.id && e.sequenceNumber > 0 && e.channel)).toBe(true);
    expect(change.watermark?.lastSequenceNumber).toBe(change.events!.at(-1)!.sequenceNumber);
  });

  it("still delivers to a listener that ignores the argument entirely", () => {
    let calls = 0;
    const legacy = store.onDidChange(() => { calls += 1; });
    store.createRun(makeRun("run-2"));
    expect(calls).toBeGreaterThan(0);
    legacy.dispose();
  });
});
