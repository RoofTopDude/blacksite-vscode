/* Map webview store. Single module-level store (one instance per bundle) that
   owns the graph view-model + camera and dispatches the graph provider's
   messages. Subscribed via useSyncExternalStore, mirroring apps/data/store.ts. */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";
import {
  DEFAULT_DISPLAY_OPTIONS,
  DEFAULT_FILTER,
  applyMessage,
  collapseAllClusters,
  collapseSymbols,
  expandAllClusters,
  initialState,
  setClusterCollapsed,
  withDisplayGraph,
  type GraphDisplayOptions,
  type GraphFilter,
  type GraphViewState,
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
}

const PREF_KEY = "blacksite.map.display";
const CAMERA_KEY = "blacksite.map.camera";

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
};
