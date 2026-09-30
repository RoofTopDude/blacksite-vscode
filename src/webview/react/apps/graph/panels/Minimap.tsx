/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { memo, useMemo, useRef } from "react";
import { clampRectToBox, visibleWorldRect, type Camera, type Viewport } from "@/lib/graph/camera";
import { cssColor, folderColor } from "@/lib/graph/colors";
import { folderTerritories, nodeBounds, type GraphViewState } from "@/lib/graph/view-model";
import type { GraphNode } from "@/lib/graph/protocol";
import { MAX_MINIMAP_TERRITORIES } from "./shared";

/** Sampled star dots for the minimap. Memoized on referential equality so a
    camera move (which only changes the viewport rectangle) never re-renders
    the potentially-thousands of circles — nodes + projection are stable
    across camera motion. */
export const MinimapDots = memo(function MinimapDots({ nodes, project, cap = 700 }: {
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
export function Minimap({ view, camera, viewport, onJump }: {
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
