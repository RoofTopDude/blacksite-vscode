/* Codebase Map webview: pixi star-map stage + HTML overlays (labels, search,
   node card, legend). State flows store → PixiStage; interactions flow back
   through store actions. */

import { useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { worldToScreen, type Camera, type Viewport } from "@/lib/graph/camera";
import { TRACE_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import {
  annotationsForNode,
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

function SearchBar({ search, nodes }: { search: string; nodes: GraphNode[] }) {
  const matches = useMemo(() => searchMatches(nodes, search, 8), [nodes, search]);
  return (
    <div className="pointer-events-auto absolute left-2 top-2 w-56">
      <input
        value={search}
        onChange={(e) => actions.setSearch(e.target.value)}
        placeholder="Search files…"
        className="w-full rounded-md border border-border bg-black/60 px-2 py-1 text-[11px] text-foreground outline-none backdrop-blur placeholder:text-muted-foreground focus:border-white/30"
      />
      {search.trim() && (
        <div className="mt-1 flex flex-col gap-px overflow-hidden rounded-md border border-border bg-black/70 backdrop-blur">
          {matches.length === 0 && <div className="px-2 py-1 text-[10px] text-muted-foreground">No matches</div>}
          {matches.map((node) => (
            <button
              key={node.id}
              className="truncate px-2 py-1 text-left font-mono text-[10px] text-foreground hover:bg-white/10"
              onClick={() => actions.select(node.id)}
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

export function GraphApp() {
  const { view, camera } = useGraphStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport(containerRef);
  const [renderer, setRenderer] = useState<GraphRenderer | null>(null);

  useEffect(() => {
    actions.ready();
  }, []);

  const selectedNode = view.selectedNodeId
    ? view.nodes.find((node) => node.id === view.selectedNodeId) ?? null
    : null;

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
      <SearchBar search={view.search} nodes={view.nodes} />
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
    </div>
  );
}
