/* Codebase Map webview: pixi star-map stage + HTML overlays (labels, search,
   node card, legend). State flows store → PixiStage; interactions flow back
   through store actions. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { clampRectToBox, visibleWorldRect, worldToScreen, zoomToFit, type Camera, type Viewport } from "@/lib/graph/camera";
import { ANNOTATION_COLOR, GIT_WARM_COLOR, IMPORT_EDGE_COLOR, RELATIONSHIP_EDGE_COLORS, SYMBOL_RELATION_COLORS, TRACE_COLORS, activityColor, cssColor, folderColor } from "@/lib/graph/colors";
import { selectNonOverlappingLabels, type ScreenLabelCandidate, type ScreenRect } from "@/lib/graph/labels";
import { FILE_ROLE_COLORS, FILE_ROLE_LABELS, fileRole, roleCounts, type FileRole } from "@/lib/graph/file-role";
import {
  MOTION_DESCRIPTIONS,
  flowParticles,
  signatureForEdgeKind,
  signatureForSymbolRelation,
  type FlowSignature,
} from "@/lib/graph/flow-signature";
import {
  altitudeBand,
  altitudeZoomRatio,
  annotationsForNode,
  baseName,
  clusterBackboneEdges,
  clusterHubKey,
  clusterHubLabel,
  clusterSubgroupLabel,
  edgePresentation,
  filterIsActive,
  folderTerritories,
  isClusterNode,
  languageCounts,
  linkKindCounts,
  neighborhoodLabel,
  nodeConnections,
  selectedEdgeLabels,
  serviceRelationshipBackbone,
  serviceRelationshipBundles,
  nodeBounds,
  positionedSymbols,
  searchHighlightSegments,
  searchMatches,
  shortClusterLabel,
  symbolRelationTargets,
  symbolRelationVerb,
  topHubs,
  traceKindVerb,
  visibleNodeIds,
  type EdgeMode,
  type GraphViewState,
  type MapAltitude,
  type SavedView,
} from "@/lib/graph/view-model";
import type { EdgeKind, GraphEdge, GraphNode, LiveActivity, NoteCategory, SymbolRelation } from "@/lib/graph/protocol";
import { Blocks, HelpCircle, ListTodo, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { CATEGORY_META, relationKindLabel } from "@/lib/notes/categories";

const NOTE_CATEGORY_ICONS: Record<NoteCategory, LucideIcon> = {
  architecture: Blocks,
  gotcha: TriangleAlert,
  todo: ListTodo,
  risk: ShieldAlert,
  question: HelpCircle,
};

const LEGEND: Array<{ label: string; kind: keyof typeof TRACE_COLORS }> = [
  { label: "Read", kind: "read" },
  { label: "Write", kind: "write" },
  { label: "Edit", kind: "edit" },
  { label: "Shell", kind: "shell" },
  { label: "Navigate", kind: "nav" },
];

const RELATIONSHIP_LEGEND: Array<{ label: string; kind: EdgeKind }> = [
  { label: "API call", kind: "api" },
  { label: "Event", kind: "event" },
  { label: "Data", kind: "data" },
  { label: "Config ref", kind: "config" },
];

const RELATIONSHIP_KIND_LABELS: Partial<Record<EdgeKind, string>> = Object.fromEntries(
  RELATIONSHIP_LEGEND.map(({ label, kind }) => [kind, label]),
);

const SYMBOL_RELATION_LEGEND: Array<{ label: string; relation: SymbolRelation }> = [
  { label: "Reference", relation: "reference" },
  { label: "Call", relation: "call" },
  { label: "Implements", relation: "implements" },
  { label: "Extends", relation: "extends" },
];

/** Unicode stand-ins for the renderer's role-mark silhouettes (file-role.ts),
    close enough in shape that the legend teaches the on-canvas mark. */
const ROLE_MARK_LEGEND: Array<{ role: FileRole; glyph: string }> = [
  { role: "test", glyph: "△" },
  { role: "config", glyph: "▢" },
  { role: "docs", glyph: "≡" },
  { role: "styles", glyph: "◆" },
  { role: "types", glyph: "‹" },
  { role: "entry", glyph: "✦" },
  { role: "data", glyph: "▤" },
  { role: "assets", glyph: "○" },
];

const ROLE_MARK_GLYPHS: Partial<Record<FileRole, string>> = Object.fromEntries(
  ROLE_MARK_LEGEND.map(({ role, glyph }) => [role, glyph]),
);

// The map is frequently used with workspaces that have dozens of meaningful
// folders/codebases. Keep the complete graph available, and raise each visual
// projection cap enough that the rail and overview do not silently hide most of
// the architecture. Label collision handling still decides what fits on screen.
const MAX_NEIGHBORHOOD_LABELS = 40;
const MAX_TERRITORY_RAIL_ITEMS = 32;
const MAX_MINIMAP_TERRITORIES = 24;

function relationshipKindLabel(kind: EdgeKind): string {
  return RELATIONSHIP_KIND_LABELS[kind] ?? kind;
}

function relationshipColor(edge: GraphEdge): string {
  return cssColor(RELATIONSHIP_EDGE_COLORS[edge.kind] ?? 0x8fa9d6);
}

function servicePeerLabel(edge: GraphEdge, node: GraphNode): string {
  const peer = edge.from === node.id ? edge.serviceTo ?? edge.to : edge.serviceFrom ?? edge.from;
  return peer.replace(/^svc:/, "");
}

function useViewport(ref: React.RefObject<HTMLDivElement | null>): Viewport {
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return viewport;
}

/** Folder cluster labels + hovered/selected file label, projected over the canvas. */
function LabelsOverlay({ view, camera, viewport, hoveredId, selectedId }: {
  view: GraphViewState;
  camera: Camera;
  viewport: Viewport;
  hoveredId: string | null;
  selectedId: string | null;
}) {
  const clusterStats = useMemo(() => {
    const byDir = new Map<string, { count: number; weight: number; sx: number; sy: number }>();
    for (const node of view.displayNodes) {
      const entry = byDir.get(node.dir) ?? { count: 0, weight: 0, sx: 0, sy: 0 };
      entry.count += isClusterNode(node) ? (node.fileCount ?? 1) : 1;
      entry.weight += 1;
      entry.sx += node.x;
      entry.sy += node.y;
      byDir.set(node.dir, entry);
    }
    return [...byDir.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([dir, { count, weight, sx, sy }]) => ({ dir, count, x: sx / weight, y: sy / weight }));
  }, [view.displayNodes]);

  const hubs = useMemo(() => {
    const byHub = new Map<string, { count: number; groups: number; sx: number; sy: number }>();
    for (const cluster of clusterStats) {
      const hub = clusterHubKey(cluster.dir);
      const entry = byHub.get(hub) ?? { count: 0, groups: 0, sx: 0, sy: 0 };
      entry.count += cluster.count;
      entry.groups += 1;
      entry.sx += cluster.x * cluster.count;
      entry.sy += cluster.y * cluster.count;
      byHub.set(hub, entry);
    }
    return [...byHub.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 18)
      .map(([dir, { count, groups, sx, sy }]) => ({
        dir,
        count,
        groups,
        x: sx / Math.max(1, count),
        y: sy / Math.max(1, count),
      }));
  }, [clusterStats]);

  /* Neighborhood territories: one coarse label per distinct codebase, present
     only when the host laid the map out as neighborhoods (node.neighborhood set). */
  const neighborhoods = useMemo(() => {
    const byNb = new Map<string, { count: number; sx: number; sy: number }>();
    for (const node of view.displayNodes) {
      const nb = node.neighborhood;
      if (!nb) continue;
      const weight = isClusterNode(node) ? (node.fileCount ?? 1) : 1;
      const entry = byNb.get(nb) ?? { count: 0, sx: 0, sy: 0 };
      entry.count += weight;
      entry.sx += node.x * weight;
      entry.sy += node.y * weight;
      byNb.set(nb, entry);
    }
    return [...byNb.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_NEIGHBORHOOD_LABELS)
      .map(([nb, { count, sx, sy }]) => ({ nb, count, x: sx / Math.max(1, count), y: sy / Math.max(1, count) }));
  }, [view.displayNodes]);

  const subgroups = useMemo(() => (
    clusterStats
      .filter((cluster) => clusterSubgroupLabel(cluster.dir) !== null)
      .slice(0, 28)
  ), [clusterStats]);

  const symbolLabels = useMemo(() => {
    if (!view.symbolsEnabled || !selectedId) return [];
    return positionedSymbols(view.displayNodes, view.symbolsByPath)
      .filter((item) => item.parent.id === selectedId)
      .slice(0, 24);
  }, [view.displayNodes, view.symbolsByPath, view.symbolsEnabled, selectedId]);

  /* Cluster/symbol label visibility must be judged relative to this map's own
     zoom-to-fit level, not an absolute camera.zoom: world span (and therefore
     the natural overview zoom) varies wildly by project size, so a threshold
     on the raw zoom made cluster labels invisible from the very first frame
     on small/tightly-clustered repos whose fit zoom already exceeds it. */
  const fitZoom = useMemo(() => zoomToFit(view.displayNodes, viewport).zoom, [view.displayNodes, viewport]);
  const zoomRatio = camera.zoom / Math.max(fitZoom, 1e-6);

  if (viewport.width === 0) return null;
  const nodeById = new Map(view.displayNodes.map((node) => [node.id, node]));
  const focus = hoveredId ?? selectedId;
  const focusNode = focus ? nodeById.get(focus) : undefined;
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  /* Exclusive semantic bands prevent the overview from showing territory,
     hub, and subgroup labels at the same time. The short crossfades keep zoom
     transitions fluid without recreating the 60-label pile-up seen at fit. */
  const territorial = neighborhoods.length > 1;
  const neighborhoodAlpha = territorial ? clamp01((1.32 - zoomRatio) / 0.38) * 0.94 : 0;
  const hubStart = territorial ? 1.1 : 0.68;
  const hubAlpha = clamp01((zoomRatio - hubStart) / 0.34) * clamp01((2.25 - zoomRatio) / 0.5) * 0.9;
  const subgroupAlpha = clamp01((zoomRatio - 1.72) / 0.5) * clamp01((3.5 - zoomRatio) / 0.65) * 0.64;

  type ArchitectureLabel = { key: string; kind: "neighborhood" | "hub" | "subgroup" };
  const candidates: Array<ScreenLabelCandidate<ArchitectureLabel>> = [];
  if (neighborhoodAlpha > 0.06) {
    for (const item of neighborhoods) {
      const p = worldToScreen(camera, viewport, item.x, item.y);
      const width = Math.min(230, Math.max(126, neighborhoodLabel(item.nb).length * 9 + 48));
      candidates.push({
        value: { key: `nb:${item.nb}`, kind: "neighborhood" },
        x: p.x - width / 2,
        y: p.y - 23,
        width,
        height: 46,
        priority: 300 + Math.log1p(item.count) * 12,
      });
    }
  }
  if (hubAlpha > 0.06) {
    for (const item of hubs) {
      const p = worldToScreen(camera, viewport, item.x, item.y);
      const width = Math.min(190, Math.max(104, clusterHubLabel(item.dir).length * 8 + 34));
      candidates.push({
        value: { key: `hub:${item.dir}`, kind: "hub" },
        x: p.x - width / 2,
        y: p.y - 20,
        width,
        height: 40,
        priority: 200 + Math.log1p(item.count) * 10,
      });
    }
  }
  if (subgroupAlpha > 0.08) {
    for (const item of subgroups) {
      const label = clusterSubgroupLabel(item.dir);
      if (!label) continue;
      const p = worldToScreen(camera, viewport, item.x, item.y);
      const width = Math.min(160, Math.max(78, label.length * 7 + 20));
      candidates.push({
        value: { key: `sub:${item.dir}`, kind: "subgroup" },
        x: p.x - width / 2,
        y: p.y + 4,
        width,
        height: 22,
        priority: 100 + Math.log1p(item.count) * 8,
      });
    }
  }

  /* Keep labels out from under the persistent control surfaces and the focus
     tooltip. These are allocation constraints, not masks: hidden labels are
     reconsidered immediately as the camera moves into free screen space. */
  const reserved: ScreenRect[] = [
    { x: 0, y: 0, width: Math.min(336, viewport.width * 0.46), height: 166 },
    { x: Math.max(0, viewport.width - 214), y: 0, width: 214, height: Math.max(174, viewport.height - 108) },
  ];
  if (focusNode) {
    const p = worldToScreen(camera, viewport, focusNode.x, focusNode.y);
    reserved.push({ x: p.x - 138, y: p.y + 8, width: 276, height: 42 });
  }
  const acceptedLabels = new Set(
    selectNonOverlappingLabels(candidates, viewport, reserved, 7, 6).map((candidate) => candidate.value.key),
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {neighborhoodAlpha > 0.06 && neighborhoods.map(({ nb, x, y, count }) => {
        if (!acceptedLabels.has(`nb:${nb}`)) return null;
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -160 || p.y < -60 || p.x > viewport.width + 160 || p.y > viewport.height + 60) return null;
        return (
          <div
            key={`nb:${nb}`}
            className="map-territory-label absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: p.x, top: p.y, color: cssColor(folderColor(nb)), opacity: neighborhoodAlpha }}
            title={nb}
          >
            <div className="whitespace-nowrap font-mono text-lg font-semibold uppercase tracking-[0.22em]">
              {neighborhoodLabel(nb)}
            </div>
            <div className="mt-0.5 whitespace-nowrap font-mono text-2xs tracking-wide text-white/55">
              codebase · {count.toLocaleString()} files
            </div>
          </div>
        );
      })}
      {hubAlpha > 0.06 && hubs.map(({ dir, x, y, count, groups }) => {
        if (!acceptedLabels.has(`hub:${dir}`)) return null;
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -120 || p.y < -40 || p.x > viewport.width + 120 || p.y > viewport.height + 40) return null;
        return (
          <div
            key={dir}
            className="map-hub-label absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: p.x, top: p.y, color: cssColor(folderColor(dir)), opacity: hubAlpha * Math.min(1, 0.45 + count / 60) }}
            title={dir}
          >
            <div className="whitespace-nowrap font-mono text-sm uppercase tracking-[0.18em]">
              {clusterHubLabel(dir)}
            </div>
            <div className="mt-0.5 whitespace-nowrap font-mono text-2xs tracking-wide text-white/58">
              {count.toLocaleString()} files{groups > 1 ? ` • ${groups} groups` : ""}
            </div>
          </div>
        );
      })}
      {subgroupAlpha > 0.08 && subgroups.map(({ dir, x, y, count }) => {
        if (!acceptedLabels.has(`sub:${dir}`)) return null;
        const subgroup = clusterSubgroupLabel(dir);
        if (!subgroup) return null;
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -100 || p.y < -24 || p.x > viewport.width + 100 || p.y > viewport.height + 24) return null;
        return (
          <div
            key={`sub:${dir}`}
            className="map-subgroup-label absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: p.x, top: p.y + 14, opacity: subgroupAlpha * Math.min(1, 0.35 + count / 36) }}
            title={dir}
          >
            {subgroup}
          </div>
        );
      })}
      {focusNode && (() => {
        const p = worldToScreen(camera, viewport, focusNode.x, focusNode.y);
        const cluster = isClusterNode(focusNode);
        const service = focusNode.kind === "service";
        const name = cluster || service
          ? focusNode.dir.replace(/^svc:/, "")
          : baseName(focusNode.id);
        const detail = cluster
          ? `${(focusNode.fileCount ?? 0).toLocaleString()} files · double-click to expand`
          : service
            ? `service · ${focusNode.inDegree} in · ${focusNode.outDegree} out`
            : `${focusNode.dir}  ·  →${focusNode.outDegree} ←${focusNode.inDegree}`;
        return (
          <div
            className="absolute -translate-x-1/2 rounded-md border border-white/10 bg-black/75 px-2 py-1 text-center backdrop-blur-[2px]"
            style={{ left: p.x, top: p.y + 12, borderLeft: `2px solid ${cssColor(folderColor(focusNode.dir))}` }}
            title={focusNode.id}
          >
            <div className="whitespace-nowrap font-mono text-sm font-semibold text-white">{name}</div>
            <div className="max-w-[260px] truncate whitespace-nowrap font-mono text-2xs text-white/55" title={detail}>
              {detail}
            </div>
          </div>
        );
      })()}
      {view.symbolsEnabled && zoomRatio > 1.6 && symbolLabels.map(({ symbol, x, y }) => {
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -100 || p.y < -24 || p.x > viewport.width + 100 || p.y > viewport.height + 24) return null;
        return (
          <div
            key={symbol.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-slate-950/70 px-1 py-0.5 font-mono text-2xs text-slate-200/85"
            style={{ left: p.x, top: p.y }}
          >
            {symbol.name}
          </div>
        );
      })}
    </div>
  );
}

function EdgeLabelsOverlay({ view, camera, viewport }: {
  view: GraphViewState;
  camera: Camera;
  viewport: Viewport;
}) {
  const labels = useMemo(() => selectedEdgeLabels(
    view.selectedNodeId,
    view.displayNodes,
    view.displayEdges,
    view.annotations,
    view.symbolsByPath,
    view.display,
  ), [view.annotations, view.display, view.displayEdges, view.displayNodes, view.selectedNodeId, view.symbolsByPath]);

  if (viewport.width === 0 || labels.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {labels.map((label) => {
        const p = worldToScreen(camera, viewport, label.x, label.y);
        if (p.x < -120 || p.y < -40 || p.x > viewport.width + 120 || p.y > viewport.height + 40) return null;
        return (
          <div
            key={label.id}
            className={`map-edge-label map-edge-label-${label.kind} absolute max-w-[180px] -translate-x-1/2 -translate-y-1/2 truncate`}
            style={{ left: p.x, top: p.y }}
            title={`${label.label}: ${label.detail}`}
          >
            <span>{label.label}</span>
            <strong>{label.detail}</strong>
          </div>
        );
      })}
    </div>
  );
}

function SearchBar({ search, nodes, searchNodes, indexedFileCount, indexedImportCount, indexing, relationshipIndexing, inputRef, onPick }: {
  search: string;
  /** Active-lens targets. Files remain searchable in the file view; the
      Services lens supplies its semantic service nodes instead. */
  searchNodes: GraphNode[];
  nodes: GraphNode[];
  indexedFileCount: number;
  indexedImportCount: number;
  indexing: boolean;
  relationshipIndexing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
}) {
  const matches = useMemo(() => searchMatches(searchNodes, search, 8), [searchNodes, search]);
  const moduleCount = useMemo(() => new Set(nodes.map((node) => node.dir)).size, [nodes]);
  const servicesMode = searchNodes.some((node) => node.kind === "service");
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [search]);

  const pick = (id: string) => {
    actions.hover(null); /* retire any result-row preview highlight */
    onPick(id);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const node = matches[Math.min(active, matches.length - 1)];
      if (node) pick(node.id);
    }
  };

  return (
    <section className="map-panel map-command-panel pointer-events-auto absolute left-3 top-3 w-[min(326px,calc(100vw-24px))]" aria-label="Architecture map search and summary" data-map-region="command">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="map-eyebrow">Project Relay · Architecture</div>
          <div className="map-command-title">System topology</div>
          <div className="map-command-subtitle">Files, modules, services, and live agent context</div>
        </div>
        <div className={`map-status ${indexing || relationshipIndexing ? "map-status-live" : ""}`} role="status" aria-live="polite">
          {indexing
            ? "Indexing files"
            : relationshipIndexing
              ? "Tracing services"
              : `${indexedFileCount.toLocaleString()} indexed`}
        </div>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <div className="map-stat">
          <span>Stars shown</span>
          <strong>{nodes.length.toLocaleString()}</strong>
        </div>
        <div className="map-stat">
          <span>Indexed links</span>
          <strong>{indexedImportCount.toLocaleString()}</strong>
        </div>
        <div className="map-stat">
          <span>Modules</span>
          <strong>{moduleCount.toLocaleString()}</strong>
        </div>
      </div>
      <label className="sr-only" htmlFor="map-search">{servicesMode ? "Search services" : "Search files and modules"}</label>
      <input
        id="map-search"
        ref={inputRef}
        value={search}
        onChange={(e) => actions.setSearch(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={servicesMode ? "Find a service…  /" : "Find a file or module…  /"}
        spellCheck={false}
        className="map-search-input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={Boolean(search.trim())}
        aria-controls="map-search-results"
        aria-activedescendant={search.trim() && matches[active] ? `map-search-result-${active}` : undefined}
      />
      {search.trim() && (
        <div id="map-search-results" className="map-results mt-1 flex flex-col gap-px overflow-hidden" role="listbox">
          {matches.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No matches</div>}
          {matches.map((node, i) => (
            <button
              id={`map-search-result-${i}`}
              key={node.id}
              className={`px-2 py-1 text-left font-mono text-xs text-foreground ${i === active ? "bg-white/12" : "hover:bg-white/10"}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => {
                setActive(i);
                /* Preview: light the star (hover spotlight) before committing. */
                actions.hover(node.id);
              }}
              onMouseLeave={() => actions.hover(null)}
              onClick={() => pick(node.id)}
              title={node.id}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: cssColor(folderColor(node.dir)) }}
                  aria-hidden
                />
                <span className="block truncate">
                  {searchHighlightSegments(node.kind === "service" ? node.dir : node.id, search).map((segment, s) => (
                    segment.hit
                      ? <strong key={s} className="map-result-hit">{segment.text}</strong>
                      : <span key={s}>{segment.text}</span>
                  ))}
                </span>
              </span>
              {node.kind === "service" && (
                <span className="mt-0.5 block text-2xs uppercase tracking-wide text-cyan-200/70">
                  service · {node.inDegree} in · {node.outDegree} out
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Sampled star dots for the minimap. Memoized on referential equality so a
    camera move (which only changes the viewport rectangle) never re-renders
    the potentially-thousands of circles — nodes + projection are stable
    across camera motion. */
const MinimapDots = memo(function MinimapDots({ nodes, project, cap = 700 }: {
  nodes: GraphNode[];
  project: (x: number, y: number) => { x: number; y: number };
  cap?: number;
}) {
  const step = Math.max(1, Math.ceil(nodes.length / cap));
  const dots: React.ReactNode[] = [];
  for (let i = 0; i < nodes.length; i += step) {
    const node = nodes[i];
    if (!node) continue;
    const p = project(node.x, node.y);
    dots.push(<circle key={node.id} cx={p.x} cy={p.y} r={0.9} fill={cssColor(folderColor(node.dir))} fillOpacity={0.85} />);
  }
  return <>{dots}</>;
});

/** Bird's-eye overview of the whole star-map with a live viewport rectangle;
    click anywhere to fly the camera there. */
function Minimap({ view, camera, viewport, onJump }: {
  view: GraphViewState;
  camera: Camera;
  viewport: Viewport;
  onJump: (x: number, y: number) => void;
}) {
  const W = 150;
  const H = 106;
  const bounds = useMemo(() => nodeBounds(view.displayNodes), [view.displayNodes]);
  const geom = useMemo(() => {
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(W / bw, H / bh);
    return { scale, ox: (W - bw * scale) / 2, oy: (H - bh * scale) / 2 };
  }, [bounds]);
  const project = useMemo(
    () => (x: number, y: number) => ({ x: geom.ox + (x - bounds.minX) * geom.scale, y: geom.oy + (y - bounds.minY) * geom.scale }),
    [bounds, geom],
  );

  /* Drag state lives in a ref: pointer capture keeps move/up events flowing
     to the svg, and no re-render is needed — onJump already drives the camera. */
  const draggingRef = useRef(false);

  /* Faint territory blobs orient the dot field: same dirs and colors as the
     rail's territory index (raw file positions share the display space). */
  const territoryBlobs = useMemo(() => folderTerritories(view.nodes, MAX_MINIMAP_TERRITORIES), [view.nodes]);

  if (view.displayNodes.length < 3 || viewport.width === 0) return null;

  const rect = visibleWorldRect(camera, viewport);
  const rp = project(rect.x, rect.y);
  const rw = rect.width * geom.scale;
  const rh = rect.height * geom.scale;
  /* Clip to the minimap's own box rather than clamping only the top-left
     corner: once panned/zoomed out past the map's bounds (unrestricted - drag
     has no hard stop), clamping just x/y while keeping the full w/h stretched
     the indicator past its true extent, misrepresenting what's on screen. */
  const clipped = clampRectToBox({ x: rp.x, y: rp.y, width: rw, height: rh }, { width: W, height: H });

  /* "You are here": the focused star, in its territory color, so the minimap
     answers where the selection sits in the whole map — not just the camera. */
  const focusId = view.hoveredNodeId ?? view.selectedNodeId;
  const focusNode = focusId ? view.displayNodes.find((node) => node.id === focusId) : undefined;
  const focusPoint = focusNode ? project(focusNode.x, focusNode.y) : null;

  const jumpTo = (clientX: number, clientY: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect();
    const mx = ((clientX - box.left) / box.width) * W;
    const my = ((clientY - box.top) / box.height) * H;
    onJump(bounds.minX + (mx - geom.ox) / geom.scale, bounds.minY + (my - geom.oy) / geom.scale);
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="map-minimap pointer-events-auto absolute right-3 top-[52px] h-[106px] w-[150px] cursor-crosshair"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        draggingRef.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch { /* unsupported host; click-jump still works */ }
        jumpTo(e.clientX, e.clientY, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) jumpTo(e.clientX, e.clientY, e.currentTarget);
      }}
      onPointerUp={() => { draggingRef.current = false; }}
      onPointerCancel={() => { draggingRef.current = false; }}
      onLostPointerCapture={() => { draggingRef.current = false; }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onJump((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
      }}
      role="button"
      tabIndex={0}
      aria-label="Architecture minimap. Click or drag to move the camera, or press Enter to center the map."
    >
      {territoryBlobs.map((territory) => {
        const p = project(territory.x, territory.y);
        const color = cssColor(folderColor(territory.dir));
        const previewing = view.hoveredTerritory === territory.dir;
        return (
          <ellipse
            key={territory.dir}
            cx={p.x}
            cy={p.y}
            rx={Math.max(3, ((territory.bounds.maxX - territory.bounds.minX) / 2) * geom.scale)}
            ry={Math.max(3, ((territory.bounds.maxY - territory.bounds.minY) / 2) * geom.scale)}
            fill={color}
            fillOpacity={previewing ? 0.2 : 0.08}
            stroke={color}
            strokeOpacity={previewing ? 0.75 : 0.22}
            strokeWidth={0.6}
          />
        );
      })}
      <MinimapDots nodes={view.displayNodes} project={project} />
      <rect
        x={clipped.x}
        y={clipped.y}
        width={clipped.width}
        height={clipped.height}
        fill="rgba(255,255,255,0.06)"
        stroke="rgba(255,255,255,0.7)"
        strokeWidth={1}
        rx={1.5}
      />
      {focusPoint && focusNode && (
        <>
          <circle cx={focusPoint.x} cy={focusPoint.y} r={3.4} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={0.8} />
          <circle cx={focusPoint.x} cy={focusPoint.y} r={1.7} fill={cssColor(folderColor(focusNode.dir))} />
        </>
      )}
    </svg>
  );
}

/** Compact relative age for a commit epoch (seconds); null when unknown. */
function commitAge(sec?: number): string | null {
  if (!sec) return null;
  const days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** One click-to-navigate neighbor in the node card's Connections list:
    direction arrow, territory swatch, name, and where it lives. A neighbor
    folded into a collapsed cluster surfaces as that cluster (▤) row. */
function ConnectionRow({ peer, direction, onFocus }: {
  peer: GraphNode;
  direction: "in" | "out";
  onFocus: (id: string) => void;
}) {
  const cluster = isClusterNode(peer);
  const name = cluster ? shortClusterLabel(peer.dir) : baseName(peer.id);
  return (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[0.08]"
      onClick={() => onFocus(peer.id)}
      title={`${direction === "out" ? "imports" : "imported by"} ${cluster ? peer.dir : peer.id}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-2xs ${direction === "out" ? "text-cyan-200/80" : "text-amber-200/80"}`} aria-hidden>
        {direction === "out" ? "→" : "←"}
      </span>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(peer.dir)) }} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {cluster ? `▤ ${name}` : name}
      </span>
      <span className="max-w-[92px] shrink-0 truncate text-2xs text-muted-foreground">{cluster ? `${(peer.fileCount ?? 0).toLocaleString()} files` : peer.dir}</span>
    </button>
  );
}

function NodeCard({ node, onFocus }: { node: GraphNode; onFocus: (id: string) => void }) {
  const { view, pendingSymbolPath } = useGraphStore();
  const annotations = annotationsForNode(node.id, view.annotations);
  const expansion = view.symbolsByPath[node.id];
  const tracing = pendingSymbolPath === node.id;
  const relationTargets = useMemo(() => [...symbolRelationTargets(expansion)], [expansion]);
  const relationsPresent = useMemo(() => {
    const order: SymbolRelation[] = ["reference", "call", "extends", "implements"];
    const set = new Set<SymbolRelation>();
    for (const edge of expansion?.edges ?? []) set.add(edge.relation ?? "reference");
    return order.filter((r) => set.has(r));
  }, [expansion]);
  const targetsBySymbol = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const edge of expansion?.edges ?? []) {
      const list = grouped.get(edge.from) ?? [];
      if (!list.includes(edge.toPath)) list.push(edge.toPath);
      grouped.set(edge.from, list);
    }
    return grouped;
  }, [expansion]);
  const connections = useMemo(
    () => nodeConnections(node.id, view.displayNodes, view.displayEdges),
    [node.id, view.displayEdges, view.displayNodes],
  );
  const directLinks = node.inDegree + node.outDegree;
  const architectureRole = directLinks === 0
    ? "Isolated file"
    : node.inDegree >= Math.max(4, node.outDegree * 2)
      ? "Shared dependency"
      : node.outDegree >= Math.max(4, node.inDegree * 2)
        ? "Coordinator"
        : directLinks >= 12
          ? "Connectivity hub"
          : "Connected file";
  // The star's corner mark denotes this — naming it here is what makes the mark learnable.
  const functionalRole = fileRole(node.id);
  return (
    <div className="map-panel map-card map-selection-panel pointer-events-auto absolute bottom-3 left-3 w-[min(320px,calc(100vw-24px))]">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        {architectureRole}
        {functionalRole !== "source" && (
          <span
            className="ml-auto rounded-full border px-1.5 py-px text-2xs font-semibold uppercase tracking-wide"
            style={{
              color: cssColor(FILE_ROLE_COLORS[functionalRole]),
              borderColor: `color-mix(in srgb, ${cssColor(FILE_ROLE_COLORS[functionalRole])} 45%, transparent)`,
            }}
          >
            {FILE_ROLE_LABELS[functionalRole]}
          </span>
        )}
      </div>
      <div className="break-all font-mono text-sm text-foreground">{node.id}</div>
      <div className="map-relationship-summary">
        <div>
          <span>Dependents</span>
          <strong>{node.inDegree.toLocaleString()}</strong>
          <small>blast radius</small>
        </div>
        <div>
          <span>Dependencies</span>
          <strong>{node.outDegree.toLocaleString()}</strong>
          <small>outbound</small>
        </div>
        <div>
          <span>Size</span>
          <strong>{(node.sizeBytes / 1024).toFixed(1)}</strong>
          <small>KB</small>
        </div>
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-xs text-amber-200/70">
          {node.churn ? `${node.churn} recent commit${node.churn === 1 ? "" : "s"}` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      {(connections.dependencies.total > 0 || connections.dependents.total > 0) && (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Connections</div>
          <div className="mt-1 flex max-h-36 flex-col gap-px overflow-y-auto">
            {connections.dependencies.nodes.map((peer) => (
              <ConnectionRow key={`dep:${peer.id}`} peer={peer} direction="out" onFocus={onFocus} />
            ))}
            {connections.dependencies.total > connections.dependencies.nodes.length && (
              <div className="px-1 text-2xs text-muted-foreground">
                +{connections.dependencies.total - connections.dependencies.nodes.length} more dependencies
              </div>
            )}
            {connections.dependents.nodes.map((peer) => (
              <ConnectionRow key={`use:${peer.id}`} peer={peer} direction="in" onFocus={onFocus} />
            ))}
            {connections.dependents.total > connections.dependents.nodes.length && (
              <div className="px-1 text-2xs text-muted-foreground">
                +{connections.dependents.total - connections.dependents.nodes.length} more dependents
              </div>
            )}
          </div>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-border/60 pt-1.5">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-slate-300/80">Notes</div>
            <button
              className="text-2xs uppercase tracking-wide text-amber-200/75 hover:text-amber-100"
              onClick={() => actions.openNotesTimeline()}
              title="Open every map note as a scrollable timeline with revision trails and git history"
            >
              Timeline
            </button>
          </div>
          {annotations.map((a) => {
            const relation = a.scope === "edge" || (a.scope === undefined && Boolean(a.to));
            const categoryMeta = a.category ? CATEGORY_META[a.category] : undefined;
            const CategoryIcon = a.category ? NOTE_CATEGORY_ICONS[a.category] : undefined;
            const relKindLabel = relation ? relationKindLabel(a.relationKind) : undefined;
            return (
              <div key={a.id} className="text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-1">
                  {categoryMeta && CategoryIcon && (
                    <span className={`notes-category-badge notes-category-badge-${categoryMeta.className}`} title={categoryMeta.description}>
                      <CategoryIcon size={10} aria-hidden />
                      {categoryMeta.label}
                    </span>
                  )}
                  {relKindLabel && <span className="notes-relation-tag">{relKindLabel}</span>}
                  <span className="text-amber-300/90">
                    {!relation ? "note" : `${a.from === node.id ? "→ " : "← "}${a.from === node.id ? a.to : a.from}`}
                  </span>
                </div>
                {a.title && <div className="mt-0.5 font-semibold text-foreground/90">{a.title}</div>}
                <div className="mt-0.5">{a.note}</div>
                {a.history && a.history.length > 0 && (
                  <div className="mt-0.5 text-2xs text-slate-400/80">revised {a.history.length + 1}× across sessions</div>
                )}
                <button className="mt-0.5 text-2xs uppercase tracking-wide text-red-300/70 hover:text-red-300" onClick={() => actions.removeAnnotation(a.id)}>
                  remove
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1.5 border-t border-border/60 pt-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Relationship tracing</div>
          <button
            className="map-trace-button"
            disabled={tracing}
            onClick={() => expansion ? actions.collapseSymbols(node.id) : actions.traceRelationships(node.id)}
          >
            {tracing ? "Tracing..." : expansion ? "Collapse" : "Trace relationships"}
          </button>
        </div>
        {!expansion && !tracing && (
          <div className="mt-1 text-xs text-muted-foreground">
            Fetch this file&apos;s symbols and their relationships — references, calls, and inheritance — via the language server. Related files light up on the map.
          </div>
        )}
        {tracing && (
          <div className="mt-1 text-xs text-muted-foreground">
            Querying the language server for symbols and references.
          </div>
        )}
        {expansion && (
          <>
            <div className="mt-1 text-xs text-muted-foreground">
              {expansion.symbols.length} symbols · {relationTargets.length} related files
            </div>
            {relationsPresent.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                {relationsPresent.map((relation) => (
                  <span key={relation} className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(SYMBOL_RELATION_COLORS[relation]) }} />
                    {symbolRelationVerb(relation)}
                  </span>
                ))}
              </div>
            )}
            {expansion.error && (
              <div className="mt-1 rounded border border-amber-400/20 bg-amber-950/40 px-2 py-1 text-xs text-amber-200/85">
                {expansion.error}
              </div>
            )}
            {!expansion.error && expansion.symbols.length === 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                No top-level symbols were surfaced for this file.
              </div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && relationTargets.length === 0 && (
              <div className="mt-1 text-xs text-muted-foreground">
                Symbols were found, but no related files were returned.
              </div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && (
              <div className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-auto">
                {expansion.symbols.map((symbol) => {
                  const targets = targetsBySymbol.get(symbol.id) ?? [];
                  const relatedLabel = `${targets.length} related file${targets.length === 1 ? "" : "s"}`;
                  return (
                    <button
                      key={symbol.id}
                      className="rounded border border-white/6 bg-white/[0.03] px-2 py-1 text-left hover:bg-white/[0.08]"
                      onClick={() => actions.openFile(node.id, symbol.startLine)}
                      title={targets.join("\n")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs text-foreground">{symbol.name}</span>
                        <span className="shrink-0 text-2xs uppercase tracking-wide text-cyan-200/75">{symbol.kind}</span>
                      </div>
                      <div className="mt-0.5 text-2xs text-muted-foreground">
                        {relatedLabel} · line {symbol.startLine + 1}
                      </div>
                      {targets[0] && (
                        <div className="mt-0.5 truncate font-mono text-2xs text-slate-300/70">
                          {targets.slice(0, 2).join("  ·  ")}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-1.5 border-t border-border/60 pt-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-slate-300/80">Isolate</div>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((depth) => (
              <button
                key={depth}
                className={`map-tool-button !px-1.5 ${view.filter.isolateDepth === depth ? "map-tool-button-active" : ""}`}
                onClick={() => actions.setFilter({ isolateDepth: depth })}
                title={depth === 0 ? "Show the whole map" : `Show only files within ${depth} hop${depth === 1 ? "" : "s"}`}
              >
                {depth === 0 ? "Off" : depth}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1 text-2xs text-muted-foreground">Dim everything beyond N import hops from this file.</div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => actions.openFile(node.id)}
        >
          Open file
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15"
          onClick={() => actions.select(null)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Card for a collapsed cluster's super-node: what it stands for and a one-tap
    way back to the files inside. */
function ClusterCard({ node }: { node: GraphNode }) {
  return (
    <div className="map-panel map-card map-selection-panel pointer-events-auto absolute bottom-3 left-3 w-[min(320px,calc(100vw-24px))]">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        Folder cluster
      </div>
      <div className="break-all font-mono text-base text-foreground">{node.dir}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {(node.fileCount ?? 0).toLocaleString()} files collapsed · {node.inDegree + node.outDegree} imports crossing
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-xs text-amber-200/70">
          {node.churn ? `${node.churn} recent commits` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
          onClick={() => actions.setClusterCollapsed(node.dir, false)}
        >
          Expand cluster
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15"
          onClick={() => actions.select(null)}
        >
          Dismiss
        </button>
      </div>
      <div className="mt-1.5 text-2xs text-muted-foreground">Double-click the star to expand it too.</div>
    </div>
  );
}

function ServiceCard({ node, view }: { node: GraphNode; view: GraphViewState }) {
  /* Camera movement updates the outer map at rendering cadence. Keep this
     evidence projection tied to graph inputs rather than re-bundling a large
     relationship corpus every time the viewport changes. */
  const bundles = useMemo(
    () => serviceRelationshipBundles(view.displayNodes, view.displayEdges)
      .filter((bundle) => bundle.from === node.id || bundle.to === node.id)
      .slice(0, 8),
    [node.id, view.displayEdges, view.displayNodes],
  );
  return (
    <div className="map-panel map-card map-selection-panel pointer-events-auto absolute bottom-3 left-3 w-[min(344px,calc(100vw-24px))]">
      <div className="map-eyebrow flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rotate-45 rounded-[1px]" style={{ background: cssColor(folderColor(node.dir)) }} aria-hidden />
        Service
      </div>
      <div className="break-all font-mono text-base text-foreground">{node.dir}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {(node.fileCount ?? 0).toLocaleString()} rendered files represented - {node.inDegree} inbound - {node.outDegree} outbound
      </div>
      <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-auto border-t border-border/60 pt-1.5">
        {bundles.length === 0 && <div className="text-xs text-muted-foreground">No visible service relationships for the active layers.</div>}
        {bundles.map((bundle) => {
          const edge = bundle.representative;
          const color = relationshipColor(edge);
          const confidence = Math.round(bundle.averageConfidence * 100);
          const direction = bundle.from === node.id ? "out" : "in";
          return (
            <div
              key={bundle.id}
              className="map-service-edge"
              style={{ borderColor: `${color}59`, background: `linear-gradient(90deg, ${color}14, rgba(255,255,255,0.025))` }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {edge.label ?? relationshipKindLabel(bundle.kind)}{bundle.count > 1 ? ` · ${bundle.count} detections` : ""}
                </span>
                <span
                  className="map-service-kind"
                  style={{ borderColor: `${color}66`, backgroundColor: `${color}1f`, color }}
                >
                  {relationshipKindLabel(bundle.kind)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{direction === "out" ? "calls" : "called by"} {servicePeerLabel(edge, node)}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground/80">{confidence}%</span>
              </div>
              {edge.detail && <div className="mt-0.5 text-xs text-muted-foreground">{edge.detail}</div>}
              <div className="map-service-confidence" title={`Average confidence ${confidence}% · range ${Math.round(bundle.minConfidence * 100)}–${Math.round(bundle.maxConfidence * 100)}%`}>
                <span>Confidence</span>
                <div><i style={{ width: `${confidence}%`, background: color }} /></div>
              </div>
              {edge.evidence?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {edge.evidence.slice(0, 2).map((item) => (
                    <span key={item} className="map-service-evidence">{item}</span>
                  ))}
                </div>
              ) : null}
              {edge.ambiguousCandidateCount && edge.ambiguousCandidateCount > 1 ? (
                <div className="mt-1 text-2xs text-amber-200/75">
                  {edge.ambiguousCandidateCount} equally ranked provider candidates
                </div>
              ) : null}
              <div className="mt-1 flex gap-1">
                {edge.sourcePath && <button className="text-2xs text-cyan-200/80 hover:text-cyan-100" onClick={() => actions.openFile(edge.sourcePath!, edge.sourceLine)}>consumer</button>}
                {edge.targetPath && <button className="text-2xs text-cyan-200/80 hover:text-cyan-100" onClick={() => actions.openFile(edge.targetPath!, edge.targetLine)}>provider</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5">
        <button className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15" onClick={() => actions.select(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

const ALTITUDE_BANDS: Array<{ band: MapAltitude; label: string; hint: string }> = [
  { band: "overview", label: "Overview", hint: "Whole-map altitude: territories and the strongest routes" },
  { band: "modules", label: "Modules", hint: "Module altitude: hub labels and folder structure" },
  { band: "files", label: "Files", hint: "File altitude: individual stars, badges, and raw links" },
];

function Legend({ fileCount, importCount, gitHeat, relationshipCount, servicesLens, zoomRatio, onAltitude, onOpenMapKey }: {
  fileCount: number;
  importCount: number;
  gitHeat: boolean;
  relationshipCount: number;
  servicesLens: boolean;
  zoomRatio: number;
  onAltitude: (band: MapAltitude) => void;
  onOpenMapKey: () => void;
}) {
  const activeBand = altitudeBand(zoomRatio);
  return (
    <div className="map-legend pointer-events-none absolute bottom-3 right-3 flex flex-col gap-0.5 px-2 py-1.5">
      <button
        className="pointer-events-auto mb-0.5 self-end rounded border border-border/60 px-1.5 py-0.5 text-2xs text-slate-300/85 hover:bg-white/10 hover:text-foreground"
        onClick={onOpenMapKey}
        title="What am I looking at? Explains territories, stars, lines, and activity."
      >
        ? Map key
      </button>
      {/* Altitude meter: names the semantic zoom band the camera is at (the
          same bands the label overlay crossfades through) and flies there on
          click — the "where am I in the zoom hierarchy?" answer. */}
      <div className="pointer-events-auto mb-0.5 flex items-center gap-0.5 border-b border-border/60 pb-1" role="group" aria-label="Zoom altitude">
        {ALTITUDE_BANDS.map(({ band, label, hint }) => (
          <button
            key={band}
            className={`rounded px-1 py-0.5 text-2xs uppercase tracking-wide transition-colors ${
              activeBand === band ? "bg-white/15 text-foreground" : "text-muted-foreground hover:bg-white/8 hover:text-foreground"
            }`}
            aria-pressed={activeBand === band}
            onClick={() => onAltitude(band)}
            title={hint}
          >
            {label}
          </button>
        ))}
      </div>
      {fileCount > 0 && !servicesLens && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-xs text-slate-300/85">
          {fileCount.toLocaleString()} files · {importCount.toLocaleString()} imports
        </div>
      )}
      {relationshipCount > 0 && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-xs text-slate-300/85">
          {relationshipCount.toLocaleString()} service edges
        </div>
      )}
      {gitHeat && (
        <div className="mb-0.5 flex items-center gap-1.5 border-b border-border/60 pb-1 text-xs text-muted-foreground">
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }}
          />
          older → recent · size = churn
        </div>
      )}
      {servicesLens && (
        <div className="mb-0.5 flex flex-col gap-0.5 border-b border-border/60 pb-1">
          {RELATIONSHIP_LEGEND.map(({ label, kind }) => (
            <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6) }} />
              {label}
            </div>
          ))}
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-px w-8 rounded-full bg-gradient-to-r from-white/10 to-white/70" />
            faint → solid · detection confidence
          </div>
        </div>
      )}
      {LEGEND.map(({ label, kind }) => (
        <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
          {label}
        </div>
      ))}
    </div>
  );
}

/** Motions the map key demonstrates, in the order they're worth learning:
 *  the two you see constantly, then the typed service traffic, then the
 *  language-server layer. Each pairs with the colour its edges are actually
 *  drawn in, so the swatch teaches colour and movement together. */
const MOTION_LEGEND: Array<{ label: string; signature: FlowSignature; color: number }> = [
  { label: "Import", signature: signatureForEdgeKind("import"), color: IMPORT_EDGE_COLOR },
  { label: "API call", signature: signatureForEdgeKind("api"), color: RELATIONSHIP_EDGE_COLORS.api ?? IMPORT_EDGE_COLOR },
  { label: "Event", signature: signatureForEdgeKind("event"), color: RELATIONSHIP_EDGE_COLORS.event ?? IMPORT_EDGE_COLOR },
  { label: "Shared data", signature: signatureForEdgeKind("data"), color: RELATIONSHIP_EDGE_COLORS.data ?? IMPORT_EDGE_COLOR },
  { label: "Config ref", signature: signatureForEdgeKind("config"), color: RELATIONSHIP_EDGE_COLORS.config ?? IMPORT_EDGE_COLOR },
  { label: "Call", signature: signatureForSymbolRelation("call"), color: SYMBOL_RELATION_COLORS.call },
  { label: "Extends", signature: signatureForSymbolRelation("extends"), color: SYMBOL_RELATION_COLORS.extends },
  { label: "Reference", signature: signatureForSymbolRelation("reference"), color: SYMBOL_RELATION_COLORS.reference },
];

const PREFERS_REDUCED_MOTION =
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A shared ~30fps clock for the motion key's swatches. One timer for the whole
 *  panel rather than one per swatch, and only while `active` — the key is a
 *  transient overlay and must not keep a repaint loop running behind it. */
function useMotionClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || PREFERS_REDUCED_MOTION) return;
    const id = window.setInterval(() => setNow(Date.now()), 33);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** A live preview of one relationship's motion, driven by the *same*
 *  `flowParticles` the canvas uses — so the key can't drift from the map the
 *  way a hand-drawn CSS approximation would. Under reduced motion it renders a
 *  single static dot: the colour and the description still teach the mark. */
function MotionSwatch({ signature, color, now }: { signature: FlowSignature; color: number; now: number }) {
  const particles = PREFERS_REDUCED_MOTION
    ? [{ t: 0.5, alpha: signature.intensity, radius: signature.radius, reverse: false }]
    : flowParticles(signature, 0, now);
  return (
    <span className="relative h-3 w-14 shrink-0 self-center overflow-hidden rounded-full">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2" style={{ background: cssColor(color), opacity: 0.28 }} />
      {particles.map((particle, index) => (
        <span
          key={index}
          className="absolute top-1/2 rounded-full"
          style={{
            left: `${particle.t * 100}%`,
            width: `${particle.radius * 2.4}px`,
            height: `${particle.radius * 2.4}px`,
            marginLeft: `${-particle.radius * 1.2}px`,
            marginTop: `${-particle.radius * 1.2}px`,
            background: cssColor(color),
            opacity: particle.alpha,
          }}
        />
      ))}
    </span>
  );
}

function MapKeySwatch({ color, dashed }: { color: number; dashed?: boolean }) {
  return (
    <span
      className={`h-0 w-6 shrink-0 border-t-[1.5px] ${dashed ? "border-dashed" : "border-solid"}`}
      style={{ borderColor: cssColor(color) }}
    />
  );
}

/** The full explainer behind the "? Map key" button — this is the answer to
    "why does the map look like this," always one click away rather than
    something a user has to be told out-of-band. Every swatch here reuses the
    same color constants the renderer actually draws with, so it can't drift
    from what's on screen. */
function MapKeyPanel({ onClose }: { onClose: () => void }) {
  const motionNow = useMotionClock(true);
  return (
    <div className="map-panel pointer-events-auto absolute bottom-3 right-3 z-10 flex max-h-[75vh] w-[min(320px,calc(100vw-24px))] flex-col gap-3 overflow-y-auto px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-foreground">Map key</div>
        <button className="rounded border border-border/60 px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-white/10 hover:text-foreground" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Territories</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Each soft bordered region is a top-level folder. Its color is a fixed hash of the folder path — the same
          folder is always the same hue, in every session. Overlapping regions just mean two folders' files sit
          close together in the layout; it isn't a conflict.
        </p>
        <p className="text-sm leading-snug text-muted-foreground">
          The border pattern names what a territory mostly holds: solid = source code, dashed = tests,
          long-dash = config, dotted = docs, short-dash = styles — with the hue leaning toward that
          purpose's color.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Stars</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Every star is one file, colored by its territory. Size and brightness scale with how connected it is,
          plus the file's size on disk — a heavily-imported or large file reads bigger and brighter. A dimmed,
          ghosted star has been filtered out by search or isolation, not deleted.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-8 rounded-full" style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }} />
          with git heat on: warmer = more recently changed
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Aggregates</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-3 w-3 shrink-0 rounded-full border border-slate-300/80" />
          A ringed star is a whole folder collapsed into one — double-click it to unfold the files inside
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 shrink-0 rotate-45 border border-slate-300/80" />
          A diamond outline is a service in the Services lens — one node per deployable unit
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Badges</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Small glyphs on a star only appear once you're zoomed in close enough to read them.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-[#8fa9d6]" />
          A dot colored by file kind — code, markup, styles, data/config, or docs
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-[#ffd66b]" />
          A gold ring on the small fraction of files with the most connections — the hubs
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ffd66b]" />
          A gold dot — this file has agent working-memory notes attached; open it to read them
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="shrink-0">Role marks:</span>
          {ROLE_MARK_LEGEND.map(({ role, glyph }) => (
            <span key={role} className="flex items-center gap-1">
              <span className="font-mono text-xs" style={{ color: cssColor(FILE_ROLE_COLORS[role]) }}>{glyph}</span>
              {FILE_ROLE_LABELS[role].toLowerCase()}
            </span>
          ))}
        </div>
        <p className="text-xs leading-snug text-muted-foreground">
          A small shape in a star's lower-left corner names the file's job; plain source files carry none.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Lines</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapKeySwatch color={IMPORT_EDGE_COLOR} />
          Import between two files
        </div>
        {RELATIONSHIP_LEGEND.map(({ label, kind }) => (
          <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapKeySwatch color={RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6} />
            {label} relationship — thicker means more detections; brighter means higher detector confidence
          </div>
        ))}
        {SYMBOL_RELATION_LEGEND.map(({ label, relation }) => (
          <div key={relation} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapKeySwatch color={SYMBOL_RELATION_COLORS[relation]} />
            {label} (from the language server)
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapKeySwatch color={ANNOTATION_COLOR} dashed />
          A note an agent (or you) attached between two files
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Motion</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Relationships don't all move the same way — each one behaves like the thing it is, so you can read the
          map by movement before reading a single label. These previews run the exact animation the canvas does.
        </p>
        {MOTION_LEGEND.map(({ label, signature, color }) => (
          <div key={label} className="flex items-start gap-2 text-xs text-muted-foreground">
            <MotionSwatch signature={signature} color={color} now={motionNow} />
            <span className="leading-snug">
              <span className="text-slate-300">{label}</span> — {MOTION_DESCRIPTIONS[signature.motion]}
            </span>
          </div>
        ))}
        <p className="text-xs leading-snug text-muted-foreground">
          Stars breathe too: a file changed often and recently pulses visibly, while an untouched corner of the
          codebase sits almost perfectly still.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live activity</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Colored pulses flowing along a line mean an agent just read, wrote, edited, or ran a shell command near
          that file. A steady ring around a star means an agent is working on it right now. When several agents run
          in parallel, each gets its own identity color instead of the activity-kind color below.
        </p>
        {LEGEND.map(({ label, kind }) => (
          <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The file-lens link families, each carrying the exact hue its edges are
    drawn with (same constants the renderer strokes), so the chips double as a
    live legend: toggle a chip, and precisely that colored strand set appears
    or disappears on the canvas. */
const LINK_TYPES: Array<{
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
function LinkTypesSection({ view }: { view: GraphViewState }) {
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

const EDGE_MODES: Array<{ value: EdgeMode; label: string }> = [
  { value: "all", label: "Adaptive" },
  { value: "selected", label: "Focus" },
  { value: "clusters", label: "Bundles" },
  { value: "off", label: "Off" },
];

function MapControls({ renderer, view, savedViews, camera, viewport, onFocusNode }: {
  renderer: GraphRenderer | null;
  view: GraphViewState;
  savedViews: SavedView[];
  camera: Camera;
  viewport: Viewport;
  onFocusNode: (id: string) => void;
}) {
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
      aria-label="Map controls"
      data-map-region="controls"
    >
      <header className="map-toolbar-header">
        <div className="min-w-0">
          <div className="map-eyebrow">Architecture controls</div>
          <div className="map-toolbar-title">Display &amp; analysis</div>
        </div>
        <span
          className={`map-density-badge ${presentation.dense ? "map-density-badge-dense" : ""}`}
          title={`${presentation.density.toFixed(1)} visible ${view.display.lens === "services" ? "typed service routes" : "import links"} per node`}
        >
          {presentation.density.toFixed(1)}×
        </span>
      </header>
      <div className="map-presentation-status" data-map-edge-strategy={presentation.strategy}>
        <span>{view.display.lens === "services" ? "Services" : presentation.strategy === "bundled" ? "Overview" : presentation.strategy === "raw" ? "Detail" : "Mode"}</span>
        <strong>{presentationLabel}</strong>
      </div>
      <div className="map-toolbar-scroll">
      <div className="map-control-section">
        <div className="map-control-title">View</div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            className={`map-tool-button ${view.display.lens === "files" ? "map-tool-button-active" : ""}`}
            aria-pressed={view.display.lens === "files"}
            data-map-control="lens-files"
            onClick={() => actions.setDisplay({ lens: "files" })}
          >
            Files
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
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button type="button" className="map-tool-button" data-map-control="fit" onClick={() => renderer?.zoomToFitAll()}>Fit</button>
          <button type="button" className="map-tool-button" data-map-control="reindex" onClick={() => actions.rebuildIndex()} disabled={view.indexing}>
            {view.indexing ? "Indexing" : "Re-index"}
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
              <span>Neighborhoods</span><strong>{label}</strong>
            </button>
          );
        })()}
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
      {view.display.lens === "files" && <TerritoriesSection view={view} renderer={renderer} />}
      {view.display.lens === "files" && <HubsSection view={view} onFocusNode={onFocusNode} />}
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
          </>
        )}
        </div>
      </details>
      {view.display.lens === "files" && <FilterSection view={view} />}
      <SavedViewsSection savedViews={savedViews} />
      </div>
    </aside>
  );
}

/** Territory index: the biggest folder territories with their true canvas
    colors, so the color-hashed map finally has a readable directory. Click a
    row to frame that territory; Fold/Open toggles its cluster super-node —
    organizational control anchored to the exact hues on screen. */
function TerritoriesSection({ view, renderer }: { view: GraphViewState; renderer: GraphRenderer | null }) {
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
function HubsSection({ view, onFocusNode }: { view: GraphViewState; onFocusNode: (id: string) => void }) {
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
function SavedViewsSection({ savedViews }: { savedViews: SavedView[] }) {
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
function FilterSection({ view }: { view: GraphViewState }) {
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

const SHORTCUTS: Array<[string, string]> = [
  ["Drag", "Pan the map"],
  ["Wheel", "Zoom in / out"],
  ["Click star", "Select a file"],
  ["Double-click star", "Open the file (or expand a cluster)"],
  ["Click minimap", "Jump the camera there"],
  ["/", "Search"],
  ["Enter", "Open selected / top match"],
  ["F", "Fit whole map"],
  ["+ / -", "Zoom in / out"],
  ["WASD / Arrows", "Pan (hold Shift for a bigger step)"],
  ["Esc", "Clear selection / search"],
];

/** Heads-up readout of what the agent is doing on the map right now, driven by
    in-flight tool calls. Hidden when the agent is idle. */
function LiveActivityChip({ live }: { live: LiveActivity[] }) {
  if (live.length === 0) return null;
  const primary = live[0]; /* host sorts most-recent-first */
  if (!primary) return null;
  const color = cssColor(activityColor(primary.kind, primary.laneId));
  const extra = live.length - 1;
  const laneCount = new Set(live.map((item) => item.laneId ?? "main")).size;
  const laneLabel = primary.laneId ? "lane" : "main";
  return (
    <div className="map-live-chip pointer-events-none absolute left-1/2 top-3 -translate-x-1/2" role="status" aria-live="polite">
      <span className="map-live-dot" style={{ color, background: color }} />
      <span className="whitespace-nowrap text-xs text-foreground">
        <span style={{ color }}>{laneLabel}</span>{" "}
        <span className="text-muted-foreground">{traceKindVerb(primary.kind)}</span>{" "}
        <strong className="font-mono font-semibold">{baseName(primary.path)}</strong>
        {primary.detail && <span className="text-muted-foreground"> · {primary.detail}</span>}
        {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
        {laneCount > 1 && <span className="text-muted-foreground"> · {laneCount} lanes</span>}
      </span>
    </div>
  );
}

function HelpChip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
      {open && (
        <div className="mb-1 flex flex-col gap-1 rounded-md border border-border bg-black/80 px-2.5 py-2 backdrop-blur">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <kbd className="min-w-[42px] rounded border border-white/15 bg-white/5 px-1 py-0.5 text-center font-mono text-2xs text-slate-200">{key}</kbd>
              {label}
            </div>
          ))}
        </div>
      )}
      <button
        className="rounded-md border border-border bg-black/60 px-2 py-1 text-xs text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
        onClick={onToggle}
        title="Keyboard shortcuts (?)"
        aria-expanded={open}
      >
        {open ? "Hide keys" : "? Keys"}
      </button>
    </div>
  );
}

function capacityWarning(view: GraphViewState): string {
  const parts: string[] = [];
  if (view.indexedTruncated) parts.push(`indexed cap reached (${view.indexedFileCount.toLocaleString()} files scanned)`);
  if (view.renderedTruncated) parts.push(`render cap reached (${view.renderedNodeCount.toLocaleString()} stars shown)`);
  if (view.relationshipTruncated) {
    // relationshipTruncated also fires when the *candidate* provider/consumer/
    // event/data pool was capped before cross-matching even ran (e.g. every
    // call site belongs to one service, so nothing crosses services) — in
    // that case relationshipEdgeCount can be 0, and "0 edges shown" would
    // read as nonsensical rather than as the capacity notice it's meant to be.
    parts.push(
      view.relationshipEdgeCount > 0
        ? `relationship cap reached (${view.relationshipEdgeCount.toLocaleString()} edges shown)`
        : "relationship detection capped (too many API/event/data call sites to fully cross-match)",
    );
  }
  return parts.length ? parts.join(" - ") : `Large workspace - showing ${view.nodes.length.toLocaleString()} files sampled across every folder`;
}

/** Human labels so the onboarding panel reads in plain language, not lang codes
    and marketplace ids. */
const LANG_NAMES: Record<string, string> = {
  py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "C#",
  cshtml: "Razor", razor: "Blazor / Razor", c: "C", cpp: "C++",
  h: "C headers", hpp: "C++ headers", cc: "C++", cxx: "C++", hxx: "C++ headers", hh: "C++ headers",
  rb: "Ruby", php: "PHP", vue: "Vue", svelte: "Svelte",
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  dart: "Dart", kt: "Kotlin", kts: "Kotlin", scala: "Scala", sc: "Scala", lua: "Lua", ex: "Elixir", exs: "Elixir",
};
const EXTENSION_NAMES: Record<string, string> = {
  "ms-python.python": "Python",
  "golang.go": "Go",
  "rust-lang.rust-analyzer": "rust-analyzer",
  "redhat.java": "Java Language Support",
  "ms-dotnettools.csharp": "C# Dev Kit",
  "ms-vscode.cpptools": "C/C++",
  "Shopify.ruby-lsp": "Ruby LSP",
  "bmewburn.vscode-intelephense-client": "PHP Intelephense",
  "Vue.volar": "Vue (Official)",
  "svelte.svelte-vscode": "Svelte",
  "Dart-Code.dart-code": "Dart",
  "fwcd.kotlin": "Kotlin Language",
  "scalameta.metals": "Metals",
  "sumneko.lua": "Lua",
  "JakeBecker.elixir-ls": "ElixirLS",
};
const LSP_STATUS_COLOR: Record<string, string> = {
  available: "#8db4a8", limited: "#c4b08d", unknown: "#8aa6c0", missing: "#c78b94",
};
const langLabel = (lang: string): string => LANG_NAMES[lang] ?? lang.toUpperCase();

/** Onboarding panel that explains, in plain terms, how to get richer symbol
    relationships and offers a one-click path to each fix. Dismissible +
    collapsible so it never nags. Import/include relationships work without
    any of this — only the richer symbol/reference edges need a language
    server, and only whole-repo coverage (vs. file-by-file) needs background
    indexing on top of that. */
function LspDiagnostics({ view }: { view: GraphViewState }) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(true);
  const limited = useMemo(
    // Only languages that actually have an extension to install belong in this "install to
    // light up more" panel. The host clears `recommendation` once a language's extension is
    // installed, so an installed-but-still-warming server never surfaces here as a false nag.
    () => view.lspSupport
      .filter((item) => Boolean(item.recommendation) && (item.status === "missing" || item.status === "limited" || item.status === "unknown"))
      .slice(0, 5),
    [view.lspSupport],
  );
  // A working server for at least one language means background indexing (off by default —
  // it's the highest-cost layer) would actually have something to sweep across the repo.
  const hasWorkingLsp = useMemo(
    () => view.lspSupport.some((item) => item.status === "available" || item.status === "limited"),
    [view.lspSupport],
  );
  const showBackgroundPrompt = hasWorkingLsp && view.config.backgroundSymbols !== true;
  if (dismissed || (limited.length === 0 && !showBackgroundPrompt)) return null;
  const installable = [...new Map(limited.filter((i) => i.recommendation).map((i) => [i.recommendation!, i])).values()];
  return (
    <div className="map-panel map-lsp-panel pointer-events-auto absolute left-3 top-[178px] w-[min(310px,calc(100vw-24px))] px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <button className="flex items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
          <span className="text-sm">{open ? "▾" : "▸"}</span>
          <span className="text-sm font-semibold text-foreground">Light up more relationships</span>
        </button>
        <button
          className="shrink-0 text-sm leading-none text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      {open && (
        <>
          {limited.length > 0 && (
            <>
              <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Imports and includes are mapped automatically. <strong className="text-foreground/90">Symbol-level</strong>{" "}
                links (who calls or references what) come from each language&apos;s VS Code extension. Install one to
                reveal more edges for these files:
              </div>
              <div className="mt-1.5 flex flex-col gap-1">
                {limited.map((item) => (
                  <div key={item.lang} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: LSP_STATUS_COLOR[item.status] ?? "#8a8a93" }}
                      title={item.detail}
                    />
                    <span className="text-foreground/90">{langLabel(item.lang)}</span>
                    <span className="text-muted-foreground">· {item.fileCount.toLocaleString()} files</span>
                  </div>
                ))}
              </div>
              {installable.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {installable.map((item) => (
                    <button
                      key={item.recommendation}
                      className="map-tool-button !py-0.5 flex items-center gap-1"
                      onClick={() => actions.installExtension(item.recommendation!)}
                      title={`Open ${item.recommendation} in the Extensions view`}
                    >
                      <span className="text-xs">↓</span>
                      Install {EXTENSION_NAMES[item.recommendation!] ?? langLabel(item.lang)}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-2xs text-muted-foreground">
                Then use <span className="text-foreground/80">Trace relationships</span> on a file to pull in its symbol links.
              </div>
            </>
          )}
          {showBackgroundPrompt && (
            <div className={limited.length > 0 ? "mt-2.5 border-t border-border/40 pt-2" : "mt-1.5"}>
              <div className="text-xs leading-relaxed text-muted-foreground">
                A working language server was found. Turning on{" "}
                <strong className="text-foreground/90">background indexing</strong> maps these links across the
                whole repo automatically, instead of file-by-file via Trace relationships.
              </div>
              <button
                className="map-tool-button !py-0.5 mt-1.5"
                onClick={() => actions.setBackgroundSymbols(true)}
                title="Sets blacksite.graph.backgroundSymbols — runs on an idle budget and pauses while you edit."
              >
                Enable background indexing
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
      actions.setClusterCollapsed(file.dir, false);
    }
    return null;
  };
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && view.displayNodes.some((n) => n.id === pending)) {
      pendingFocusRef.current = null;
      rendererRef.current?.focusNode(pending);
    }
  }, [view.displayNodes]);

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
    if (target) actions.select(target);
    else if (viewRef.current.display.lens !== "services") actions.select(id);
    else actions.select(null);
    flyToNode(id, target);
  };

  /* Host-requested navigation ("Show on map" from the Notes timeline): select
     and fly to the file's star once the renderer and node data are live. */
  useEffect(() => {
    if (!pendingFocusPath || !renderer || view.nodes.length === 0) return;
    actions.clearPendingFocus();
    focusNode(pendingFocusPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusPath, renderer, view.nodes]);

  /* Follow mode: gently fly to the file the agent is actively working on when
     it changes. Only fires on a *new* primary target (not every message) so a
     sustained edit doesn't jitter the camera; resets when toggled off. */
  const lastFollowedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!view.display.followAgent) {
      lastFollowedRef.current = null;
      return;
    }
    const primary = view.liveActivity[0]?.path ?? null;
    if (primary && primary !== lastFollowedRef.current) {
      lastFollowedRef.current = primary;
      flyToNode(primary);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.display.followAgent, view.liveActivity]);

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
        search={view.search}
        nodes={view.nodes}
        searchNodes={view.display.lens === "services" ? view.displayNodes : view.nodes}
        indexedFileCount={view.indexedFileCount}
        indexedImportCount={view.indexedImportEdgeCount}
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
      <LiveActivityChip live={view.liveActivity} />
      {view.truncated && (
        <div
          className={`map-status-warning pointer-events-auto absolute left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-xs ${view.liveActivity.length > 0 ? "top-12" : "top-3"}`}
          title="Open Blacksite graph settings to raise indexed, rendered, or relationship caps on capable machines."
          role="status"
        >
          {capacityWarning(view)}
        </div>
      )}
      {!renderError && view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="map-panel px-3 py-1.5 text-sm text-muted-foreground" role="status" aria-live="polite">Indexing workspace...</div>
        </div>
      )}
      {!renderError && !view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="map-panel flex flex-col items-center gap-1 px-4 py-3 text-center">
            <span className="text-base font-semibold text-foreground">No files indexed yet</span>
            <span className="text-xs text-muted-foreground">
              Click <strong className="text-foreground/80">Re-index</strong> in the toolbar to build the map.
            </span>
          </div>
        </div>
      )}
      {!renderError && !view.indexing && view.relationshipIndexing && view.display.lens === "services" && view.displayNodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="map-panel map-analysis-progress px-3 py-1.5 text-sm text-muted-foreground" role="status" aria-live="polite">
            Tracing API, event, and data contracts in the background…
          </div>
        </div>
      )}
      {!renderError && serviceProjectionEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
          <div className="map-panel pointer-events-auto flex max-w-[320px] flex-col items-center gap-2 px-4 py-3 text-center" role="status" aria-live="polite" data-map-region="service-empty">
            <span className="text-base font-semibold text-foreground">No visible service routes</span>
            <span className="text-xs text-muted-foreground">
              {view.relationshipEdges.length === 0
                ? "No service/API relationships have been detected in this workspace yet."
                : "Every service relationship layer is currently hidden."}
            </span>
            <div className="flex gap-1.5">
              {view.relationshipEdges.length > 0 && (
                <button
                  className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
                  onClick={() => actions.setDisplay({ showApi: true, showEvents: true, showData: true, showConfig: true })}
                >
                  Show routes
                </button>
              )}
              <button
                className="rounded bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/15"
                onClick={() => actions.setDisplay({ lens: "files" })}
              >
                Browse files
              </button>
              {view.relationshipEdges.length === 0 && (
                <button
                  className="rounded bg-white/10 px-2 py-0.5 text-xs text-foreground hover:bg-white/20"
                  onClick={() => actions.rebuildIndex()}
                >
                  Re-index
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {renderError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="map-panel max-w-[280px] px-3 py-2 text-center text-sm text-muted-foreground" role="alert">
            <div>Couldn&apos;t start the map&apos;s renderer.</div>
            <div className="mt-1 text-xs opacity-70" title={renderError}>{renderError}</div>
          </div>
        </div>
      )}
      {selectedNode && (selectedNode.kind === "service"
        ? <ServiceCard key={selectedNode.id} node={selectedNode} view={view} />
        : isClusterNode(selectedNode)
        ? <ClusterCard key={selectedNode.id} node={selectedNode} />
        : <NodeCard key={selectedNode.id} node={selectedNode} onFocus={focusNode} />)}
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
