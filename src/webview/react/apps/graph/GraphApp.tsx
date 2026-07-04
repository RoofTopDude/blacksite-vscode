/* Codebase Map webview: pixi star-map stage + HTML overlays (labels, search,
   node card, legend). State flows store → PixiStage; interactions flow back
   through store actions. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { clampRectToBox, visibleWorldRect, worldToScreen, zoomToFit, type Camera, type Viewport } from "@/lib/graph/camera";
import { GIT_WARM_COLOR, TRACE_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
  baseName,
  filterIsActive,
  isClusterNode,
  languageCounts,
  selectedEdgeLabels,
  nodeBounds,
  positionedSymbols,
  searchMatches,
  shortClusterLabel,
  symbolRelationTargets,
  traceKindVerb,
  type EdgeMode,
  type GraphViewState,
} from "@/lib/graph/view-model";
import type { GraphNode, LiveActivity } from "@/lib/graph/protocol";

const LEGEND: Array<{ label: string; kind: keyof typeof TRACE_COLORS }> = [
  { label: "Read", kind: "read" },
  { label: "Write", kind: "write" },
  { label: "Edit", kind: "edit" },
  { label: "Shell", kind: "shell" },
  { label: "Navigate", kind: "nav" },
];

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
  const clusters = useMemo(() => {
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
      .slice(0, 40)
      .map(([dir, { count, weight, sx, sy }]) => ({ dir, count, x: sx / weight, y: sy / weight }));
  }, [view.displayNodes]);

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
  const clusterAlpha = Math.max(0, Math.min(0.9, 1.3 - zoomRatio));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {clusterAlpha > 0.05 && clusters.map(({ dir, x, y, count }) => {
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -80 || p.y < -20 || p.x > viewport.width + 80 || p.y > viewport.height + 20) return null;
        return (
          <div
            key={dir}
            className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-widest"
            style={{ left: p.x, top: p.y, color: cssColor(folderColor(dir)), opacity: clusterAlpha * Math.min(1, 0.45 + count / 40) }}
            title={dir}
          >
            {shortClusterLabel(dir)}
          </div>
        );
      })}
      {focusNode && (() => {
        const p = worldToScreen(camera, viewport, focusNode.x, focusNode.y);
        return (
          <div
            className="absolute -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white"
            style={{ left: p.x, top: p.y + 10 }}
          >
            {focusNode.id}
          </div>
        );
      })()}
      {view.symbolsEnabled && zoomRatio > 1.6 && symbolLabels.map(({ symbol, x, y }) => {
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -100 || p.y < -24 || p.x > viewport.width + 100 || p.y > viewport.height + 24) return null;
        return (
          <div
            key={symbol.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-slate-950/70 px-1 py-0.5 font-mono text-[9px] text-slate-200/85"
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

function SearchBar({ search, nodes, importCount, indexing, inputRef, onPick }: {
  search: string;
  nodes: GraphNode[];
  importCount: number;
  indexing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
}) {
  const matches = useMemo(() => searchMatches(nodes, search, 8), [nodes, search]);
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [search]);

  const pick = (id: string) => {
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
    <div className="map-panel pointer-events-auto absolute left-3 top-3 w-[min(320px,calc(100vw-24px))]">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="map-eyebrow">Codebase Map</div>
          <div className="truncate text-[12px] font-semibold text-foreground">Workspace relationships</div>
        </div>
        <div className={`map-status ${indexing ? "map-status-live" : ""}`}>
          {indexing ? "Indexing" : `${nodes.length.toLocaleString()} files`}
        </div>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <div className="map-stat">
          <span>Files</span>
          <strong>{nodes.length.toLocaleString()}</strong>
        </div>
        <div className="map-stat">
          <span>Imports</span>
          <strong>{importCount.toLocaleString()}</strong>
        </div>
      </div>
      <input
        ref={inputRef}
        value={search}
        onChange={(e) => actions.setSearch(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search files...  ( / )"
        spellCheck={false}
        className="map-search-input"
      />
      {search.trim() && (
        <div className="map-results mt-1 flex flex-col gap-px overflow-hidden">
          {matches.length === 0 && <div className="px-2 py-1 text-[10px] text-muted-foreground">No matches</div>}
          {matches.map((node, i) => (
            <button
              key={node.id}
              className={`truncate px-2 py-1 text-left font-mono text-[10px] text-foreground ${i === active ? "bg-white/12" : "hover:bg-white/10"}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(node.id)}
              title={node.id}
            >
              {node.id}
            </button>
          ))}
        </div>
      )}
    </div>
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
      onClick={(e) => jumpTo(e.clientX, e.clientY, e.currentTarget)}
      role="presentation"
    >
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

function NodeCard({ node }: { node: GraphNode }) {
  const { view, pendingSymbolPath } = useGraphStore();
  const annotations = annotationsForNode(node.id, view.annotations);
  const expansion = view.symbolsByPath[node.id];
  const tracing = pendingSymbolPath === node.id;
  const relationTargets = useMemo(() => [...symbolRelationTargets(expansion)], [expansion]);
  const targetsBySymbol = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const edge of expansion?.edges ?? []) {
      const list = grouped.get(edge.from) ?? [];
      if (!list.includes(edge.toPath)) list.push(edge.toPath);
      grouped.set(edge.from, list);
    }
    return grouped;
  }, [expansion]);
  return (
    <div className="map-panel pointer-events-auto absolute bottom-3 left-3 w-[min(300px,calc(100vw-24px))]">
      <div className="break-all font-mono text-[11px] text-foreground">{node.id}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {node.inDegree} imported-by · {node.outDegree} imports · {(node.sizeBytes / 1024).toFixed(1)} KB
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-[10px] text-amber-200/70">
          {node.churn ? `${node.churn} recent commit${node.churn === 1 ? "" : "s"}` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      {annotations.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-t border-border/60 pt-1.5">
          {annotations.map((a) => (
            <div key={a.id} className="text-[10px] text-muted-foreground">
              <span className="text-amber-300/90">{a.from === node.id ? "→ " : "← "}{a.from === node.id ? a.to : a.from}</span>
              <div className="mt-0.5">{a.note}</div>
              <button className="mt-0.5 text-[9px] uppercase tracking-wide text-red-300/70 hover:text-red-300" onClick={() => actions.removeAnnotation(a.id)}>
                remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 border-t border-border/60 pt-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-300/80">Relationship tracing</div>
          <button
            className="map-trace-button"
            disabled={tracing}
            onClick={() => expansion ? actions.collapseSymbols(node.id) : actions.traceRelationships(node.id)}
          >
            {tracing ? "Tracing..." : expansion ? "Collapse" : "Trace relationships"}
          </button>
        </div>
        {!expansion && !tracing && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Fetch symbols and reference edges for this file. Related files will be labeled on the map.
          </div>
        )}
        {tracing && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Querying the language server for symbols and references.
          </div>
        )}
        {expansion && (
          <>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {expansion.symbols.length} symbols · {relationTargets.length} related files
            </div>
            {expansion.error && (
              <div className="mt-1 rounded border border-amber-400/20 bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200/85">
                {expansion.error}
              </div>
            )}
            {!expansion.error && expansion.symbols.length === 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground">
                No top-level symbols were surfaced for this file.
              </div>
            )}
            {!expansion.error && expansion.symbols.length > 0 && relationTargets.length === 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground">
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
                        <span className="truncate font-mono text-[10px] text-foreground">{symbol.name}</span>
                        <span className="shrink-0 text-[9px] uppercase tracking-wide text-cyan-200/75">{symbol.kind}</span>
                      </div>
                      <div className="mt-0.5 text-[9px] text-muted-foreground">
                        {relatedLabel} · line {symbol.startLine + 1}
                      </div>
                      {targets[0] && (
                        <div className="mt-0.5 truncate font-mono text-[9px] text-slate-300/70">
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
          <div className="text-[10px] uppercase tracking-wide text-slate-300/80">Isolate</div>
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
        <div className="mt-1 text-[9px] text-muted-foreground">Dim everything beyond N import hops from this file.</div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-white/20"
          onClick={() => actions.openFile(node.id)}
        >
          Open file
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-white/15"
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
    <div className="map-panel pointer-events-auto absolute bottom-3 left-3 w-[min(300px,calc(100vw-24px))]">
      <div className="map-eyebrow">Folder cluster</div>
      <div className="break-all font-mono text-[12px] text-foreground">{node.dir}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {(node.fileCount ?? 0).toLocaleString()} files collapsed · {node.inDegree + node.outDegree} imports crossing
      </div>
      {(node.churn || node.lastCommitAt) && (
        <div className="mt-0.5 text-[10px] text-amber-200/70">
          {node.churn ? `${node.churn} recent commits` : "tracked"}
          {commitAge(node.lastCommitAt) ? ` · last ${commitAge(node.lastCommitAt)}` : ""}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-white/20"
          onClick={() => actions.setClusterCollapsed(node.dir, false)}
        >
          Expand cluster
        </button>
        <button
          className="rounded bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-white/15"
          onClick={() => actions.select(null)}
        >
          Dismiss
        </button>
      </div>
      <div className="mt-1.5 text-[9px] text-muted-foreground">Double-click the star to expand it too.</div>
    </div>
  );
}

function Legend({ fileCount, importCount, gitHeat }: { fileCount: number; importCount: number; gitHeat: boolean }) {
  return (
    <div className="map-legend pointer-events-none absolute bottom-3 right-3 flex flex-col gap-0.5 px-2 py-1.5">
      {fileCount > 0 && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-[9.5px] text-slate-300/85">
          {fileCount.toLocaleString()} files · {importCount.toLocaleString()} imports
        </div>
      )}
      {gitHeat && (
        <div className="mb-0.5 flex items-center gap-1.5 border-b border-border/60 pb-1 text-[9.5px] text-muted-foreground">
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }}
          />
          older → recent · size = churn
        </div>
      )}
      {LEGEND.map(({ label, kind }) => (
        <div key={kind} className="flex items-center gap-1.5 text-[9.5px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
          {label}
        </div>
      ))}
    </div>
  );
}

const EDGE_MODES: Array<{ value: EdgeMode; label: string }> = [
  { value: "all", label: "All" },
  { value: "selected", label: "Focus" },
  { value: "clusters", label: "Clusters" },
  { value: "off", label: "Off" },
];

function MapControls({ renderer, view }: { renderer: GraphRenderer | null; view: GraphViewState }) {
  const setLayer = (key: "showImports" | "showAnnotations" | "showRelations" | "showEdgeLabels" | "showGitHeat") => {
    actions.setDisplay({ [key]: !view.display[key] });
  };
  const gitData = useMemo(() => view.displayNodes.some((n) => n.lastCommitAt), [view.displayNodes]);
  return (
    <div className="map-toolbar pointer-events-auto absolute right-3 top-[166px] flex w-[156px] flex-col gap-2">
      <div className="map-control-section">
        <div className="map-control-title">View</div>
        <div className="grid grid-cols-2 gap-1">
          <button className="map-tool-button" onClick={() => renderer?.zoomToFitAll()}>Fit</button>
          <button className="map-tool-button" onClick={() => actions.rebuildIndex()} disabled={view.indexing}>
            {view.indexing ? "Indexing" : "Re-index"}
          </button>
        </div>
        <button
          className={`map-layer-toggle ${view.display.followAgent ? "map-layer-toggle-on" : ""}`}
          onClick={() => actions.setDisplay({ followAgent: !view.display.followAgent })}
          title="Gently pan to the file the agent is working on"
        >
          <span>Follow agent</span><strong>{view.display.followAgent ? "On" : "Off"}</strong>
        </button>
      </div>
      <div className="map-control-section">
        <div className="map-control-title">Clusters</div>
        <div className="grid grid-cols-2 gap-1">
          <button
            className="map-tool-button"
            onClick={() => actions.collapseAllClusters()}
            title="Collapse every folder into a single super-node"
          >
            Collapse
          </button>
          <button
            className="map-tool-button"
            onClick={() => actions.expandAllClusters()}
            disabled={view.collapsedClusters.length === 0}
            title="Expand all clusters back to individual files and their relations"
          >
            Expand all
          </button>
        </div>
        {view.collapsedClusters.length > 0 && (
          <div className="mt-1 text-[9px] text-muted-foreground">
            {view.collapsedClusters.length} collapsed · double-click one to open it
          </div>
        )}
      </div>
      <div className="map-control-section">
        <div className="map-control-title">Edges</div>
        <div className="grid grid-cols-2 gap-1">
          {EDGE_MODES.map((mode) => (
            <button
              key={mode.value}
              className={`map-tool-button ${view.display.edgeMode === mode.value ? "map-tool-button-active" : ""}`}
              onClick={() => actions.setDisplay({ edgeMode: mode.value })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      <div className="map-control-section">
        <div className="map-control-title">Layers</div>
        <button className={`map-layer-toggle ${view.display.showImports ? "map-layer-toggle-on" : ""}`} onClick={() => setLayer("showImports")}>
          <span>Imports</span><strong>{view.display.showImports ? "On" : "Off"}</strong>
        </button>
        <button className={`map-layer-toggle ${view.display.showAnnotations ? "map-layer-toggle-on" : ""}`} onClick={() => setLayer("showAnnotations")}>
          <span>Notes</span><strong>{view.display.showAnnotations ? "On" : "Off"}</strong>
        </button>
        <button className={`map-layer-toggle ${view.display.showRelations ? "map-layer-toggle-on" : ""}`} onClick={() => setLayer("showRelations")}>
          <span>Symbols</span><strong>{view.display.showRelations ? "On" : "Off"}</strong>
        </button>
        <button className={`map-layer-toggle ${view.display.showEdgeLabels ? "map-layer-toggle-on" : ""}`} onClick={() => setLayer("showEdgeLabels")}>
          <span>Labels</span><strong>{view.display.showEdgeLabels ? "On" : "Off"}</strong>
        </button>
        <button
          className={`map-layer-toggle ${view.display.showGitHeat ? "map-layer-toggle-on" : ""}`}
          onClick={() => setLayer("showGitHeat")}
          title="Tint stars by commit recency (warm = recently changed) and size them by churn"
        >
          <span>Git heat</span><strong>{view.display.showGitHeat ? "On" : "Off"}</strong>
        </button>
        {view.display.showGitHeat && !gitData && (
          <div className="mt-1 text-[9px] text-muted-foreground">No git history found in this workspace.</div>
        )}
      </div>
      <FilterSection view={view} />
    </div>
  );
}

/** Language chips + a min-links stepper. Filtered-out stars ghost (they don't
    vanish), so the map keeps its shape while you narrow focus. Isolate-by-hops
    lives on the node card, where a selection gives it a root. */
function FilterSection({ view }: { view: GraphViewState }) {
  const langs = useMemo(() => languageCounts(view.nodes).slice(0, 8), [view.nodes]);
  const active = filterIsActive(view.filter, Boolean(view.selectedNodeId));
  const { filter } = view;
  const stepMinDegree = (delta: number) =>
    actions.setFilter({ minDegree: Math.max(0, Math.min(20, filter.minDegree + delta)) });
  if (langs.length === 0) return null;
  return (
    <div className="map-control-section">
      <div className="flex items-center justify-between">
        <div className="map-control-title">Filter</div>
        {active && (
          <button
            className="text-[9px] uppercase tracking-wide text-cyan-200/70 hover:text-cyan-200"
            onClick={() => actions.clearFilter()}
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {langs.map(({ lang, count }) => {
          const on = filter.langs.includes(lang);
          return (
            <button
              key={lang}
              className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] transition-colors ${on ? "bg-cyan-400/25 text-cyan-50" : "bg-white/5 text-muted-foreground hover:bg-white/10"}`}
              onClick={() => actions.toggleLanguage(lang)}
              title={`${count.toLocaleString()} ${lang} file${count === 1 ? "" : "s"}`}
            >
              {lang}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[9.5px] text-muted-foreground">
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
  const color = cssColor(TRACE_COLORS[primary.kind]);
  const extra = live.length - 1;
  return (
    <div className="map-live-chip pointer-events-none absolute left-1/2 top-3 -translate-x-1/2">
      <span className="map-live-dot" style={{ color, background: color }} />
      <span className="whitespace-nowrap text-[10px] text-foreground">
        <span style={{ color }}>{traceKindVerb(primary.kind)}</span>{" "}
        <strong className="font-mono font-semibold">{baseName(primary.path)}</strong>
        {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
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
            <div key={key} className="flex items-center gap-2 text-[9.5px] text-muted-foreground">
              <kbd className="min-w-[42px] rounded border border-white/15 bg-white/5 px-1 py-0.5 text-center font-mono text-[9px] text-slate-200">{key}</kbd>
              {label}
            </div>
          ))}
        </div>
      )}
      <button
        className="rounded-md border border-border bg-black/60 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
        onClick={onToggle}
        title="Keyboard shortcuts (?)"
      >
        {open ? "Hide keys" : "? Keys"}
      </button>
    </div>
  );
}

export function GraphApp() {
  const { view, camera } = useGraphStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const viewport = useViewport(containerRef);
  const [renderer, setRenderer] = useState<GraphRenderer | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    actions.ready();
  }, []);

  const selectedNode = view.selectedNodeId
    ? view.displayNodes.find((node) => node.id === view.selectedNodeId) ?? null
    : null;

  /* Latest values for the window-level key handler without re-attaching it. */
  const rendererRef = useRef<GraphRenderer | null>(null);
  rendererRef.current = renderer;
  const viewRef = useRef(view);
  viewRef.current = view;

  /* Fly to a node, expanding its cluster first if it's currently collapsed
     (search results and follow-agent can target a file hidden inside a
     super-node). The actual focus is deferred to the effect below, which fires
     once the newly-expanded file lands in displayNodes. */
  const pendingFocusRef = useRef<string | null>(null);
  const flyToNode = (id: string) => {
    if (viewRef.current.displayNodes.some((n) => n.id === id)) {
      rendererRef.current?.focusNode(id);
      return;
    }
    const file = viewRef.current.nodes.find((n) => n.id === id);
    if (file) {
      pendingFocusRef.current = id;
      actions.setClusterCollapsed(file.dir, false);
    }
  };
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && view.displayNodes.some((n) => n.id === pending)) {
      pendingFocusRef.current = null;
      rendererRef.current?.focusNode(pending);
    }
  }, [view.displayNodes]);

  const focusNode = (id: string) => {
    actions.select(id);
    flyToNode(id);
  };

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
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      if (e.key === "Escape") {
        if (typing) (target as HTMLElement).blur();
        if (v.search) actions.setSearch("");
        else if (v.selectedNodeId) actions.select(null);
        return;
      }
      if (typing) return; /* let the search box own every other key */

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
          if (v.selectedNodeId) actions.openFile(v.selectedNodeId);
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
    <div ref={containerRef} className="map-root relative h-screen w-full select-none overflow-hidden text-foreground">
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
        importCount={view.edges.reduce((n, e) => n + (e.kind === "import" ? 1 : 0), 0)}
        indexing={view.indexing}
        inputRef={searchInputRef}
        onPick={focusNode}
      />
      <MapControls renderer={renderer} view={view} />
      {view.displayNodes.length >= 3 && (
        <Minimap view={view} camera={camera} viewport={viewport} onJump={(x, y) => renderer?.focusWorld(x, y)} />
      )}
      <LiveActivityChip live={view.liveActivity} />
      {view.truncated && (
        <div
          className={`map-status-warning pointer-events-auto absolute left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-[10px] ${view.liveActivity.length > 0 ? "top-12" : "top-3"}`}
          title="Showing a fair sample spread across every folder, not just the first ones found. Raise blacksite.graph.maxNodes in settings to show more."
        >
          Large workspace - showing {view.nodes.length} files sampled across every folder
        </div>
      )}
      {!renderError && view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="map-panel px-3 py-1.5 text-[11px] text-muted-foreground">Indexing workspace...</div>
        </div>
      )}
      {!renderError && !view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="map-panel px-3 py-1.5 text-[11px] text-muted-foreground">No files indexed yet - try Re-index</div>
        </div>
      )}
      {renderError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="map-panel max-w-[280px] px-3 py-2 text-center text-[11px] text-muted-foreground">
            <div>Couldn&apos;t start the map&apos;s renderer.</div>
            <div className="mt-1 text-[9.5px] opacity-70" title={renderError}>{renderError}</div>
          </div>
        </div>
      )}
      {selectedNode && (isClusterNode(selectedNode) ? <ClusterCard node={selectedNode} /> : <NodeCard node={selectedNode} />)}
      <Legend
        fileCount={view.nodes.length}
        importCount={view.edges.reduce((n, e) => n + (e.kind === "import" ? 1 : 0), 0)}
        gitHeat={view.display.showGitHeat}
      />
      <HelpChip open={showHelp} onToggle={() => setShowHelp((s) => !s)} />
    </div>
  );
}
