import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { StoredRunArtifact } from "./run-model.js";
import type { PutRunArtifactOptions, RunStore } from "./run-store.js";

export interface VideoRetentionPolicy {
  enabled: boolean;
  maxDiskMb: number;
  degradeAfterDays: number;
  deleteAfterDays: number;
  keyframeIntervalMs: number;
}

export interface VideoRetentionSweepResult {
  degradedArtifactIds: string[];
  deletedArtifactIds: string[];
  freedBytes: number;
}

interface VideoCandidate {
  runId: string;
  artifact: StoredRunArtifact;
  preserved: boolean;
  quality: string;
  degradeAt?: string;
  expiresAt?: string;
}

export type VideoTranscoder = (inputPath: string) => Promise<Buffer | undefined>;

/** Applies the user-owned recording budget without touching extracted keyframes. */
export class VideoRetentionManager {
  private sweeping?: Promise<VideoRetentionSweepResult>;

  constructor(
    private readonly store: RunStore,
    private readonly policy: () => VideoRetentionPolicy,
    private readonly transcode: VideoTranscoder = transcodeWebm,
  ) {}

  sweep(now = new Date()): Promise<VideoRetentionSweepResult> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.runSweep(now).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async runSweep(now: Date): Promise<VideoRetentionSweepResult> {
    const policy = this.policy();
    const result: VideoRetentionSweepResult = { degradedArtifactIds: [], deletedArtifactIds: [], freedBytes: 0 };
    if (!policy.enabled) return result;

    let candidates = this.collectVideos();
    for (const candidate of candidates) {
      if (candidate.preserved || !candidate.expiresAt || Date.parse(candidate.expiresAt) > now.getTime()) continue;
      if (this.store.removeArtifactAttachment(candidate.runId, candidate.artifact.id)) {
        result.deletedArtifactIds.push(candidate.artifact.id);
        result.freedBytes += candidate.artifact.byteLength;
      }
    }

    candidates = this.collectVideos();
    for (const candidate of candidates) {
      if (candidate.preserved || candidate.quality !== "original"
        || !candidate.degradeAt || Date.parse(candidate.degradeAt) > now.getTime()) continue;
      let reduced: Buffer | undefined;
      try {
        reduced = await this.transcode(this.store.artifactPath(candidate.artifact.id));
      } catch {
        reduced = undefined;
      }
      if (!reduced || reduced.byteLength >= candidate.artifact.byteLength) continue;
      const retention = retentionRecord(candidate.artifact);
      const options: PutRunArtifactOptions = {
        mediaType: candidate.artifact.mediaType,
        kind: candidate.artifact.kind,
        fileName: candidate.artifact.fileName,
        role: candidate.artifact.role,
        stepId: candidate.artifact.stepId,
        observationId: candidate.artifact.observationId,
        metadata: {
          ...(candidate.artifact.metadata ?? {}),
          videoRetention: { ...retention, quality: "reduced", degradedAt: now.toISOString() },
        },
      };
      const replacement = this.store.putArtifact(candidate.runId, reduced, options);
      for (const observation of this.store.listObservations(candidate.runId)) {
        if (!observation.visualArtifactIds.includes(candidate.artifact.id)) continue;
        this.store.putObservation({
          ...observation,
          visualArtifactIds: observation.visualArtifactIds.map((id) => id === candidate.artifact.id ? replacement.id : id),
        });
      }
      this.store.removeArtifactAttachment(candidate.runId, candidate.artifact.id);
      result.degradedArtifactIds.push(replacement.id);
      result.freedBytes += candidate.artifact.byteLength - replacement.byteLength;
    }

    candidates = this.collectVideos()
      .filter((candidate) => !candidate.preserved)
      .sort((left, right) => left.artifact.createdAt.localeCompare(right.artifact.createdAt));
    let total = candidates.reduce((sum, candidate) => sum + candidate.artifact.byteLength, 0);
    const budget = Math.max(1, policy.maxDiskMb) * 1024 * 1024;
    for (const candidate of candidates) {
      if (total <= budget) break;
      if (!this.store.removeArtifactAttachment(candidate.runId, candidate.artifact.id)) continue;
      total -= candidate.artifact.byteLength;
      result.deletedArtifactIds.push(candidate.artifact.id);
      result.freedBytes += candidate.artifact.byteLength;
    }
    return result;
  }

  private collectVideos(): VideoCandidate[] {
    const candidates: VideoCandidate[] = [];
    let offset = 0;
    while (true) {
      const page = this.store.listRuns({ limit: 500, offset });
      for (const run of page.runs) {
        for (const artifact of this.store.listArtifacts(run.id)) {
          if (artifact.kind !== "browser-video" && !artifact.mediaType?.startsWith("video/")) continue;
          const retention = retentionRecord(artifact);
          candidates.push({
            runId: run.id,
            artifact,
            preserved: retention["preserved"] === true,
            quality: typeof retention["quality"] === "string" ? retention["quality"] : "original",
            degradeAt: typeof retention["degradeAt"] === "string" ? retention["degradeAt"] : undefined,
            expiresAt: typeof retention["expiresAt"] === "string" ? retention["expiresAt"] : undefined,
          });
        }
      }
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    return candidates;
  }
}

function retentionRecord(artifact: StoredRunArtifact): Record<string, unknown> {
  const value = artifact.metadata?.["videoRetention"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function transcodeWebm(inputPath: string): Promise<Buffer | undefined> {
  const directory = path.join(os.tmpdir(), `blacksite-video-decay-${randomUUID()}`);
  const output = path.join(directory, "reduced.webm");
  fs.mkdirSync(directory, { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-vf", "fps=5,scale=trunc(iw/4)*2:trunc(ih/4)*2",
        "-c:v", "libvpx-vp9", "-crf", "42", "-b:v", "0", "-an", output,
      ], { windowsHide: true, timeout: 120_000 }, (error) => error ? reject(error) : resolve());
    });
    return fs.existsSync(output) ? fs.readFileSync(output) : undefined;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
