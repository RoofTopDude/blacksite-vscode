/* Codebase Map webview: pixi star-map stage + HTML overlays (labels, search,
   node card, legend). State flows store → PixiStage; interactions flow back
   through store actions. */

import { useEffect, useMemo, useRef, useState } from "react";
import { PixiStage } from "./scene/PixiStage";
import type { GraphRenderer } from "./scene/renderer";
import { actions, useGraphStore } from "./store";
import { worldToScreen, type Camera, type Viewport } from "@/lib/graph/camera";
import { TRACE_COLORS, cssColor, folderColor } from "@/lib/graph/colors";
import { annotationsForNode, searchMatches } from "@/lib/graph/view-model";
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
function LabelsOverlay({ nodes, camera, viewport, hoveredId, selectedId }: {
  nodes: GraphNode[];
  camera: Camera;
  viewport: Viewport;
  hoveredId: string | null;
  selectedId: string | null;
}) {
  const clusters = useMemo(() => {
    const byDir = new Map<string, { count: number; sx: number; sy: number }>();
    for (const node of nodes) {
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
  }, [nodes]);

  if (viewport.width === 0) return null;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
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
          >
            {dir}
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

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col gap-0.5 rounded-md border border-border bg-black/60 px-2 py-1.5 backdrop-blur">
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
        nodes={view.nodes}
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
          className="rounded-md border border-border bg-black/60 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
          onClick={() => actions.rebuildIndex()}
          disabled={view.indexing}
        >
          {view.indexing ? "Indexing…" : "Re-index"}
        </button>
      </div>
      {view.truncated && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-amber-400/40 bg-amber-950/60 px-2.5 py-0.5 text-[10px] text-amber-200 backdrop-blur">
          Large workspace — showing the first {view.nodes.length} files
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
      <Legend />
    </div>
  );
}
