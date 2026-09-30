/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useEffect, useMemo, useState } from "react";
import type { GraphRenderer } from "../scene/renderer";
import { actions } from "../store";
import { zoomToFit, type Camera, type Viewport } from "@/lib/graph/camera";
import {
  ANNOTATION_COLOR,
  IMPORT_EDGE_COLOR,
  RELATIONSHIP_EDGE_COLORS,
  cssColor,
  folderColor,
} from "@/lib/graph/colors";
import { FILE_ROLE_COLORS, FILE_ROLE_LABELS, roleCounts } from "@/lib/graph/file-role";
import {
  baseName,
  clusterBackboneEdges,
  edgePresentation,
  filterIsActive,
  folderTerritories,
  languageCounts,
  linkKindCounts,
  serviceRelationshipBackbone,
  serviceRelationshipBundles,
  shortClusterLabel,
  topHubs,
  visibleNodeIds,
  type EdgeMode,
  type GraphViewState,
  type SavedView,
} from "@/lib/graph/view-model";
import type { EdgeKind } from "@/lib/graph/protocol";
import { ChevronDown, Maximize2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { ROLE_MARK_GLYPHS, MAX_TERRITORY_RAIL_ITEMS } from "./shared";
import { DepthSection } from "./Legend";

/** The file-lens link families, each carrying the exact hue its edges are
    drawn with (same constants the renderer strokes), so the chips double as a
    live legend: toggle a chip, and precisely that colored strand set appears
    or disappears on the canvas. */
export const LINK_TYPES: Array<{
  key: "showImports" | "showCalls" | "showRefs" | "showInheritance" | "showAnnotations";
  kind: EdgeKind | null;
  label: string;
  color: number;
  dashed?: boolean;
  hint: string;
}> = [
  { key: "showImports", kind: "import", label: "Imports", color: IMPORT_EDGE_COLOR, hint: "Module imports/includes between files" },
  { key: "showCalls", kind: "call", label: "Calls", color: RELATIONSHIP_EDGE_COLORS.call ?? IMPORT_EDGE_COLOR, hint: "Call flow from the background symbol sweep" },
  { key: "showRefs", kind: "reference", label: "References", color: RELATIONSHIP_EDGE_COLORS.reference ?? IMPORT_EDGE_COLOR, hint: "Symbol references from the background symbol sweep" },
  { key: "showInheritance", kind: "supertype", label: "Inheritance", color: RELATIONSHIP_EDGE_COLORS.supertype ?? IMPORT_EDGE_COLOR, hint: "Extends/implements relationships" },
  { key: "showAnnotations", kind: null, label: "Notes", color: ANNOTATION_COLOR, dashed: true, hint: "Working-memory notes the agent (or you) attached" },
];

/** Color-coded, per-relationship link filters for the file lens. Every chip is
    both a filter and a legend row: swatch = the edge family's true canvas
    color, count = how many such links the current graph carries. */
export function LinkTypesSection({ view }: { view: GraphViewState }) {
  const counts = useMemo(() => linkKindCounts(view.edges), [view.edges]);
  const noteCount = view.annotations.length;
  return (
    <div className="map-control-section" data-map-region="link-types">
      <div className="map-control-title">Link types</div>
      <div className="flex flex-col gap-0.5">
        {LINK_TYPES.map(({ key, kind, label, color, dashed, hint }) => {
          const count = kind ? counts[kind] ?? 0 : noteCount;
          const on = view.display[key];
          const css = cssColor(color);
          return (
            <button
              type="button"
              key={key}
              className={`map-link-chip ${on ? "map-link-chip-on" : ""}`}
              aria-pressed={on}
              data-map-control={`link-${key}`}
              disabled={count === 0 && !on}
              onClick={() => actions.setDisplay({ [key]: !on })}
              title={`${hint} — ${count.toLocaleString()} on the map. Click to ${on ? "hide" : "show"}.`}
              style={on ? { borderColor: `${css}55`, background: `linear-gradient(90deg, ${css}1c, transparent)` } : undefined}
            >
              <span
                className={`h-0 w-5 shrink-0 border-t-[2px] ${dashed ? "border-dashed" : "border-solid"}`}
                style={{ borderColor: css, opacity: on ? 1 : 0.35 }}
                aria-hidden
              />
              <span className={`min-w-0 flex-1 truncate text-left text-xs ${on ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const EDGE_MODES: Array<{ value: EdgeMode; label: string }> = [
  { value: "all", label: "Adaptive" },
  { value: "selected", label: "Focus" },
  { value: "clusters", label: "Bundles" },
  { value: "off", label: "Off" },
];

export function MapControls({ renderer, view, savedViews, camera, viewport, onFocusNode }: {
  renderer: GraphRenderer | null;
  view: GraphViewState;
  savedViews: SavedView[];
  camera: Camera;
  viewport: Viewport;
  onFocusNode: (id: string) => void;
}) {
  const [controlsExpanded, setControlsExpanded] = useState<boolean | null>(null);
  const expanded = controlsExpanded ?? viewport.width > 720;
  const setLayer = (key: "showImports" | "showAnnotations" | "showRelations" | "showEdgeLabels" | "showGitHeat" | "showTicketHeat" | "showApi" | "showEvents" | "showData" | "showConfig" | "showCycles" | "showCulDeSacs") => {
    actions.setDisplay({ [key]: !view.display[key] });
  };
  const gitData = useMemo(() => view.displayNodes.some((n) => n.lastCommitAt), [view.displayNodes]);
  const topologyIds = useMemo(
    () => visibleNodeIds(view.displayNodes, view.displayEdges, view.annotations, view.filter, view.selectedNodeId),
    [view.annotations, view.displayEdges, view.displayNodes, view.filter, view.selectedNodeId],
  );
  const topologyNodes = useMemo(
    () => topologyIds ? view.displayNodes.filter((node) => topologyIds.has(node.id)) : view.displayNodes,
    [topologyIds, view.displayNodes],
  );
  const topologyEdges = useMemo(
    () => topologyIds
      ? view.displayEdges.filter((edge) => topologyIds.has(edge.from) && topologyIds.has(edge.to))
      : view.displayEdges,
    [topologyIds, view.displayEdges],
  );
  const edgeCount = topologyEdges.length;
  const serviceBundles = useMemo(
    () => view.display.lens === "services"
      ? serviceRelationshipBundles(topologyNodes, topologyEdges)
      : [],
    [topologyEdges, topologyNodes, view.display.lens],
  );
  /* Dense-service decisions use typed routes, not raw detections: hundreds of
     observations of one API do not make a visually dense topology. */
  const topologyRouteCount = view.display.lens === "services" ? serviceBundles.length : edgeCount;
  const fitZoom = useMemo(() => zoomToFit(view.displayNodes, viewport).zoom, [view.displayNodes, viewport]);
  const presentation = edgePresentation(
    view.display.edgeMode,
    view.display.lens,
    topologyNodes.length,
    topologyRouteCount,
    camera.zoom / Math.max(fitZoom, 1e-6),
  );
  const bundleCount = useMemo(
    () => view.display.lens === "services"
      ? serviceRelationshipBackbone(serviceBundles).length
      : clusterBackboneEdges(topologyNodes, topologyEdges).length,
    [serviceBundles, topologyEdges, topologyNodes, view.display.lens],
  );
  const presentationLabel = view.display.lens === "services"
    ? presentation.strategy === "bundled"
      ? `${bundleCount.toLocaleString()} backbone routes`
      : presentation.strategy === "raw"
        ? `${serviceBundles.length.toLocaleString()} typed routes`
        : presentation.strategy === "selected"
          ? "Focus only"
          : "Connections off"
    : presentation.strategy === "bundled"
    ? `${bundleCount.toLocaleString()} routes`
    : presentation.strategy === "raw"
      ? "File detail"
      : presentation.strategy === "selected"
        ? "Focus only"
        : "Connections off";
  return (
    <aside
      className="map-toolbar pointer-events-auto absolute right-3 top-[178px] flex w-[204px] flex-col"
      data-expanded={expanded}
      aria-label="Map controls"
      data-map-region="controls"
    >
      <button
        type="button"
        className="map-toolbar-header"
        aria-label="Display & analysis"
        aria-expanded={expanded}
        aria-controls="map-controls-content"
        onClick={() => setControlsExpanded(!expanded)}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        <span className="map-toolbar-title">Display &amp; analysis</span>
        <ChevronDown className="map-toolbar-chevron" size={14} aria-hidden="true" />
      </button>
      <div id="map-controls-content" className="map-controls-content" hidden={!expanded}>
      <div className="map-presentation-status" data-map-edge-strategy={presentation.strategy}>
        <span>{view.display.lens === "services" ? "Services" : presentation.strategy === "bundled" ? "Overview" : presentation.strategy === "raw" ? "Detail" : "Mode"}</span>
        <strong>{presentationLabel}</strong>
      </div>
      <div className="map-toolbar-scroll">
      <div className="map-control-section">
        <div className="map-control-title">View</div>
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            className={`map-tool-button ${view.display.lens === "files" ? "map-tool-button-active" : ""}`}
            aria-pressed={view.display.lens === "files"}
            data-map-control="lens-files"
            onClick={() => actions.setDisplay({ lens: "files" })}
            title="Files, folders, and codebases with their imports and structural links"
          >
            Structure
          </button>
          <button
            type="button"
            className={`map-tool-button ${view.display.lens === "services" ? "map-tool-button-active" : ""}`}
            aria-pressed={view.display.lens === "services"}
            data-map-control="lens-services"
            onClick={() => actions.setDisplay({ lens: "services" })}
            disabled={view.relationshipEdges.length === 0 && view.display.lens !== "services"}
            title={view.relationshipEdges.length === 0 ? "No service API relationships detected yet" : "Show service/API relationships"}
          >
            Services
          </button>
          <button
            type="button"
            className={`map-tool-button ${view.display.lens === "work" ? "map-tool-button-active" : ""}`}
            aria-pressed={view.display.lens === "work"}
            data-map-control="lens-work"
            onClick={() => actions.setDisplay({ lens: "work" })}
            title={view.ticketCount === 0 ? "No open tickets yet — open the lens to see how to recover" : "Show tickets, their territory, blockers, and overlapping scope"}
          >
            Work
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button type="button" className="map-tool-button" data-map-control="fit" onClick={() => renderer?.zoomToFitAll()}><Maximize2 size={12} aria-hidden="true" /> Fit map</button>
          <button type="button" className="map-tool-button" data-map-control="reindex" onClick={() => actions.rebuildIndex()} disabled={view.indexing}>
            <RefreshCw size={12} aria-hidden="true" /> {view.indexing ? "Indexing" : "Re-index"}
          </button>
        </div>
        <button
          type="button"
          className="map-tool-button"
          data-map-control="open-full-map"
          onClick={() => actions.openFullMap()}
          title="Open the Map in an editor tab. Use VS Code's split-editor controls to keep code beside it."
        >
          Open in editor
        </button>
        <button
          type="button"
          className="map-tool-button"
          data-map-control="open-notes-timeline"
          onClick={() => actions.openNotesTimeline()}
          title="Open the agent's working-memory notes as a scrollable timeline with revision trails and per-file git history."
        >
          Notes timeline
        </button>
        <button
          type="button"
          className={`map-layer-toggle ${view.display.followAgent ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.followAgent}
          data-map-control="follow-agent"
          onClick={() => actions.setDisplay({ followAgent: !view.display.followAgent })}
          title={view.display.lens === "services" ? "Gently pan to the service containing the file the agent is working on" : "Gently pan to the file the agent is working on"}
        >
          <span>Follow agent</span><strong>{view.display.followAgent ? "On" : "Off"}</strong>
        </button>
      </div>
      {view.display.lens === "files" && (
      <div className="map-control-section">
        <div className="map-control-title">Clusters</div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            className="map-tool-button"
            data-map-control="collapse-clusters"
            onClick={() => actions.collapseAllClusters()}
            title="Collapse every folder into a single super-node"
          >
            Collapse
          </button>
          <button
            type="button"
            className="map-tool-button"
            data-map-control="expand-clusters"
            onClick={() => actions.expandAllClusters()}
            disabled={view.collapsedClusters.length === 0}
            title="Expand all clusters back to individual files and their relations"
          >
            Expand all
          </button>
        </div>
        {view.collapsedClusters.length > 0 && (
          <div className="mt-1 text-2xs text-muted-foreground">
            {view.collapsedClusters.length} collapsed · double-click one to open it
          </div>
        )}
      </div>
      )}
      {view.display.lens === "files" && <LinkTypesSection view={view} />}
      {/* Territories and hubs live in the outline rail when the host sent a
          hierarchy; these flat lists remain the fallback before it arrives. */}
      {view.display.lens === "files" && !view.hierarchy && <TerritoriesSection view={view} renderer={renderer} />}
      {view.display.lens === "files" && !view.hierarchy && <HubsSection view={view} onFocusNode={onFocusNode} />}
      <div className="map-control-section">
        <div className="map-control-title">Edges</div>
        <div className="grid grid-cols-2 gap-1">
          {EDGE_MODES.map((mode) => (
            <button
              type="button"
              key={mode.value}
              className={`map-tool-button ${view.display.edgeMode === mode.value ? "map-tool-button-active" : ""}`}
              aria-pressed={view.display.edgeMode === mode.value}
              data-map-control={`edge-mode-${mode.value}`}
              onClick={() => actions.setDisplay({ edgeMode: mode.value })}
              title={mode.value === "all" ? "Automatically bundle dense architecture at overview scale and reveal file links as you zoom" : undefined}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="map-density-card">
          <span>Visible projection</span>
          <strong>{view.display.lens === "services"
            ? `${serviceBundles.length.toLocaleString()} typed routes · ${topologyNodes.length.toLocaleString()} services`
            : `${edgeCount.toLocaleString()} links · ${topologyNodes.length.toLocaleString()} nodes`}</strong>
          <small>
            {view.display.lens === "services"
              ? presentation.strategy === "bundled"
                ? `Showing ${bundleCount.toLocaleString()} strongest routes from ${serviceBundles.length.toLocaleString()} typed routes. Focus a service to inspect every direct relationship.`
                : `Bundled from ${edgeCount.toLocaleString()} raw detections; select a service for evidence.`
              : presentation.strategy === "bundled"
              ? `Showing ${bundleCount.toLocaleString()} strongest routes; focus or zoom in for file-level evidence.`
              : presentation.dense && view.display.edgeMode === "all"
                ? `Zoom out below ${presentation.detailZoom.toFixed(1)}× fit to return to the architecture backbone.`
                : "Adaptive changes detail without changing the indexed corpus."}
          </small>
        </div>
      </div>
      <details className="map-control-disclosure">
        <summary>
          <span>Layers</span>
          <small>Overlays</small>
        </summary>
        <div className="map-control-body">
        {view.display.lens === "services" && (
          <>
            <button type="button" className={`map-layer-toggle ${view.display.showApi ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showApi} data-map-control="layer-api" onClick={() => setLayer("showApi")}>
              <span>APIs</span><strong>{view.display.showApi ? "On" : "Off"}</strong>
            </button>
            <button type="button" className={`map-layer-toggle ${view.display.showEvents ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showEvents} data-map-control="layer-events" onClick={() => setLayer("showEvents")}>
              <span>Events</span><strong>{view.display.showEvents ? "On" : "Off"}</strong>
            </button>
            <button type="button" className={`map-layer-toggle ${view.display.showData ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showData} data-map-control="layer-data" onClick={() => setLayer("showData")}>
              <span>Data</span><strong>{view.display.showData ? "On" : "Off"}</strong>
            </button>
            <button type="button" className={`map-layer-toggle ${view.display.showConfig ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showConfig} data-map-control="layer-config" onClick={() => setLayer("showConfig")}>
              <span>Config</span><strong>{view.display.showConfig ? "On" : "Off"}</strong>
            </button>
          </>
        )}
        {view.display.lens === "files" && (
          <>
        <button type="button" className={`map-layer-toggle ${view.display.showRelations ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showRelations} data-map-control="layer-symbols" onClick={() => setLayer("showRelations")}>
          <span>Symbols</span><strong>{view.display.showRelations ? "On" : "Off"}</strong>
        </button>
        <button type="button" className={`map-layer-toggle ${view.display.showEdgeLabels ? "map-layer-toggle-on" : ""}`} aria-pressed={view.display.showEdgeLabels} data-map-control="layer-labels" onClick={() => setLayer("showEdgeLabels")}>
          <span>Labels</span><strong>{view.display.showEdgeLabels ? "On" : "Off"}</strong>
        </button>
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showGitHeat ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showGitHeat}
          data-map-control="layer-git-heat"
          onClick={() => setLayer("showGitHeat")}
          title="Tint stars by commit recency (warm = recently changed) and size them by churn"
        >
          <span>Git heat</span><strong>{view.display.showGitHeat ? "On" : "Off"}</strong>
        </button>
        {view.display.showGitHeat && !gitData && (
          <div className="mt-1 text-2xs text-muted-foreground">No git history found in this workspace.</div>
        )}
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showTicketHeat ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showTicketHeat}
          data-map-control="layer-ticket-heat"
          onClick={() => setLayer("showTicketHeat")}
          title="Tint and size stars by the weight of open tickets covering them — where the work is piling up"
        >
          <span>Ticket heat</span><strong>{view.display.showTicketHeat ? "On" : "Off"}</strong>
        </button>
        {view.display.showTicketHeat && view.ticketCount === 0 && (
          <div className="mt-1 text-2xs text-muted-foreground">No open tickets to show.</div>
        )}
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showCycles ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showCycles}
          data-map-control="layer-cycles"
          onClick={() => setLayer("showCycles")}
          title="Highlight cross-project reference cycles between codebases"
        >
          <span>Cycles</span><strong>{view.display.showCycles ? "On" : "Off"}</strong>
        </button>
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showCulDeSacs ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showCulDeSacs}
          data-map-control="layer-cul-de-sacs"
          onClick={() => setLayer("showCulDeSacs")}
          title="Highlight single-access pocket subgraphs and dim probably-unused orphan files"
        >
          <span>Cul-de-sacs</span><strong>{view.display.showCulDeSacs ? "On" : "Off"}</strong>
        </button>
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showProjectRefs ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showProjectRefs}
          data-map-control="layer-project-refs"
          onClick={() => actions.setDisplay({ showProjectRefs: !view.display.showProjectRefs })}
          title="Dependencies projects declare in their manifests (package.json, .csproj, Cargo.toml, …), drawn between project and codebase nodes"
        >
          <span>Declared deps</span><strong>{view.display.showProjectRefs ? "On" : "Off"}</strong>
        </button>
        <button
          type="button"
          className={`map-layer-toggle ${view.display.showCochange ? "map-layer-toggle-on" : ""}`}
          aria-pressed={view.display.showCochange}
          data-map-control="layer-cochange"
          onClick={() => actions.setDisplay({ showCochange: !view.display.showCochange })}
          disabled={view.cochangeEdges.length === 0}
          title={view.cochangeEdges.length === 0
            ? "No co-change found in the git history of the drawn files"
            : "Files that keep changing in the same commits. Between codebases, co-change that nothing structural explains is always shown dashed as hidden coupling."}
        >
          <span>Co-change</span><strong>{view.display.showCochange ? "On" : "Off"}</strong>
        </button>
          </>
        )}
        </div>
      </details>
      {view.display.lens === "files" && (
        <details className="map-control-disclosure">
          <summary>
            <span>Advanced</span>
            <small>Depth · layout · budget</small>
          </summary>
          <div className="map-control-body">
            <div className="map-control-title">Focus budget</div>
            <div className="flex items-center justify-between gap-1">
              <button type="button" className="map-tool-button !px-2" onClick={() => actions.setDisplay({ focusBudget: Math.max(200, view.display.focusBudget - 500) })} aria-label="Fewer nodes before folding">−</button>
              <strong className="text-xs" title="How many stars a scoped view draws before folding areas into single nodes">{view.display.focusBudget.toLocaleString()} nodes</strong>
              <button type="button" className="map-tool-button !px-2" onClick={() => actions.setDisplay({ focusBudget: Math.min(20000, view.display.focusBudget + 500) })} aria-label="More nodes before folding">+</button>
            </div>
            {(() => {
              const mode = view.config.neighborhoods ?? "auto";
              const next = mode === "auto" ? "on" : mode === "on" ? "off" : "auto";
              const label = mode === "auto" ? "Auto" : mode === "on" ? "On" : "Off";
              return (
                <button
                  type="button"
                  className={`map-layer-toggle ${mode === "on" ? "map-layer-toggle-on" : ""}`}
                  aria-pressed={mode === "on"}
                  data-map-control="neighborhoods"
                  onClick={() => actions.setNeighborhoodMode(next)}
                  disabled={view.indexing}
                  title="Separate distinct codebases into neighborhood territories. Auto decides by workspace size; On forces it; Off keeps a flat map. Rebuilds the map."
                >
                  <span>Territory layout</span><strong>{label}</strong>
                </button>
              );
            })()}
            <DepthSection display={view.display} />
          </div>
        </details>
      )}
      {view.display.lens === "files" && <FilterSection view={view} />}
      <SavedViewsSection savedViews={savedViews} />
      </div>
      </div>
    </aside>
  );
}

/** Territory index: the biggest folder territories with their true canvas
    colors, so the color-hashed map finally has a readable directory. Click a
    row to frame that territory; Fold/Open toggles its cluster super-node —
    organizational control anchored to the exact hues on screen. */
export function TerritoriesSection({ view, renderer }: { view: GraphViewState; renderer: GraphRenderer | null }) {
  const territories = useMemo(() => folderTerritories(view.nodes, MAX_TERRITORY_RAIL_ITEMS), [view.nodes]);
  const totalDirs = useMemo(() => new Set(view.nodes.map((node) => node.dir)).size, [view.nodes]);
  /* A row hover previews its territory on the canvas; never leave that
     preview stuck if the section unmounts mid-hover (e.g. a lens switch). */
  useEffect(() => () => actions.hoverTerritory(null), []);
  if (territories.length < 2) return null;
  return (
    <details className="map-control-disclosure" open>
      <summary>
        <span>Territories</span>
        <small>{totalDirs > territories.length ? `top ${territories.length} of ${totalDirs}` : totalDirs}</small>
      </summary>
      <div className="map-control-body">
        {territories.map((territory) => {
          const folded = view.collapsedClusters.includes(territory.dir);
          const soloed = view.filter.dirs.includes(territory.dir);
          return (
            <div
              key={territory.dir}
              className="flex min-w-0 items-center gap-1"
              onMouseEnter={() => actions.hoverTerritory(territory.dir)}
              onMouseLeave={() => actions.hoverTerritory(null)}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.08]"
                onClick={() => renderer?.frameWorld([
                  { x: territory.bounds.minX, y: territory.bounds.minY },
                  { x: territory.bounds.maxX, y: territory.bounds.maxY },
                ])}
                title={`Fly to ${territory.dir}`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-[3px]"
                  style={{ background: cssColor(folderColor(territory.dir)) }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {shortClusterLabel(territory.dir)}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">{territory.count.toLocaleString()}</span>
              </button>
              <button
                className={`map-tool-button shrink-0 !px-1.5 !py-0.5 !text-2xs uppercase tracking-wide ${soloed ? "map-tool-button-active" : ""}`}
                aria-pressed={soloed}
                onClick={() => actions.toggleDirFilter(territory.dir)}
                title={soloed ? "Stop soloing — show every territory again" : "Solo this territory: ghost every file outside it"}
              >
                Solo
              </button>
              <button
                className={`map-tool-button shrink-0 !px-1.5 !py-0.5 !text-2xs uppercase tracking-wide ${folded ? "map-tool-button-active" : ""}`}
                onClick={() => actions.setClusterCollapsed(territory.dir, !folded)}
                title={folded ? "Expand this folder back to individual files" : "Fold this folder into one star"}
              >
                {folded ? "Open" : "Fold"}
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Hubs quick-list: the most-connected files in the corpus, one click from
    anywhere. The gold ring on the canvas marks them; this is the same set as
    a readable, sorted index. */
export function HubsSection({ view, onFocusNode }: { view: GraphViewState; onFocusNode: (id: string) => void }) {
  const hubs = useMemo(() => topHubs(view.nodes, 8), [view.nodes]);
  if (hubs.length === 0) return null;
  return (
    <details className="map-control-disclosure">
      <summary>
        <span>Hubs</span>
        <small>Most connected</small>
      </summary>
      <div className="map-control-body">
        {hubs.map((hub) => (
          <button
            key={hub.id}
            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.08]"
            onClick={() => onFocusNode(hub.id)}
            title={hub.id}
          >
            <span className="h-2 w-2 shrink-0 rounded-full border border-[#ffd66b]/80" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{baseName(hub.id)}</span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">↔{hub.inDegree + hub.outDegree}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

/** Named, persisted snapshots of camera + display/filter/collapsed-cluster
    state, so a user can jump back to a particular vantage (e.g. "auth flow")
    instead of re-deriving it. Mirrors the Data workbench's Saved Queries list:
    name + short descriptor, Open/Delete, no rename. */
export function SavedViewsSection({ savedViews }: { savedViews: SavedView[] }) {
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim()) return;
    actions.saveView(name);
    setName("");
  };
  return (
    <details className="map-control-disclosure">
      <summary>
        <span>Saved views</span>
        <small>{savedViews.length > 0 ? savedViews.length : "Snapshots"}</small>
      </summary>
      <div className="map-control-body">
      <div className="flex gap-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="Name this view..."
          spellCheck={false}
          className="map-search-input"
        />
        <button className="map-tool-button shrink-0" onClick={save} disabled={!name.trim()}>Save</button>
      </div>
      {savedViews.length === 0 ? (
        <div className="mt-1 text-2xs text-muted-foreground">
          Save the current camera, filters, and collapsed clusters to jump back later.
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          {savedViews.map((v) => (
            <div key={v.id} className="flex items-center gap-1 text-xs">
              <button
                className="flex-1 truncate text-left text-foreground/90 hover:text-foreground"
                onClick={() => actions.applyView(v.id)}
                title={`${v.collapsedClusters.length} collapsed · saved ${new Date(v.createdAt).toLocaleDateString()}`}
              >
                {v.name}
              </button>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => actions.deleteView(v.id)}
                title="Delete this saved view"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
    </details>
  );
}

/** Language chips + a min-links stepper. Filtered-out stars ghost (they don't
    vanish), so the map keeps its shape while you narrow focus. Isolate-by-hops
    lives on the node card, where a selection gives it a root. */
export function FilterSection({ view }: { view: GraphViewState }) {
  const langs = useMemo(() => languageCounts(view.nodes).slice(0, 8), [view.nodes]);
  const roles = useMemo(
    () => roleCounts(view.nodes.filter((n) => !n.kind || n.kind === "file").map((n) => n.id)).slice(0, 8),
    [view.nodes],
  );
  const active = filterIsActive(view.filter, Boolean(view.selectedNodeId));
  const { filter } = view;
  const activeRoles = filter.roles ?? [];
  const stepMinDegree = (delta: number) =>
    actions.setFilter({ minDegree: Math.max(0, Math.min(20, filter.minDegree + delta)) });
  if (langs.length === 0 && roles.length === 0 && filter.dirs.length === 0) return null;
  return (
    <div className="map-control-section">
      <div className="flex items-center justify-between">
        <div className="map-control-title">Filter</div>
        {active && (
          <button
            className="text-2xs uppercase tracking-wide text-cyan-200/70 hover:text-cyan-200"
            onClick={() => actions.clearFilter()}
          >
            Clear
          </button>
        )}
      </div>
      {filter.dirs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filter.dirs.map((dir) => (
            <button
              key={dir}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-2xs text-foreground hover:bg-white/15"
              onClick={() => actions.toggleDirFilter(dir)}
              title={`Soloed territory — click to show every territory again (${dir})`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(dir)) }} aria-hidden />
              <span className="max-w-[120px] truncate">{shortClusterLabel(dir)}</span>
              <span aria-hidden>✕</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {langs.map(({ lang, count }) => {
          const on = filter.langs.includes(lang);
          return (
            <button
              key={lang}
              className={`rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${on ? "bg-cyan-400/25 text-cyan-50" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
              onClick={() => actions.toggleLanguage(lang)}
              title={`${count.toLocaleString()} ${lang} file${count === 1 ? "" : "s"}`}
            >
              {lang}
            </button>
          );
        })}
      </div>
      {/* Role chips: filter by what files are *for* (the same classification the
          star corner marks denote), ANDed with the language chips above. */}
      {roles.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {roles.map(({ role, count }) => {
            const on = activeRoles.includes(role);
            return (
              <button
                key={role}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors ${on ? "bg-cyan-400/25 text-cyan-50" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
                onClick={() => actions.toggleRoleFilter(role)}
                title={`${count.toLocaleString()} ${FILE_ROLE_LABELS[role].toLowerCase()} file${count === 1 ? "" : "s"}`}
              >
                <span className="font-mono" style={on ? undefined : { color: cssColor(FILE_ROLE_COLORS[role]) }}>
                  {ROLE_MARK_GLYPHS[role] ?? "·"}
                </span>
                {FILE_ROLE_LABELS[role].toLowerCase()}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>Min links</span>
        <div className="flex items-center gap-1">
          <button className="map-tool-button !px-2 !py-0.5" onClick={() => stepMinDegree(-1)} disabled={filter.minDegree === 0}>–</button>
          <strong className="w-4 text-center text-foreground">{filter.minDegree}</strong>
          <button className="map-tool-button !px-2 !py-0.5" onClick={() => stepMinDegree(1)} disabled={filter.minDegree >= 20}>+</button>
        </div>
      </div>
    </div>
  );
}
