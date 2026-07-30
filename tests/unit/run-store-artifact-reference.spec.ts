import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRun } from "../../src/runs/run-model";
import { RunStore } from "../../src/runs/run-store";

function run(id: string): ExecutionRun {
  return {
    id,
    sequenceId: `sequence-${id}`,
    sequenceVersion: 1,
    status: "created",
    target: { adapterId: "browser", type: "route", id: "/same" },
    adapterIds: ["browser"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: ["capture"],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

describe("RunStore content-addressed artifact references", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-artifact-ref-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
    store.createRun(run("run-1"));
    store.createRun(run("run-2"));
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deduplicates bytes while preserving metadata on every attachment", () => {
    const bytes = Buffer.from("identical captured bytes");
    const before = store.putArtifact("run-1", bytes, {
      mediaType: "image/png",
      kind: "screenshot",
      fileName: "capture-before.png",
      role: "before",
      stepId: "capture",
      observationId: "observation-before",
      metadata: { phase: "before", viewport: "desktop" },
    });
    const after = store.putArtifact("run-1", bytes, {
      mediaType: "image/webp",
      kind: "visual-diff",
      fileName: "capture-after.webp",
      role: "after",
      stepId: "capture",
      observationId: "observation-after",
      metadata: { phase: "after", viewport: "mobile" },
    });
    const baseline = store.putArtifact("run-2", bytes, {
      mediaType: "application/octet-stream",
      kind: "baseline-bytes",
      fileName: "baseline.bin",
      role: "baseline",
      stepId: "capture",
      observationId: "observation-baseline",
      metadata: { source: "run-2" },
    });

    expect(after.id).toBe(before.id);
    expect(baseline.id).toBe(before.id);
    expect(store.readArtifact(before.id)).toEqual(bytes);
    expect(store.listArtifacts("run-1")).toMatchObject([
      {
        id: before.id,
        runId: "run-1",
        mediaType: "image/png",
        kind: "screenshot",
        fileName: "capture-before.png",
        role: "before",
        observationId: "observation-before",
        metadata: { phase: "before", viewport: "desktop" },
      },
      {
        id: before.id,
        runId: "run-1",
        mediaType: "image/webp",
        kind: "visual-diff",
        fileName: "capture-after.webp",
        role: "after",
        observationId: "observation-after",
        metadata: { phase: "after", viewport: "mobile" },
      },
    ]);
    expect(store.listArtifacts("run-2")).toMatchObject([{
      id: before.id,
      runId: "run-2",
      mediaType: "application/octet-stream",
      kind: "baseline-bytes",
      fileName: "baseline.bin",
      role: "baseline",
      observationId: "observation-baseline",
      metadata: { source: "run-2" },
    }]);

    const blobDirectory = path.dirname(store.artifactPath(before.id));
    expect(fs.readdirSync(blobDirectory)).toEqual([before.id]);
  });

  it("persists attachment-local metadata across reload", () => {
    const bytes = Buffer.from("same screenshot");
    const first = store.putArtifact("run-1", bytes, {
      mediaType: "image/png",
      kind: "screenshot",
      fileName: "before.png",
      role: "before",
      observationId: "before-observation",
    });
    store.putArtifact("run-1", bytes, {
      mediaType: "image/png",
      kind: "screenshot",
      fileName: "after.png",
      role: "after",
      observationId: "after-observation",
    });
    store.dispose();
    store = new RunStore(root, { metadataMode: "json" }).open();

    expect(store.listArtifacts("run-1")).toMatchObject([
      { id: first.id, fileName: "before.png", role: "before" },
      { id: first.id, fileName: "after.png", role: "after" },
    ]);
  });

  it("preserves distinct semantic attachments with the same bytes and context", () => {
    const bytes = Buffer.from("same bytes and provenance");
    const screenshot = store.putArtifact("run-1", bytes, {
      mediaType: "image/png",
      kind: "screenshot",
      fileName: "capture.png",
      role: "evidence",
      stepId: "capture",
      observationId: "observation-1",
      metadata: { phase: "before" },
    });
    const diff = store.putArtifact("run-1", bytes, {
      mediaType: "image/webp",
      kind: "visual-diff",
      fileName: "diff.webp",
      role: "evidence",
      stepId: "capture",
      observationId: "observation-1",
      metadata: { phase: "after" },
    });

    expect(diff.id).toBe(screenshot.id);
    expect(store.listArtifacts("run-1")).toMatchObject([
      {
        id: screenshot.id,
        kind: "screenshot",
        mediaType: "image/png",
        fileName: "capture.png",
        metadata: { phase: "before" },
      },
      {
        id: screenshot.id,
        kind: "visual-diff",
        mediaType: "image/webp",
        fileName: "diff.webp",
        metadata: { phase: "after" },
      },
    ]);
  });
});
