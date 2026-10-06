/* Codebase Map webview: pixi star-map stage + HTML overlays — the command
   panel with the scope bar and search (top left), the workspace outline
   (left), the inspector for the selection (bottom left), display controls
   (right), and the legend. State flows store → PixiStage; interactions flow
   back through store actions. The panels live in ./panels. */

import { useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { zoomToFit } from "@/lib/graph/camera";
import { altitudeZoomRatio, type MapAltitude } from "@/lib/graph/view-model";
import type { GraphNode } from "@/lib/graph/protocol";
import { Inspector } from "./panels/Inspector";
import { OutlineRail } from "./panels/Outline";
import { useViewport } from "./panels/shared";
import { LabelsOverlay, EdgeLabelsOverlay } from "./panels/LabelsOverlay";
import { SearchBar } from "./panels/SearchBar";
import { Minimap } from "./panels/Minimap";
import { Legend, MapKeyPanel } from "./panels/Legend";
import { MapControls } from "./panels/MapControls";
import { LiveActivityChip, RunPlaybackControls, HelpChip, capacityWarning, LspDiagnostics } from "./panels/StatusChips";
import { MapButton } from "./panels/ui";


export function GraphApp() {
  const { view, camera, savedViews, pendingCameraRestore, pendingFocusPath } = useGraphStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const viewport = useViewport(containerRef);
  const [renderer, setRenderer] = useState<GraphRenderer | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showMapKey, setShowMapKey] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    actions.ready();
  }, []);

  const selectedNode = view.selectedNodeId
    ? view.displayNodes.find((node) => node.id === view.selectedNodeId) ?? null
    : null;
  const serviceProjectionEmpty = !view.indexing
    && !view.relationshipIndexing
    && view.display.lens === "services"
    && view.nodes.length > 0
    && view.displayNodes.length === 0;
  const workProjectionEmpty = !view.indexing
    && view.display.lens === "work"
    && view.ticketCount === 0;

  /* Latest values for the window-level key handler without re-attaching it. */
  const rendererRef = useRef<GraphRenderer | null>(null);
  rendererRef.current = renderer;
  const viewRef = useRef(view);
  viewRef.current = view;

  /* Zoom relative to the whole-map fit — the altitude meter's reference frame
     (same convention as LabelsOverlay's label bands). */
  const fitZoom = useMemo(() => zoomToFit(view.displayNodes, viewport).zoom, [view.displayNodes, viewport]);
  const zoomRatio = camera.zoom / Math.max(fitZoom, 1e-6);
  const flyToAltitude = (band: MapAltitude) => {
    rendererRef.current?.flyTo({ cx: camera.cx, cy: camera.cy, zoom: fitZoom * altitudeZoomRatio(band) });
  };

  /* Fly to a node, expanding its cluster first if it's currently collapsed
     (search results and follow-agent can target a file hidden inside a
     super-node). The actual focus is deferred to the effect below, which fires
     once the newly-expanded file lands in displayNodes. */
  const pendingFocusRef = useRef<string | null>(null);
  const visibleFocusTarget = (id: string): string | null => {
    const state = viewRef.current;
    if (state.displayNodes.some((node) => node.id === id)) return id;
    if (state.display.lens !== "services") return null;
    /* Live activity and file search originate as file paths. In the Services
       lens project those paths to the most-specific visible service rather
       than selecting an invisible file and leaving the camera unchanged. */
    let service: GraphNode | null = null;
    for (const node of state.displayNodes) {
      if (node.kind !== "service") continue;
      if (node.dir !== "." && id !== node.dir && !id.startsWith(`${node.dir}/`)) continue;
      if (!service || node.dir.length > service.dir.length || (node.dir.length === service.dir.length && node.id < service.id)) {
        service = node;
      }
    }
    return service?.id ?? null;
  };
  const flyToNode = (id: string, target = visibleFocusTarget(id)): string | null => {
    if (target) {
      rendererRef.current?.focusNode(target);
      return target;
    }
    /* In service mode, an unmatched file has no representation. Deliberately
       return null instead of queuing a file focus that could surprise the user
       after changing lenses later. */
    if (viewRef.current.display.lens === "services") return null;
    const file = viewRef.current.nodes.find((node) => node.id === id);
    if (file) {
      pendingFocusRef.current = id;
      /* Folded by the scope or the focus budget: scope so it is drawn. A
         folder collapsed by hand still just expands. */
      if (viewRef.current.collapsedClusters.includes(file.dir)) actions.setClusterCollapsed(file.dir, false);
      else actions.revealInScope(id);
    }
    return null;
  };
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && view.displayNodes.some((n) => n.id === pending)) {
      pendingFocusRef.current = null;
      actions.select(pending);
      rendererRef.current?.focusNode(pending);
    }
  }, [view.displayNodes]);

  /* Scope changes re-frame the camera on what is now drawn, once the new
     display graph has reached the renderer. */
  const scopeKey = `${view.scope.join("|")}#${view.scopeMode}`;
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    const frame = requestAnimationFrame(() => rendererRef.current?.zoomToFitAll());
    return () => cancelAnimationFrame(frame);
  }, [scopeKey]);

  /* Saved-view restore: display/filter/collapse state applies immediately
     (store.ts's applyView), but the camera is renderer-owned, so flying there
     happens here once the renderer instance is available. */
  useEffect(() => {
    if (!pendingCameraRestore) return;
    rendererRef.current?.flyTo(pendingCameraRestore);
    actions.clearCameraRestore();
  }, [pendingCameraRestore]);

  const focusNode = (id: string) => {
    const target = visibleFocusTarget(id);
    flyToNode(id, target);
    if (target) actions.select(target);
    else if (viewRef.current.display.lens === "services") actions.select(null);
  };

  /* Host-requested navigation ("Show on map" from the Notes timeline): select
     and fly to the file's star once the renderer and node data are live. */
  useEffect(() => {
    if (!pendingFocusPath || !renderer || view.nodes.length === 0) return;
    /* A corpus search pick waits for its scope's files to arrive. */
    if (!view.nodes.some((node) => node.id === pendingFocusPath) && view.detailGroups.length > 0 && view.indexedFileCount > view.nodes.length) return;
    actions.clearPendingFocus();
    focusNode(pendingFocusPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusPath, renderer, view.nodes]);

  /* Follow mode: gently fly to the file the agent is actively working on when
     it changes. Only fires on a *new* primary target (not every message) so a
     sustained edit doesn't jitter the camera; resets when toggled off. */
  const lastFollowedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!view.display.followAgent || view.runPlayback.mode === "playback") {
      lastFollowedRef.current = null;
      return;
    }
    const primary = view.liveActivity[0]?.path ?? null;
    if (primary && primary !== lastFollowedRef.current) {
      lastFollowedRef.current = primary;
      /* Following the agent must not tear the user out of an overview: a file
         folded into a group is followed by gliding to that group. */
      const folded = viewRef.current.displayFoldOf.get(primary);
      if (folded && !visibleFocusTarget(primary)) rendererRef.current?.focusNode(folded);
      else flyToNode(primary);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.display.followAgent, view.liveActivity, view.runPlayback.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = rendererRef.current;
      const v = viewRef.current;
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      const usingControl = Boolean(target?.closest("input, textarea, select, button, summary, [contenteditable='true'], [role='combobox'], [role='listbox']"));

      if (e.key === "Escape") {
        if (typing) target?.blur();
        if (v.search) actions.setSearch("");
        else if (v.selectedNodeId) actions.select(null);
        return;
      }
      if (typing || usingControl) return; /* interactive chrome owns every other key */

      switch (e.key) {
        case "Backspace":
          e.preventDefault();
          actions.scopeUp();
          break;
        case "/":
          e.preventDefault();
          searchInputRef.current?.focus();
          break;
        case "f":
        case "F":
          r?.zoomToFitAll();
          break;
        case "+":
        case "=":
          r?.zoomBy(1.25);
          break;
        case "-":
        case "_":
          r?.zoomBy(0.8);
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          e.preventDefault();
          r?.panBy(e.shiftKey ? 200 : 70, 0);
          break;
        case "ArrowRight":
        case "d":
        case "D":
          e.preventDefault();
          r?.panBy(e.shiftKey ? -200 : -70, 0);
          break;
        case "ArrowUp":
        case "w":
        case "W":
          e.preventDefault();
          r?.panBy(0, e.shiftKey ? 200 : 70);
          break;
        case "ArrowDown":
        case "s":
        case "S":
          e.preventDefault();
          r?.panBy(0, e.shiftKey ? -200 : -70);
          break;
        case "Enter":
          if (v.selectedNodeId) actions.activateNode(v.selectedNodeId);
          break;
        case "?":
          setShowHelp((s) => !s);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={containerRef} className="map-root relative h-screen w-full overflow-hidden text-foreground">
      <PixiStage view={view} initialCamera={camera} onRenderer={setRenderer} onInitError={setRenderError} />
      {/* Depth vignette: subtly darkens the viewport edges so the eye settles
          on the center of the star-map. Above the canvas, below every label
          and panel so nothing interactive is dimmed. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.42) 100%)" }}
      />
      <LabelsOverlay
        view={view}
        camera={camera}
        viewport={viewport}
        hoveredId={view.hoveredNodeId}
        selectedId={view.selectedNodeId}
      />
      <EdgeLabelsOverlay view={view} camera={camera} viewport={viewport} />
      <SearchBar
        view={view}
        search={view.search}
        nodes={view.nodes}
        searchNodes={view.display.lens === "services" ? view.displayNodes : view.nodes}
        indexedFileCount={view.indexedFileCount}
        indexedImportCount={view.indexedImportEdgeCount}
        hiddenByPolicyCount={view.hiddenByPolicyCount}
        excludeDotDirectories={view.config.excludeDotDirectories !== false}
        indexing={view.indexing}
        relationshipIndexing={view.relationshipIndexing}
        inputRef={searchInputRef}
        onPick={focusNode}
      />
      <MapControls renderer={renderer} view={view} savedViews={savedViews} camera={camera} viewport={viewport} onFocusNode={focusNode} />
      <LspDiagnostics view={view} />
      {view.displayNodes.length >= 3 && (
        <Minimap view={view} camera={camera} viewport={viewport} onJump={(x, y) => renderer?.focusWorld(x, y)} />
      )}
      <RunPlaybackControls view={view} />
      {view.runPlayback.mode === "live" && <LiveActivityChip live={view.liveActivity} onFocus={focusNode} />}
      {view.truncated && (
        <div
          className={`map-status-warning pointer-events-auto absolute left-1/2 -translate-x-1/2 text-2xs ${
            view.runPlayback.mode === "playback"
              ? "top-20"
              : view.liveActivity.length > 0 && view.runPlayback.summaries.length > 0
                ? "top-24"
                : view.liveActivity.length > 0 || view.runPlayback.summaries.length > 0
                ? "top-14"
                : "top-3"
          }`}
          title="Raise the indexed, rendered, or relationship caps in Blacksite's graph settings on capable machines."
          role="status"
        >
          {capacityWarning(view)}
        </div>
      )}
      {!renderError && view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="map-panel map-card map-analysis-progress flex items-center gap-2 !py-2 text-sm text-[color:var(--map-text-2)]" role="status" aria-live="polite">
            <span className="map-live-pip" aria-hidden />
            Indexing the workspace…
          </div>
        </div>
      )}
      {!renderError && !view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
          <div className="map-panel map-card pointer-events-auto flex max-w-[300px] flex-col items-center gap-2 text-center">
            <span className="text-sm font-semibold text-[color:var(--map-text)]">Nothing indexed yet</span>
            <span className="map-hint !text-xs">Build the map to see every file, folder, and how they connect.</span>
            <MapButton variant="primary" onClick={() => actions.rebuildIndex()}>Index workspace</MapButton>
          </div>
        </div>
      )}
      {!renderError && !view.indexing && view.relationshipIndexing && view.display.lens === "services" && view.displayNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="map-panel map-card map-analysis-progress flex items-center gap-2 !py-2 text-sm text-[color:var(--map-text-2)]" role="status" aria-live="polite">
            <span className="map-live-pip" aria-hidden />
            Tracing API, event, and data contracts…
          </div>
        </div>
      )}
      {!renderError && serviceProjectionEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
          <div className="map-panel map-card pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 text-center" role="status" aria-live="polite" data-map-region="service-empty">
            <span className="text-sm font-semibold text-[color:var(--map-text)]">No visible service routes</span>
            <span className="map-hint !text-xs">
              {view.relationshipEdges.length === 0
                ? "No service/API relationships have been detected in this workspace yet."
                : "Every service relationship layer is currently hidden."}
            </span>
            <div className="flex gap-1.5">
              {view.relationshipEdges.length > 0 && (
                <MapButton size="xs" variant="primary" onClick={() => actions.setDisplay({ showApi: true, showEvents: true, showData: true, showConfig: true })}>Show routes</MapButton>
              )}
              {view.relationshipEdges.length === 0 && (
                <MapButton size="xs" variant="primary" onClick={() => actions.rebuildIndex()}>Re-index</MapButton>
              )}
              <MapButton size="xs" variant="ghost" onClick={() => actions.setDisplay({ lens: "files" })}>Browse files</MapButton>
            </div>
          </div>
        </div>
      )}
      {!renderError && workProjectionEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
          <div className="map-panel map-card pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 text-center" role="status" aria-live="polite" data-map-region="work-empty">
            <span className="text-sm font-semibold text-[color:var(--map-text)]">No open work tickets</span>
            <span className="map-hint !text-xs">File a ticket from the Tickets view, a todo or risk map note, or a plan phase that finds work it should not absorb.</span>
            <div className="flex gap-1.5">
              <MapButton size="xs" variant="primary" onClick={() => actions.openTickets()}>Open Tickets</MapButton>
              <MapButton size="xs" variant="ghost" onClick={() => actions.setDisplay({ lens: "files" })}>Browse files</MapButton>
            </div>
          </div>
        </div>
      )}
      {renderError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="map-panel max-w-[280px] text-center text-sm text-[color:var(--map-text-2)]" role="alert">
            <div>Couldn&apos;t start the map&apos;s renderer.</div>
            <div className="mt-1 text-xs opacity-70" title={renderError}>{renderError}</div>
          </div>
        </div>
      )}
      <OutlineRail view={view} onFocusNode={focusNode} defaultOpen={viewport.width > 720 && viewport.height > 640} />
      {selectedNode && <Inspector view={view} node={selectedNode} onFocus={focusNode} />}
      {showMapKey
        ? <MapKeyPanel onClose={() => setShowMapKey(false)} />
        : (
          <Legend
            fileCount={view.nodes.length}
            importCount={view.renderedImportEdgeCount}
            gitHeat={view.display.showGitHeat}
            relationshipCount={view.relationshipEdges.length}
            servicesLens={view.display.lens === "services"}
            zoomRatio={zoomRatio}
            onAltitude={flyToAltitude}
            onOpenMapKey={() => setShowMapKey(true)}
          />
        )}
      <HelpChip open={showHelp} onToggle={() => setShowHelp((s) => !s)} />
    </div>
  );
}
