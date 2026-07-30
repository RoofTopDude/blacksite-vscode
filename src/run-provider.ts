import * as path from "node:path";
import * as vscode from "vscode";
import type {
  EntityRef,
  ExecutionRun,
  ObservationBundle,
  RunEvent,
  StoredRunArtifact,
} from "./runs/run-model.js";
import type { RunStore } from "./runs/run-store.js";
import type {
  RunComparison,
  RunComparisonAlignment,
  RunComparisonSide,
} from "./sequences/run-comparator.js";
import type { SequenceService } from "./sequences/sequence-service.js";
import { renderWebviewHtml } from "./webview-html.js";

const MAX_VISIBLE_RUNS = 500;
const INITIAL_EVENT_WINDOW_SIZE = 240;
const MAX_EVENT_WINDOW_SIZE = 500;
const RUN_EXPLORER_SESSION_ID = "run-explorer";

export interface RunExplorerMapTarget {
  runId: string;
  sequenceNumber?: number;
  entity?: EntityRef;
}

export interface RunProviderCallbacks {
  openEntity?: (entity: EntityRef) => void | Promise<void>;
  openOnMap?: (target: RunExplorerMapTarget) => void | Promise<void>;
  fileAnomaly?: (target: {
    run: ExecutionRun;
    event?: RunEvent;
    observation?: ObservationBundle;
  }) => void | Promise<void>;
}

interface EventWindow {
  from: number;
  to: number;
}

type RunExplorerOperation =
  | "ready"
  | "refresh"
  | "select_run"
  | "request_event_window"
  | "select_observation"
  | "compare_runs"
  | "pin_run"
  | "cancel_run"
  | "open_entity"
  | "open_on_map"
  | "file_anomaly_ticket";

/**
 * Host-side bridge for the retained Execution Runs explorer.
 *
 * The webview receives only a bounded event window. Artifact metadata may be
 * listed for the whole selected run, but a readable webview URI is attached
 * only to the selected observation (or to an explicit comparison response).
 */
export class RunProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private readonly _storeSubscription: vscode.Disposable;
  private readonly _viewSubscriptions: vscode.Disposable[] = [];
  private _selectedRunId?: string;
  private _selectedObservationId?: string;
  private _refreshQueued = false;
  private _disposed = false;
  private _comparisonGeneration = 0;
  private _openEntity?: RunProviderCallbacks["openEntity"];
  private _openOnMap?: RunProviderCallbacks["openOnMap"];
  private _fileAnomaly?: RunProviderCallbacks["fileAnomaly"];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: RunStore,
    private readonly _sequences: SequenceService,
    callbacks: RunProviderCallbacks = {},
  ) {
    this._openEntity = callbacks.openEntity;
    this._openOnMap = callbacks.openOnMap;
    this._fileAnomaly = callbacks.fileAnomaly;
    this._storeSubscription = this._store.onDidChange(() => this._queueStateRefresh());
  }

  setEntityOpener(opener: RunProviderCallbacks["openEntity"]): void {
    this._openEntity = opener;
  }

  setMapOpener(opener: RunProviderCallbacks["openOnMap"]): void {
    this._openOnMap = opener;
  }

  setAnomalyTicketFiler(filer: RunProviderCallbacks["fileAnomaly"]): void {
    this._fileAnomaly = filer;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._comparisonGeneration += 1;
    this._storeSubscription.dispose();
    this._disposeViewSubscriptions();
    this._view = undefined;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._disposeViewSubscriptions();
    this._view = webviewView;
    const artifactRoot = vscode.Uri.file(
      path.join(this._store.workspaceRoot, ".blacksite", "runs", "artifacts"),
    );
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, "out"),
        artifactRoot,
      ],
    };
    webviewView.webview.html = renderWebviewHtml(
      webviewView.webview,
      this._context.extensionUri,
      "runs.js",
    );
    this._viewSubscriptions.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        void this._onMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this._postState();
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) this._view = undefined;
      }),
    );
    this._postState();
  }

  refresh(): void {
    this._postState();
  }

  private async _onMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value["type"] !== "string") return;
    const operation = value["type"] as RunExplorerOperation;
    try {
      switch (operation) {
        case "ready":
        case "refresh":
          this._postState();
          return;
        case "select_run": {
          const runId = requiredString(value, "runId");
          if (!this._store.getRun(runId)) {
            throw new Error(`Run not found: ${runId}`);
          }
          this._selectedRunId = runId;
          this._selectedObservationId = undefined;
          this._comparisonGeneration += 1;
          this._postState();
          return;
        }
        case "request_event_window": {
          const runId = requiredString(value, "runId");
          this._postEventWindow(runId, value["from"], value["to"]);
          return;
        }
        case "select_observation": {
          const runId = requiredString(value, "runId");
          const observationId = requiredString(value, "observationId");
          const observation = this._store.getObservation(observationId);
          if (!observation || observation.runId !== runId) {
            throw new Error(`Observation not found in run ${runId}: ${observationId}`);
          }
          this._selectedRunId = runId;
          this._selectedObservationId = observationId;
          this._postState();
          return;
        }
        case "compare_runs":
          await this._compareRuns(
            requiredString(value, "leftRunId"),
            requiredString(value, "rightRunId"),
          );
          return;
        case "pin_run": {
          const runId = requiredString(value, "runId");
          this._sequences.setPinned(runId, value["pinned"] === true);
          return;
        }
        case "cancel_run": {
          const runId = requiredString(value, "runId");
          if (!this._store.getRun(runId)) throw new Error(`Run not found: ${runId}`);
          if (!this._sequences.cancelRun(runId)) {
            throw new Error(`Run is no longer active: ${runId}`);
          }
          this._postState();
          return;
        }
        case "open_entity": {
          const entity = readEntityRef(value["entity"]);
          if (!entity) throw new Error("A valid entity reference is required");
          await this._openEntityRef(entity);
          return;
        }
        case "open_on_map": {
          const target = readMapTarget(value);
          if (!target) throw new Error("A valid run id is required");
          if (!this._store.getRun(target.runId)) {
            throw new Error(`Run not found: ${target.runId}`);
          }
          if (!this._openOnMap) {
            throw new Error("Codebase Map navigation is unavailable");
          }
          await this._openOnMap(target);
          return;
        }
        case "file_anomaly_ticket": {
          const runId = requiredString(value, "runId");
          const run = this._store.getRun(runId);
          if (!run) throw new Error(`Run not found: ${runId}`);
          if (!this._fileAnomaly) throw new Error("Ticket filing is unavailable");
          const eventId = optionalString(value, "eventId");
          const observationId = optionalString(value, "observationId");
          const event = eventId
            ? this._store.findEvent(runId, eventId)
            : undefined;
          const observation = observationId ? this._store.getObservation(observationId) : undefined;
          if (eventId && !event) throw new Error(`Event not found in run ${runId}: ${eventId}`);
          if (observationId && observation?.runId !== runId) {
            throw new Error(`Observation not found in run ${runId}: ${observationId}`);
          }
          await this._fileAnomaly({ run, event, observation });
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this._postError(errorMessage(error), operation, optionalString(value, "runId"));
      if (operation === "pin_run") this._postState();
    }
  }

  private _postState(): void {
    const view = this._view;
    if (!view || this._disposed) return;

    try {
      let runs = this._store.listRuns({ limit: MAX_VISIBLE_RUNS }).runs;
      if (this._selectedRunId && !runs.some((run) => run.id === this._selectedRunId)) {
        const explicitlySelected = this._store.getRun(this._selectedRunId);
        if (explicitlySelected) {
          runs = [
            explicitlySelected,
            ...runs.slice(0, Math.max(0, MAX_VISIBLE_RUNS - 1)),
          ];
        }
      }
      const selectedRun = this._resolveSelectedRun(runs);
      if (!selectedRun) {
        void view.webview.postMessage({
          type: "runs_state",
          runs,
          steps: [],
          observations: [],
          events: [],
          totalEvents: 0,
          artifacts: [],
        });
        return;
      }

      const steps = this._store.getSteps(selectedRun.id);
      const observations = this._store.listObservations(selectedRun.id);
      const selectedObservation = this._resolveSelectedObservation(selectedRun, observations);
      const totalEvents = this._eventCount(selectedRun.id);
      const initialWindow = windowAround(
        selectedObservation?.cursor.sequenceNumber ?? 1,
        totalEvents,
        INITIAL_EVENT_WINDOW_SIZE,
      );
      const events = totalEvents > 0
        ? this._store.readEvents(selectedRun.id, {
          fromSequence: initialWindow.from,
          toSequence: initialWindow.to,
          limit: INITIAL_EVENT_WINDOW_SIZE,
        })
        : [];
      const artifacts = this._store.listArtifacts(selectedRun.id).map((artifact) =>
        this._artifactForWebview(view.webview, artifact, artifactBelongsToObservation(
          artifact,
          selectedObservation,
        )));

      void view.webview.postMessage({
        type: "runs_state",
        runs,
        selectedRun,
        steps,
        observations,
        events,
        totalEvents,
        artifacts,
      });
    } catch (error) {
      this._postError(errorMessage(error), "refresh", this._selectedRunId);
    }
  }

  private _postEventWindow(runId: string, rawFrom: unknown, rawTo: unknown): void {
    if (!this._view) return;
    const run = this._store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const totalEvents = this._eventCount(runId);
    const window = boundedWindow(rawFrom, rawTo, totalEvents);
    const events = totalEvents > 0
      ? this._store.readEvents(runId, {
        fromSequence: window.from,
        toSequence: window.to,
        limit: MAX_EVENT_WINDOW_SIZE,
      })
      : [];
    void this._view.webview.postMessage({
      type: "run_event_window",
      runId,
      events,
      totalEvents,
      from: window.from,
      to: window.to,
    });
  }

  private async _compareRuns(leftRunId: string, rightRunId: string): Promise<void> {
    const view = this._view;
    if (!view) return;
    if (leftRunId === rightRunId) throw new Error("Choose two different runs to compare");
    const generation = ++this._comparisonGeneration;
    const result = await this._sequences.dispatch(
      "compare",
      {
        left_run_id: leftRunId,
        right_run_id: rightRunId,
        alignment: "semantic",
      },
      { sessionId: RUN_EXPLORER_SESSION_ID },
    );
    if (generation !== this._comparisonGeneration || view !== this._view) return;
    if (result["ok"] !== true) {
      throw new Error(typeof result["error"] === "string"
        ? result["error"]
        : "Run comparison failed");
    }
    const comparison = result["comparison"];
    if (!isRunComparison(comparison)) {
      throw new Error("Run comparison returned an invalid response");
    }
    void view.webview.postMessage({
      type: "run_comparison",
      comparison: this._comparisonForWebview(view.webview, comparison),
    });
  }

  private _resolveSelectedRun(runs: ExecutionRun[]): ExecutionRun | undefined {
    const selected = this._selectedRunId
      ? runs.find((run) => run.id === this._selectedRunId)
      : undefined;
    const run = selected ?? runs[0];
    this._selectedRunId = run?.id;
    if (!selected && run) this._selectedObservationId = undefined;
    return run;
  }

  private _resolveSelectedObservation(
    run: ExecutionRun,
    observations: ObservationBundle[],
  ): ObservationBundle | undefined {
    const current = this._selectedObservationId
      ? observations.find((observation) => observation.id === this._selectedObservationId)
      : undefined;
    if (current) return current;
    const key = run.keyObservationIds
      .map((id) => observations.find((observation) => observation.id === id))
      .find((observation): observation is ObservationBundle => observation !== undefined);
    const selected = key ?? observations[0];
    this._selectedObservationId = selected?.id;
    return selected;
  }

  private _eventCount(runId: string): number {
    return this._store.listEventSegments(runId)
      .reduce((total, segment) => total + segment.eventCount, 0);
  }

  private _artifactForWebview(
    webview: vscode.Webview,
    artifact: StoredRunArtifact,
    includeUrl: boolean,
  ): StoredRunArtifact & { url?: string } {
    if (!includeUrl) return artifact;
    try {
      if (!this._store.artifacts.has(artifact.id)) return artifact;
      const url = webview.asWebviewUri(
        vscode.Uri.file(this._store.artifactPath(artifact.id)),
      ).toString();
      return { ...artifact, url };
    } catch {
      return artifact;
    }
  }

  private _comparisonForWebview(
    webview: vscode.Webview,
    comparison: RunComparison,
  ): RunComparison {
    const transformSide = (side: RunComparisonSide | undefined): RunComparisonSide | undefined => {
      if (!side) return undefined;
      return {
        ...side,
        artifacts: side.artifacts.map((artifact) =>
          this._artifactForWebview(webview, artifact, true)),
      };
    };
    return {
      ...comparison,
      alignments: comparison.alignments.map((alignment): RunComparisonAlignment => ({
        ...alignment,
        ...(alignment.left ? { left: transformSide(alignment.left) } : {}),
        ...(alignment.right ? { right: transformSide(alignment.right) } : {}),
      })),
    };
  }

  private async _openEntityRef(entity: EntityRef): Promise<void> {
    if (this._openEntity) {
      await this._openEntity(entity);
      return;
    }
    if (entity.scheme === "route" || entity.scheme === "browser-request") {
      if (!/^https?:\/\//i.test(entity.id)) {
        throw new Error("This route has no absolute URL to open");
      }
      await vscode.env.openExternal(vscode.Uri.parse(entity.id));
      return;
    }
    if (entity.scheme === "artifact") {
      const artifact = this._store.getArtifact(entity.id);
      if (!artifact) throw new Error(`Artifact not found: ${entity.id}`);
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(this._store.artifactPath(artifact.id)),
      );
      return;
    }
    if (!entity.workspacePath && entity.scheme !== "workspace-file" && entity.scheme !== "code-symbol") {
      throw new Error(`No opener is available for ${entity.scheme} entities`);
    }
    const candidate = entity.workspacePath ?? entity.id;
    const absolutePath = path.resolve(this._store.workspaceRoot, candidate);
    const relative = path.relative(this._store.workspaceRoot, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Entity path is outside the active workspace");
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    const selection = entity.range
      ? new vscode.Range(
        entity.range.start.line,
        entity.range.start.character,
        entity.range.end.line,
        entity.range.end.character,
      )
      : undefined;
    await vscode.window.showTextDocument(document, {
      preview: true,
      ...(selection ? { selection } : {}),
    });
  }

  private _queueStateRefresh(): void {
    if (this._refreshQueued || this._disposed) return;
    this._refreshQueued = true;
    queueMicrotask(() => {
      this._refreshQueued = false;
      if (!this._disposed) this._postState();
    });
  }

  private _postError(
    message: string,
    operation?: RunExplorerOperation,
    runId?: string,
  ): void {
    if (!this._view) return;
    void this._view.webview.postMessage({
      type: "run_error",
      message,
      ...(operation ? { operation } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  private _disposeViewSubscriptions(): void {
    for (const subscription of this._viewSubscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}

function boundedWindow(rawFrom: unknown, rawTo: unknown, totalEvents: number): EventWindow {
  if (totalEvents <= 0) return { from: 0, to: 0 };
  const candidateFrom = finiteInteger(rawFrom, 1);
  const candidateTo = finiteInteger(rawTo, candidateFrom);
  const low = Math.min(candidateFrom, candidateTo);
  const high = Math.max(candidateFrom, candidateTo);
  const from = clamp(low, 1, totalEvents);
  const requestedTo = clamp(high, from, totalEvents);
  return {
    from,
    to: Math.min(requestedTo, from + MAX_EVENT_WINDOW_SIZE - 1),
  };
}

function windowAround(center: number, totalEvents: number, size: number): EventWindow {
  if (totalEvents <= 0) return { from: 0, to: 0 };
  const boundedSize = clamp(Math.trunc(size), 1, MAX_EVENT_WINDOW_SIZE);
  const boundedCenter = clamp(Math.trunc(center), 1, totalEvents);
  const half = Math.floor(boundedSize / 2);
  let from = Math.max(1, boundedCenter - half);
  let to = Math.min(totalEvents, from + boundedSize - 1);
  from = Math.max(1, to - boundedSize + 1);
  to = Math.max(from, to);
  return { from, to };
}

function artifactBelongsToObservation(
  artifact: StoredRunArtifact,
  observation: ObservationBundle | undefined,
): boolean {
  if (!observation) return false;
  if (artifact.observationId === observation.id) return true;
  return observation.visualArtifactIds.includes(artifact.id)
    || observation.structuralArtifactIds.includes(artifact.id)
    || observation.stateArtifactIds.includes(artifact.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key);
  if (!result) throw new Error(`${key} is required`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed || undefined;
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) ? number : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function readEntityRef(value: unknown): EntityRef | undefined {
  if (!isRecord(value)) return undefined;
  const scheme = value["scheme"];
  const id = value["id"];
  if (typeof scheme !== "string" || typeof id !== "string" || !id.trim()) return undefined;
  if (!ENTITY_SCHEMES.has(scheme as EntityRef["scheme"])) return undefined;
  return value as unknown as EntityRef;
}

function readMapTarget(value: Record<string, unknown>): RunExplorerMapTarget | undefined {
  const runId = optionalString(value, "runId");
  if (!runId) return undefined;
  const sequenceNumber = finiteInteger(value["sequenceNumber"], 0);
  const entity = readEntityRef(value["entity"]);
  return {
    runId,
    ...(sequenceNumber > 0 ? { sequenceNumber } : {}),
    ...(entity ? { entity } : {}),
  };
}

function isRunComparison(value: unknown): value is RunComparison {
  return isRecord(value)
    && typeof value["leftRunId"] === "string"
    && typeof value["rightRunId"] === "string"
    && Array.isArray(value["alignments"]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ENTITY_SCHEMES = new Set<EntityRef["scheme"]>([
  "workspace-file",
  "code-symbol",
  "dom-node",
  "ui-component",
  "route",
  "browser-request",
  "process",
  "test",
  "scene",
  "scene-object",
  "mesh",
  "material",
  "artifact",
]);
