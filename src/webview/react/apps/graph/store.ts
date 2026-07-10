/* Map webview store. Single module-level store (one instance per bundle) that
   owns the graph view-model + camera and dispatches the graph provider's
   messages. Subscribed via useSyncExternalStore, mirroring apps/data/store.ts. */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";
import {
  DEFAULT_DISPLAY_OPTIONS,
  DEFAULT_FILTER,
  applyMessage,
  applySavedView,
  collapseAllClusters,
  collapseSymbols,
  expandAllClusters,
  initialState,
  setClusterCollapsed,
  withDisplayGraph,
  type GraphDisplayOptions,
  type GraphFilter,
  type GraphViewState,
  type SavedView,
} from "@/lib/graph/view-model";
import { isClusterNodeId } from "@/lib/graph/view-model";
import { isGraphHostMessage, type GraphWebviewMessage } from "@/lib/graph/protocol";
import type { Camera } from "@/lib/graph/camera";

export interface GraphStoreState {
  view: GraphViewState;
  camera: Camera;
  /** Bumped by the renderer on camera motion so label overlays re-project. */
  cameraVersion: number;
  pendingSymbolPath: string | null;
  savedViews: SavedView[];
  /** Set by applyView, consumed by GraphApp.tsx's flyTo effect (camera is
      renderer-owned, so restoring it can't happen purely in this store). */
  pendingCameraRestore: Camera | null;
}

const PREF_KEY = "blacksite.map.display";
const CAMERA_KEY = "blacksite.map.camera";
const SAVED_VIEWS_KEY = "blacksite.map.savedViews";

/** Layer/symbol prefs only — deliberately excludes `search`: a lingering
    filter from a past session would silently dim most of a *different*
    browsing session's files with no visible cause. */
function readDisplayPrefs(): Partial<GraphViewState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Pick<GraphViewState, "display" | "symbolsEnabled" | "collapsedClusters" | "filter">>;
    return {
      symbolsEnabled: parsed.symbolsEnabled === true,
      display: {
        ...DEFAULT_DISPLAY_OPTIONS,
        ...(parsed.display && typeof parsed.display === "object" ? parsed.display : {}),
      },
      collapsedClusters: Array.isArray(parsed.collapsedClusters)
        ? parsed.collapsedClusters.filter((d): d is string => typeof d === "string")
        : [],
      filter: {
        ...DEFAULT_FILTER,
        ...(parsed.filter && typeof parsed.filter === "object" ? parsed.filter : {}),
      },
    };
  } catch {
    return {};
  }
}

function persistDisplayPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify({
      symbolsEnabled: state.view.symbolsEnabled,
      display: state.view.display,
      collapsedClusters: state.view.collapsedClusters,
      filter: state.view.filter,
    }));
  } catch {
    /* Persistence is best-effort inside VS Code webviews. */
  }
}

function readCameraPrefs(): Camera {
  if (typeof window === "undefined") return { cx: 0, cy: 0, zoom: 1 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CAMERA_KEY) ?? "null") as Partial<Camera> | null;
    if (!parsed) return { cx: 0, cy: 0, zoom: 1 };
    const cx = Number(parsed.cx);
    const cy = Number(parsed.cy);
    const zoom = Number(parsed.zoom);
    return {
      cx: Number.isFinite(cx) ? cx : 0,
      cy: Number.isFinite(cy) ? cy : 0,
      zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    };
  } catch {
    return { cx: 0, cy: 0, zoom: 1 };
  }
}

function persistCameraPrefs(camera: Camera): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAMERA_KEY, JSON.stringify(camera));
  } catch {
    /* best-effort */
  }
}

function isSavedView(value: unknown): value is SavedView {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SavedView>;
  return typeof v.id === "string"
    && typeof v.name === "string"
    && typeof v.createdAt === "string"
    && Boolean(v.camera && typeof v.camera === "object")
    && Boolean(v.display && typeof v.display === "object")
    && Boolean(v.filter && typeof v.filter === "object")
    && Array.isArray(v.collapsedClusters);
}

function readSavedViews(): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_VIEWS_KEY) ?? "null") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSavedView) : [];
  } catch {
    return [];
  }
}

function persistSavedViews(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(state.savedViews));
  } catch {
    /* best-effort */
  }
}

function generateViewId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The renderer reports camera motion every animation frame (drag, wheel,
    fly-to) — up to ~40/sec. Writing to localStorage synchronously on each one
    was real, avoidable jank during a pan gesture. Trailing-debounce the write
    instead; losing the last <300ms of position on an abrupt close is a fine
    trade for a smooth drag. */
let cameraPersistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersistCamera(camera: Camera): void {
  if (cameraPersistTimer) clearTimeout(cameraPersistTimer);
  cameraPersistTimer = setTimeout(() => {
    cameraPersistTimer = undefined;
    persistCameraPrefs(camera);
  }, 300);
}

export const state: GraphStoreState = {
  view: { ...initialState(), ...readDisplayPrefs() },
  camera: readCameraPrefs(),
  cameraVersion: 0,
  pendingSymbolPath: null,
  savedViews: readSavedViews(),
  pendingCameraRestore: null,
};

let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): number {
  return version;
}

export function useGraphStore(): GraphStoreState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return state;
}

function send(message: GraphWebviewMessage): void {
  post(message);
}

onMessage((msg) => {
  if (!isGraphHostMessage(msg)) return;
  state.view = applyMessage(state.view, msg, Date.now());
  if (msg.type === "symbols_state" && state.pendingSymbolPath === msg.path) {
    state.pendingSymbolPath = null;
  }
  bump();
});

export const actions = {
  ready(): void {
    send({ type: "ready" });
  },
  rebuildIndex(): void {
    send({ type: "rebuild_index" });
  },
  openFullMap(): void {
    send({ type: "open_full_map" });
  },
  /** Set the neighborhood-territory layout mode. The host persists it and
      rebuilds; the new config comes back via graph_config, so we don't mutate
      local state here. */
  setNeighborhoodMode(mode: "auto" | "on" | "off"): void {
    send({ type: "set_neighborhoods", mode });
  },
  openFile(path: string, line?: number): void {
    send({ type: "open_file", path, line });
  },
  /** Double-click / "open" gesture on a node: expand a collapsed cluster's
      super-node in place, or open a real file. */
  activateNode(id: string): void {
    if (isClusterNodeId(id)) {
      state.view = setClusterCollapsed(state.view, id.slice(1), false);
      persistDisplayPrefs();
      bump();
      return;
    }
    send({ type: "open_file", path: id });
  },
  removeAnnotation(id: string): void {
    send({ type: "remove_annotation", id });
  },
  /** Reveal a language-server extension in the Extensions view for one-click
      install (from the LSP onboarding panel). */
  installExtension(extensionId: string): void {
    send({ type: "install_extension", extensionId });
  },
  /** Turn blacksite.graph.backgroundSymbols on/off (from the LSP onboarding
      panel). The updated value comes back via graph_config, same as
      set_neighborhoods — no local state mutation needed here. */
  setBackgroundSymbols(enabled: boolean): void {
    send({ type: "set_background_symbols", enabled });
  },
  expandSymbols(path: string): void {
    state.pendingSymbolPath = path;
    bump();
    send({ type: "expand_symbols", path });
  },
  collapseSymbols(path: string): void {
    state.view = collapseSymbols(state.view, path);
    if (state.pendingSymbolPath === path) state.pendingSymbolPath = null;
    bump();
    send({ type: "collapse_symbols", path });
  },
  setSearch(query: string): void {
    state.view = { ...state.view, search: query };
    bump();
  },
  select(nodeId: string | null): void {
    /* Isolate is rooted at the selection; dropping the selection retires it so
       the map doesn't stay mysteriously filtered with nothing selected. */
    const clearIsolate = !nodeId && state.view.filter.isolateDepth > 0;
    const filter = clearIsolate ? { ...state.view.filter, isolateDepth: 0 } : state.view.filter;
    state.view = { ...state.view, selectedNodeId: nodeId, filter };
    if (clearIsolate) persistDisplayPrefs();
    bump();
  },
  hover(nodeId: string | null): void {
    if (state.view.hoveredNodeId === nodeId) return;
    state.view = { ...state.view, hoveredNodeId: nodeId };
    bump();
  },
  toggleSymbols(): void {
    state.view = { ...state.view, symbolsEnabled: !state.view.symbolsEnabled };
    persistDisplayPrefs();
    bump();
  },
  traceRelationships(path: string): void {
    state.view = {
      ...state.view,
      symbolsEnabled: true,
      display: { ...state.view.display, showRelations: true },
    };
    persistDisplayPrefs();
    state.pendingSymbolPath = path;
    bump();
    send({ type: "expand_symbols", path });
  },
  setDisplay(display: Partial<GraphDisplayOptions>): void {
    state.view = withDisplayGraph({ ...state.view, display: { ...state.view.display, ...display } });
    persistDisplayPrefs();
    bump();
  },
  collapseAllClusters(): void {
    state.view = collapseAllClusters(state.view);
    persistDisplayPrefs();
    bump();
  },
  expandAllClusters(): void {
    state.view = expandAllClusters(state.view);
    persistDisplayPrefs();
    bump();
  },
  /** Expand a single collapsed cluster (e.g. clicking its super-node) or
      collapse an expanded one. */
  setClusterCollapsed(dir: string, collapsed: boolean): void {
    state.view = setClusterCollapsed(state.view, dir, collapsed);
    persistDisplayPrefs();
    bump();
  },
  setFilter(filter: Partial<GraphFilter>): void {
    state.view = { ...state.view, filter: { ...state.view.filter, ...filter } };
    persistDisplayPrefs();
    bump();
  },
  toggleLanguage(lang: string): void {
    const langs = state.view.filter.langs.includes(lang)
      ? state.view.filter.langs.filter((l) => l !== lang)
      : [...state.view.filter.langs, lang];
    state.view = { ...state.view, filter: { ...state.view.filter, langs } };
    persistDisplayPrefs();
    bump();
  },
  /** Solo/unsolo a folder territory (ghost everything outside filter.dirs). */
  toggleDirFilter(dir: string): void {
    const dirs = state.view.filter.dirs.includes(dir)
      ? state.view.filter.dirs.filter((d) => d !== dir)
      : [...state.view.filter.dirs, dir];
    state.view = { ...state.view, filter: { ...state.view.filter, dirs } };
    persistDisplayPrefs();
    bump();
  },
  /** Transient territory preview from the rail's territory index — the
      renderer lifts that territory's stars while the pointer rests on a row.
      Never persisted (unlike the solo filter above). */
  hoverTerritory(dir: string | null): void {
    if (state.view.hoveredTerritory === dir) return;
    state.view = { ...state.view, hoveredTerritory: dir };
    bump();
  },
  clearFilter(): void {
    state.view = { ...state.view, filter: { ...DEFAULT_FILTER } };
    persistDisplayPrefs();
    bump();
  },
  /** Called by the renderer (rAF-throttled) so HTML overlays track the camera. */
  cameraMoved(camera: Camera): void {
    state.camera = camera;
    state.cameraVersion += 1;
    schedulePersistCamera(camera);
    bump();
  },
  /** Snapshot the current camera + display/filter/collapse state under a name. */
  saveView(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const view: SavedView = {
      id: generateViewId(),
      name: trimmed,
      createdAt: new Date().toISOString(),
      camera: state.camera,
      display: state.view.display,
      filter: state.view.filter,
      collapsedClusters: state.view.collapsedClusters,
    };
    state.savedViews = [...state.savedViews, view];
    persistSavedViews();
    bump();
  },
  /** Restore a saved view's display/filter/collapse state immediately; the
      camera flies there via pendingCameraRestore (consumed in GraphApp.tsx). */
  applyView(id: string): void {
    const view = state.savedViews.find((v) => v.id === id);
    if (!view) return;
    state.view = applySavedView(state.view, view);
    state.pendingCameraRestore = view.camera;
    persistDisplayPrefs();
    bump();
  },
  deleteView(id: string): void {
    state.savedViews = state.savedViews.filter((v) => v.id !== id);
    persistSavedViews();
    bump();
  },
  /** Consumed by GraphApp.tsx once its flyTo effect has fired. */
  clearCameraRestore(): void {
    state.pendingCameraRestore = null;
    bump();
  },
};
