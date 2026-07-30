import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  openSqlDriver,
  type SqlDriver,
} from "../data/sql-driver";
import {
  type EntityRef,
  type ExecutionRun,
  type FinalizeRunInput,
  type ObservationBundle,
  type ReadEventsOptions,
  type RunArtifact,
  type RunEvent,
  type RunEventInput,
  type RunRetentionClass,
  type RunRetentionPolicy,
  type RunRetentionResult,
  type RunSearchQuery,
  type RunSearchResult,
  type SideEffectRecord,
  type RunStatus,
  type RunStep,
  type StoredRunArtifact,
  isTerminalRunStatus,
} from "./run-model";
import {
  RunArtifactStore,
  type ArtifactContent,
} from "./run-artifact-store";
import { buildRunSummary } from "./run-summary";

const METADATA_SCHEMA_VERSION = 2;
const DEFAULT_SEGMENT_EVENTS = 1_000;
const DEFAULT_SEGMENT_BYTES = 1_048_576;
const DEFAULT_READ_LIMIT = 1_000;
const MAX_READ_LIMIT = 100_000;
const EVENT_METADATA_FLUSH_INTERVAL = 256;
const MAX_SIGNED_64_BIT = 9_223_372_036_854_775_807n;
const SQLITE_SCHEMA_VERSION = 2;

const INTERRUPTED_STATUSES = new Set<RunStatus>([
  "validating",
  "awaiting_approval",
  "running",
]);

export type RunStoreChangeKind =
  | "run"
  | "step"
  | "event"
  | "observation"
  | "artifact"
  | "retention"
  | "recovery";

export interface RunStoreChangeEvent {
  kind: RunStoreChangeKind;
  runId?: string;
  ids?: string[];
}

export interface RunStoreOptions {
  maxEventsPerSegment?: number;
  maxUncompressedSegmentBytes?: number;
  /** Test/compatibility escape hatch; `auto` prefers SQLite and mirrors to JSON. */
  metadataMode?: "auto" | "json";
}

export interface PutRunArtifactOptions {
  mediaType?: string;
  kind?: string;
  fileName?: string;
  role?: string;
  stepId?: string;
  observationId?: string;
  metadata?: Record<string, unknown>;
}

export interface EventSegmentInfo {
  runId: string;
  firstSequence: number;
  lastSequence: number;
  firstMonotonicTimestampNs: string;
  lastMonotonicTimestampNs: string;
  eventCount: number;
  warningCount: number;
  errorCount: number;
  fileName: string;
  codec: "gzip" | "identity";
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface RunEventStats {
  eventCount: number;
  warningCount: number;
  errorCount: number;
}

interface StoredRunRecord {
  run: ExecutionRun;
  createdAt: string;
  updatedAt: string;
  nextSequence: number;
  lastMonotonicTimestampNs: string;
  eventCount: number;
  warningCount: number;
  errorCount: number;
}

interface StoredEntityRef {
  runId: string;
  ref: EntityRef;
}

interface RunMetadataDocument {
  schemaVersion: number;
  runs: StoredRunRecord[];
  steps: RunStep[];
  observations: ObservationBundle[];
  artifacts: RunArtifact[];
  runArtifacts: StoredRunArtifact[];
  segments: EventSegmentInfo[];
  entities: StoredEntityRef[];
}

interface AppendResult {
  events: RunEvent[];
  sealedSegment: boolean;
}

export class RunSegmentCorruptionError extends Error {
  constructor(
    readonly runId: string,
    readonly fileName: string,
    message: string,
  ) {
    super(`Corrupt event segment ${fileName} for run ${runId}: ${message}`);
    this.name = "RunSegmentCorruptionError";
  }
}

/**
 * Durable execution-run metadata and trace storage.
 *
 * SQLite is used when a supported binding is available. An atomically-replaced
 * JSON mirror is always maintained, both as a migration source and as the complete
 * fallback for VS Code hosts whose embedded Node version has no SQLite binding.
 * High-volume events never enter either metadata representation.
 */
export class RunStore {
  readonly rootPath: string;
  readonly tracesPath: string;
  readonly indexPath: string;
  readonly fallbackIndexPath: string;
  readonly artifacts: RunArtifactStore;

  private readonly maxEventsPerSegment: number;
  private readonly maxUncompressedSegmentBytes: number;
  private readonly metadataMode: "auto" | "json";
  private readonly listeners = new Set<(event: RunStoreChangeEvent) => void>();
  private state: RunMetadataDocument = emptyMetadata();
  private driver: SqlDriver | undefined;
  private initialized = false;
  private disposed = false;
  private dirtyEventAppends = 0;

  constructor(
    readonly workspaceRoot: string,
    options: RunStoreOptions = {},
  ) {
    this.rootPath = path.join(path.resolve(workspaceRoot), ".blacksite", "runs");
    this.tracesPath = path.join(this.rootPath, "traces");
    this.indexPath = path.join(this.rootPath, "index.sqlite");
    this.fallbackIndexPath = path.join(this.rootPath, "index.json");
    this.artifacts = new RunArtifactStore(workspaceRoot);
    this.maxEventsPerSegment = positiveInteger(
      options.maxEventsPerSegment,
      DEFAULT_SEGMENT_EVENTS,
    );
    this.maxUncompressedSegmentBytes = positiveInteger(
      options.maxUncompressedSegmentBytes,
      DEFAULT_SEGMENT_BYTES,
    );
    this.metadataMode = options.metadataMode ?? "auto";
  }

  get metadataEngine(): "sqlite" | "json" {
    return this.driver ? "sqlite" : "json";
  }

  open(): this {
    return this.ensureInitialized();
  }

  ensureInitialized(): this {
    if (this.initialized) return this;
    if (this.disposed) throw new Error("RunStore has been disposed");

    fs.mkdirSync(this.tracesPath, { recursive: true });
    this.artifacts.ensureInitialized();

    const jsonState = readMetadataFile(this.fallbackIndexPath);
    if (this.metadataMode === "auto") this.tryOpenSqlite();
    const sqliteState = this.driver ? this.readSqliteState() : undefined;
    const backupState = jsonState === undefined
      ? readMetadataFile(`${this.fallbackIndexPath}.bak`)
      : undefined;
    // Prefer the SQLite index over an older JSON backup when the primary mirror
    // is damaged. Mutation order is primary JSON, then SQLite, then next backup.
    this.state = normalizeMetadata(jsonState ?? sqliteState ?? backupState ?? emptyMetadata());
    this.initialized = true;

    let recoveredStorage = false;
    for (const record of this.state.runs) {
      if (this.reconcileSegments(record)) recoveredStorage = true;
    }
    const recoveredRuns = this.recoverInterruptedRuns(false);
    if (recoveredStorage || recoveredRuns.length > 0 || jsonState === undefined) {
      this.persistMetadata();
    } else if (this.driver) {
      // The JSON mirror is canonical after a crash; refresh SQLite even when no
      // semantic recovery was needed.
      this.persistSqlite();
    }
    return this;
  }

  onDidChange(listener: (event: RunStoreChangeEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  createRun(run: ExecutionRun): ExecutionRun {
    this.assertOpen();
    validateRun(run);
    if (this.findRunRecord(run.id)) {
      throw new Error(`Execution run already exists: ${run.id}`);
    }
    const now = new Date().toISOString();
    const stored = cloneJson(run);
    this.state.runs.push({
      run: stored,
      createdAt: now,
      updatedAt: now,
      nextSequence: 1,
      lastMonotonicTimestampNs: "0",
      eventCount: 0,
      warningCount: 0,
      errorCount: 0,
    });
    this.indexRunEntities(stored.id, targetEntityRefs(stored));
    this.writeRunManifest(stored.id);
    this.persistMetadata();
    this.emit({ kind: "run", runId: stored.id, ids: [stored.id] });
    return cloneJson(stored);
  }

  updateRun(run: ExecutionRun): ExecutionRun;
  updateRun(runId: string, patch: Partial<ExecutionRun>): ExecutionRun;
  updateRun(
    runOrId: ExecutionRun | string,
    patch?: Partial<ExecutionRun>,
  ): ExecutionRun {
    this.assertOpen();
    const runId = typeof runOrId === "string" ? runOrId : runOrId.id;
    const record = this.requireRunRecord(runId);
    const next = typeof runOrId === "string"
      ? { ...record.run, ...cloneJson(patch ?? {}), id: runId }
      : cloneJson(runOrId);
    validateRun(next);
    record.run = next;
    record.updatedAt = new Date().toISOString();
    this.replaceTargetEntities(runId, targetEntityRefs(next));
    this.persistMetadata();
    this.emit({ kind: "run", runId, ids: [runId] });
    return cloneJson(next);
  }

  getRun(runId: string): ExecutionRun | undefined {
    this.assertOpen();
    const record = this.findRunRecord(runId);
    return record ? cloneJson(record.run) : undefined;
  }

  listRuns(query: RunSearchQuery = {}): RunSearchResult {
    return this.searchRuns(query);
  }

  searchRuns(query: RunSearchQuery = {}): RunSearchResult {
    this.assertOpen();
    const statusFilter = query.status === undefined
      ? undefined
      : new Set(Array.isArray(query.status) ? query.status : [query.status]);
    const terms = splitSearchTerms(query.query);
    const offset = nonNegativeInteger(query.offset, 0);
    const limit = boundedInteger(query.limit, 50, 1, 500);

    const matches = this.state.runs.filter((record) => {
      const run = record.run;
      if (statusFilter && !statusFilter.has(run.status)) return false;
      if (query.retentionClass && run.retentionClass !== query.retentionClass) return false;
      if (query.planId && run.planId !== query.planId) return false;
      if (query.phaseId && run.phaseId !== query.phaseId) return false;
      if (query.ticketId && !run.ticketIds.includes(query.ticketId)) return false;
      if (query.parentRunId && run.parentRunId !== query.parentRunId) return false;
      if (query.adapterId && !run.adapterIds.includes(query.adapterId)) return false;
      if (query.anomalyType && !run.summary?.anomalyTypes?.some((type) =>
        type.toLocaleLowerCase().includes(query.anomalyType!.toLocaleLowerCase())
      )) return false;
      const runDate = run.startedAt ?? record.createdAt;
      if (query.startedAfter && runDate < query.startedAfter) return false;
      if (query.startedBefore && runDate > query.startedBefore) return false;

      const refs = this.entityRefsForRun(run.id);
      const requestedFile = query.filePath
        ? normalizeWorkspacePath(query.filePath)
        : undefined;
      if (requestedFile && !refs.some((ref) => (
        ref.workspacePath === requestedFile
        || (ref.scheme === "workspace-file" && ref.id === requestedFile)
      ))) return false;
      if (query.surfaceId && !refs.some((ref) => (
        ref.id === query.surfaceId
        && SURFACE_SCHEMES.has(ref.scheme)
      ))) return false;

      if (terms.length > 0) {
        const haystack = runSearchText(run, refs);
        if (!terms.every((term) => haystack.includes(term))) return false;
      }
      return true;
    });

    matches.sort((left, right) => {
      const leftDate = left.run.startedAt ?? left.createdAt;
      const rightDate = right.run.startedAt ?? right.createdAt;
      return rightDate.localeCompare(leftDate) || right.createdAt.localeCompare(left.createdAt);
    });

    const page = matches.slice(offset, offset + limit).map((record) => cloneJson(record.run));
    return {
      runs: page,
      matched: matches.length,
      ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}),
    };
  }

  putSteps(runId: string, steps: RunStep[]): RunStep[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    const seenIds = new Set<string>();
    for (const step of steps) {
      validateStep(runId, step);
      if (seenIds.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
      seenIds.add(step.id);
    }

    const incomingIds = new Set(steps.map((step) => step.id));
    this.state.steps = this.state.steps.filter((step) => (
      step.runId !== runId || !incomingIds.has(step.id)
    ));
    this.state.steps.push(...cloneJson(steps));
    this.state.steps.sort(compareSteps);

    const record = this.requireRunRecord(runId);
    const allRunSteps = this.state.steps.filter((step) => step.runId === runId);
    record.run.stepIds = allRunSteps.sort(compareSteps).map((step) => step.id);
    record.updatedAt = new Date().toISOString();
    this.indexRunEntities(runId, steps.flatMap((step) => step.targetEntityRefs));
    this.persistMetadata();
    this.emit({ kind: "step", runId, ids: steps.map((step) => step.id) });
    return cloneJson(steps);
  }

  getSteps(runId: string): RunStep[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    return cloneJson(this.state.steps.filter((step) => step.runId === runId).sort(compareSteps));
  }

  updateStep(step: RunStep): RunStep;
  updateStep(runId: string, stepId: string, patch: Partial<RunStep>): RunStep;
  updateStep(
    stepOrRunId: RunStep | string,
    stepId?: string,
    patch?: Partial<RunStep>,
  ): RunStep {
    this.assertOpen();
    const runId = typeof stepOrRunId === "string" ? stepOrRunId : stepOrRunId.runId;
    const id = typeof stepOrRunId === "string" ? stepId : stepOrRunId.id;
    if (!id) throw new Error("Step id is required");
    const index = this.state.steps.findIndex((step) => step.runId === runId && step.id === id);
    if (index < 0) throw new Error(`Run step not found: ${id}`);
    const existing = this.state.steps[index];
    if (!existing) throw new Error(`Run step not found: ${id}`);
    const next = typeof stepOrRunId === "string"
      ? { ...existing, ...cloneJson(patch ?? {}), id, runId }
      : cloneJson(stepOrRunId);
    validateStep(runId, next);
    this.state.steps[index] = next;
    this.requireRunRecord(runId).updatedAt = new Date().toISOString();
    this.indexRunEntities(runId, next.targetEntityRefs);
    this.persistMetadata();
    this.emit({ kind: "step", runId, ids: [id] });
    return cloneJson(next);
  }

  appendEvent(runId: string, input: RunEventInput): RunEvent {
    const result = this.appendEventsInternal(runId, [input], false);
    const event = result.events[0];
    if (!event) throw new Error("Failed to append event");
    return event;
  }

  appendEvents(runId: string, inputs: RunEventInput[]): RunEvent[] {
    return this.appendEventsInternal(runId, inputs, true).events;
  }

  readEvents(runId: string, options: ReadEventsOptions = {}): RunEvent[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    const fromSequence = validSequenceBoundary(options.fromSequence, 1);
    const toSequence = validSequenceBoundary(options.toSequence, Number.MAX_SAFE_INTEGER);
    if (toSequence < fromSequence) return [];
    const fromTimestamp = decimalNanoseconds(options.fromMonotonicTimestampNs, 0n);
    const toTimestamp = decimalNanoseconds(
      options.toMonotonicTimestampNs,
      MAX_SIGNED_64_BIT,
    );
    if (toTimestamp < fromTimestamp) return [];
    const limit = boundedInteger(options.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
    const channels = options.channels ? new Set(options.channels) : undefined;
    const segments = this.state.segments
      .filter((segment) => (
        segment.runId === runId
        && segment.lastSequence >= fromSequence
        && segment.firstSequence <= toSequence
        && BigInt(segment.lastMonotonicTimestampNs) >= fromTimestamp
        && BigInt(segment.firstMonotonicTimestampNs) <= toTimestamp
      ))
      .sort(compareSegments);

    const result: RunEvent[] = [];
    for (const segment of segments) {
      const events = this.readSegment(segment);
      for (const event of events) {
        if (event.sequenceNumber < fromSequence) continue;
        if (event.sequenceNumber > toSequence) break;
        const timestamp = BigInt(event.monotonicTimestampNs);
        if (timestamp < fromTimestamp) continue;
        if (timestamp > toTimestamp) break;
        if (channels && !channels.has(event.channel)) continue;
        result.push(event);
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  /**
   * Reads the latest matching events while still returning them in chronological
   * order. This is used for bounded windows ending at a cursor, where a normal
   * ascending read could discard the events closest to that cursor.
   */
  readEventsEndingAt(runId: string, options: ReadEventsOptions = {}): RunEvent[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    const fromSequence = validSequenceBoundary(options.fromSequence, 1);
    const toSequence = validSequenceBoundary(options.toSequence, Number.MAX_SAFE_INTEGER);
    if (toSequence < fromSequence) return [];
    const fromTimestamp = decimalNanoseconds(options.fromMonotonicTimestampNs, 0n);
    const toTimestamp = decimalNanoseconds(
      options.toMonotonicTimestampNs,
      MAX_SIGNED_64_BIT,
    );
    if (toTimestamp < fromTimestamp) return [];
    const limit = boundedInteger(options.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
    const channels = options.channels ? new Set(options.channels) : undefined;
    const segments = this.state.segments
      .filter((segment) => (
        segment.runId === runId
        && segment.lastSequence >= fromSequence
        && segment.firstSequence <= toSequence
        && BigInt(segment.lastMonotonicTimestampNs) >= fromTimestamp
        && BigInt(segment.firstMonotonicTimestampNs) <= toTimestamp
      ))
      .sort(compareSegments)
      .reverse();

    const result: RunEvent[] = [];
    for (const segment of segments) {
      const events = this.readSegment(segment);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event) continue;
        if (event.sequenceNumber > toSequence) continue;
        if (event.sequenceNumber < fromSequence) break;
        const timestamp = BigInt(event.monotonicTimestampNs);
        if (timestamp > toTimestamp) continue;
        if (timestamp < fromTimestamp) break;
        if (channels && !channels.has(event.channel)) continue;
        result.push(event);
        if (result.length >= limit) return result.reverse();
      }
    }
    return result.reverse();
  }

  /** Exact retained counters, without materializing a capped event page. */
  getEventStats(runId: string): RunEventStats {
    this.assertOpen();
    const record = this.requireRunRecord(runId);
    return {
      eventCount: record.eventCount,
      warningCount: record.warningCount,
      errorCount: record.errorCount,
    };
  }

  /** Finds an event by its stable ID across every retained segment. */
  findEvent(runId: string, eventId: string): RunEvent | undefined {
    return this.findFirstEvent(runId, (event) => event.id === eventId);
  }

  /**
   * Finds the first semantic event match without the public page-size cap.
   * Callers should keep predicates deterministic and side-effect free.
   */
  findFirstEvent(
    runId: string,
    predicate: (event: RunEvent) => boolean,
    options: Pick<ReadEventsOptions, "channels"> = {},
  ): RunEvent | undefined {
    this.assertOpen();
    this.requireRunRecord(runId);
    const channels = options.channels ? new Set(options.channels) : undefined;
    const segments = this.state.segments
      .filter((segment) => segment.runId === runId)
      .sort(compareSegments);
    for (const segment of segments) {
      for (const event of this.readSegment(segment)) {
        if (channels && !channels.has(event.channel)) continue;
        if (predicate(event)) return cloneJson(event);
      }
    }
    return undefined;
  }

  /** Finds the latest semantic matches without relying on a capped prefix page. */
  findLastEvents(
    runId: string,
    predicate: (event: RunEvent) => boolean,
    limit: number,
    options: Pick<ReadEventsOptions, "channels"> = {},
  ): RunEvent[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    const boundedLimit = boundedInteger(limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT);
    const channels = options.channels ? new Set(options.channels) : undefined;
    const segments = this.state.segments
      .filter((segment) => segment.runId === runId)
      .sort(compareSegments)
      .reverse();
    const result: RunEvent[] = [];
    for (const segment of segments) {
      const events = this.readSegment(segment);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || (channels && !channels.has(event.channel))) continue;
        if (!predicate(event)) continue;
        result.push(event);
        if (result.length >= boundedLimit) return cloneJson(result.reverse());
      }
    }
    return cloneJson(result.reverse());
  }

  /**
   * Reads a bounded event window relative to the run's first retained event.
   * Per-segment timestamp bounds make this random access rather than a prefix scan.
   */
  readEventsByElapsedMs(
    runId: string,
    fromMs: number,
    toMs: number,
    options: Omit<
      ReadEventsOptions,
      "fromMonotonicTimestampNs" | "toMonotonicTimestampNs"
    > = {},
  ): RunEvent[] {
    const origin = this.getEventTimeOrigin(runId);
    if (origin === undefined) return [];
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs < fromMs) {
      throw new Error("Elapsed event window must be a finite, increasing non-negative range");
    }
    const originNs = BigInt(origin);
    const fromNs = originNs + BigInt(Math.trunc(fromMs * 1_000_000));
    const toNs = originNs + BigInt(Math.trunc(toMs * 1_000_000));
    return this.readEvents(runId, {
      ...options,
      fromMonotonicTimestampNs: fromNs.toString(),
      toMonotonicTimestampNs: toNs.toString(),
    });
  }

  getEventTimeOrigin(runId: string): string | undefined {
    this.assertOpen();
    this.requireRunRecord(runId);
    return this.state.segments
      .filter((segment) => segment.runId === runId)
      .sort(compareSegments)[0]?.firstMonotonicTimestampNs;
  }

  listEventSegments(runId: string): EventSegmentInfo[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    return cloneJson(
      this.state.segments.filter((segment) => segment.runId === runId).sort(compareSegments),
    );
  }

  putObservation(observation: ObservationBundle): ObservationBundle {
    this.assertOpen();
    this.requireRunRecord(observation.runId);
    validateObservation(observation);
    const stored = cloneJson(observation);
    const index = this.state.observations.findIndex((item) => item.id === stored.id);
    if (index >= 0) {
      const existing = this.state.observations[index];
      if (existing && existing.runId !== stored.runId) {
        throw new Error(`Observation id belongs to another run: ${stored.id}`);
      }
      this.state.observations[index] = stored;
    } else {
      this.state.observations.push(stored);
    }
    this.indexRunEntities(stored.runId, stored.entityRefs);
    const record = this.requireRunRecord(stored.runId);
    record.updatedAt = new Date().toISOString();
    this.persistMetadata();
    this.emit({ kind: "observation", runId: stored.runId, ids: [stored.id] });
    return cloneJson(stored);
  }

  getObservation(observationId: string): ObservationBundle | undefined {
    this.assertOpen();
    const observation = this.state.observations.find((item) => item.id === observationId);
    return observation ? cloneJson(observation) : undefined;
  }

  listObservations(runId: string): ObservationBundle[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    return cloneJson(
      this.state.observations
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.cursor.sequenceNumber - right.cursor.sequenceNumber),
    );
  }

  putArtifact(
    runId: string,
    content: ArtifactContent,
    options: PutRunArtifactOptions = {},
  ): StoredRunArtifact {
    this.assertOpen();
    this.requireRunRecord(runId);
    const blob = this.artifacts.put(content);
    let artifact = this.state.artifacts.find((item) => item.id === blob.id);
    if (!artifact) {
      artifact = {
        id: blob.id,
        sha256: blob.sha256,
        byteLength: blob.byteLength,
        ...(options.mediaType ? { mediaType: options.mediaType } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.fileName ? { fileName: options.fileName } : {}),
        createdAt: new Date().toISOString(),
        ...(options.metadata ? { metadata: cloneJson(options.metadata) } : {}),
      };
      this.state.artifacts.push(artifact);
    }

    // The blob identity is content-addressed, while presentation/provenance fields
    // belong to this run attachment. Do not inherit those fields from whichever
    // run happened to store the bytes first.
    const attached: StoredRunArtifact = {
      id: artifact.id,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      createdAt: artifact.createdAt,
      runId,
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.fileName ? { fileName: options.fileName } : {}),
      ...(options.role ? { role: options.role } : {}),
      ...(options.stepId ? { stepId: options.stepId } : {}),
      ...(options.observationId ? { observationId: options.observationId } : {}),
      ...(options.metadata ? { metadata: cloneJson(options.metadata) } : {}),
    };
    const attachmentKey = runArtifactKey(attached);
    const existingIndex = this.state.runArtifacts.findIndex(
      (item) => runArtifactKey(item) === attachmentKey,
    );
    if (existingIndex >= 0) this.state.runArtifacts[existingIndex] = attached;
    else this.state.runArtifacts.push(attached);

    this.indexRunEntities(runId, [{ scheme: "artifact", id: artifact.id }]);
    this.requireRunRecord(runId).updatedAt = new Date().toISOString();
    this.persistMetadata();
    this.emit({ kind: "artifact", runId, ids: [artifact.id] });
    return cloneJson(attached);
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    this.assertOpen();
    const artifact = this.state.artifacts.find((item) => item.id === normalizeSha256(artifactId));
    return artifact ? cloneJson(artifact) : undefined;
  }

  listArtifacts(runId: string): StoredRunArtifact[] {
    this.assertOpen();
    this.requireRunRecord(runId);
    return cloneJson(this.state.runArtifacts.filter((item) => item.runId === runId));
  }

  readArtifact(artifactId: string): Buffer {
    this.assertOpen();
    return this.artifacts.read(artifactId);
  }

  artifactPath(artifactId: string): string {
    this.assertOpen();
    return this.artifacts.path(artifactId);
  }

  getArtifactPath(artifactId: string): string {
    return this.artifactPath(artifactId);
  }

  setRetention(runId: string, retentionClass: RunRetentionClass): ExecutionRun {
    return this.updateRun(runId, { retentionClass });
  }

  pinRun(runId: string): ExecutionRun {
    return this.setRetention(runId, "pinned");
  }

  finalizeRun(runId: string, input: FinalizeRunInput): ExecutionRun {
    this.assertOpen();
    if (!isTerminalRunStatus(input.status)) {
      throw new Error(`Cannot finalize a run with non-terminal status: ${input.status}`);
    }
    const record = this.requireRunRecord(runId);
    this.sealActiveSegment(runId);
    record.run.status = input.status;
    record.run.endedAt = input.endedAt ?? new Date().toISOString();
    record.run.summary = input.summary
      ? cloneJson(input.summary)
      : buildRunSummary({
        run: record.run,
        steps: this.state.steps.filter((step) => step.runId === runId),
        observations: this.state.observations.filter(
          (observation) => observation.runId === runId,
        ),
        eventCount: record.eventCount,
        warningCount: record.warningCount,
        errorCount: record.errorCount,
        artifactCount: this.state.runArtifacts.filter(
          (artifact) => artifact.runId === runId,
        ).length,
        replayability: record.run.summary?.replayability ?? "R0",
        keyFindings: record.run.summary?.keyFindings,
      });
    record.updatedAt = record.run.endedAt;
    this.dirtyEventAppends = 0;
    this.persistMetadata();
    this.emit({ kind: "run", runId, ids: [runId] });
    return cloneJson(record.run);
  }

  recoverInterruptedRuns(emit = true): string[] {
    this.assertOpen();
    const now = new Date().toISOString();
    const recovered: string[] = [];
    for (const record of this.state.runs) {
      if (!INTERRUPTED_STATUSES.has(record.run.status)) continue;
      this.sealActiveSegment(record.run.id);
      for (const step of this.state.steps) {
        if (step.runId !== record.run.id) continue;
        if (
          step.status === "running"
          && !step.sideEffects.some((effect) => !effect.reversible)
        ) {
          const unknownEffect = interruptedStepEffect(step, record.run.target.adapterId);
          if (unknownEffect) step.sideEffects.push(unknownEffect);
        }
        if (step.status === "running" || step.status === "awaiting_approval") {
          step.status = "cancelled";
        }
      }
      record.run.status = "partial";
      record.run.endedAt = now;
      record.run.summary = {
        ...(record.run.summary ?? {
          outcome: "partial",
          completedSteps: this.state.steps.filter(
            (step) => step.runId === record.run.id && step.status === "succeeded",
          ).length,
          totalSteps: this.state.steps.filter((step) => step.runId === record.run.id).length,
          eventCount: record.eventCount,
          observationCount: this.state.observations.filter(
            (observation) => observation.runId === record.run.id,
          ).length,
          artifactCount: this.state.runArtifacts.filter(
            (artifact) => artifact.runId === record.run.id,
          ).length,
          warningCount: record.warningCount,
          errorCount: record.errorCount,
          replayability: "R0",
        }),
        outcome: "partial",
        keyFindings: [
          ...(record.run.summary?.keyFindings ?? []),
          "Recovered after the extension host stopped before finalization.",
        ],
      };
      record.updatedAt = now;
      recovered.push(record.run.id);
    }
    if (recovered.length > 0 && emit) {
      this.persistMetadata();
      this.emit({ kind: "recovery", ids: recovered });
    }
    return recovered;
  }

  pruneRuns(policy: RunRetentionPolicy): RunRetentionResult {
    this.assertOpen();
    const protectedRunIds = new Set(policy.protectedRunIds ?? []);
    const candidates = this.state.runs
      .filter((record) => {
        if (record.run.retentionClass === "pinned"
          || protectedRunIds.has(record.run.id)
          || !isTerminalRunStatus(record.run.status)) return false;
        const date = record.run.endedAt ?? record.updatedAt;
        if (record.run.retentionClass === "temporary") {
          return date < policy.temporaryOlderThan;
        }
        return policy.standardOlderThan !== undefined && date < policy.standardOlderThan;
      })
      .sort((left, right) => (
        (left.run.endedAt ?? left.updatedAt).localeCompare(right.run.endedAt ?? right.updatedAt)
      ));

    if (policy.maxRuns !== undefined) {
      const already = new Set(candidates.map((record) => record.run.id));
      const eligibleUnpinned = this.state.runs
        .filter((record) => record.run.retentionClass !== "pinned"
          && isTerminalRunStatus(record.run.status)
          && !protectedRunIds.has(record.run.id));
      const maximum = nonNegativeInteger(policy.maxRuns, eligibleUnpinned.length);
      const remainingAfterAgePruning = eligibleUnpinned
        .filter((record) => !already.has(record.run.id));
      const excess = Math.max(0, remainingAfterAgePruning.length - maximum);
      const oldestAdditional = remainingAfterAgePruning
        .sort((left, right) => (
          (left.run.endedAt ?? left.updatedAt).localeCompare(right.run.endedAt ?? right.updatedAt)
        ))
        .slice(0, excess);
      candidates.push(...oldestAdditional);
    }

    const deletedRunIds = [...new Set(candidates.map((record) => record.run.id))];
    const deleted = new Set(deletedRunIds);
    const previousState = this.state;
    const nextState: RunMetadataDocument = {
      ...previousState,
      runs: previousState.runs.filter((record) => !deleted.has(record.run.id)),
      steps: previousState.steps.filter((step) => !deleted.has(step.runId)),
      observations: previousState.observations.filter(
        (observation) => !deleted.has(observation.runId),
      ),
      runArtifacts: previousState.runArtifacts.filter(
        (artifact) => !deleted.has(artifact.runId),
      ),
      segments: previousState.segments.filter((segment) => !deleted.has(segment.runId)),
      entities: previousState.entities.filter((entity) => !deleted.has(entity.runId)),
      artifacts: previousState.artifacts,
    };

    const referencedArtifacts = new Set(nextState.runArtifacts.map((item) => item.id));
    const deletedArtifactIds: string[] = [];
    let freedArtifactBytes = 0;
    nextState.artifacts = previousState.artifacts.filter((artifact) => {
      if (referencedArtifacts.has(artifact.id)) return true;
      deletedArtifactIds.push(artifact.id);
      freedArtifactBytes += artifact.byteLength;
      return false;
    });

    if (deletedRunIds.length > 0 || deletedArtifactIds.length > 0) {
      // Commit reference removal before deleting trace/CAS data. A crash after
      // this point can leave harmless orphaned files, but never retained
      // metadata that deliberately points at evidence we already removed.
      this.state = nextState;
      try {
        this.persistMetadata();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
      for (const runId of deletedRunIds) this.removeTraceDirectory(runId);
      for (const artifactId of deletedArtifactIds) this.artifacts.remove(artifactId);
      this.emit({ kind: "retention", ids: deletedRunIds });
    }
    return { deletedRunIds, deletedArtifactIds, freedArtifactBytes };
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.initialized) {
      for (const record of this.state.runs) this.sealActiveSegment(record.run.id);
      this.persistMetadata();
    }
    this.driver?.close();
    this.driver = undefined;
    this.listeners.clear();
    this.disposed = true;
  }

  private appendEventsInternal(
    runId: string,
    inputs: RunEventInput[],
    flushAfterBatch: boolean,
  ): AppendResult {
    this.assertOpen();
    const record = this.requireRunRecord(runId);
    if (inputs.length === 0) return { events: [], sealedSegment: false };
    if (isTerminalRunStatus(record.run.status)) {
      throw new Error(`Cannot append events to finalized run ${runId}`);
    }
    const assigned: RunEvent[] = [];
    let sealedSegment = false;
    let inputOffset = 0;

    while (inputOffset < inputs.length) {
      let active = this.activeSegment(runId);
      if (!active) {
        active = this.createActiveSegment(runId, record.nextSequence);
      }
      const capacity = Math.max(1, this.maxEventsPerSegment - active.eventCount);
      const chunk = inputs.slice(inputOffset, inputOffset + capacity);
      const chunkEvents: RunEvent[] = [];
      for (const input of chunk) {
        if (
          !validSequence(record.nextSequence)
          || record.nextSequence >= Number.MAX_SAFE_INTEGER
        ) {
          throw new Error(`Run ${runId} exhausted safe integer sequence numbers`);
        }
        if (input.runId !== undefined && input.runId !== runId) {
          throw new Error(`Event run id ${input.runId} does not match ${runId}`);
        }
        if (!input.type.trim()) throw new Error("Run event type is required");
        const timestamp = nextMonotonicTimestamp(record.lastMonotonicTimestampNs);
        const event: RunEvent = {
          ...cloneJson(input),
          id: input.id ?? randomUUID(),
          runId,
          sequenceNumber: record.nextSequence,
          monotonicTimestampNs: timestamp,
          wallClockTimestamp: input.wallClockTimestamp ?? new Date().toISOString(),
          entityRefs: cloneJson(input.entityRefs),
          source: cloneJson(input.source),
        };
        // Validate serializability before assigning durable order.
        serializeEvent(event);
        record.nextSequence += 1;
        record.lastMonotonicTimestampNs = timestamp;
        record.eventCount += 1;
        if (event.severity === "warning") record.warningCount += 1;
        if (event.severity === "error" || event.severity === "fatal") record.errorCount += 1;
        chunkEvents.push(event);
      }

      const serialized = chunkEvents.map(serializeEvent).join("");
      const activePath = this.segmentPath(runId, active.fileName);
      fs.appendFileSync(activePath, serialized, "utf8");
      active.lastSequence = chunkEvents[chunkEvents.length - 1]?.sequenceNumber
        ?? active.lastSequence;
      active.firstMonotonicTimestampNs = active.eventCount === 0
        ? chunkEvents[0]?.monotonicTimestampNs ?? "0"
        : active.firstMonotonicTimestampNs;
      active.lastMonotonicTimestampNs = (
        chunkEvents[chunkEvents.length - 1]?.monotonicTimestampNs
        ?? active.lastMonotonicTimestampNs
      );
      active.eventCount += chunkEvents.length;
      const severityCounts = countEventSeverities(chunkEvents);
      active.warningCount += severityCounts.warningCount;
      active.errorCount += severityCounts.errorCount;
      active.uncompressedBytes += Buffer.byteLength(serialized);
      active.compressedBytes = active.uncompressedBytes;
      this.indexRunEntities(runId, chunkEvents.flatMap((event) => event.entityRefs));
      assigned.push(...chunkEvents);
      inputOffset += chunk.length;

      if (
        active.eventCount >= this.maxEventsPerSegment
        || active.uncompressedBytes >= this.maxUncompressedSegmentBytes
      ) {
        this.sealActiveSegment(runId);
        sealedSegment = true;
      }
    }

    record.updatedAt = new Date().toISOString();
    this.dirtyEventAppends += assigned.length;
    if (
      flushAfterBatch
      || sealedSegment
      || this.dirtyEventAppends >= EVENT_METADATA_FLUSH_INTERVAL
    ) {
      this.persistMetadata();
      this.dirtyEventAppends = 0;
    }
    this.emit({ kind: "event", runId, ids: assigned.map((event) => event.id) });
    return { events: assigned, sealedSegment };
  }

  private activeSegment(runId: string): EventSegmentInfo | undefined {
    return this.state.segments.find(
      (segment) => segment.runId === runId && segment.codec === "identity",
    );
  }

  private createActiveSegment(runId: string, firstSequence: number): EventSegmentInfo {
    const fileName = `events-${padSequence(firstSequence)}.open.jsonl`;
    const segment: EventSegmentInfo = {
      runId,
      firstSequence,
      lastSequence: firstSequence - 1,
      firstMonotonicTimestampNs: "0",
      lastMonotonicTimestampNs: "0",
      eventCount: 0,
      warningCount: 0,
      errorCount: 0,
      fileName,
      codec: "identity",
      compressedBytes: 0,
      uncompressedBytes: 0,
    };
    fs.mkdirSync(this.traceDirectory(runId), { recursive: true });
    fs.writeFileSync(this.segmentPath(runId, fileName), "", { flag: "wx" });
    this.state.segments.push(segment);
    return segment;
  }

  private sealActiveSegment(runId: string): boolean {
    const active = this.activeSegment(runId);
    if (!active) return false;
    const activePath = this.segmentPath(runId, active.fileName);
    if (active.eventCount === 0) {
      fs.rmSync(activePath, { force: true });
      this.state.segments = this.state.segments.filter((segment) => segment !== active);
      return false;
    }

    const raw = fs.readFileSync(activePath);
    const compressed = gzipSync(raw, { level: 6 });
    const fileName = (
      `events-${padSequence(active.firstSequence)}-${padSequence(active.lastSequence)}.jsonl.gz`
    );
    const destination = this.segmentPath(runId, fileName);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, compressed, { flag: "wx" });
    fs.renameSync(temporary, destination);
    fs.rmSync(activePath, { force: true });

    active.fileName = fileName;
    active.codec = "gzip";
    active.compressedBytes = compressed.byteLength;
    active.uncompressedBytes = raw.byteLength;
    return true;
  }

  private readSegment(segment: EventSegmentInfo): RunEvent[] {
    const segmentPath = this.segmentPath(segment.runId, segment.fileName);
    let text: string;
    try {
      const bytes = fs.readFileSync(segmentPath);
      text = segment.codec === "gzip"
        ? gunzipSync(bytes).toString("utf8")
        : bytes.toString("utf8");
    } catch (error) {
      throw new RunSegmentCorruptionError(
        segment.runId,
        segment.fileName,
        error instanceof Error ? error.message : String(error),
      );
    }
    return parseEventLines(segment.runId, segment.fileName, text, false).events;
  }

  private reconcileSegments(record: StoredRunRecord): boolean {
    const runId = record.run.id;
    const directory = this.traceDirectory(runId);
    fs.mkdirSync(directory, { recursive: true });
    this.cleanTemporarySegmentFiles(directory);
    const diskFiles = fs.readdirSync(directory);
    const previous = this.state.segments.filter((segment) => segment.runId === runId);
    const previousByFile = new Map(previous.map((segment) => [segment.fileName, segment]));
    const reconciled: EventSegmentInfo[] = [];
    let changed = false;
    let recoveredLastTimestamp = BigInt(record.lastMonotonicTimestampNs || "0");

    const sealedByFirst = new Map<number, EventSegmentInfo>();
    for (const fileName of diskFiles) {
      const sealedMatch = /^events-(\d{16})-(\d{16})\.jsonl\.gz$/.exec(fileName);
      if (!sealedMatch) continue;
      const firstSequence = Number(sealedMatch[1]);
      const lastSequence = Number(sealedMatch[2]);
      if (!validSequence(firstSequence) || !validSequence(lastSequence) || lastSequence < firstSequence) {
        throw new RunSegmentCorruptionError(runId, fileName, "invalid sequence range");
      }
      const existing = previousByFile.get(fileName);
      const stat = fs.statSync(this.segmentPath(runId, fileName));
      const segment: EventSegmentInfo = existing
        ? { ...existing, compressedBytes: stat.size }
        : {
          runId,
          firstSequence,
          lastSequence,
          firstMonotonicTimestampNs: "0",
          lastMonotonicTimestampNs: "0",
          eventCount: lastSequence - firstSequence + 1,
          warningCount: 0,
          errorCount: 0,
          fileName,
          codec: "gzip",
          compressedBytes: stat.size,
          uncompressedBytes: 0,
        };
      if (
        !existing
        || !isDecimalNanoseconds(existing.firstMonotonicTimestampNs)
        || !isDecimalNanoseconds(existing.lastMonotonicTimestampNs)
        || !validEventCount(existing.warningCount)
        || !validEventCount(existing.errorCount)
      ) {
        changed = true;
        const events = this.readSegment(segment);
        validateSegmentRange(segment, events);
        const firstTimestamp = events[0]?.monotonicTimestampNs;
        const lastTimestamp = events[events.length - 1]?.monotonicTimestampNs;
        if (!firstTimestamp || !lastTimestamp) {
          throw new RunSegmentCorruptionError(runId, fileName, "segment has no events");
        }
        segment.firstMonotonicTimestampNs = firstTimestamp;
        segment.lastMonotonicTimestampNs = lastTimestamp;
        recoveredLastTimestamp = maxBigInt(recoveredLastTimestamp, BigInt(lastTimestamp));
        segment.uncompressedBytes = Buffer.byteLength(events.map(serializeEvent).join(""));
        const severityCounts = countEventSeverities(events);
        segment.warningCount = severityCounts.warningCount;
        segment.errorCount = severityCounts.errorCount;
      }
      sealedByFirst.set(firstSequence, segment);
      reconciled.push(segment);
    }

    for (const fileName of diskFiles) {
      const activeMatch = /^events-(\d{16})\.open\.jsonl$/.exec(fileName);
      if (!activeMatch) continue;
      const firstSequence = Number(activeMatch[1]);
      const activePath = this.segmentPath(runId, fileName);
      const text = fs.readFileSync(activePath, "utf8");
      const parsed = parseEventLines(runId, fileName, text, true);
      if (parsed.truncated) {
        atomicWriteFile(activePath, parsed.events.map(serializeEvent).join(""));
        changed = true;
      }
      if (parsed.events.length === 0) {
        fs.rmSync(activePath, { force: true });
        changed = true;
        continue;
      }
      const lastEvent = parsed.events[parsed.events.length - 1];
      if (!lastEvent || lastEvent.sequenceNumber < firstSequence) {
        throw new RunSegmentCorruptionError(runId, fileName, "invalid active sequence range");
      }
      const sealed = sealedByFirst.get(firstSequence);
      if (sealed && lastEvent.sequenceNumber <= sealed.lastSequence) {
        fs.rmSync(activePath, { force: true });
        changed = true;
        continue;
      }
      if (sealed) {
        throw new RunSegmentCorruptionError(runId, fileName, "overlaps a sealed segment");
      }
      const bytes = Buffer.byteLength(parsed.events.map(serializeEvent).join(""));
      const segment: EventSegmentInfo = {
        runId,
        firstSequence,
        lastSequence: lastEvent.sequenceNumber,
        firstMonotonicTimestampNs: parsed.events[0]?.monotonicTimestampNs ?? "0",
        lastMonotonicTimestampNs: lastEvent.monotonicTimestampNs,
        eventCount: parsed.events.length,
        ...countEventSeverities(parsed.events),
        fileName,
        codec: "identity",
        compressedBytes: bytes,
        uncompressedBytes: bytes,
      };
      recoveredLastTimestamp = maxBigInt(
        recoveredLastTimestamp,
        BigInt(lastEvent.monotonicTimestampNs),
      );
      reconciled.push(segment);
      const existing = previousByFile.get(fileName);
      if (
        !existing
        || existing.lastSequence !== segment.lastSequence
        || existing.eventCount !== segment.eventCount
        || existing.warningCount !== segment.warningCount
        || existing.errorCount !== segment.errorCount
      ) changed = true;
    }

    reconciled.sort(compareSegments);
    const first = reconciled[0];
    if (first && first.firstSequence !== 1) {
      throw new RunSegmentCorruptionError(
        runId,
        first.fileName,
        `missing initial event range before sequence ${first.firstSequence}`,
      );
    }
    for (let index = 1; index < reconciled.length; index += 1) {
      const prior = reconciled[index - 1];
      const current = reconciled[index];
      if (prior && current && current.firstSequence <= prior.lastSequence) {
        throw new RunSegmentCorruptionError(runId, current.fileName, "overlapping segment range");
      }
      if (prior && current && current.firstSequence !== prior.lastSequence + 1) {
        throw new RunSegmentCorruptionError(
          runId,
          current.fileName,
          `missing event range after sequence ${prior.lastSequence}`,
        );
      }
    }
    if (previous.length !== reconciled.length) changed = true;
    this.state.segments = [
      ...this.state.segments.filter((segment) => segment.runId !== runId),
      ...reconciled,
    ];
    const lastSequence = reconciled[reconciled.length - 1]?.lastSequence ?? 0;
    const eventCount = reconciled.reduce((total, segment) => total + segment.eventCount, 0);
    const warningCount = reconciled.reduce((total, segment) => total + segment.warningCount, 0);
    const errorCount = reconciled.reduce((total, segment) => total + segment.errorCount, 0);
    if (
      record.nextSequence !== lastSequence + 1
      || record.eventCount !== eventCount
      || record.warningCount !== warningCount
      || record.errorCount !== errorCount
    ) changed = true;
    record.nextSequence = lastSequence + 1;
    record.eventCount = eventCount;
    record.warningCount = warningCount;
    record.errorCount = errorCount;
    record.lastMonotonicTimestampNs = recoveredLastTimestamp.toString();
    return changed;
  }

  private cleanTemporarySegmentFiles(directory: string): void {
    for (const fileName of fs.readdirSync(directory)) {
      if (!fileName.startsWith("events-") || !fileName.endsWith(".tmp")) continue;
      fs.rmSync(path.join(directory, fileName), { force: true });
    }
  }

  private tryOpenSqlite(): void {
    try {
      this.driver = openSqlDriver(this.indexPath);
      this.driver.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          retention_class TEXT NOT NULL,
          plan_id TEXT,
          phase_id TEXT,
          parent_run_id TEXT,
          started_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_sequence INTEGER NOT NULL,
          last_monotonic_ns TEXT NOT NULL,
          event_count INTEGER NOT NULL,
          warning_count INTEGER NOT NULL,
          error_count INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS runs_plan_idx ON runs(plan_id, phase_id);
        CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs(parent_run_id);
        CREATE TABLE IF NOT EXISTS run_steps (
          run_id TEXT NOT NULL,
          id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY(run_id, id)
        );
        CREATE INDEX IF NOT EXISTS run_steps_run_idx ON run_steps(run_id, ordinal);
        CREATE TABLE IF NOT EXISTS run_observations (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          sequence_number INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_observations_run_idx
          ON run_observations(run_id, sequence_number);
        CREATE TABLE IF NOT EXISTS run_artifacts (
          id TEXT PRIMARY KEY,
          byte_length INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_artifact_refs (
          ref_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_artifact_refs_run_idx ON run_artifact_refs(run_id);
        CREATE TABLE IF NOT EXISTS run_event_segments (
          run_id TEXT NOT NULL,
          first_sequence INTEGER NOT NULL,
          last_sequence INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          codec TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY(run_id, first_sequence)
        );
        CREATE INDEX IF NOT EXISTS run_event_segments_window_idx
          ON run_event_segments(run_id, first_sequence, last_sequence);
        CREATE TABLE IF NOT EXISTS run_entities (
          ref_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          scheme TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          workspace_path TEXT,
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_entities_file_idx
          ON run_entities(workspace_path, run_id);
        CREATE INDEX IF NOT EXISTS run_entities_identity_idx
          ON run_entities(scheme, entity_id, run_id);
        CREATE TABLE IF NOT EXISTS run_tickets (
          run_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          PRIMARY KEY(run_id, ticket_id)
        );
        CREATE INDEX IF NOT EXISTS run_tickets_ticket_idx ON run_tickets(ticket_id, run_id);
      `);
      this.migrateRunStepsPrimaryKey();
      if (this.driver.pragma("user_version") < SQLITE_SCHEMA_VERSION) {
        this.driver.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      }
    } catch {
      try {
        this.driver?.close();
      } catch {
        // JSON fallback remains usable.
      }
      this.driver = undefined;
    }
  }

  /**
   * Schema v1 keyed steps by `id` alone, even though semantic step IDs are only
   * unique within a run. Rebuild the table transactionally so an existing index
   * remains readable and two runs can retain the same stable step ID.
   */
  private migrateRunStepsPrimaryKey(): void {
    const driver = this.driver;
    if (!driver) return;
    const primaryKeyColumns = driver
      .all("PRAGMA table_info(run_steps)")
      .filter((row) => Number(row["pk"] ?? 0) > 0)
      .sort((left, right) => Number(left["pk"] ?? 0) - Number(right["pk"] ?? 0))
      .map((row) => String(row["name"] ?? ""));
    if (
      primaryKeyColumns.length === 2
      && primaryKeyColumns[0] === "run_id"
      && primaryKeyColumns[1] === "id"
    ) return;

    driver.transaction(() => {
      driver.exec(`
        DROP TABLE IF EXISTS run_steps_v2;
        CREATE TABLE run_steps_v2 (
          run_id TEXT NOT NULL,
          id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL,
          data_json TEXT NOT NULL,
          PRIMARY KEY(run_id, id)
        );
        INSERT INTO run_steps_v2 (run_id, id, ordinal, status, data_json)
          SELECT run_id, id, ordinal, status, data_json FROM run_steps;
        DROP TABLE run_steps;
        ALTER TABLE run_steps_v2 RENAME TO run_steps;
        CREATE INDEX run_steps_run_idx ON run_steps(run_id, ordinal);
      `);
    });
  }

  private readSqliteState(): RunMetadataDocument | undefined {
    const driver = this.driver;
    if (!driver) return undefined;
    const runRows = driver.all("SELECT * FROM runs");
    if (runRows.length === 0) return undefined;
    const state = emptyMetadata();
    for (const row of runRows) {
      state.runs.push({
        run: parseJsonColumn<ExecutionRun>(row.data_json, "runs.data_json"),
        createdAt: sqlString(row.created_at),
        updatedAt: sqlString(row.updated_at),
        nextSequence: sqlNumber(row.next_sequence),
        lastMonotonicTimestampNs: sqlString(row.last_monotonic_ns),
        eventCount: sqlNumber(row.event_count),
        warningCount: sqlNumber(row.warning_count),
        errorCount: sqlNumber(row.error_count),
      });
    }
    state.steps = driver.all("SELECT data_json FROM run_steps")
      .map((row) => parseJsonColumn<RunStep>(row.data_json, "run_steps.data_json"));
    state.observations = driver.all("SELECT data_json FROM run_observations")
      .map((row) => parseJsonColumn<ObservationBundle>(
        row.data_json,
        "run_observations.data_json",
      ));
    state.artifacts = driver.all("SELECT data_json FROM run_artifacts")
      .map((row) => parseJsonColumn<RunArtifact>(row.data_json, "run_artifacts.data_json"));
    state.runArtifacts = driver.all("SELECT data_json FROM run_artifact_refs")
      .map((row) => parseJsonColumn<StoredRunArtifact>(
        row.data_json,
        "run_artifact_refs.data_json",
      ));
    state.segments = driver.all("SELECT data_json FROM run_event_segments")
      .map((row) => parseJsonColumn<EventSegmentInfo>(
        row.data_json,
        "run_event_segments.data_json",
      ));
    state.entities = driver.all("SELECT run_id, data_json FROM run_entities")
      .map((row) => ({
        runId: sqlString(row.run_id),
        ref: parseJsonColumn<EntityRef>(row.data_json, "run_entities.data_json"),
      }));
    return state;
  }

  private persistMetadata(): void {
    if (!this.initialized || this.disposed) return;
    atomicWriteJson(this.fallbackIndexPath, this.state);
    if (this.driver) this.persistSqlite();
  }

  private persistSqlite(): void {
    const driver = this.driver;
    if (!driver) return;
    driver.transaction(() => {
      driver.exec(`
        DELETE FROM run_tickets;
        DELETE FROM run_entities;
        DELETE FROM run_event_segments;
        DELETE FROM run_artifact_refs;
        DELETE FROM run_artifacts;
        DELETE FROM run_observations;
        DELETE FROM run_steps;
        DELETE FROM runs;
      `);
      for (const record of this.state.runs) {
        const run = record.run;
        driver.run(
          `INSERT INTO runs (
            id, status, retention_class, plan_id, phase_id, parent_run_id,
            started_at, created_at, updated_at, next_sequence, last_monotonic_ns,
            event_count, warning_count, error_count, data_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            run.id,
            run.status,
            run.retentionClass,
            run.planId ?? null,
            run.phaseId ?? null,
            run.parentRunId ?? null,
            run.startedAt ?? null,
            record.createdAt,
            record.updatedAt,
            record.nextSequence,
            record.lastMonotonicTimestampNs,
            record.eventCount,
            record.warningCount,
            record.errorCount,
            JSON.stringify(run),
          ],
        );
        for (const ticketId of run.ticketIds) {
          driver.run(
            "INSERT INTO run_tickets (run_id, ticket_id) VALUES (?, ?)",
            [run.id, ticketId],
          );
        }
      }
      for (const step of this.state.steps) {
        driver.run(
          `INSERT INTO run_steps (id, run_id, ordinal, status, data_json)
           VALUES (?, ?, ?, ?, ?)`,
          [step.id, step.runId, step.ordinal, step.status, JSON.stringify(step)],
        );
      }
      for (const observation of this.state.observations) {
        driver.run(
          `INSERT INTO run_observations (id, run_id, sequence_number, data_json)
           VALUES (?, ?, ?, ?)`,
          [
            observation.id,
            observation.runId,
            observation.cursor.sequenceNumber,
            JSON.stringify(observation),
          ],
        );
      }
      for (const artifact of this.state.artifacts) {
        driver.run(
          "INSERT INTO run_artifacts (id, byte_length, data_json) VALUES (?, ?, ?)",
          [artifact.id, artifact.byteLength, JSON.stringify(artifact)],
        );
      }
      for (const artifact of this.state.runArtifacts) {
        driver.run(
          `INSERT INTO run_artifact_refs (ref_key, run_id, artifact_id, data_json)
           VALUES (?, ?, ?, ?)`,
          [
            runArtifactKey(artifact),
            artifact.runId,
            artifact.id,
            JSON.stringify(artifact),
          ],
        );
      }
      for (const segment of this.state.segments) {
        driver.run(
          `INSERT INTO run_event_segments (
            run_id, first_sequence, last_sequence, file_name, codec, data_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            segment.runId,
            segment.firstSequence,
            segment.lastSequence,
            segment.fileName,
            segment.codec,
            JSON.stringify(segment),
          ],
        );
      }
      for (const entity of this.state.entities) {
        driver.run(
          `INSERT INTO run_entities (
            ref_key, run_id, scheme, entity_id, workspace_path, data_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            entityRefKey(entity.runId, entity.ref),
            entity.runId,
            entity.ref.scheme,
            entity.ref.id,
            entity.ref.workspacePath ?? null,
            JSON.stringify(entity.ref),
          ],
        );
      }
    });
  }

  private findRunRecord(runId: string): StoredRunRecord | undefined {
    return this.state.runs.find((record) => record.run.id === runId);
  }

  private requireRunRecord(runId: string): StoredRunRecord {
    const record = this.findRunRecord(runId);
    if (!record) throw new Error(`Execution run not found: ${runId}`);
    return record;
  }

  private indexRunEntities(runId: string, refs: EntityRef[]): void {
    const existing = new Set(
      this.state.entities
        .filter((item) => item.runId === runId)
        .map((item) => entityRefKey(runId, item.ref)),
    );
    for (const ref of refs) {
      if (!ref.id || !ref.scheme) continue;
      const normalized = cloneJson(ref);
      if (normalized.workspacePath) {
        normalized.workspacePath = normalizeWorkspacePath(normalized.workspacePath);
      }
      const key = entityRefKey(runId, normalized);
      if (existing.has(key)) continue;
      existing.add(key);
      this.state.entities.push({ runId, ref: normalized });
    }
  }

  private replaceTargetEntities(runId: string, refs: EntityRef[]): void {
    // Event/step/observation refs remain durable; adding current target refs is
    // sufficient for search even if a target was revised.
    this.indexRunEntities(runId, refs);
  }

  private entityRefsForRun(runId: string): EntityRef[] {
    return this.state.entities
      .filter((item) => item.runId === runId)
      .map((item) => item.ref);
  }

  private traceDirectory(runId: string): string {
    const digest = createHash("sha256").update(runId).digest("hex").slice(0, 32);
    return path.join(this.tracesPath, `run-${digest}`);
  }

  private segmentPath(runId: string, fileName: string): string {
    if (path.basename(fileName) !== fileName || !fileName.startsWith("events-")) {
      throw new Error(`Invalid event segment file name: ${fileName}`);
    }
    return path.join(this.traceDirectory(runId), fileName);
  }

  private writeRunManifest(runId: string): void {
    const directory = this.traceDirectory(runId);
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteJson(path.join(directory, "manifest.json"), { runId });
  }

  private removeTraceDirectory(runId: string): void {
    const target = path.resolve(this.traceDirectory(runId));
    const root = path.resolve(this.tracesPath);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to remove trace path outside run storage: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  private assertOpen(): void {
    if (!this.initialized) this.ensureInitialized();
    if (this.disposed) throw new Error("RunStore has been disposed");
  }

  private emit(event: RunStoreChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A UI listener must not make a durable store mutation fail.
      }
    }
  }
}

const SURFACE_SCHEMES = new Set([
  "route",
  "ui-component",
  "dom-node",
  "scene",
  "scene-object",
  "test",
]);

function emptyMetadata(): RunMetadataDocument {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    runs: [],
    steps: [],
    observations: [],
    artifacts: [],
    runArtifacts: [],
    segments: [],
    entities: [],
  };
}

function normalizeMetadata(value: RunMetadataDocument): RunMetadataDocument {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    runs: Array.isArray(value.runs) ? value.runs : [],
    steps: Array.isArray(value.steps) ? value.steps : [],
    observations: Array.isArray(value.observations) ? value.observations : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    runArtifacts: Array.isArray(value.runArtifacts) ? value.runArtifacts : [],
    segments: Array.isArray(value.segments) ? value.segments : [],
    entities: Array.isArray(value.entities) ? value.entities : [],
  };
}

function readMetadataFile(filePath: string): RunMetadataDocument | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as RunMetadataDocument;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteFile(filePath, `${JSON.stringify(value)}\n`);
}

function atomicWriteFile(filePath: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { flag: "wx" });
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      // The new complete temporary file is still safe to promote.
    }
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the rename failure.
    }
    throw error;
  }
}

function parseEventLines(
  runId: string,
  fileName: string,
  text: string,
  allowTruncatedTail: boolean,
): { events: RunEvent[]; truncated: boolean } {
  const lines = text.split("\n");
  const events: RunEvent[] = [];
  let truncated = false;
  let expectedSequence: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let event: RunEvent;
    try {
      event = JSON.parse(line) as RunEvent;
    } catch (error) {
      const isTail = lines.slice(index + 1).every((remaining) => remaining.length === 0);
      if (allowTruncatedTail && isTail) {
        truncated = true;
        break;
      }
      throw new RunSegmentCorruptionError(
        runId,
        fileName,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      event.runId !== runId
      || !validSequence(event.sequenceNumber)
      || typeof event.monotonicTimestampNs !== "string"
      || !/^\d+$/.test(event.monotonicTimestampNs)
    ) {
      throw new RunSegmentCorruptionError(runId, fileName, "invalid event envelope");
    }
    if (expectedSequence !== undefined && event.sequenceNumber !== expectedSequence) {
      throw new RunSegmentCorruptionError(runId, fileName, "non-contiguous sequence numbers");
    }
    expectedSequence = event.sequenceNumber + 1;
    events.push(event);
  }
  return { events, truncated };
}

function validateSegmentRange(segment: EventSegmentInfo, events: RunEvent[]): void {
  const first = events[0]?.sequenceNumber;
  const last = events[events.length - 1]?.sequenceNumber;
  if (
    events.length !== segment.eventCount
    || first !== segment.firstSequence
    || last !== segment.lastSequence
  ) {
    throw new RunSegmentCorruptionError(
      segment.runId,
      segment.fileName,
      "file contents do not match the encoded sequence range",
    );
  }
}

function serializeEvent(event: RunEvent): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(event);
  } catch (error) {
    throw new Error(
      `Run event ${event.id} is not JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (json === undefined) throw new Error(`Run event ${event.id} is not JSON serializable`);
  return `${json}\n`;
}

function nextMonotonicTimestamp(previous: string): string {
  const prior = /^\d+$/.test(previous) ? BigInt(previous) : 0n;
  const current = process.hrtime.bigint();
  return (current > prior ? current : prior + 1n).toString();
}

function decimalNanoseconds(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  if (!isDecimalNanoseconds(value)) {
    throw new Error(`Invalid decimal nanosecond timestamp: ${value}`);
  }
  return BigInt(value);
}

function isDecimalNanoseconds(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function targetEntityRefs(run: ExecutionRun): EntityRef[] {
  const refs: EntityRef[] = [];
  if (run.target.workspacePath) {
    refs.push({
      scheme: "workspace-file",
      id: normalizeWorkspacePath(run.target.workspacePath),
      workspacePath: normalizeWorkspacePath(run.target.workspacePath),
      label: run.target.label,
    });
  }
  if (run.target.id) {
    refs.push({
      scheme: targetScheme(run.target.type),
      id: run.target.id,
      label: run.target.label,
      workspacePath: run.target.workspacePath
        ? normalizeWorkspacePath(run.target.workspacePath)
        : undefined,
    });
  }
  return refs;
}

function targetScheme(type: string): EntityRef["scheme"] {
  if (type.includes("route") || type.includes("browser")) return "route";
  if (type.includes("scene")) return "scene";
  if (type.includes("test")) return "test";
  if (type.includes("process")) return "process";
  return "ui-component";
}

function runSearchText(run: ExecutionRun, refs: EntityRef[]): string {
  return [
    run.id,
    run.title ?? "",
    run.sequenceId,
    run.branchName ?? "",
    run.planId ?? "",
    run.phaseId ?? "",
    ...run.ticketIds,
    ...run.adapterIds,
    JSON.stringify(run.target),
    JSON.stringify(run.summary ?? {}),
    ...refs.flatMap((ref) => [
      ref.id,
      ref.workspacePath ?? "",
      ref.label ?? "",
      JSON.stringify(ref.metadata ?? {}),
    ]),
  ].join("\n").toLocaleLowerCase();
}

function splitSearchTerms(query: string | undefined): string[] {
  return (query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function validateRun(run: ExecutionRun): void {
  if (!run.id.trim()) throw new Error("Execution run id is required");
  if (!run.sequenceId.trim()) throw new Error("Sequence id is required");
  if (!Number.isSafeInteger(run.sequenceVersion) || run.sequenceVersion < 1) {
    throw new Error("Sequence version must be a positive safe integer");
  }
  if (!run.target?.adapterId || !run.target.type) {
    throw new Error("Execution run target requires adapterId and type");
  }
  if (!Array.isArray(run.adapterIds) || !Array.isArray(run.ticketIds)) {
    throw new Error("Execution run adapterIds and ticketIds must be arrays");
  }
}

function validateStep(runId: string, step: RunStep): void {
  if (step.runId !== runId) throw new Error(`Step ${step.id} belongs to ${step.runId}, not ${runId}`);
  if (!step.id.trim()) throw new Error("Run step id is required");
  if (!Number.isSafeInteger(step.ordinal) || step.ordinal < 0) {
    throw new Error(`Run step ${step.id} has an invalid ordinal`);
  }
}

function validateObservation(observation: ObservationBundle): void {
  if (!observation.id.trim()) throw new Error("Observation id is required");
  if (!validSequence(observation.cursor.sequenceNumber)) {
    throw new Error(`Observation ${observation.id} has an invalid cursor`);
  }
  if (
    !validSequence(observation.eventRange.firstSequenceNumber)
    || !validSequence(observation.eventRange.lastSequenceNumber)
    || observation.eventRange.lastSequenceNumber < observation.eventRange.firstSequenceNumber
  ) {
    throw new Error(`Observation ${observation.id} has an invalid event range`);
  }
}

function compareSteps(left: RunStep, right: RunStep): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function compareSegments(left: EventSegmentInfo, right: EventSegmentInfo): number {
  return left.firstSequence - right.firstSequence;
}

function interruptedStepEffect(
  step: RunStep,
  fallbackAdapterId: string,
): SideEffectRecord | undefined {
  const adapterId = step.declaredAction.adapterId ?? fallbackAdapterId;
  const action = step.declaredAction.type;
  const knownReadOnly = (
    (adapterId === "workspace"
      && ["read_file", "list_directory", "glob", "search_files"].includes(action))
    || (adapterId === "test" && action === "detect")
    || (adapterId === "browser"
      && ["navigate", "wait", "screenshot", "get_text"].includes(action))
  );
  if (knownReadOnly) return undefined;
  const effectClass: SideEffectRecord["class"] = adapterId === "process" || adapterId === "test"
    ? "process"
    : adapterId === "browser"
      ? "network_write"
      : "destructive";
  return {
    id: `effect-recovered-${randomUUID()}`,
    class: effectClass,
    description: `${adapterId}:${action} may have completed before the extension host stopped`,
    entityRefs: cloneJson(step.targetEntityRefs),
    reversible: false,
    metadata: {
      outcome: "unknown",
      recoveredAfterHostInterruption: true,
    },
  };
}

function entityRefKey(runId: string, ref: EntityRef): string {
  return [
    runId,
    ref.scheme,
    ref.id,
    ref.workspacePath ?? "",
  ].join("\u0000");
}

function runArtifactKey(artifact: StoredRunArtifact): string {
  return [
    artifact.runId,
    artifact.id,
    artifact.role ?? "",
    artifact.stepId ?? "",
    artifact.observationId ?? "",
    artifact.kind ?? "",
    artifact.mediaType ?? "",
    artifact.fileName ?? "",
    artifact.metadata ? JSON.stringify(artifact.metadata) : "",
  ].join("\u0000");
}

function normalizeWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function normalizeSha256(value: string): string {
  const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error(`Invalid artifact id: ${value}`);
  return normalized.toLowerCase();
}

function padSequence(value: number): string {
  if (!validSequence(value)) throw new Error(`Invalid event sequence number: ${value}`);
  return value.toString().padStart(16, "0");
}

function validSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validEventCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countEventSeverities(
  events: readonly RunEvent[],
): { warningCount: number; errorCount: number } {
  let warningCount = 0;
  let errorCount = 0;
  for (const event of events) {
    if (event.severity === "warning") warningCount += 1;
    if (event.severity === "error" || event.severity === "fatal") errorCount += 1;
  }
  return { warningCount, errorCount };
}

function validSequenceBoundary(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!validSequence(value)) throw new Error(`Invalid event sequence boundary: ${value}`);
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value as number : fallback;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value as number));
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseJsonColumn<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return JSON.parse(value) as T;
}

function sqlString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected SQLite text value");
  return value;
}

function sqlNumber(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("Expected SQLite numeric value");
  }
  return Number(value);
}
