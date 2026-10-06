/* The Map's display controls (right rail): what is drawn and how. Ordered by
   how often each is reached for — the lens and the canvas actions first, the
   link families that double as the legend, then layers, filters, and the
   rarely-touched budget/layout knobs folded away. Every control's full
   meaning is in its tooltip so its label can stay one or two words. */

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
import { ChevronDown, Clock3, ExternalLink, Maximize2, Minus, Plus, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { ROLE_MARK_GLYPHS, MAX_TERRITORY_RAIL_ITEMS } from "./shared";
import { DepthSection } from "./Legend";
import { MapButton, MapDisclosure, MapIconButton, MapSection, MapSegmented, MapSwitchRow } from "./ui";

/** The file-lens link families, each carrying the exact hue its edges are
    drawn with (same constants the renderer strokes), so the rows double as a
    live legend: toggle one, and precisely that coloured strand set appears
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

export function LinkTypesSection({ view }: { view: GraphViewState }) {
  const counts = useMemo(() => linkKindCounts(view.edges), [view.edges]);
  const noteCount = view.annotations.length;
  return (
    <MapSection title="Links" region="link-types">
      <div className="flex flex-col">
        {LINK_TYPES.map(({ key, kind, label, color, dashed, hint }) => {
          const count = kind ? counts[kind] ?? 0 : noteCount;
          const on = view.display[key];
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
            >
              <span className={`map-link-swatch ${dashed ? "border-dashed" : ""}`} style={{ borderColor: cssColor(color), opacity: on ? 1 : 0.3 }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              <span className="shrink-0 font-mono text-2xs tabular-nums">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
    </MapSection>
  );
}

export const EDGE_MODES: Array<{ value: EdgeMode; label: string; title: string }> = [
  { value: "all", label: "Adaptive", title: "Bundle dense architecture into routes at overview scale; reveal file links as you zoom in" },
  { value: "selected", label: "Focus", title: "Only the links of the selected file or group" },
  { value: "clusters", label: "Bundles", title: "Always draw folder-to-folder routes instead of file links" },
  { value: "off", label: "Off", title: "Hide links" },
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
  const services = view.display.lens === "services";
  const drawing = presentation.strategy === "bundled"
    ? `${bundleCount.toLocaleString()} ${services ? "backbone routes" : "routes"}`
    : presentation.strategy === "raw"
      ? services ? `${serviceBundles.length.toLocaleString()} typed routes` : `${edgeCount.toLocaleString()} links`
      : presentation.strategy === "selected" ? "selection only" : "links hidden";
  const drawingDetail = services
    ? presentation.strategy === "bundled"
      ? `Showing the ${bundleCount.toLocaleString()} strongest of ${serviceBundles.length.toLocaleString()} typed routes. Select a service to see every direct relationship.`
      : `Bundled from ${edgeCount.toLocaleString()} raw detections; select a service for evidence.`
    : presentation.strategy === "bundled"
      ? `Showing the ${bundleCount.toLocaleString()} strongest folder routes; select or zoom in for file-level links.`
      : presentation.dense && view.display.edgeMode === "all"
        ? `Zoom out below ${presentation.detailZoom.toFixed(1)}× fit to return to the folder routes.`
        : "Adaptive changes how much is drawn, never what is indexed.";
  const agentActive = view.liveActivity.length > 0;

  return (
    <aside
      className="map-toolbar pointer-events-auto absolute"
      data-expanded={expanded}
      data-minimap={view.displayNodes.length >= 3}
      aria-label="Map display"
      data-map-region="controls"
    >
      <button
        type="button"
        className="map-toolbar-header"
        aria-label="Display"
        aria-expanded={expanded}
        aria-controls="map-controls-content"
        title={expanded ? "Hide display controls" : "Show display controls: lens, links, layers, filters"}
        onClick={() => setControlsExpanded(!expanded)}
      >
        <SlidersHorizontal aria-hidden="true" />
        <span className="map-toolbar-title">Display</span>
        {!expanded && <span className="map-toolbar-summary">{view.display.lens === "files" ? "Structure" : services ? "Services" : "Work"}</span>}
        <ChevronDown className="map-toolbar-chevron" size={14} aria-hidden="true" />
      </button>
      <div id="map-controls-content" className="map-controls-content" hidden={!expanded}>
        <div className="map-toolbar-scroll">
          <MapSection>
            <MapSegmented
              label="Lens"
              value={view.display.lens}
              onChange={(lens) => actions.setDisplay({ lens })}
              options={[
                { value: "files", label: "Structure", title: "Files, folders, and codebases with their imports and structural links", control: "lens-files" },
                {
                  value: "services", label: "Services", control: "lens-services",
                  disabled: view.relationshipEdges.length === 0 && !services,
                  title: view.relationshipEdges.length === 0 ? "No service API relationships detected yet" : "Services and the API, event, and data routes between them",
                },
                { value: "work", label: "Work", control: "lens-work", title: view.ticketCount === 0 ? "No open tickets yet — open the lens to see how to add some" : "Open tickets, their territory, blockers, and overlapping scope" },
              ]}
            />
            <div className="map-toolbar-actions">
              <MapIconButton icon={Maximize2} label="Fit the whole map (F)" data-map-control="fit" onClick={() => renderer?.zoomToFitAll()} />
              <MapIconButton
                icon={RefreshCw}
                label={view.indexing ? "Indexing…" : "Re-index the workspace"}
                spin={view.indexing}
                data-map-control="reindex"
                onClick={() => actions.rebuildIndex()}
                disabled={view.indexing}
              />
              <MapIconButton
                icon={ExternalLink}
                label="Open the map in an editor tab — split the editor to keep code beside it"
                data-map-control="open-full-map"
                onClick={() => actions.openFullMap()}
              />
              <MapIconButton
                icon={Clock3}
                label="Notes timeline: the agent's working-memory notes, with revisions and git history"
                data-map-control="open-notes-timeline"
                onClick={() => actions.openNotesTimeline()}
              />
            </div>
            <MapSwitchRow
              label="Follow agent"
              checked={view.display.followAgent}
              onChange={(followAgent) => actions.setDisplay({ followAgent })}
              control="follow-agent"
              live={agentActive && !view.display.followAgent}
              title={agentActive && !view.display.followAgent
                ? "The agent is working now — follow to glide to each file it touches"
                : services ? "Glide to the service containing the file the agent is working on" : "Glide to the file the agent is working on"}
            />
          </MapSection>

          <MapSection title="Links drawn" action={<span className="map-hint" title={drawingDetail}>{drawing}</span>}>
            <MapSegmented
              label="How links are drawn"
              value={view.display.edgeMode}
              onChange={(edgeMode) => actions.setDisplay({ edgeMode })}
              options={EDGE_MODES.map((mode) => ({ value: mode.value, label: mode.label, title: mode.title, control: `edge-mode-${mode.value}` }))}
              size="xs"
            />
          </MapSection>

          {view.display.lens === "files" && <LinkTypesSection view={view} />}

          {view.display.lens === "files" && (
            <MapSection
              title="Folders"
              action={view.collapsedClusters.length > 0 ? <span className="map-hint">{view.collapsedClusters.length} folded</span> : undefined}
            >
              <div className="grid grid-cols-2 gap-1.5">
                <MapButton size="xs" data-map-control="collapse-clusters" onClick={() => actions.collapseAllClusters()} title="Fold every folder into a single star">Fold all</MapButton>
                <MapButton
                  size="xs"
                  data-map-control="expand-clusters"
                  onClick={() => actions.expandAllClusters()}
                  disabled={view.collapsedClusters.length === 0}
                  title="Unfold every folder back to its files (double-click a folded star to open just that one)"
                >
                  Unfold all
                </MapButton>
              </div>
            </MapSection>
          )}

          {/* Territories and hubs live in the outline rail when the host sent a
              hierarchy; these flat lists remain the fallback before it arrives. */}
          {view.display.lens === "files" && !view.hierarchy && <TerritoriesSection view={view} renderer={renderer} />}
          {view.display.lens === "files" && !view.hierarchy && <HubsSection view={view} onFocusNode={onFocusNode} />}

          <MapDisclosure title="Layers" meta="Overlays" region="layers">
            {services ? (
              <>
                <MapSwitchRow label="APIs" checked={view.display.showApi} onChange={(showApi) => actions.setDisplay({ showApi })} control="layer-api" title="HTTP/RPC calls between services" />
                <MapSwitchRow label="Events" checked={view.display.showEvents} onChange={(showEvents) => actions.setDisplay({ showEvents })} control="layer-events" title="Published and consumed events" />
                <MapSwitchRow label="Data" checked={view.display.showData} onChange={(showData) => actions.setDisplay({ showData })} control="layer-data" title="Tables, collections, and stores services share" />
                <MapSwitchRow label="Config" checked={view.display.showConfig} onChange={(showConfig) => actions.setDisplay({ showConfig })} control="layer-config" title="Configuration one service reads from another" />
              </>
            ) : (
              <>
                <MapSwitchRow label="Symbols" checked={view.display.showRelations} onChange={(showRelations) => actions.setDisplay({ showRelations })} control="layer-symbols" title="Symbol relationships traced from the language server" />
                <MapSwitchRow label="Link labels" checked={view.display.showEdgeLabels} onChange={(showEdgeLabels) => actions.setDisplay({ showEdgeLabels })} control="layer-labels" title="Name the links around the selection" />
                <MapSwitchRow
                  label="Git heat"
                  checked={view.display.showGitHeat}
                  onChange={(showGitHeat) => actions.setDisplay({ showGitHeat })}
                  control="layer-git-heat"
                  meta={view.display.showGitHeat && !gitData ? "no history" : undefined}
                  title="Tint stars by commit recency (warm = recently changed) and size them by churn"
                />
                <MapSwitchRow
                  label="Ticket heat"
                  checked={view.display.showTicketHeat}
                  onChange={(showTicketHeat) => actions.setDisplay({ showTicketHeat })}
                  control="layer-ticket-heat"
                  meta={view.display.showTicketHeat && view.ticketCount === 0 ? "none open" : undefined}
                  title="Tint and size stars by the weight of open tickets covering them — where work is piling up"
                />
                <MapSwitchRow label="Cycles" checked={view.display.showCycles} onChange={(showCycles) => actions.setDisplay({ showCycles })} control="layer-cycles" title="Highlight reference cycles between codebases" />
                <MapSwitchRow label="Cul-de-sacs" checked={view.display.showCulDeSacs} onChange={(showCulDeSacs) => actions.setDisplay({ showCulDeSacs })} control="layer-cul-de-sacs" title="Highlight single-access pockets and dim probably-unused orphan files" />
                <MapSwitchRow
                  label="Declared deps"
                  checked={view.display.showProjectRefs}
                  onChange={(showProjectRefs) => actions.setDisplay({ showProjectRefs })}
                  control="layer-project-refs"
                  title="Dependencies projects declare in their manifests (package.json, .csproj, Cargo.toml, …), drawn between project and codebase nodes"
                />
                <MapSwitchRow
                  label="Co-change"
                  checked={view.display.showCochange}
                  onChange={(showCochange) => actions.setDisplay({ showCochange })}
                  control="layer-cochange"
                  disabled={view.cochangeEdges.length === 0}
                  meta={view.cochangeEdges.length === 0 ? "none" : undefined}
                  title={view.cochangeEdges.length === 0
                    ? "No co-change found in the git history of the drawn files"
                    : "Files that keep changing in the same commits. Between codebases, co-change nothing structural explains is always drawn dashed as hidden coupling."}
                />
              </>
            )}
          </MapDisclosure>

          {view.display.lens === "files" && <FilterSection view={view} />}

          {view.display.lens === "files" && (
            <MapDisclosure title="Advanced" meta="Depth · layout · budget" region="advanced">
              <div className="flex items-center justify-between gap-2">
                <span className="map-hint" title="How many stars a scoped view draws before folding areas into single stars">Focus budget</span>
                <span className="map-stepper">
                  <MapIconButton icon={Minus} label="Fewer stars before folding" onClick={() => actions.setDisplay({ focusBudget: Math.max(200, view.display.focusBudget - 500) })} />
                  <strong>{view.display.focusBudget.toLocaleString()}</strong>
                  <MapIconButton icon={Plus} label="More stars before folding" onClick={() => actions.setDisplay({ focusBudget: Math.min(20000, view.display.focusBudget + 500) })} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="map-hint" title="Separate distinct codebases into their own regions. Auto decides by workspace size; On forces it; Off keeps one folder tree. Rebuilds the map.">Codebase regions</span>
                <MapSegmented
                  label="Codebase regions"
                  size="xs"
                  className="w-[132px]"
                  value={view.config.neighborhoods ?? "auto"}
                  onChange={(mode) => { if (!view.indexing) actions.setNeighborhoodMode(mode); }}
                  options={[
                    { value: "auto", label: "Auto", control: "neighborhoods-auto" },
                    { value: "on", label: "On", control: "neighborhoods-on" },
                    { value: "off", label: "Off", control: "neighborhoods-off" },
                  ]}
                />
              </div>
              <DepthSection display={view.display} />
            </MapDisclosure>
          )}
          <SavedViewsSection savedViews={savedViews} />
        </div>
      </div>
    </aside>
  );
}

/** Folder index before the host's hierarchy arrives: the biggest folders with
    their true canvas colours. Click to frame one; Solo ghosts everything else;
    Fold collapses it to one star. */
export function TerritoriesSection({ view, renderer }: { view: GraphViewState; renderer: GraphRenderer | null }) {
  const territories = useMemo(() => folderTerritories(view.nodes, MAX_TERRITORY_RAIL_ITEMS), [view.nodes]);
  const totalDirs = useMemo(() => new Set(view.nodes.map((node) => node.dir)).size, [view.nodes]);
  /* A row hover previews its territory on the canvas; never leave that
     preview stuck if the section unmounts mid-hover (e.g. a lens switch). */
  useEffect(() => () => actions.hoverTerritory(null), []);
  if (territories.length < 2) return null;
  return (
    <MapDisclosure title="Folders" meta={totalDirs > territories.length ? `top ${territories.length} of ${totalDirs}` : totalDirs} defaultOpen>
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
              type="button"
              className="map-inspector-row min-w-0 flex-1"
              onClick={() => renderer?.frameWorld([
                { x: territory.bounds.minX, y: territory.bounds.minY },
                { x: territory.bounds.maxX, y: territory.bounds.maxY },
              ])}
              title={`Fly to ${territory.dir}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: cssColor(folderColor(territory.dir)) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono">{shortClusterLabel(territory.dir)}</span>
              <span className="shrink-0 font-mono text-2xs text-[color:var(--map-text-3)]">{territory.count.toLocaleString()}</span>
            </button>
            <MapButton size="xs" variant="ghost" active={soloed} onClick={() => actions.toggleDirFilter(territory.dir)} title={soloed ? "Stop soloing — show every folder again" : "Solo: ghost every file outside this folder"}>Solo</MapButton>
            <MapButton size="xs" variant="ghost" active={folded} onClick={() => actions.setClusterCollapsed(territory.dir, !folded)} title={folded ? "Unfold back to individual files" : "Fold this folder into one star"}>{folded ? "Open" : "Fold"}</MapButton>
          </div>
        );
      })}
    </MapDisclosure>
  );
}

/** The most-connected files, one click away. The gold ring on the canvas marks them. */
export function HubsSection({ view, onFocusNode }: { view: GraphViewState; onFocusNode: (id: string) => void }) {
  const hubs = useMemo(() => topHubs(view.nodes, 8), [view.nodes]);
  if (hubs.length === 0) return null;
  return (
    <MapDisclosure title="Hubs" meta="Most connected">
      {hubs.map((hub) => (
        <button key={hub.id} type="button" className="map-inspector-row" onClick={() => onFocusNode(hub.id)} title={hub.id}>
          <span className="h-2 w-2 shrink-0 rounded-full border border-[#ffd66b]/80" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono">{baseName(hub.id)}</span>
          <span className="shrink-0 font-mono text-2xs text-[color:var(--map-text-3)]" title="Imports in and out">{hub.inDegree + hub.outDegree}</span>
        </button>
      ))}
    </MapDisclosure>
  );
}

/** Named snapshots of camera + display/filter/fold state, to jump back to a vantage later. */
export function SavedViewsSection({ savedViews }: { savedViews: SavedView[] }) {
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim()) return;
    actions.saveView(name);
    setName("");
  };
  return (
    <MapDisclosure title="Saved views" meta={savedViews.length > 0 ? savedViews.length : undefined} region="saved-views">
      <div className="flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder="Name this view…"
          aria-label="Saved view name"
          spellCheck={false}
          className="map-search-input min-w-0 flex-1 !px-2 !min-h-[28px]"
        />
        <MapButton size="sm" onClick={save} disabled={!name.trim()} title="Save the camera, filters, and folded folders under this name">Save</MapButton>
      </div>
      {savedViews.length === 0 ? (
        <div className="map-hint">Keep the current camera, filters, and folded folders to come back to later.</div>
      ) : (
        <div className="flex flex-col">
          {savedViews.map((v) => (
            <div key={v.id} className="flex items-center gap-1">
              <button
                type="button"
                className="map-inspector-row min-w-0 flex-1"
                onClick={() => actions.applyView(v.id)}
                title={`${v.collapsedClusters.length} folded · saved ${new Date(v.createdAt).toLocaleDateString()}`}
              >
                <span className="truncate">{v.name}</span>
              </button>
              <MapIconButton icon={X} label={`Delete "${v.name}"`} onClick={() => actions.deleteView(v.id)} />
            </div>
          ))}
        </div>
      )}
    </MapDisclosure>
  );
}

/** Language and role chips plus a minimum-links stepper. Filtered-out stars
    ghost rather than vanish, so the map keeps its shape while focus narrows. */
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
    <MapDisclosure
      title="Filter"
      meta={active ? <button type="button" className="map-text-link" onClick={(e) => { e.preventDefault(); actions.clearFilter(); }} title="Clear every filter">Clear</button> : undefined}
      defaultOpen={active}
      region="filter"
    >
      {filter.dirs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filter.dirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="map-chip map-chip-on font-mono"
              onClick={() => actions.toggleDirFilter(dir)}
              title={`Soloed folder — click to show every folder again (${dir})`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(dir)) }} aria-hidden />
              <span className="max-w-[120px] truncate">{shortClusterLabel(dir)}</span>
              <X className="size-3" aria-hidden />
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
              type="button"
              className={`map-chip font-mono ${on ? "map-chip-on" : ""}`}
              aria-pressed={on}
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
        <div className="flex flex-wrap gap-1">
          {roles.map(({ role, count }) => {
            const on = activeRoles.includes(role);
            return (
              <button
                key={role}
                type="button"
                className={`map-chip ${on ? "map-chip-on" : ""}`}
                aria-pressed={on}
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
      <div className="flex items-center justify-between">
        <span className="map-hint" title="Ghost files with fewer import links than this">Min links</span>
        <span className="map-stepper">
          <MapIconButton icon={Minus} label="Fewer links required" onClick={() => stepMinDegree(-1)} disabled={filter.minDegree === 0} />
          <strong>{filter.minDegree}</strong>
          <MapIconButton icon={Plus} label="More links required" onClick={() => stepMinDegree(1)} disabled={filter.minDegree >= 20} />
        </span>
      </div>
    </MapDisclosure>
  );
}
