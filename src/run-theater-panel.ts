/* A single execution run as an editor tab: watch it happen, then scrub back through it.

   Distinct from the sidebar Run Explorer rather than a wider version of it. The sidebar browses
   every run and swaps its whole state when you pick a different one; this follows exactly one run
   and appends to what it already holds. Bolting append semantics onto the sidebar's store is
   where that shipped surface would have regressed, so the two share their domain layer
   (apps/runs/view-model.ts, the protocol's domain types) and nothing else.

   The economics that shape this file: RunStore.emit runs synchronously inside the sequence
   execution loop, so anything done on arrival is on the critical path of the run itself. _ingest
   therefore only filters, buffers, and arms a timer — no store reads, no serialization. The
   records it needs already arrive on the change event (see RunStoreChangeEvent). */

import * as path from "node:path";
import * as vscode from "vscode";
import type { ExecutionRun, ObservationBundle, RunEvent, RunStep, StoredRunArtifact } from "./runs/run-model.js";
import type { RunStore, RunStoreChangeEvent, RunWatermark } from "./runs/run-store.js";
import { buildInspectionReport } from "./runs/run-inspection.js";
import { isTerminalRunStatus } from "./runs/run-model.js";
import type { SequenceService } from "./sequences/sequence-service.js";
import type { RunFocusCoordinator } from "./runs/run-focus-coordinator.js";
import { renderWebviewHtml } from "./webview-html.js";

/** ~10fps. Reads as live to a human and bounds postMessage traffic; matches the graph provider's
 *  trace flush so the two live surfaces behave the same way under load. */
const FLUSH_MS = 100;

/**
 * Ceiling on events in one delta.
 *
 * `recordBrowserTelemetry` slices at 5000 and calls `appendEvents` once, so a single emit really
 * can carry thousands. Past this the newest are kept and `droppedBefore` tells the webview it is
 * no longer contiguous, which is honest and cheap — where posting the whole burst would stall the
 * tab exactly when the run is most active.
 */
const MAX_DELTA_EVENTS = 400;

/** Events sent with the initial attach. Enough to give the timeline immediate shape without
 *  paying for the whole trace on open. */
const ATTACH_EVENT_TAIL = 300;

/** Ceiling on the trace scan behind the inspection report. Runs once per terminal transition, not
 *  per event, but a pathological run should still not read an unbounded number of segments. */
const INSPECTION_EVENT_LIMIT = 20_000;

interface PendingDelta {
  events: RunEvent[];
  steps: Map<string, RunStep>;
  observations: Map<string, ObservationBundle>;
  artifacts: Map<string, StoredRunArtifact>;
  run?: ExecutionRun;
  watermark?: RunWatermark;
}

export interface RunTheaterCallbacks {
  askAgent?: (reference: { text: string; label: string }) => void;
  focus?: RunFocusCoordinator;
  openMap?: (target: { runId: string; sequenceNumber?: number }) => void | Promise<void>;
  fileAnomaly?: (target: { run: ExecutionRun; event?: RunEvent; observation?: ObservationBundle }) => void | Promise<void>;
}

function emptyPending(): PendingDelta {
  return { events: [], steps: new Map(), observations: new Map(), artifacts: new Map() };
}

export class RunTheaterPanel implements vscode.Disposable {
  private _panel?: vscode.WebviewPanel;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private _runId?: string;
  /** Bumped on every attach. A delta stamped with an older generation is discarded by the
   *  webview, which is what keeps an in-flight flush from landing after a resync. */
  private _generation = 0;
  private _pending: PendingDelta = emptyPending();
  private _flushTimer?: ReturnType<typeof setTimeout>;
  /** A change arrived while the tab was hidden, so the buffer is no longer contiguous and the
   *  next reveal must re-attach rather than resume. */
  private _staleWhileHidden = false;
  private _disposed = false;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: RunStore,
    private readonly _sequences: SequenceService,
    private readonly _callbacks: RunTheaterCallbacks = {},
  ) {
    this._subscriptions.push(this._store.onDidChange((change) => this._ingest(change)));
    if (this._callbacks.focus) {
      this._subscriptions.push(this._callbacks.focus.onDidChange((focus) => {
        if (focus.runId === this._runId) void this._panel?.webview.postMessage({ type: "theater_agent_focus", focus });
      }));
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._clearFlush();
    this._panel?.dispose();
    for (const subscription of this._subscriptions) subscription.dispose();
    this._subscriptions.length = 0;
  }

  /** Open (or focus) the theater on a run. Defaults to the most recent run, so the command is
   *  useful without the caller knowing an id. */
  open(runId?: string): void {
    const target = runId ?? this._store.listRuns({ limit: 1 }).runs[0]?.id;
    if (!target) {
      void vscode.window.showInformationMessage(
        "No execution runs recorded yet. Runs are produced by the agent's sequence tools.",
      );
      return;
    }

    if (this._panel) {
      this._panel.reveal(this._panel.viewColumn, false);
      this._attach(target);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "blacksite.runs.theater",
      "Blacksite: Run",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._context.extensionUri, "out"),
          // Screenshots live in the content-addressed run artifact store, outside `out`.
          vscode.Uri.file(path.join(this._store.workspaceRoot, ".blacksite", "runs", "artifacts")),
        ],
      },
    );
    this._panel = panel;
    panel.webview.html = renderWebviewHtml(panel.webview, this._context.extensionUri, "run-theater.js");

    const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
      void this._onMessage(message);
    });
    const viewState = panel.onDidChangeViewState((changed) => {
      // Deltas are dropped while hidden rather than queued, so a reveal must re-attach from a
      // known baseline instead of resuming a buffer with a hole in it.
      if (changed.webviewPanel.visible && this._staleWhileHidden && this._runId) {
        this._attach(this._runId);
      }
    });
    panel.onDidDispose(() => {
      receive.dispose();
      viewState.dispose();
      this._clearFlush();
      this._panel = undefined;
      this._runId = undefined;
      this._pending = emptyPending();
    });

    this._attach(target);
  }

  /** Whether the theater is currently following this run — lets the sidebar show an active state
   *  on its "open in editor" affordance. */
  isFollowing(runId: string): boolean {
    return this._panel !== undefined && this._runId === runId;
  }

  setAnomalyTicketFiler(filer: RunTheaterCallbacks["fileAnomaly"]): void {
    this._callbacks.fileAnomaly = filer;
  }

  // ── live path ────────────────────────────────────────────────────────────────

  /**
   * Runs inside the store mutation, inside the run's own execution loop. Filter, buffer, arm a
   * timer — nothing else belongs here.
   */
  private _ingest(change: RunStoreChangeEvent): void {
    if (this._disposed || !this._panel || !this._runId) return;
    if (change.runId !== this._runId) return;
    if (!this._panel.visible) { this._staleWhileHidden = true; return; }

    if (change.events?.length) this._pending.events.push(...change.events);
    for (const step of change.steps ?? []) this._pending.steps.set(step.id, step);
    for (const observation of change.observations ?? []) this._pending.observations.set(observation.id, observation);
    for (const artifact of change.artifacts ?? []) this._pending.artifacts.set(artifact.id, artifact);
    if (change.run) this._pending.run = change.run;
    if (change.watermark) this._pending.watermark = change.watermark;

    if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);

    // A settled run is the moment the question changes from "what is happening" to "what did
    // this do". Building the report reads the store, so it is deferred out of _ingest — which
    // runs inside the run's own execution loop — rather than done here.
    if (change.run && isTerminalRunStatus(change.run.status)) {
      setTimeout(() => this._postInspection(), FLUSH_MS + 1);
    }
    if (change.kind === "annotation") {
      setTimeout(() => this._postAnnotations(), 0);
    }
  }

  private _flush(): void {
    this._flushTimer = undefined;
    if (this._disposed || !this._panel || !this._runId) return;

    const pending = this._pending;
    this._pending = emptyPending();

    let events = pending.events;
    let droppedBefore: number | undefined;
    if (events.length > MAX_DELTA_EVENTS) {
      const kept = events.slice(-MAX_DELTA_EVENTS);
      droppedBefore = kept[0]?.sequenceNumber;
      events = kept;
    }

    const observations = [...pending.observations.values()];
    const artifacts = [...pending.artifacts.values()];

    void this._panel.webview.postMessage({
      type: "theater_delta",
      runId: this._runId,
      generation: this._generation,
      events,
      ...(droppedBefore !== undefined ? { droppedBefore } : {}),
      ...(pending.steps.size ? { steps: [...pending.steps.values()] } : {}),
      ...(observations.length ? { observations } : {}),
      ...(artifacts.length ? { artifacts: this._withUrls(artifacts) } : {}),
      ...(pending.run ? { run: pending.run } : {}),
      ...(pending.watermark ? { watermark: pending.watermark } : {}),
    });
  }

  private _clearFlush(): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = undefined; }
    this._pending = emptyPending();
  }

  // ── attach / resync ──────────────────────────────────────────────────────────

  /**
   * Send a complete baseline for a run and start following it. This is the one path allowed to
   * read from the store, and it is bounded: everything after it is incremental.
   */
  private _attach(runId: string): void {
    const panel = this._panel;
    if (!panel || this._disposed) return;

    try {
      const run = this._store.getRun(runId);
      if (!run) { this._postError(`Run not found: ${runId}`); return; }

      this._runId = runId;
      this._generation += 1;
      this._staleWhileHidden = false;
      this._clearFlush();

      panel.title = `Blacksite: ${run.title?.trim() || runId.slice(0, 12)}`;

      const overview = this._store.getTraceOverview(runId);
      const totalEvents = overview.eventCount;
      const from = Math.max(1, totalEvents - ATTACH_EVENT_TAIL + 1);
      const events = totalEvents > 0
        ? this._store.readEvents(runId, { fromSequence: from, toSequence: totalEvents, limit: ATTACH_EVENT_TAIL })
        : [];

      void panel.webview.postMessage({
        type: "theater_attach",
        runId,
        generation: this._generation,
        run,
        steps: this._store.getSteps(runId),
        observations: this._store.listObservations(runId),
        artifacts: this._withUrls(this._store.listArtifacts(runId)),
        overview,
        annotations: this._store.listAnnotations(runId),
        events,
        totalEvents,
        watermark: {
          lastSequenceNumber: overview.lastSequence,
          eventCount: totalEvents,
          warningCount: overview.warningCount,
          errorCount: overview.errorCount,
        },
      });
      const focus = this._callbacks.focus?.get(runId);
      if (focus) void panel.webview.postMessage({ type: "theater_agent_focus", focus });
    } catch (error) {
      this._postError(error instanceof Error ? error.message : String(error));
    }
  }

  private async _onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    const type = String(message["type"] ?? "");

    try {
      switch (type) {
        case "theater_ready":
        case "theater_resync":
          if (this._runId) this._attach(this._runId);
          return;
        case "theater_select_run": {
          const runId = String(message["runId"] ?? "");
          if (runId) this._attach(runId);
          return;
        }
        case "theater_window": {
          this._postWindow(String(message["runId"] ?? ""), message["from"], message["to"]);
          return;
        }
        case "theater_seek": {
          this._postSeek(
            String(message["runId"] ?? ""),
            message["sequenceNumber"],
            message["monotonicTimestampNs"],
          );
          return;
        }
        case "theater_ask_agent": {
          const runId = String(message["runId"] ?? "");
          if (!runId || runId !== this._runId) return;
          const sequenceNumber = Math.max(1, Math.trunc(Number(message["sequenceNumber"] ?? 1)));
          const eventId = typeof message["eventId"] === "string" ? message["eventId"] : undefined;
          const observationId = typeof message["observationId"] === "string" ? message["observationId"] : undefined;
          const compact = [
            `Run ${runId}`,
            `sequence ${sequenceNumber}`,
            eventId ? `event ${eventId}` : undefined,
            observationId ? `observation ${observationId}` : undefined,
          ].filter(Boolean).join(", ");
          this._callbacks.askAgent?.({
            label: `Execution evidence · ${runId.slice(0, 8)} @ ${sequenceNumber}`,
            text: `Please examine this retained execution moment: ${compact}. Retrieve detail with sequence_inspect before drawing conclusions.`,
          });
          return;
        }
        case "theater_annotate": {
          const runId = String(message["runId"] ?? "");
          if (!runId || runId !== this._runId) return;
          const kind = String(message["kind"] ?? "note");
          if (!["note", "finding", "decision", "false_positive"].includes(kind)) return;
          this._store.putAnnotation({
            runId,
            kind: kind as "note" | "finding" | "decision" | "false_positive",
            body: String(message["body"] ?? ""),
            author: "user",
            anchor: {
              sequenceNumber: Math.max(1, Math.trunc(Number(message["sequenceNumber"] ?? 1))),
              ...(typeof message["eventId"] === "string" ? { eventId: message["eventId"] } : {}),
              ...(typeof message["observationId"] === "string" ? { observationId: message["observationId"] } : {}),
              ...(typeof message["stepId"] === "string" ? { stepId: message["stepId"] } : {}),
            },
          });
          return;
        }
        case "theater_keep_run": {
          const runId = String(message["runId"] ?? "");
          if (runId && runId === this._runId) this._store.setRetention(runId, "pinned");
          return;
        }
        case "theater_set_baseline": {
          const runId = String(message["runId"] ?? "");
          if (!runId || runId !== this._runId) return;
          const run = this._store.getRun(runId);
          this._store.setBaseline(runId, run?.planId && run.phaseId ? "phase" : "family");
          return;
        }
        case "theater_compare_baseline": {
          const runId = String(message["runId"] ?? "");
          if (runId && runId === this._runId) await this._postBaselineComparison(runId);
          return;
        }
        case "theater_open_map": {
          const runId = String(message["runId"] ?? "");
          if (runId && runId === this._runId) await this._callbacks.openMap?.({
            runId,
            sequenceNumber: Math.max(1, Math.trunc(Number(message["sequenceNumber"] ?? 1))),
          });
          return;
        }
        case "theater_file_anomaly": {
          const runId = String(message["runId"] ?? "");
          const run = this._store.getRun(runId);
          if (!run || runId !== this._runId || !this._callbacks.fileAnomaly) return;
          const eventId = typeof message["eventId"] === "string" ? message["eventId"] : undefined;
          const observationId = typeof message["observationId"] === "string" ? message["observationId"] : undefined;
          await this._callbacks.fileAnomaly({
            run,
            ...(eventId ? { event: this._store.findEvent(runId, eventId) } : {}),
            ...(observationId ? { observation: this._store.getObservation(observationId) } : {}),
          });
          return;
        }
        case "theater_cancel": {
          if (this._runId) await this._sequences.cancelRun(this._runId);
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this._postError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Answer a scrub into history. Unlike the delta path this does read segments off disk, which is
   * acceptable precisely because it is driven by a human dragging a playhead rather than by the
   * run's own event rate.
   */
  private _postWindow(runId: string, rawFrom: unknown, rawTo: unknown): void {
    const panel = this._panel;
    if (!panel || runId !== this._runId) return;

    const totalEvents = this._store.listEventSegments(runId)
      .reduce((total, segment) => total + segment.eventCount, 0);
    if (totalEvents <= 0) return;

    const clamp = (value: unknown, fallback: number): number => {
      const parsed = Math.trunc(Number(value));
      return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), totalEvents) : fallback;
    };
    const from = clamp(rawFrom, 1);
    const to = Math.max(from, Math.min(clamp(rawTo, totalEvents), from + MAX_DELTA_EVENTS - 1));

    void panel.webview.postMessage({
      type: "theater_window",
      runId,
      generation: this._generation,
      events: this._store.readEvents(runId, { fromSequence: from, toSequence: to, limit: MAX_DELTA_EVENTS }),
      from,
      to,
      totalEvents,
    });
  }

  /** Resolve a global time/sequence seek to a real event, then return a capped detail window. */
  private _postSeek(runId: string, rawSequence: unknown, rawTimestamp: unknown): void {
    if (!this._panel || runId !== this._runId) return;
    const overview = this._store.getTraceOverview(runId);
    if (overview.eventCount <= 0) return;
    let anchor: number | undefined;
    if (typeof rawTimestamp === "string") {
      anchor = this._store.findNearestEventByTimestamp(runId, rawTimestamp)?.sequenceNumber;
    }
    if (anchor === undefined) {
      const parsed = Math.trunc(Number(rawSequence));
      if (Number.isFinite(parsed)) anchor = Math.min(Math.max(parsed, overview.firstSequence), overview.lastSequence);
    }
    if (anchor === undefined) return;
    const half = Math.floor(MAX_DELTA_EVENTS / 2);
    const from = Math.max(overview.firstSequence, anchor - half);
    const to = Math.min(overview.lastSequence, from + MAX_DELTA_EVENTS - 1);
    void this._panel.webview.postMessage({
      type: "theater_window",
      runId,
      generation: this._generation,
      events: this._store.readEvents(runId, { fromSequence: from, toSequence: to, limit: MAX_DELTA_EVENTS }),
      from,
      to,
      totalEvents: overview.eventCount,
      anchorSequence: anchor,
    });
  }

  private _postAnnotations(): void {
    if (!this._panel || !this._runId || this._disposed) return;
    void this._panel.webview.postMessage({
      type: "theater_annotations",
      runId: this._runId,
      annotations: this._store.listAnnotations(this._runId),
    });
  }

  private async _postBaselineComparison(runId: string): Promise<void> {
    const panel = this._panel;
    const current = this._store.getRun(runId);
    if (!panel || !current) return;
    const baselineRunId = current.baselineRunId ?? this._store.resolveBaseline(current)?.runId;
    if (!baselineRunId || baselineRunId === runId) {
      this._postError("No compatible baseline is bound to this run family or plan phase.");
      return;
    }
    const baseline = this._store.getRun(baselineRunId);
    if (!baseline) { this._postError(`Baseline run not found: ${baselineRunId}`); return; }
    const result = await this._sequences.dispatch("compare", {
      left_run_id: baselineRunId,
      right_run_id: runId,
      alignment: "semantic",
    }, { sessionId: "run-theater" });
    if (result["ok"] !== true || !result["comparison"] || typeof result["comparison"] !== "object") {
      this._postError(String(result["error"] ?? "Run comparison failed."));
      return;
    }
    const raw = result["comparison"] as Record<string, unknown>;
    const alignments = Array.isArray(raw["alignments"]) ? raw["alignments"] as Array<Record<string, unknown>> : [];
    const comparison = {
      ...raw,
      alignments: alignments.map((alignment) => ({
        ...alignment,
        ...Object.fromEntries(["left", "right"].flatMap((key) => {
          const side = alignment[key];
          if (!side || typeof side !== "object") return [];
          const value = side as Record<string, unknown>;
          const artifacts = Array.isArray(value["artifacts"]) ? value["artifacts"] as StoredRunArtifact[] : [];
          return [[key, { ...value, artifacts: this._withUrls(artifacts) }]];
        })),
      })),
    };
    void panel.webview.postMessage({
      type: "theater_comparison",
      runId,
      comparison,
      environmentMismatch: Boolean(
        baseline.environmentFingerprint && current.environmentFingerprint
        && baseline.environmentFingerprint !== current.environmentFingerprint,
      ),
    });
  }

  /**
   * Build and send the post-run report: what this run touched, and whether it matched what it
   * promised. Host-side because it needs the full step list and a manifest lookup, neither of
   * which the webview has — it holds only a bounded window.
   */
  private _postInspection(): void {
    const panel = this._panel;
    const runId = this._runId;
    if (!panel || !runId || this._disposed) return;

    try {
      const run = this._store.getRun(runId);
      if (!run) return;
      const steps = this._store.getSteps(runId);
      const totalEvents = this._store.listEventSegments(runId)
        .reduce((total, segment) => total + segment.eventCount, 0);
      const events = totalEvents > 0
        ? this._store.readEvents(runId, { fromSequence: 1, toSequence: totalEvents, limit: INSPECTION_EVENT_LIMIT })
        : [];
      const failedStep = steps.find((step) => step.failure);

      const report = buildInspectionReport({
        run,
        steps,
        events,
        observations: this._store.listObservations(runId),
        ...(failedStep?.failure ? { failure: failedStep.failure } : {}),
        ...((): { promise?: ReturnType<SequenceService["getPreflightManifest"]> } => {
          const promise = this._sequences.getPreflightManifest?.(runId);
          return promise ? { promise } : {};
        })(),
      });

      void panel.webview.postMessage({ type: "theater_inspection", runId, report });
    } catch (error) {
      this._postError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Attach a readable webview URI to each artifact.
   *
   * Unlike the sidebar this mints for every artifact of the followed run, because the whole point
   * of the timeline is landing on any frame without waiting for a round trip. The bound that
   * matters is unchanged: ids come from `listArtifacts(runId)` or from a delta for this same run,
   * so a content-addressed id belonging to some other run in the workspace is never resolvable
   * from here.
   */
  private _withUrls(artifacts: StoredRunArtifact[]): Array<StoredRunArtifact & { url?: string }> {
    const panel = this._panel;
    if (!panel) return artifacts;
    return artifacts.map((artifact) => {
      if (!artifact.mediaType?.startsWith("image/")) return artifact;
      try {
        if (!this._store.artifacts.has(artifact.id)) return artifact;
        const url = panel.webview
          .asWebviewUri(vscode.Uri.file(this._store.artifactPath(artifact.id)))
          .toString();
        return { ...artifact, url };
      } catch {
        return artifact;
      }
    });
  }

  private _postError(message: string): void {
    void this._panel?.webview.postMessage({ type: "theater_error", message });
  }
}
