import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalRuntime } from "@blacksite/local-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRun, RunStep, RunStepStatus } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";
import { SequenceService } from "../../src/sequences/sequence-service";

function run(id: string): ExecutionRun {
  return {
    id,
    sequenceId: "compare-sequence",
    sequenceVersion: 1,
    status: "created",
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

function step(runId: string, id: string, ordinal: number, route: string, status: RunStepStatus): RunStep {
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

describe("SequenceService discovery validation", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-discovery-service-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns a structured failure for an unknown adapter", async () => {
    const handleMessage = vi.fn();
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: { handleMessage } as unknown as LocalRuntime,
    });

    const result = await service.dispatch("discover", {
      target: { adapter: "mystery-engine" },
    }, { sessionId: "discovery-test" });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unsupported discovery adapter/i),
      failure: {
        code: "unsupported_discovery_adapter",
        adapter: "mystery-engine",
          supportedAdapters: ["browser", "workspace", "process", "test", "desktop"],
      },
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("passes channel and surface scopes through sequence_compare", async () => {
    store.createRun(run("left"));
    store.createRun(run("right"));
    store.putSteps("left", [
      step("left", "checkout", 0, "/checkout", "succeeded"),
      step("left", "account", 1, "/account", "succeeded"),
    ]);
    store.putSteps("right", [
      step("right", "checkout", 0, "/checkout", "failed"),
      step("right", "account", 1, "/account", "succeeded"),
    ]);
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: { handleMessage: vi.fn() } as unknown as LocalRuntime,
    });

    const visualOnly = await service.dispatch("compare", {
      left_run_id: "left",
      right_run_id: "right",
      scope: { surface: "/checkout" },
      channels: ["visual"],
    }, { sessionId: "compare-test" });
    expect(visualOnly).toMatchObject({
      ok: true,
      comparison: {
        summary: { changed: 0, unchanged: 1 },
        alignments: [{
          left: { step: { id: "checkout" } },
          right: { step: { id: "checkout" } },
          changes: [],
        }],
      },
    });

    const behavior = await service.dispatch("compare", {
      left_run_id: "left",
      right_run_id: "right",
      scope: { surface: "route:/checkout" },
      channels: ["behavior"],
    }, { sessionId: "compare-test" });
    expect(behavior).toMatchObject({
      ok: true,
      comparison: {
        summary: { changed: 1, unchanged: 0 },
        alignments: [{
          changes: [expect.objectContaining({ channel: "behavior" })],
        }],
      },
    });
  });
});
