import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionRun, RunStep } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";

function run(id: string, adapterId: string): ExecutionRun {
  return {
    id,
    sequenceId: `sequence-${id}`,
    sequenceVersion: 1,
    status: "running",
    target: { adapterId, type: adapterId },
    adapterIds: [adapterId],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: ["active"],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

function step(runId: string, adapterId: string, action: string): RunStep {
  return {
    id: "active",
    runId,
    ordinal: 0,
    declaredAction: { adapterId, type: action, input: {} },
    targetEntityRefs: [],
    status: "running",
    assertionResults: [],
    sideEffects: [],
  };
}

describe("RunStore interrupted side-effect recovery", () => {
  it("records an unknown non-reversible effect for an in-flight mutation but not a read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-crash-effect-"));
    let recovered: RunStore | undefined;
    try {
      const abruptlyStopped = new RunStore(root, { metadataMode: "json" }).open();
      abruptlyStopped.createRun(run("mutating", "test"));
      abruptlyStopped.putSteps("mutating", [step("mutating", "test", "run")]);
      abruptlyStopped.createRun(run("readonly", "workspace"));
      abruptlyStopped.putSteps("readonly", [step("readonly", "workspace", "read_file")]);

      recovered = new RunStore(root, { metadataMode: "json" }).open();

      expect(recovered.getSteps("mutating")).toMatchObject([{
        status: "cancelled",
        sideEffects: [{
          class: "process",
          reversible: false,
          metadata: {
            outcome: "unknown",
            recoveredAfterHostInterruption: true,
          },
        }],
      }]);
      expect(recovered.getSteps("readonly")).toMatchObject([{
        status: "cancelled",
        sideEffects: [],
      }]);
      expect(recovered.getRun("mutating")?.status).toBe("partial");
      expect(recovered.getRun("readonly")?.status).toBe("partial");
    } finally {
      recovered?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
