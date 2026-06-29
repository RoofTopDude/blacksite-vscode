import * as fs from "fs";
import * as path from "path";
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
import { createPgVectorProvider } from "./data/pgvector-sidecar-provider.js";
import { ExactLocalVectorProvider as ExactLocalVectorProviderForSwitch } from "./data/exact-local-vector-provider.js";
import { renderWebviewHtml } from "./webview-html.js";

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
  private readonly _container = new ContainerRuntime();
  private readonly _sidecarProfile = POSTGRES_PGVECTOR_PROFILE;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _workspaceRoot: string,
    private readonly _workbench: DataWorkbench,
  ) {}

  /** Wire the M3 assistant after construction (it depends on chat-provider secrets). */
  setAssistant(assistant: DataAssistant): void {
    this._assistant = assistant;
  }

  dispose(): void {
    /* DataWorkbench owns the DB lifecycle; disposed by extension subscriptions. */
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
          const vector = sparseEmbed(text);
          const hits = await surface.vectorSearch({
            vector,
            topK: typeof msg.topK === "number" ? msg.topK : 10,
            collection: typeof msg.collection === "string" && msg.collection ? msg.collection : undefined,
          });
          this._post({ type: "vector_results", hits, query: text });
          break;
        }
        case "sidecar_status": {
          const available = await this._container.isAvailable();
          const status = available ? await this._container.status(this._sidecarProfile) : null;
          this._post({
            type: "sidecar_status",
            engineAvailable: available,
            profile: this._sidecarProfile.label,
            status,
            activeBackend: surface?.status().vectorBackend ?? "exact_local",
          });
          break;
        }
        case "sidecar_up": {
          const result = await this._container.up(this._sidecarProfile);
          this._post({ type: "sidecar_action", action: "up", ...result });
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "sidecar_stop": {
          const result = await this._container.stop(this._sidecarProfile);
          this._post({ type: "sidecar_action", action: "stop", ...result });
          await this._onMessage({ type: "sidecar_status" });
          break;
        }
        case "set_vector_backend": {
          if (!surface || !this._workbench.manager) break;
          const mode = String(msg.mode ?? "exact_local");
          if (mode === "pgvector_container") {
            const result = await createPgVectorProvider(connectionStringFor(this._sidecarProfile));
            if (result.ok && result.provider) {
              surface.setVectorProvider(result.provider);
              this._post({ type: "sidecar_action", action: "switch", ok: true, message: "Switched to pgvector sidecar." });
            } else {
              this._post({ type: "sidecar_action", action: "switch", ok: false, message: result.reason ?? "pgvector unavailable." });
            }
          } else {
            surface.setVectorProvider(new ExactLocalVectorProviderForSwitch(this._workbench.manager));
            this._post({ type: "sidecar_action", action: "switch", ok: true, message: "Switched to embedded exact search." });
          }
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
      }
    } catch (err) {
      this._post({ type: "data_error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private _postState(): void {
    if (!this._view) return;
    const surface = this._workbench.surface;
    const state: Record<string, unknown> = {
      type: "data_state",
      status: { ...this._workbench.status, assistantEnabled: this._assistantEnabled() },
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
    const absolute = path.isAbsolute(relativePath) ? relativePath : path.join(this._workspaceRoot, relativePath);
    if (!fs.existsSync(absolute)) {
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

  private _previewPageSize(): number {
    return this._config().get<number>("previewPageSize", 50);
  }

  private _maxQueryRows(): number {
    return this._config().get<number>("maxQueryRows", 500);
  }

  private _assistantEnabled(): boolean {
    return this._config().get<boolean>("enableAssistant", true);
  }
}
