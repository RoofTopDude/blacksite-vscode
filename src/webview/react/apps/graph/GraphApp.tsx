/* Codebase Map webview: pixi star-map stage + HTML overlays (labels, search,
   node card, legend). State flows store → PixiStage; interactions flow back
   through store actions. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { visibleWorldRect, worldToScreen, type Camera, type Viewport } from "@/lib/graph/camera";
import { TRACE_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
  nodeBounds,
  positionedSymbols,
  searchMatches,
  shortClusterLabel,
  symbolRelationTargets,
  type GraphViewState,
} from "@/lib/graph/view-model";
import type { GraphNode } from "@/lib/graph/protocol";

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
    const byDir = new Map<string, { count: number; sx: number; sy: number }>();
    for (const node of view.nodes) {
      const entry = byDir.get(node.dir) ?? { count: 0, sx: 0, sy: 0 };
      entry.count += 1;
      entry.sx += node.x;
      entry.sy += node.y;
      byDir.set(node.dir, entry);
    }
    return [...byDir.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40)
      .map(([dir, { count, sx, sy }]) => ({ dir, count, x: sx / count, y: sy / count }));
  }, [view.nodes]);

  const symbolLabels = useMemo(() => {
    if (!view.symbolsEnabled || !selectedId) return [];
    return positionedSymbols(view.nodes, view.symbolsByPath)
      .filter((item) => item.parent.id === selectedId)
      .slice(0, 24);
  }, [view.nodes, view.symbolsByPath, view.symbolsEnabled, selectedId]);

  if (viewport.width === 0) return null;
  const nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  const focus = hoveredId ?? selectedId;
  const focusNode = focus ? nodeById.get(focus) : undefined;
  const clusterAlpha = Math.max(0, Math.min(0.9, 1.3 - camera.zoom));

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
      {view.symbolsEnabled && camera.zoom > 0.18 && symbolLabels.map(({ symbol, x, y }) => {
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

function SearchBar({ search, nodes, inputRef, onPick }: {
  search: string;
  nodes: GraphNode[];
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
    <div className="pointer-events-auto absolute left-2 top-2 w-60">
      <input
        ref={inputRef}
        value={search}
        onChange={(e) => actions.setSearch(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search files…  ( / )"
        spellCheck={false}
        className="w-full rounded-md border border-border bg-black/60 px-2 py-1 text-[11px] text-foreground outline-none backdrop-blur placeholder:text-muted-foreground focus:border-white/30"
      />
      {search.trim() && (
        <div className="mt-1 flex flex-col gap-px overflow-hidden rounded-md border border-border bg-black/70 backdrop-blur">
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
  const bounds = useMemo(() => nodeBounds(view.nodes), [view.nodes]);
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

  if (view.nodes.length < 3 || viewport.width === 0) return null;

  const rect = visibleWorldRect(camera, viewport);
  const rp = project(rect.x, rect.y);
  const rw = rect.width * geom.scale;
  const rh = rect.height * geom.scale;

  const jumpTo = (clientX: number, clientY: number, target: SVGSVGElement) => {
    const box = target.getBoundingClientRect();
    const mx = ((clientX - box.left) / box.width) * W;
    const my = ((clientY - box.top) / box.height) * H;
    onJump(bounds.minX + (mx - geom.ox) / geom.scale, bounds.minY + (my - geom.oy) / geom.scale);
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pointer-events-auto absolute right-2 top-11 h-[106px] w-[150px] cursor-crosshair rounded-md border border-border bg-black/55 backdrop-blur"
      onClick={(e) => jumpTo(e.clientX, e.clientY, e.currentTarget)}
      role="presentation"
    >
      <MinimapDots nodes={view.nodes} project={project} />
      <rect
        x={Math.max(0, rp.x)}
        y={Math.max(0, rp.y)}
        width={Math.min(W, rw)}
        height={Math.min(H, rh)}
        fill="rgba(255,255,255,0.06)"
        stroke="rgba(255,255,255,0.7)"
        strokeWidth={1}
        rx={1.5}
      />
    </svg>
  );
}

function NodeCard({ node }: { node: GraphNode }) {
  const { view } = useGraphStore();
  const annotations = annotationsForNode(node.id, view.annotations);
  const expansion = view.symbolsByPath[node.id];
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
    <div className="pointer-events-auto absolute bottom-2 left-2 w-64 rounded-lg border border-border bg-black/75 p-2.5 backdrop-blur">
      <div className="break-all font-mono text-[11px] text-foreground">{node.id}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {node.inDegree} imported-by · {node.outDegree} imports · {(node.sizeBytes / 1024).toFixed(1)} KB
      </div>
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
          {!view.symbolsEnabled ? (
            <button
              className="rounded bg-cyan-500/12 px-2 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200/80 hover:bg-cyan-500/20"
              onClick={() => actions.toggleSymbols()}
            >
              Enable
            </button>
          ) : (
            <button
              className="rounded bg-cyan-500/12 px-2 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200/80 hover:bg-cyan-500/20"
              onClick={() => expansion ? actions.collapseSymbols(node.id) : actions.expandSymbols(node.id)}
            >
              {expansion ? "Collapse" : "Trace"}
            </button>
          )}
        </div>
        {!view.symbolsEnabled && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Turn on symbol-level tracing to orbit file symbols and highlight which files they drive.
          </div>
        )}
        {view.symbolsEnabled && !expansion && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Expand this file to fetch language-server symbols and reference-based relationships.
          </div>
        )}
        {view.symbolsEnabled && expansion && (
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

function Legend({ fileCount, importCount }: { fileCount: number; importCount: number }) {
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col gap-0.5 rounded-md border border-border bg-black/60 px-2 py-1.5 backdrop-blur">
      {fileCount > 0 && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-[9.5px] text-slate-300/85">
          {fileCount.toLocaleString()} files · {importCount.toLocaleString()} imports
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

const SHORTCUTS: Array<[string, string]> = [
  ["/", "Search"],
  ["Enter", "Open selected / top match"],
  ["F", "Fit whole map"],
  ["+ / −", "Zoom in / out"],
  ["Arrows", "Pan"],
  ["Esc", "Clear selection / search"],
];

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

  useEffect(() => {
    actions.ready();
  }, []);

  const selectedNode = view.selectedNodeId
    ? view.nodes.find((node) => node.id === view.selectedNodeId) ?? null
    : null;

  /* Latest values for the window-level key handler without re-attaching it. */
  const rendererRef = useRef<GraphRenderer | null>(null);
  rendererRef.current = renderer;
  const viewRef = useRef(view);
  viewRef.current = view;

  const focusNode = (id: string) => {
    actions.select(id);
    rendererRef.current?.focusNode(id);
  };

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
          e.preventDefault();
          r?.panBy(e.shiftKey ? 200 : 70, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          r?.panBy(e.shiftKey ? -200 : -70, 0);
          break;
        case "ArrowUp":
          e.preventDefault();
          r?.panBy(0, e.shiftKey ? 200 : 70);
          break;
        case "ArrowDown":
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
    <div ref={containerRef} className="relative h-screen w-full select-none overflow-hidden bg-[#0b0e1a] text-foreground">
      <PixiStage view={view} onRenderer={setRenderer} />
      <LabelsOverlay
        view={view}
        camera={camera}
        viewport={viewport}
        hoveredId={view.hoveredNodeId}
        selectedId={view.selectedNodeId}
      />
      <SearchBar search={view.search} nodes={view.nodes} inputRef={searchInputRef} onPick={focusNode} />
      <div className="pointer-events-auto absolute right-2 top-2 flex gap-1.5">
        <button
          className="rounded-md border border-border bg-black/60 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
          onClick={() => renderer?.zoomToFitAll()}
        >
          Fit
        </button>
        <button
          className={`rounded-md border px-2 py-1 text-[10px] backdrop-blur ${
            view.symbolsEnabled
              ? "border-cyan-400/30 bg-cyan-500/12 text-cyan-100 hover:bg-cyan-500/18"
              : "border-border bg-black/60 text-muted-foreground hover:bg-white/10 hover:text-foreground"
          }`}
          onClick={() => actions.toggleSymbols()}
        >
          {view.symbolsEnabled ? "Relations on" : "Relations off"}
        </button>
        <button
          className="rounded-md border border-border bg-black/60 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
          onClick={() => actions.rebuildIndex()}
          disabled={view.indexing}
        >
          {view.indexing ? "Indexing…" : "Re-index"}
        </button>
      </div>
      {view.nodes.length >= 3 && (
        <Minimap view={view} camera={camera} viewport={viewport} onJump={(x, y) => renderer?.focusWorld(x, y)} />
      )}
      {view.truncated && (
        <div
          className="pointer-events-auto absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-amber-400/40 bg-amber-950/60 px-2.5 py-0.5 text-[10px] text-amber-200 backdrop-blur"
          title="Showing a fair sample spread across every folder, not just the first ones found. Raise blacksite.graph.maxNodes in settings to show more."
        >
          Large workspace — showing {view.nodes.length} files sampled across every folder
        </div>
      )}
      {view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="rounded-md bg-black/70 px-3 py-1.5 text-[11px] text-muted-foreground">Indexing workspace…</div>
        </div>
      )}
      {!view.indexing && view.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-md bg-black/70 px-3 py-1.5 text-[11px] text-muted-foreground">No files indexed yet — try Re-index</div>
        </div>
      )}
      {selectedNode && <NodeCard node={selectedNode} />}
      <Legend
        fileCount={view.nodes.length}
        importCount={view.edges.reduce((n, e) => n + (e.kind === "import" ? 1 : 0), 0)}
      />
      <HelpChip open={showHelp} onToggle={() => setShowHelp((s) => !s)} />
    </div>
  );
}
