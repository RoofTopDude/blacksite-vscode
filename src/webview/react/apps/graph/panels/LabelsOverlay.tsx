/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useMemo } from "react";
import { worldToScreen, zoomToFit, type Camera, type Viewport } from "@/lib/graph/camera";
import { cssColor, folderColor } from "@/lib/graph/colors";
import { selectNonOverlappingLabels, type ScreenLabelCandidate, type ScreenRect } from "@/lib/graph/labels";
import {
  baseName,
  clusterBaseDir,
  clusterHubKey,
  clusterHubLabel,
  clusterSubgroupLabel,
  isClusterNode,
  neighborhoodLabel,
  selectedEdgeLabels,
  positionedSymbols,
  type GraphViewState,
} from "@/lib/graph/view-model";
import { MAX_NEIGHBORHOOD_LABELS } from "./shared";

/* Measuring file labels with their own font. The old fixed 6.5px-per-character
   estimate was narrower than the rendered monospace text, so nearly every label
   ended in an ellipsis ("types.t…"). */
let measureContext: CanvasRenderingContext2D | null | undefined;
let measuredFont = "";
const measuredWidths = new Map<string, number>();

function labelFont(): string {
  const root = getComputedStyle(document.documentElement);
  const size = root.getPropertyValue("--ui-text-2xs").trim() || "11px";
  const family = root.getPropertyValue("--font-mono").trim() || "monospace";
  return `${size} ${family}`;
}

/** Rendered width of a file label (text plus its padding). */
function fileLabelWidth(text: string, font: string): number {
  if (measureContext === undefined) measureContext = document.createElement("canvas").getContext("2d");
  if (font !== measuredFont) {
    measuredFont = font;
    measuredWidths.clear();
  }
  let width = measuredWidths.get(text);
  if (width === undefined) {
    if (measureContext) {
      measureContext.font = font;
      width = measureContext.measureText(text).width;
    } else {
      width = text.length * 7;
    }
    if (measuredWidths.size > 5000) measuredWidths.clear();
    measuredWidths.set(text, width);
  }
  return Math.ceil(width) + 14;
}

/** Folder cluster labels + hovered/selected file label, projected over the canvas. */
export function LabelsOverlay({ view, camera, viewport, hoveredId, selectedId }: {
  view: GraphViewState;
  camera: Camera;
  viewport: Viewport;
  hoveredId: string | null;
  selectedId: string | null;
}) {
  const clusterStats = useMemo(() => {
    /* Keyed by folder, not cluster: the chunks of an oversized folder are packed
       side by side, and one label at their middle names the folder they share. */
    const byDir = new Map<string, { count: number; weight: number; sx: number; sy: number }>();
    for (const node of view.displayNodes) {
      const dir = clusterBaseDir(node.dir);
      const entry = byDir.get(dir) ?? { count: 0, weight: 0, sx: 0, sy: 0 };
      entry.count += isClusterNode(node) ? (node.fileCount ?? 1) : 1;
      entry.weight += 1;
      entry.sx += node.x;
      entry.sy += node.y;
      byDir.set(dir, entry);
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
  /* When codebases are folded into their own labelled nodes, a territory label
     for the same codebase would just repeat it. */
  const foldedGroups = view.displayNodes.some((node) => node.groupLevel && node.groupLevel !== "area");
  const neighborhoodAlpha = territorial && !foldedGroups ? clamp01((1.32 - zoomRatio) / 0.38) * 0.94 : 0;
  const hubStart = territorial ? 1.1 : 0.68;
  const hubAlpha = clamp01((zoomRatio - hubStart) / 0.34) * clamp01((2.25 - zoomRatio) / 0.5) * 0.9;
  const subgroupAlpha = clamp01((zoomRatio - 1.72) / 0.5) * clamp01((3.5 - zoomRatio) / 0.65) * 0.64;
  const fileAlpha = clamp01((zoomRatio - 2.6) / 0.65) * 0.9;

  type ArchitectureLabel = { key: string; kind: "neighborhood" | "hub" | "subgroup" | "file" | "group" };
  const candidates: Array<ScreenLabelCandidate<ArchitectureLabel>> = [];
  /* Folded codebases/projects/folders are few and are the whole point of the
     Systems view: label every one, at every zoom, ahead of everything else. */
  const groupNodes = view.displayNodes.filter((node) => node.groupLevel && node.groupLevel !== "area");
  for (const node of groupNodes) {
    const p = worldToScreen(camera, viewport, node.x, node.y);
    const label = node.groupLabel ?? node.dir;
    const width = Math.min(220, Math.max(96, label.length * 8.5 + 36));
    candidates.push({
      value: { key: `grp:${node.id}`, kind: "group" },
      x: p.x - width / 2,
      y: p.y + 14,
      width,
      height: 38,
      priority: 500 + Math.log1p(node.fileCount ?? 1) * 10,
    });
  }
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

  const neighbors = new Set<string>();
  if (fileAlpha > 0.06) {
    if (focus) {
      for (const edge of view.displayEdges) {
        if (edge.from === focus) neighbors.add(edge.to);
        if (edge.to === focus) neighbors.add(edge.from);
      }
    }
    const font = labelFont();
    for (const node of view.displayNodes) {
      if ((node.kind && node.kind !== "file") || node.id === focus) continue;
      const p = worldToScreen(camera, viewport, node.x, node.y);
      // Cull before allocation: zoomed-in maps can still contain thousands of
      // offscreen files. Neighbors of the focused file get first claim.
      if (p.x < 0 || p.y < 0 || p.x > viewport.width || p.y > viewport.height) continue;
      candidates.push({
        value: { key: `file:${node.id}`, kind: "file" },
        x: p.x + 10,
        y: p.y - 9,
        width: Math.min(220, fileLabelWidth(baseName(node.id), font)),
        height: 18,
        priority: (neighbors.has(node.id) ? 90 : 10) + Math.min(70, Math.log1p(node.inDegree + node.outDegree) * 8),
      });
    }
  }

  /* Keep labels out from under the persistent control surfaces and the focus
     tooltip. These are allocation constraints, not masks: hidden labels are
     reconsidered immediately as the camera moves into free screen space. */
  const reserved: ScreenRect[] = viewport.width > 720
    ? [
      { x: 0, y: 0, width: 332, height: 150 },
      { x: Math.max(0, viewport.width - 252), y: 0, width: 252, height: viewport.height },
    ]
    : [{ x: 0, y: 0, width: viewport.width, height: 170 }];
  if (focusNode) {
    const p = worldToScreen(camera, viewport, focusNode.x, focusNode.y);
    reserved.push({ x: p.x - 138, y: p.y + 8, width: 276, height: 42 });
  }
  const allocatedLabels = selectNonOverlappingLabels(candidates, viewport, reserved, 7, 6, 80);
  const acceptedLabels = new Set(allocatedLabels.map((candidate) => candidate.value.key));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {allocatedLabels.filter((label) => label.value.kind === "file").map((label) => {
        const id = label.value.key.slice(5);
        return (
          <div
            key={label.value.key}
            className={`map-file-label absolute truncate ${neighbors.has(id) ? "map-file-label-near" : ""}`}
            style={{ left: label.x, top: label.y, maxWidth: label.width, opacity: fileAlpha }}
            title={id}
          >
            {baseName(id)}
          </div>
        );
      })}
      {groupNodes.map((node) => {
        if (!acceptedLabels.has(`grp:${node.id}`)) return null;
        const p = worldToScreen(camera, viewport, node.x, node.y);
        if (p.x < -160 || p.y < -60 || p.x > viewport.width + 160 || p.y > viewport.height + 60) return null;
        const level = node.groupLevel === "root" ? "folder" : node.groupLevel;
        return (
          <div
            key={`grp:${node.id}`}
            className="map-group-label absolute -translate-x-1/2"
            style={{ left: p.x, top: p.y + 14, color: cssColor(folderColor(node.dir)) }}
            title={node.dir}
          >
            <div className="map-label-name">{node.groupLabel ?? node.dir}</div>
            <div className="map-label-sub">{level} · {(node.fileCount ?? 0).toLocaleString()} files</div>
          </div>
        );
      })}
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
            <div className="map-label-name">{neighborhoodLabel(nb)}</div>
            <div className="map-label-sub">codebase · {count.toLocaleString()} files</div>
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
            style={{ left: p.x, top: p.y, color: cssColor(folderColor(dir)), opacity: hubAlpha }}
            title={dir}
          >
            <div className="map-label-name">{clusterHubLabel(dir)}</div>
            <div className="map-label-sub">{count.toLocaleString()} files{groups > 1 ? ` · ${groups} folders` : ""}</div>
          </div>
        );
      })}
      {subgroupAlpha > 0.08 && subgroups.map(({ dir, x, y }) => {
        if (!acceptedLabels.has(`sub:${dir}`)) return null;
        const subgroup = clusterSubgroupLabel(dir);
        if (!subgroup) return null;
        const p = worldToScreen(camera, viewport, x, y);
        if (p.x < -100 || p.y < -24 || p.x > viewport.width + 100 || p.y > viewport.height + 24) return null;
        return (
          <div
            key={`sub:${dir}`}
            className="map-subgroup-label absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: p.x, top: p.y + 14, opacity: subgroupAlpha }}
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
        const ticket = focusNode.kind === "ticket";
        const name = ticket ? `${focusNode.ticketId} · ${focusNode.ticketTitle}` : focusNode.groupLabel ? focusNode.groupLabel : cluster || service
          ? focusNode.dir.replace(/^svc:/, "")
          : baseName(focusNode.id);
        const detail = cluster
          ? `${(focusNode.fileCount ?? 0).toLocaleString()} files · double-click to ${view.collapsedClusters.includes(focusNode.dir) ? "expand" : "open"}`
          : ticket
            ? `${focusNode.ticketPriority} · ${focusNode.ticketStatus?.replace(/_/g, " ")} · ${focusNode.outDegree} files`
            : service
            ? `service · ${focusNode.inDegree} in · ${focusNode.outDegree} out`
            : `${focusNode.dir}  ·  →${focusNode.outDegree} ←${focusNode.inDegree}`;
        return (
          <div
            className="map-focus-tip absolute -translate-x-1/2"
            style={{ left: p.x, top: p.y + 12, boxShadow: `inset 0 2px 0 ${cssColor(folderColor(focusNode.dir))}` }}
            title={focusNode.id}
          >
            <div className="whitespace-nowrap font-mono text-xs font-semibold text-[color:var(--map-text)]">{name}</div>
            <div className="max-w-[260px] truncate whitespace-nowrap font-mono text-2xs text-[color:var(--map-text-3)]" title={detail}>
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

export function EdgeLabelsOverlay({ view, camera, viewport }: {
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
  const allocated = selectNonOverlappingLabels(labels.map((label) => {
    const p = worldToScreen(camera, viewport, label.x, label.y);
    return { value: label, x: p.x - 90, y: p.y - 22, width: 180, height: 44, priority: 1 };
  }), viewport, [], 6, 6, 16);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {allocated.map(({ value: label }) => {
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
