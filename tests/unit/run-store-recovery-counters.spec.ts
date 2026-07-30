import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionRun, RunEventInput } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";

function run(): ExecutionRun {
  return {
    id: "run-recovery",
    sequenceId: "sequence-recovery",
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

function event(severity: RunEventInput["severity"]): RunEventInput {
  return {
    channel: "diagnostic",
    type: `event_${severity}`,
    severity,
    source: { adapterId: "browser", producer: "unit-test" },
    entityRefs: [],
  };
}

describe("RunStore severity counter recovery", () => {
  it("includes events written after the last metadata flush in an interrupted-run summary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-counter-recovery-"));
    let recovered: RunStore | undefined;
    try {
      const abruptlyStopped = new RunStore(root, {
        metadataMode: "json",
        maxEventsPerSegment: 100,
      }).open();
      abruptlyStopped.createRun(run());

      // appendEvent intentionally leaves metadata buffered until the 256-event
      // flush threshold. The JSONL bytes survive an extension-host crash even
      // though the index still reports zero events and zero severity counters.
      abruptlyStopped.appendEvent("run-recovery", event("warning"));
      abruptlyStopped.appendEvent("run-recovery", event("error"));
      abruptlyStopped.appendEvent("run-recovery", event("fatal"));

      recovered = new RunStore(root, {
        metadataMode: "json",
        maxEventsPerSegment: 100,
      }).open();

      expect(recovered.getRun("run-recovery")).toMatchObject({
        status: "partial",
        summary: {
          eventCount: 3,
          warningCount: 1,
          errorCount: 2,
        },
      });
      expect(recovered.listEventSegments("run-recovery")).toMatchObject([{
        eventCount: 3,
        warningCount: 1,
        errorCount: 2,
      }]);
    } finally {
      recovered?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("backfills severity counts when opening pre-v2 segment metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-counter-migration-"));
    let reopened: RunStore | undefined;
    try {
      const original = new RunStore(root, {
        metadataMode: "json",
        maxEventsPerSegment: 2,
      }).open();
      original.createRun(run());
      original.appendEvents("run-recovery", [event("warning"), event("error")]);
      original.dispose();

      const indexPath = path.join(root, ".blacksite", "runs", "index.json");
      const metadata = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
        schemaVersion: number;
        runs: Array<{ warningCount: number; errorCount: number }>;
        segments: Array<Record<string, unknown>>;
      };
      metadata.schemaVersion = 1;
      metadata.runs[0]!.warningCount = 0;
      metadata.runs[0]!.errorCount = 0;
      for (const segment of metadata.segments) {
        delete segment["warningCount"];
        delete segment["errorCount"];
      }
      fs.writeFileSync(indexPath, `${JSON.stringify(metadata)}\n`);

      reopened = new RunStore(root, {
        metadataMode: "json",
        maxEventsPerSegment: 2,
      }).open();

      expect(reopened.getRun("run-recovery")?.summary).toMatchObject({
        eventCount: 2,
        warningCount: 1,
        errorCount: 1,
      });
      expect(reopened.listEventSegments("run-recovery")).toMatchObject([{
        warningCount: 1,
        errorCount: 1,
      }]);
      const migrated = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { schemaVersion: number };
      expect(migrated.schemaVersion).toBe(2);
    } finally {
      reopened?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
