import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRun } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";
import { VideoRetentionManager, type VideoRetentionPolicy } from "../../src/runs/video-retention";

function run(id: string): ExecutionRun {
  return {
    id,
    sequenceId: `sequence-${id}`,
    sequenceVersion: 1,
    status: "succeeded",
    target: { adapterId: "browser", type: "route", id: "/simulation" },
    adapterIds: ["browser"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: ["record"],
    checkpointIds: [],
    keyObservationIds: ["observation-1"],
    retentionClass: "standard",
  };
}

const policy: VideoRetentionPolicy = {
  enabled: true,
  maxDiskMb: 64,
  degradeAfterDays: 1,
  deleteAfterDays: 3,
  keyframeIntervalMs: 500,
};

describe("VideoRetentionManager", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-video-retention-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
    store.createRun(run("run-1"));
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("expires the recording while retaining extracted keyframes and stable observation evidence", async () => {
    const frame = store.putArtifact("run-1", Buffer.from("frame"), {
      mediaType: "image/jpeg", kind: "video-keyframe", role: "video-keyframe", stepId: "record",
    });
    const video = store.putArtifact("run-1", Buffer.alloc(128, 1), {
      mediaType: "video/webm", kind: "browser-video", role: "video", stepId: "record",
      metadata: { videoRetention: { preserved: false, quality: "original", expiresAt: "2025-01-01T00:00:00.000Z" } },
    });
    store.putObservation({
      id: "observation-1", runId: "run-1", stepId: "record",
      cursor: { sequenceNumber: 1, monotonicTimestampNs: "1", eventId: "event-1" },
      visualArtifactIds: [video.id, frame.id], structuralArtifactIds: [], stateArtifactIds: [],
      eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 }, entityRefs: [], captureProfile: "video",
    });

    const result = await new VideoRetentionManager(store, () => policy, async () => undefined)
      .sweep(new Date("2026-01-01T00:00:00.000Z"));

    expect(result.deletedArtifactIds).toEqual([video.id]);
    expect(store.listArtifacts("run-1").map((artifact) => artifact.id)).toEqual([frame.id]);
    expect(store.getObservation("observation-1")?.visualArtifactIds).toEqual([frame.id]);
  });

  it("reduces old recordings and rewires observations to the replacement artifact", async () => {
    const video = store.putArtifact("run-1", Buffer.alloc(1_024, 1), {
      mediaType: "video/webm", kind: "browser-video", role: "video", stepId: "record",
      metadata: {
        keyframeArtifactIds: [],
        videoRetention: {
          preserved: false, quality: "original",
          degradeAt: "2025-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z",
        },
      },
    });
    store.putObservation({
      id: "observation-1", runId: "run-1", stepId: "record",
      cursor: { sequenceNumber: 1, monotonicTimestampNs: "1", eventId: "event-1" },
      visualArtifactIds: [video.id], structuralArtifactIds: [], stateArtifactIds: [],
      eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 }, entityRefs: [], captureProfile: "video",
    });

    const result = await new VideoRetentionManager(store, () => policy, async () => Buffer.alloc(128, 2))
      .sweep(new Date("2026-01-01T00:00:00.000Z"));

    const replacement = store.listArtifacts("run-1")[0]!;
    expect(replacement.id).not.toBe(video.id);
    expect(replacement.metadata?.["videoRetention"]).toMatchObject({ quality: "reduced", preserved: false });
    expect(store.getObservation("observation-1")?.visualArtifactIds).toEqual([replacement.id]);
    expect(result.freedBytes).toBe(896);
  });

  it("never expires a recording the user preserved", async () => {
    const video = store.putArtifact("run-1", Buffer.alloc(128, 1), {
      mediaType: "video/webm", kind: "browser-video", role: "video", stepId: "record",
      metadata: { videoRetention: { preserved: true, quality: "original", expiresAt: "2025-01-01T00:00:00.000Z" } },
    });

    await new VideoRetentionManager(store, () => ({ ...policy, maxDiskMb: 1 }), async () => undefined)
      .sweep(new Date("2026-01-01T00:00:00.000Z"));

    expect(store.listArtifacts("run-1").map((artifact) => artifact.id)).toContain(video.id);
  });
});
