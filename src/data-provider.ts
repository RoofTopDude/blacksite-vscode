import * as fs from "fs";
import * as vscode from "vscode";
import { DatabaseManager, SqlDriverUnavailableError } from "./data/database-manager.js";
import { resolveStorageLocations } from "./data/database-paths.js";
import { ExactLocalVectorProvider } from "./data/exact-local-vector-provider.js";
import { DataSurfaceProvider } from "./data/data-surface-provider.js";
import {
  applyImportRecords,
  collectLegacyRecords,
  hasImported,
  markImported,
} from "./data/legacy-import.js";
import { sparseEmbed } from "./embedding-service.js";
import { ContainerRuntime } from "./data/container-runtime.js";
import {
  POSTGRES_PGVECTOR_PROFILE,
  connectionStringFor,
} from "./data/postgres-pgvector-profile.js";
import { createPgVectorProvider, type PgClient } from "./data/pgvector-sidecar-provider.js";
import { ExactLocalVectorProvider as ExactLocalVectorProviderForSwitch } from "./data/exact-local-vector-provider.js";
import { renderWebviewHtml } from "./webview-html.js";
import { resolveWorkspacePath } from "./workspace-paths.js";

/**
 * Result of an assistant turn. Implemented by the M3 query planner and injected so
 * the webview's Assistant tab can render a proposed query + explanation + safety.
 */
export interface DataAssistantReply {
  ok: boolean;
  explanation: string;
  sql?: string;
  safety?: "read" | "write" | "destructive" | "ddl" | "unknown";
  needsConfirmation?: boolean;
  error?: string;
}

export interface DataAssistant {
  ask(question: string): Promise<DataAssistantReply>;
}

export interface DataWorkbenchSettings {
  previewPageSize: number;
  maxQueryRows: number;
  enableAssistant: boolean;
  backendMode: "exact_local" | "pgvector_container";
}

/** Everything the Data surface needs after activation; degrades cleanly if SQLite is absent. */
export interface DataWorkbench {
  surface: DataSurfaceProvider | null;
  manager: DatabaseManager | null;
  status: { available: boolean; engine: string | null; schemaVersion: number; reason?: string };
  dispose(): void;
}

/**
 * Bootstrap the embedded database, vector provider, and surface adapter. Opening the
 * database can fail when no SQLite binding is present on the host — that is handled
 * here so the rest of the extension keeps working and the Data view shows a clear
 * "engine unavailable" state instead of crashing activation.
 */
export function createDataWorkbench(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
): DataWorkbench {
  let manager: DatabaseManager | null = null;
  let surface: DataSurfaceProvider | null = null;
  let status: DataWorkbench["status"] = { available: false, engine: null, schemaVersion: 0 };

  try {
    const locations = resolveStorageLocations({
      storageFsPath: context.storageUri?.fsPath,
      globalStorageFsPath: context.globalStorageUri.fsPath,
      workspaceRoot,
    });
    manager = new DatabaseManager(locations.databaseFile);
    const migration = manager.open();
    const vectors = new ExactLocalVectorProvider(manager);
    surface = new DataSurfaceProvider(manager, vectors);
    status = { available: true, engine: manager.engine, schemaVersion: migration.toVersion };

    // Staged cutover: import legacy `.blacksite/*` artifacts once. Best-effort — a
    // failure here must not stop the workbench from opening.
    void runLegacyImport(manager).catch(() => undefined);
  } catch (err) {
    const reason = err instanceof SqlDriverUnavailableError
      ? "No SQLite binding is available on this host. Install better-sqlite3 or run on Node >= 22.5."
      : err instanceof Error ? err.message : String(err);
    status = { available: false, engine: null, schemaVersion: 0, reason };
  }

  return {
    surface,
    manager,
    status,
    dispose: () => manager?.close(),
  };
}

async function runLegacyImport(manager: DatabaseManager): Promise<void> {
  if (hasImported(manager)) return;
  // collectLegacyRecords reads `.blacksite/*` relative to the workspace; resolve from
  // the first folder if present, otherwise skip silently.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;
  const records = collectLegacyRecords(workspaceRoot);
  const summary = await applyImportRecords(manager, records);
  await markImported(manager, summary);
}

// ── Webview provider ─────────────────────────────────────────────────────────

export class DataProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view?: vscode.WebviewView;
  private _assistant?: DataAssistant;
  private _embedder?: (text: string) => Promise<number[]>;
  private readonly _container = new ContainerRuntime();
  private readonly _sidecarProfile = POSTGRES_PGVECTOR_PROFILE;
  private _pgClient: PgClient | null = null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: string,
    private readonly _workbench: DataWorkbench,
  ) {
    void this.applyConfiguredBackend();
  }

  /** Wire the M3 assistant after construction (it depends on chat-provider secrets). */
  setAssistant(assistant: DataAssistant): void {
    this._assistant = assistant;
  }

  /** Wire the embedding function after construction (it depends on chat-provider secrets
      and the unified embedding-model setting). Falls back to a local sparse vector when
      absent or when the API path fails. */
  setEmbedder(embed: (text: string) => Promise<number[]>): void {
    this._embedder = embed;
  }

  private async _embedQuery(text: string): Promise<number[]> {
    if (!this._embedder) return sparseEmbed(text);
    try {
      const vec = await this._embedder(text);
      return vec.length ? vec : sparseEmbed(text);
    } catch {
      return sparseEmbed(text);
    }
  }

  dispose(): void {
    void this._closePgClient();
  }

  async applyConfiguredBackend(): Promise<void> {
    const settings = this._readSettings();
    await this._applyVectorBackend(settings.backendMode, { persist: false, silent: true });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
    };
    webviewView.webview.html = renderWebviewHtml(webviewView.webview, this._context.extensionUri, "data.js");
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this._onMessage(msg),
      undefined,
      this._context.subscriptions,
    );
    this._postState();
  }

  refresh(): void {
    this._postState();
  }

  /** Focus the Query tab with a SQL string pre-loaded (used by `blacksite.runQuery`). */
  loadQueryIntoEditor(sql: string): void {
    this._post({ type: "load_query", sql });
  }

  private async _onMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    const surface = this._workbench.surface;
    try {
      switch (type) {
        case "ready":
        case "refresh":
          await this.applyConfiguredBackend();
          this._postState();
          break;
        case "describe_object": {
          if (!surface) break;
          const description = surface.describeObject(String(msg.name ?? ""));
          this._post({ type: "object_description", description });
          break;
        }
        case "preview_rows": {
          if (!surface) break;
          const result = surface.previewRows(String(msg.name ?? ""), {
            limit: typeof msg.limit === "number" ? msg.limit : this._previewPageSize(),
            offset: typeof msg.offset === "number" ? msg.offset : 0,
            filter: typeof msg.filter === "string" ? msg.filter : undefined,
            orderBy: typeof msg.orderBy === "string" ? msg.orderBy : undefined,
            orderDir: msg.orderDir === "desc" ? "desc" : msg.orderDir === "asc" ? "asc" : undefined,
          });
          this._post({ type: "preview_result", result });
          break;
        }
        case "run_query": {
          if (!surface) break;
          const result = await surface.runQuery(String(msg.sql ?? ""), {
            confirmed: msg.confirmed === true,
            maxRows: this._maxQueryRows(),
          });
          this._post({ type: "query_result", result });
          break;
        }
        case "save_query": {
          if (!surface) break;
          await surface.saveQuery({
            id: typeof msg.id === "string" ? msg.id : undefined,
            name: String(msg.name ?? "Untitled query"),
            sql: String(msg.sql ?? ""),
            description: typeof msg.description === "string" ? msg.description : undefined,
          });
          this._postState();
          break;
        }
        case "open_saved_query": {
          if (!surface) break;
          const saved = surface.getSavedQuery(String(msg.id ?? ""));
          if (saved) this._post({ type: "load_query", sql: saved.sql, name: saved.name, id: saved.id });
          break;
        }
        case "delete_saved_query": {
          if (!surface) break;
          await surface.deleteSavedQuery(String(msg.id ?? ""));
          this._postState();
          break;
        }
        case "vector_search": {
          if (!surface) break;
          const text = String(msg.text ?? "").trim();
          if (!text) break;
          const vector = await this._embedQuery(text);
          const hits = await surface.vectorSearch({
            vector,
            topK: typeof msg.topK === "number" ? msg.topK : 10,
            collection: typeof msg.collection === "string" && msg.collection ? msg.collection : undefined,
          });
          this._post({ type: "vector_results", hits, query: text });
          break;
        }
        case "sidecar_status": {
          const settings = this._readSettings();
          const available = await this._container.isAvailable();
          const status = available ? await this._container.status(this._sidecarProfile) : null;
          this._post({
            type: "sidecar_status",
            engineAvailable: available,
            profile: this._sidecarProfile.label,
            status,
            configuredBackend: settings.backendMode,
            activeBackend: surface?.status().vectorBackend ?? "exact_local",
          });
          break;
        }
        case "sidecar_up": {
          const result = await this._container.up(this._sidecarProfile);
          if (result.ok && this._readSettings().backendMode === "pgvector_container") {
            await this.applyConfiguredBackend();
          }
          this._post({ type: "sidecar_action", action: "up", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "sidecar_stop": {
          const result = await this._container.stop(this._sidecarProfile);
          if (result.ok && surface?.status().vectorBackend === "pgvector_container") {
            await this._applyVectorBackend("exact_local", { persist: false, silent: true });
          }
          this._post({ type: "sidecar_action", action: "stop", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "set_vector_backend": {
          const mode = msg.mode === "pgvector_container" ? "pgvector_container" : "exact_local";
          const result = await this._applyVectorBackend(mode, { persist: true, silent: false });
          this._post({ type: "sidecar_action", action: "switch", ...result });
          this._postState();
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "assistant_ask": {
          const question = String(msg.question ?? "").trim();
          if (!question) break;
          if (!this._assistantEnabled()) {
            this._post({ type: "assistant_reply", reply: { ok: false, explanation: "", error: "The database assistant is disabled. Enable it in settings (blacksite.data.enableAssistant)." } });
            break;
          }
          if (!this._assistant) {
            this._post({ type: "assistant_reply", reply: { ok: false, explanation: "", error: "Assistant is not available in this context." } });
            break;
          }
          const reply = await this._assistant.ask(question);
          this._post({ type: "assistant_reply", reply });
          break;
        }
        case "open_source_file": {
          await this._openFile(String(msg.path ?? ""));
          break;
        }
        case "open_settings": {
          await this._openSettings(typeof msg.query === "string" ? msg.query : undefined);
          break;
        }
      }
    } catch (err) {
      this._post({ type: "data_error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private _postState(): void {
    if (!this._view) return;
    const surface = this._workbench.surface;
    const settings = this._readSettings();
    const state: Record<string, unknown> = {
      type: "data_state",
      status: {
        ...this._workbench.status,
        assistantEnabled: settings.enableAssistant,
        activeBackend: surface?.status().vectorBackend ?? settings.backendMode,
      },
      settings,
    };
    if (surface) {
      state.catalog = surface.getCatalog();
      state.savedQueries = surface.listSavedQueries();
    }
    void this._view.webview.postMessage(state);
    if (surface) {
      void surface.vectorStats().then((stats) => this._post({ type: "vector_stats", stats })).catch(() => undefined);
    }
  }

  private async _openFile(relativePath: string): Promise<void> {
    if (!relativePath) return;
    const absolute = resolveWorkspacePath(relativePath, this._workspaceRoots());
    if (!absolute || !fs.existsSync(absolute)) {
      vscode.window.showWarningMessage(`Blacksite: ${relativePath} was not found in this workspace.`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(absolute);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private _post(message: Record<string, unknown>): void {
    void this._view?.webview.postMessage(message);
  }

  private _config() {
    return vscode.workspace.getConfiguration("blacksite.data");
  }

  private _configTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  private _workspaceRoots(): string[] {
    return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [this._workspaceRoot];
  }

  private async _closePgClient(): Promise<void> {
    const client = this._pgClient;
    this._pgClient = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // Best-effort cleanup; losing the connection is harmless during dispose/switch.
      }
    }
  }

  private _readSettings(): DataWorkbenchSettings {
    const cfg = this._config();
    const backendMode = cfg.get<string>("backendMode") === "pgvector_container"
      ? "pgvector_container"
      : "exact_local";
    return {
      previewPageSize: Math.max(10, Math.min(500, cfg.get<number>("previewPageSize", 50))),
      maxQueryRows: Math.max(1, Math.min(10_000, cfg.get<number>("maxQueryRows", 500))),
      enableAssistant: cfg.get<boolean>("enableAssistant", true),
      backendMode,
    };
  }

  private async _openSettings(query?: string): Promise<void> {
    const search = query?.trim() || "@ext:blacksite";
    await vscode.commands.executeCommand("workbench.action.openSettings", search);
  }

  private async _applyVectorBackend(
    mode: DataWorkbenchSettings["backendMode"],
    options: { persist: boolean; silent: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    const surface = this._workbench.surface;
    const manager = this._workbench.manager;
    if (!surface || !manager) {
      return { ok: false, message: "The embedded database engine is unavailable." };
    }

    const activeMode = surface.status().vectorBackend;
    if (activeMode === mode && (mode !== "pgvector_container" || this._pgClient)) {
      return { ok: true, message: mode === "pgvector_container" ? "pgvector sidecar is already active." : "Embedded exact search is already active." };
    }

    if (mode === "pgvector_container") {
      const readiness = await this._ensureSidecarReady();
      if (!readiness.ok) {
        return readiness;
      }
      const result = await createPgVectorProvider(
        connectionStringFor(this._sidecarProfile),
        this._sidecarProfile.initSql,
      );
      if (!result.ok || !result.provider || !result.client) {
        return { ok: false, message: result.reason ?? "pgvector is unavailable." };
      }
      const previousClient = this._pgClient;
      surface.setVectorProvider(result.provider);
      this._pgClient = result.client;
      if (options.persist) {
        await this._config().update("backendMode", mode, this._configTarget());
      }
      if (previousClient) {
        try {
          await previousClient.end();
        } catch {
          // Ignore stale-client cleanup failures after a successful switch.
        }
      }
      return { ok: true, message: "Switched to pgvector sidecar." };
    }

    surface.setVectorProvider(new ExactLocalVectorProviderForSwitch(manager));
    await this._closePgClient();
    if (options.persist) {
      await this._config().update("backendMode", mode, this._configTarget());
    }
    return { ok: true, message: "Switched to embedded exact search." };
  }

  private async _ensureSidecarReady(): Promise<{ ok: boolean; message: string }> {
    const available = await this._container.isAvailable();
    if (!available) {
      return { ok: false, message: "No container engine (docker/podman) detected." };
    }

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const status = await this._container.status(this._sidecarProfile);
      if (status.health === "running") {
        return { ok: true, message: "Sidecar is ready." };
      }
      if (status.health === "missing") {
        return { ok: false, message: "The pgvector sidecar has not been started yet." };
      }
      if (status.health === "stopped" || status.health === "unhealthy") {
        return { ok: false, message: `The pgvector sidecar is not ready: ${status.detail}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { ok: false, message: "The pgvector sidecar is still starting. Try again in a moment." };
  }

  private _previewPageSize(): number {
    return this._readSettings().previewPageSize;
  }

  private _maxQueryRows(): number {
    return this._readSettings().maxQueryRows;
  }

  private _assistantEnabled(): boolean {
    return this._readSettings().enableAssistant;
  }
}
