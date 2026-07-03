/* Map webview store. Single module-level store (one instance per bundle) that
   owns the graph view-model + camera and dispatches the graph provider's
   messages. Subscribed via useSyncExternalStore, mirroring apps/data/store.ts. */

import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";
import {
  applyMessage,
  collapseSymbols,
  initialState,
  type GraphViewState,
} from "@/lib/graph/view-model";
import { isGraphHostMessage, type GraphWebviewMessage } from "@/lib/graph/protocol";
import type { Camera } from "@/lib/graph/camera";

export interface GraphStoreState {
  view: GraphViewState;
  camera: Camera;
  /** Bumped by the renderer on camera motion so label overlays re-project. */
  cameraVersion: number;
}

export const state: GraphStoreState = {
  view: initialState(),
  camera: { cx: 0, cy: 0, zoom: 1 },
  cameraVersion: 0,
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
    send({ type: "expand_symbols", path });
  },
  collapseSymbols(path: string): void {
    state.view = collapseSymbols(state.view, path);
    bump();
    send({ type: "collapse_symbols", path });
  },
  setSearch(query: string): void {
    state.view = { ...state.view, search: query };
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
    bump();
  },
  /** Called by the renderer (rAF-throttled) so HTML overlays track the camera. */
  cameraMoved(camera: Camera): void {
    state.camera = camera;
    state.cameraVersion += 1;
    bump();
  },
};
