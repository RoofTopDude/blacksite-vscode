import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRun, RunStep } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";
import { compareRuns } from "../../src/sequences/run-comparator";

function run(id: string): ExecutionRun {
  return {
    id,
    sequenceId: "sequence-results",
    sequenceVersion: 1,
    status: "succeeded",
    target: { adapterId: "workspace", type: "workspace" },
    adapterIds: ["workspace"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: ["read-config"],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

function step(runId: string): RunStep {
  return {
    id: "read-config",
    runId,
    ordinal: 0,
    declaredAction: {
      adapterId: "workspace",
      type: "read_file",
      input: { path: "config.json" },
    },
    targetEntityRefs: [{ scheme: "workspace-file", id: "config.json" }],
    status: "succeeded",
    assertionResults: [],
    sideEffects: [],
  };
}

describe("compareRuns adapter-result artifacts", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-result-compare-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
    store.createRun(run("left"));
    store.createRun(run("right"));
    store.putSteps("left", [step("left")]);
    store.putSteps("right", [step("right")]);
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports changed successful action payloads through the behavior channel", async () => {
    store.putArtifact("left", JSON.stringify({ ok: true, content: "before" }), {
      mediaType: "application/json",
      kind: "adapter-result",
      role: "result",
      stepId: "read-config",
    });
    store.putArtifact("right", JSON.stringify({ ok: true, content: "after" }), {
      mediaType: "application/json",
      kind: "adapter-result",
      role: "result",
      stepId: "read-config",
    });

    const comparison = await compareRuns(
      store,
      store.getRun("left")!,
      store.getRun("right")!,
      "semantic",
      { channels: ["behavior"] },
    );

    expect(comparison.summary).toMatchObject({ changed: 1, unchanged: 0 });
    expect(comparison.alignments[0]?.changes).toEqual([
      expect.objectContaining({
        channel: "behavior",
        kind: "changed",
        summary: expect.stringMatching(/action result artifacts differ/i),
      }),
    ]);
    expect(comparison.alignments[0]?.left?.artifacts).toHaveLength(1);
    expect(comparison.alignments[0]?.right?.artifacts).toHaveLength(1);
  });

  it("does not surface result payload differences when behavior was not requested", async () => {
    store.putArtifact("left", "before", {
      mediaType: "application/json",
      kind: "adapter-result",
      role: "result",
      stepId: "read-config",
    });
    store.putArtifact("right", "after", {
      mediaType: "application/json",
      kind: "adapter-result",
      role: "result",
      stepId: "read-config",
    });

    const comparison = await compareRuns(
      store,
      store.getRun("left")!,
      store.getRun("right")!,
      "semantic",
      { channels: ["visual"] },
    );

    expect(comparison.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(comparison.alignments[0]?.changes).toEqual([]);
    expect(comparison.alignments[0]?.left?.artifacts).toEqual([]);
    expect(comparison.alignments[0]?.right?.artifacts).toEqual([]);
  });

  it("keeps identical result payloads unchanged", async () => {
    for (const runId of ["left", "right"]) {
      store.putArtifact(runId, JSON.stringify({ ok: true, content: "same" }), {
        mediaType: "application/json",
        kind: "adapter-result",
        role: "result",
        stepId: "read-config",
      });
    }

    const comparison = await compareRuns(
      store,
      store.getRun("left")!,
      store.getRun("right")!,
      "semantic",
      { channels: ["behavior"] },
    );

    expect(comparison.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(comparison.alignments[0]?.changes).toEqual([]);
  });
});
