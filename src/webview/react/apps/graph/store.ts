/* Map webview store. Single module-level store (one instance per bundle) that
   owns the graph view-model + camera and dispatches the graph provider's
   messages. Subscribed via useSyncExternalStore, mirroring apps/data/store.ts. */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";
import {
  DEFAULT_DISPLAY_OPTIONS,
  applyMessage,
  collapseSymbols,
  initialState,
  type GraphDisplayOptions,
  type GraphViewState,
} from "@/lib/graph/view-model";
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

function readDisplayPrefs(): Partial<GraphViewState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Pick<GraphViewState, "display" | "symbolsEnabled">>;
    return {
      symbolsEnabled: parsed.symbolsEnabled === true,
      search: typeof (parsed as { search?: unknown }).search === "string" ? (parsed as { search: string }).search : "",
      display: {
        ...DEFAULT_DISPLAY_OPTIONS,
        ...(parsed.display && typeof parsed.display === "object" ? parsed.display : {}),
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
      search: state.view.search,
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
    persistDisplayPrefs();
    bump();
  },
  select(nodeId: string | null): void {
    state.view = { ...state.view, selectedNodeId: nodeId };
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
    state.view = { ...state.view, display: { ...state.view.display, ...display } };
    persistDisplayPrefs();
    bump();
  },
  /** Called by the renderer (rAF-throttled) so HTML overlays track the camera. */
  cameraMoved(camera: Camera): void {
    state.camera = camera;
    state.cameraVersion += 1;
    persistCameraPrefs(camera);
    bump();
  },
};
