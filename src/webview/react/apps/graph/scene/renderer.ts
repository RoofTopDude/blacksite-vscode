/* Non-React pixi renderer for the Codebase Map. Owns the WebGL scene, camera
   interactions, and the per-frame trace animation. React (PixiStage) only
   mounts/unmounts it and pushes view-model state in.

   Scale discipline: the zoom floor is derived from the current layout's
   zoom-to-fit (a fixed floor once made big maps impossible to see whole), and
   node sprites never drop below a minimum on-screen size — zoomed way out the
   map reads as a starfield of pinpoints, not sub-pixel dust.

   CPU discipline: the ticker is FPS-capped and stops entirely when the
   document is hidden — a hidden retained webview must not burn a core. While
   visible, a gentle ambient twinkle keeps the map alive; under
   prefers-reduced-motion the twinkle is disabled and the ticker also goes
   fully idle when nothing is animating. */

import { Application, Circle, Container, FederatedPointerEvent, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import {
  MIN_ZOOM,
  camerasClose,
  clampZoom,
  easeInOutCubic,
  edgeLayerAlpha,
  focusZoomFor,
  frameNode,
  lerpCamera,
  nodeSpriteScale,
  pan as panCamera,
  rectOverlapsBounds,
  visibleWorldRect,
  zoomAround,
  zoomToFit,
  type Camera,
  type Viewport,
} from "@/lib/graph/camera";
import {
  ANNOTATION_COLOR,
  BACKGROUND_COLOR,
  IMPORT_EDGE_COLOR,
  SYMBOL_NODE_COLOR,
  TRACE_COLORS,
  folderColor,
  hashString,
  mixColors,
} from "@/lib/graph/colors";
import {
  HEAT_CAP,
  deriveTraceEdges,
  hasActiveAnimation,
  heatAt,
  pulseAt,
  dominantKind,
  traceEdgeAlpha,
  twinkleFactor,
  type TraceEdge,
} from "@/lib/graph/traces";
import { seededRandomForStarfield } from "./starfield";
import type { GraphViewState } from "@/lib/graph/view-model";
import {
  clusterEdges,
  graphNodeRadius,
  matchesSearch,
  neighborIds,
  nodeBounds,
  positionedSymbols,
  symbolRelationTargets,
} from "@/lib/graph/view-model";

export interface RendererCallbacks {
  onHover(nodeId: string | null): void;
  onSelect(nodeId: string | null): void;
  onOpen(nodeId: string): void;
  onCameraChange(camera: Camera): void;
  /** WebGL unavailable (remote/virtualized hosts) — otherwise the panel is
      silently blank forever with only a console line to explain why. */
  onInitError?(message: string): void;
}

export interface GraphRenderer {
  setState(view: GraphViewState): void;
  zoomToFitAll(): void;
  /** Smoothly fly the camera to frame a node by id (search result, deep link). */
  focusNode(id: string): void;
  /** Smoothly recenter on a world point at the current zoom (minimap jump). */
  focusWorld(x: number, y: number): void;
  /** Keyboard pan by a pixel delta. */
  panBy(dxPx: number, dyPx: number): void;
  /** Keyboard zoom about the viewport center. */
  zoomBy(factor: number): void;
  destroy(): void;
}

const GLOW_TEXTURE_RADIUS = 48;
const COMET_MS = 700;
/** Nodes never render smaller than this on-screen core radius (px). */
const MIN_NODE_SCREEN_PX = 4;
const HOVER_POP = 1.4;
const MAX_FPS = 40;

function makeGlowTexture(app: Application): Texture {
  const gfx = new Graphics();
  /* Bright core + soft halo rings — reads as a star under additive blending. */
  for (let ring = GLOW_TEXTURE_RADIUS; ring > 6; ring -= 2) {
    const t = ring / GLOW_TEXTURE_RADIUS;
    gfx.circle(0, 0, ring).fill({ color: 0xffffff, alpha: 0.02 + 0.06 * (1 - t) * (1 - t) });
  }
  gfx.circle(0, 0, 6).fill({ color: 0xffffff, alpha: 0.9 });
  gfx.circle(0, 0, 3).fill({ color: 0xffffff, alpha: 1 });
  return app.renderer.generateTexture(gfx);
}

export function createGraphRenderer(host: HTMLElement, callbacks: RendererCallbacks, initialCamera?: Camera): GraphRenderer {
  const app = new Application();
  let destroyed = false;
  let ready = false;

  let view: GraphViewState | null = null;
  let camera: Camera = initialCamera ?? { cx: 0, cy: 0, zoom: 1 };
  let cameraTouched = initialCamera !== undefined;
  let stateDirty = false;
  let cameraDirty = false;
  let traceEdges: TraceEdge[] = [];
  /** Zoom that frames the whole node cloud; refreshed when nodes/viewport change. */
  let fitZoom = 1;
  /** Dynamic wheel-zoom floor: always allows a comfortable overview. */
  let minZoom = MIN_ZOOM;
  /** Active fly-to animation, or null when the camera is at rest / dragged. */
  let anim: { from: Camera; to: Camera; start: number; dur: number } | null = null;
  const FLY_MS = 480;

  const reducedMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const spriteById = new Map<string, Sprite>();
  const symbolSpriteById = new Map<string, Sprite>();
  const nodeById = new Map<string, GraphViewState["nodes"][number]>();
  const symbolPositionById = new Map<string, { x: number; y: number; parentId: string }>();
  /** Per-node world-space sprite scale after min-px compensation + hover pop. */
  const baseScaleById = new Map<string, number>();
  /** Per-node emphasis alpha (search/selection dimming) before twinkle/traces. */
  const baseAlphaById = new Map<string, number>();
  /** Stable per-node hash driving each star's twinkle phase. */
  const twinkleSeedById = new Map<string, number>();

  /* Two parallax background layers give the "deep space" depth cue. */
  const bgFarLayer = new Container();
  const bgMidLayer = new Container();
  const nebulaGfx = new Graphics();
  const starsFarGfx = new Graphics();
  const starsMidGfx = new Graphics();
  const world = new Container();
  const edgeGfx = new Graphics();
  const clusterEdgeGfx = new Graphics();
  const selEdgeGfx = new Graphics(); /* selection-highlighted edges, full alpha */
  const relationGfx = new Graphics();
  const annotationGfx = new Graphics();
  const traceGfx = new Graphics();
  const symbolOrbitGfx = new Graphics();
  const nodeLayer = new Container();
  const symbolLayer = new Container();

  let glowTexture: Texture | null = null;

  function viewport(): Viewport {
    return { width: app.screen.width, height: app.screen.height };
  }

  function requestRender(): void {
    if (destroyed || !ready) return;
    if (!app.ticker.started && !document.hidden) app.ticker.start();
  }

  function setCamera(next: Camera): void {
    anim = null; /* any direct camera move cancels an in-flight fly-to */
    camera = { ...next, zoom: clampZoom(next.zoom, minZoom) };
    cameraTouched = true;
    cameraDirty = true;
    requestRender();
  }

  /** Begin a smooth fly-to. Target zoom is floored/capped to the live bounds. */
  function animateTo(target: Camera): void {
    const clamped: Camera = { ...target, zoom: clampZoom(target.zoom, minZoom) };
    if (camerasClose(camera, clamped)) {
      camera = clamped;
      cameraTouched = true;
      cameraDirty = true;
      requestRender();
      return;
    }
    anim = { from: camera, to: clamped, start: Date.now(), dur: FLY_MS };
    cameraTouched = true;
    requestRender();
  }

  function recomputeZoomBounds(): void {
    if (!view || view.nodes.length === 0) return;
    const fit = zoomToFit(view.nodes, viewport());
    fitZoom = fit.zoom;
    minZoom = Math.min(MIN_ZOOM, fitZoom * 0.5);
  }

  /** Does the current camera frame overlap the node cloud at all? The camera
      persisted across sessions (store.ts) isn't scoped per-workspace — a
      webview's localStorage is keyed by extension + view type, not by which
      folder is open — so opening a different project can hand back a camera
      tuned for a completely different coordinate system. Without this check
      `cameraTouched` (true from the very first restore) would permanently
      suppress auto-fit and leave the user staring at an empty starfield with
      no clue why. Also guards a big re-index reshaping the layout out from
      under an already-touched camera. */
  function cameraSeesNodes(nodesList: GraphViewState["nodes"]): boolean {
    if (nodesList.length === 0) return true;
    const vp = viewport();
    if (vp.width <= 0 || vp.height <= 0) return true; /* not laid out yet; don't judge */
    return rectOverlapsBounds(visibleWorldRect(camera, vp), nodeBounds(nodesList));
  }

  /** True once a real (non-degenerate) auto-fit has landed; reset on resize
      so a legitimate viewport-size change re-fits an untouched camera. */
  let hasValidFit = false;

  /** Re-fit the camera to the current node cloud, but only if the user
      hasn't touched it yet. Critical fix: a webview host element can report
      a 0x0 viewport for a tick after mount (VS Code sidebar layout timing),
      which made zoomToFit return a degenerate {cx:0,cy:0,zoom:1} camera that
      then got "baked in" permanently — the old resize handler only
      recomputed zoom *bounds*, never re-applied the fit. This retries every
      frame until the viewport is real, then goes idle (cheap: one guard
      check) until `force` (a resize) asks for it again. */
  function autoFitIfUntouched(force = false): void {
    if (!ready || !view || view.nodes.length === 0 || cameraTouched) return;
    if (hasValidFit && !force) return;
    const vp = viewport();
    if (vp.width <= 0 || vp.height <= 0) return; /* still not laid out; retry next frame */
    recomputeZoomBounds();
    camera = zoomToFit(view.nodes, vp);
    cameraDirty = true;
    hasValidFit = true;
  }

  /* ── Scene (re)construction on state change ─────────────────── */

  function rebuildNodes(): void {
    if (!view || !glowTexture) return;
    nodeById.clear();
    for (const node of view.nodes) nodeById.set(node.id, node);

    for (const [id, sprite] of spriteById) {
      if (!nodeById.has(id)) {
        sprite.destroy();
        spriteById.delete(id);
        baseScaleById.delete(id);
        baseAlphaById.delete(id);
        twinkleSeedById.delete(id);
      }
    }
    for (const node of view.nodes) {
      let sprite = spriteById.get(node.id);
      if (!sprite) {
        sprite = new Sprite(glowTexture);
        sprite.anchor.set(0.5);
        sprite.blendMode = "add";
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        /* Generous hit circle (local px): with min-size compensation this
           keeps every star comfortably clickable at any zoom. */
        sprite.hitArea = new Circle(0, 0, 20);
        const id = node.id;
        sprite.on("pointerover", () => callbacks.onHover(id));
        sprite.on("pointerout", () => callbacks.onHover(null));
        sprite.on("pointertap", (event: FederatedPointerEvent) => {
          if (event.detail >= 2) callbacks.onOpen(id);
          else callbacks.onSelect(id);
        });
        nodeLayer.addChild(sprite);
        spriteById.set(node.id, sprite);
      }
      sprite.position.set(node.x, node.y);
      sprite.tint = folderColor(node.dir);
      if (!twinkleSeedById.has(node.id)) twinkleSeedById.set(node.id, hashString(node.id));
    }
    rebuildSymbols();
    applyEmphasis();
    applyNodeScales();
  }

  function rebuildSymbols(): void {
    if (!view || !glowTexture) return;
    const placements = view.symbolsEnabled ? positionedSymbols(view.nodes, view.symbolsByPath) : [];
    const active = new Set(placements.map((placement) => placement.symbol.id));
    symbolPositionById.clear();

    for (const [id, sprite] of symbolSpriteById) {
      if (!active.has(id)) {
        sprite.destroy();
        symbolSpriteById.delete(id);
      }
    }

    for (const placement of placements) {
      symbolPositionById.set(placement.symbol.id, {
        x: placement.x,
        y: placement.y,
        parentId: placement.parent.id,
      });

      let sprite = symbolSpriteById.get(placement.symbol.id);
      if (!sprite) {
        sprite = new Sprite(glowTexture);
        sprite.anchor.set(0.5);
        sprite.blendMode = "add";
        symbolLayer.addChild(sprite);
        symbolSpriteById.set(placement.symbol.id, sprite);
      }
      sprite.position.set(placement.x, placement.y);
      sprite.tint = SYMBOL_NODE_COLOR;
    }
  }

  /** Search dimming + selection neighborhood highlighting; results land in
      baseAlphaById so the twinkle/trace passes can modulate without losing
      the emphasis baseline. */
  function applyEmphasis(): void {
    if (!view) return;
    const searching = view.search.trim().length > 0;
    const selected = view.selectedNodeId;
    const neighbors = selected ? neighborIds(selected, view.edges, view.annotations) : null;
    const relationTargets = selected ? symbolRelationTargets(view.symbolsByPath[selected]) : null;
    for (const node of view.nodes) {
      const sprite = spriteById.get(node.id);
      if (!sprite) continue;
      const base = 0.45 + 0.55 * node.z;
      let dim = 1;
      if (searching && !matchesSearch(node, view.search)) dim = 0.1;
      if (
        selected
        && node.id !== selected
        && neighbors
        && !neighbors.has(node.id)
        && !(relationTargets?.has(node.id))
      ) {
        dim = Math.min(dim, 0.16);
      }
      let alpha = base * dim;
      if (node.id === selected || node.id === view.hoveredNodeId) alpha = Math.max(alpha, 0.95);
      baseAlphaById.set(node.id, alpha);
      sprite.alpha = alpha;
    }

    for (const [id, sprite] of symbolSpriteById) {
      const placement = symbolPositionById.get(id);
      if (!placement) continue;
      const parentNode = nodeById.get(placement.parentId);
      let alpha = 0.72;
      if (searching && parentNode && !matchesSearch(parentNode, view.search)) alpha *= 0.2;
      if (selected) alpha *= placement.parentId === selected ? 1 : 0.18;
      sprite.alpha = alpha;
    }
  }

  /** Recompute every sprite's world-space scale so nodes keep a minimum
      on-screen size at any zoom; hovered node pops slightly. Runs on camera
      or state changes (cheap: one multiply-and-set per sprite). */
  function applyNodeScales(): void {
    if (!view) return;
    const hovered = view.hoveredNodeId;
    for (const node of view.nodes) {
      const sprite = spriteById.get(node.id);
      if (!sprite) continue;
      let scale = nodeSpriteScale(graphNodeRadius(node), camera.zoom, MIN_NODE_SCREEN_PX);
      if (node.id === hovered) scale *= HOVER_POP;
      baseScaleById.set(node.id, scale);
      sprite.scale.set(scale);
    }
    const symbolScale = nodeSpriteScale(1.9, camera.zoom, 2.5);
    for (const sprite of symbolSpriteById.values()) {
      sprite.scale.set(symbolScale);
    }
  }

  function drawEdges(): void {
    if (!view) return;
    edgeGfx.clear();
    clusterEdgeGfx.clear();
    const showSelectedOnly = view.display.edgeMode === "selected";
    const showClusterEdges = view.display.edgeMode === "clusters" || (view.display.edgeMode === "all" && view.nodes.length > 1200 && camera.zoom / Math.max(fitZoom, 1e-6) < 0.9);
    if (view.display.showImports && view.display.edgeMode !== "off" && !showClusterEdges) {
    for (const edge of view.edges) {
      if (edge.kind !== "import") continue;
      if (showSelectedOnly && edge.from !== view.selectedNodeId && edge.to !== view.selectedNodeId) continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      edgeGfx.moveTo(from.x, from.y);
      edgeGfx.lineTo(to.x, to.y);
    }
    /* Stroke at a rich base alpha; the layer's container alpha is driven by
       zoom each frame (dimmer at overview, richer zoomed-in) — but always
       clearly observable, not merely a whisper. */
    edgeGfx.stroke({ width: 1.2, color: IMPORT_EDGE_COLOR, alpha: 0.86, pixelLine: true });
    } else if (view.display.showImports && view.display.edgeMode !== "off" && showClusterEdges) {
      for (const edge of clusterEdges(view.nodes, view.edges)) {
        clusterEdgeGfx.moveTo(edge.fromX, edge.fromY);
        clusterEdgeGfx.lineTo(edge.toX, edge.toY);
      }
      clusterEdgeGfx.stroke({ width: 1.7, color: IMPORT_EDGE_COLOR, alpha: 0.72, pixelLine: true });
    }

    /* Selection: re-draw the selected node's own edges bright, in its folder
       color, on a layer that ignores the zoom fade. */
    selEdgeGfx.clear();
    const selected = view.selectedNodeId ? nodeById.get(view.selectedNodeId) : undefined;
    if (selected && view.display.showImports && view.display.edgeMode !== "off") {
      const highlight = mixColors(folderColor(selected.dir), 0xffffff, 0.35);
      for (const edge of view.edges) {
        if (edge.kind !== "import") continue;
        if (edge.from !== selected.id && edge.to !== selected.id) continue;
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        selEdgeGfx.moveTo(from.x, from.y);
        selEdgeGfx.lineTo(to.x, to.y);
      }
      selEdgeGfx.stroke({ width: 2, color: highlight, alpha: 0.96, pixelLine: true });
    }

    relationGfx.clear();
    symbolOrbitGfx.clear();
    if (view.symbolsEnabled && view.display.showRelations) {
      for (const position of symbolPositionById.values()) {
        const parent = nodeById.get(position.parentId);
        if (!parent) continue;
        symbolOrbitGfx.moveTo(parent.x, parent.y);
        symbolOrbitGfx.lineTo(position.x, position.y);
      }
      symbolOrbitGfx.stroke({ width: 1.15, color: SYMBOL_NODE_COLOR, alpha: 0.34, pixelLine: true });

      for (const expansion of Object.values(view.symbolsByPath)) {
        for (const edge of expansion.edges) {
          const from = symbolPositionById.get(edge.from);
          if (!from) continue;
          const toSymbol = edge.toSymbol ? symbolPositionById.get(edge.toSymbol) : undefined;
          if (toSymbol) {
            relationGfx.moveTo(from.x, from.y);
            relationGfx.lineTo(toSymbol.x, toSymbol.y);
            continue;
          }
          const toFile = nodeById.get(edge.toPath);
          if (!toFile) continue;
          relationGfx.moveTo(from.x, from.y);
          relationGfx.lineTo(toFile.x, toFile.y);
        }
      }
      relationGfx.stroke({ width: 1.55, color: SYMBOL_NODE_COLOR, alpha: 0.78, pixelLine: true });
    }

    annotationGfx.clear();
    if (view.display.showAnnotations) for (const annotation of view.annotations) {
      if (showSelectedOnly && annotation.from !== view.selectedNodeId && annotation.to !== view.selectedNodeId) continue;
      const from = nodeById.get(annotation.from);
      const to = nodeById.get(annotation.to);
      if (!from || !to) continue;
      drawDashedLine(annotationGfx, from.x, from.y, to.x, to.y, 7, 5);
    }
    annotationGfx.stroke({ width: 1.8, color: ANNOTATION_COLOR, alpha: 0.92, pixelLine: true });
  }

  function drawDashedLine(gfx: Graphics, x1: number, y1: number, x2: number, y2: number, dash: number, gap: number): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length;
    const uy = dy / length;
    let travelled = 0;
    while (travelled < length) {
      const segment = Math.min(dash, length - travelled);
      gfx.moveTo(x1 + ux * travelled, y1 + uy * travelled);
      gfx.lineTo(x1 + ux * (travelled + segment), y1 + uy * (travelled + segment));
      travelled += dash + gap;
    }
  }

  /** Decorative deep-space background: soft nebula glows behind the biggest
      folder clusters plus two parallax starfield layers sized to the world. */
  function drawBackground(): void {
    if (!view) return;
    nebulaGfx.clear();
    starsFarGfx.clear();
    starsMidGfx.clear();
    if (view.nodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const clusterAgg = new Map<string, { sx: number; sy: number; count: number }>();
    for (const node of view.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
      const agg = clusterAgg.get(node.dir) ?? { sx: 0, sy: 0, count: 0 };
      agg.sx += node.x;
      agg.sy += node.y;
      agg.count += 1;
      clusterAgg.set(node.dir, agg);
    }

    /* Nebulae: one soft additive glow per major cluster, in its folder hue. */
    const majors = [...clusterAgg.entries()]
      .filter(([, agg]) => agg.count >= 5)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 7);
    for (const [dir, agg] of majors) {
      const cx = agg.sx / agg.count;
      const cy = agg.sy / agg.count;
      const spread = 24 * Math.sqrt(agg.count);
      const color = folderColor(dir);
      for (let ring = 5; ring >= 1; ring -= 1) {
        const t = ring / 5;
        nebulaGfx.circle(cx, cy, spread * (0.7 + 1.5 * t)).fill({ color, alpha: 0.014 + 0.02 * (1 - t) });
      }
    }

    /* Starfields: density follows world size so big maps don't look empty. */
    const span = (maxX - minX) + (maxY - minY);
    const starCount = Math.min(800, Math.max(260, Math.round(span / 8)));
    const padX = (maxX - minX) * 0.35 + 200;
    const padY = (maxY - minY) * 0.35 + 200;
    const farRandom = seededRandomForStarfield(view.nodes.length);
    const farCount = Math.round(starCount * 0.55);
    for (let i = 0; i < farCount; i += 1) {
      const x = minX - padX + farRandom() * (maxX - minX + padX * 2);
      const y = minY - padY + farRandom() * (maxY - minY + padY * 2);
      starsFarGfx.circle(x, y, farRandom() * 1.4 + 0.4).fill({ color: 0xaab4d4, alpha: 0.06 + farRandom() * 0.1 });
    }
    const midRandom = seededRandomForStarfield(view.nodes.length + 7919);
    for (let i = 0; i < starCount - farCount; i += 1) {
      const x = minX - padX + midRandom() * (maxX - minX + padX * 2);
      const y = minY - padY + midRandom() * (maxY - minY + padY * 2);
      starsMidGfx.circle(x, y, midRandom() * 1.0 + 0.3).fill({ color: 0xc4d2f0, alpha: 0.05 + midRandom() * 0.09 });
    }
  }

  /* ── Per-frame work ─────────────────────────────────────────── */

  function applyCameraTransform(): void {
    const vp = viewport();
    world.scale.set(camera.zoom);
    world.position.set(vp.width / 2 - camera.cx * camera.zoom, vp.height / 2 - camera.cy * camera.zoom);
    /* Distant layers drift slower for depth. */
    const farParallax = 0.8;
    bgFarLayer.scale.set(camera.zoom);
    bgFarLayer.position.set(vp.width / 2 - camera.cx * farParallax * camera.zoom, vp.height / 2 - camera.cy * farParallax * camera.zoom);
    const midParallax = 0.92;
    bgMidLayer.scale.set(camera.zoom);
    bgMidLayer.position.set(vp.width / 2 - camera.cx * midParallax * camera.zoom, vp.height / 2 - camera.cy * midParallax * camera.zoom);
    /* Import-edge layer fades at overview, richens on zoom-in. */
    edgeGfx.alpha = edgeLayerAlpha(camera.zoom / Math.max(fitZoom, 1e-6));
    clusterEdgeGfx.alpha = edgeLayerAlpha(camera.zoom / Math.max(fitZoom, 1e-6));
  }

  /** Ambient life: each star breathes on its own slow phase. */
  function twinklePass(now: number): void {
    if (!view || reducedMotion) return;
    for (const [id, sprite] of spriteById) {
      const base = baseAlphaById.get(id);
      if (base === undefined) continue;
      sprite.alpha = Math.min(1, base * twinkleFactor(twinkleSeedById.get(id) ?? 1, now));
    }
  }

  function animateTraces(now: number): boolean {
    if (!view) return false;
    const fadeMs = view.config.traceFadeSeconds * 1000;
    const events = view.traces;
    traceGfx.clear();
    if (events.length === 0) return false;

    /* Node heat + pulse — only paths with events are touched. */
    const activePaths = new Set<string>();
    for (const event of events) activePaths.add(event.path);
    for (const path of activePaths) {
      const node = nodeById.get(path);
      const sprite = spriteById.get(path);
      if (!node || !sprite) continue;
      const heat = heatAt(events, path, now, fadeMs);
      const pulse = pulseAt(events, path, now);
      const kind = dominantKind(events, path, now, fadeMs);
      const baseColor = folderColor(node.dir);
      sprite.tint = kind ? mixColors(baseColor, TRACE_COLORS[kind], Math.min(1, heat / HEAT_CAP + pulse * 0.5)) : baseColor;
      const baseScale = baseScaleById.get(path) ?? nodeSpriteScale(graphNodeRadius(node), camera.zoom, MIN_NODE_SCREEN_PX);
      sprite.scale.set(baseScale * (1 + pulse * 0.6 + (heat / HEAT_CAP) * 0.15));
      if (pulse > 0 || heat > 0.02) {
        const base = baseAlphaById.get(path) ?? 0.6;
        sprite.alpha = Math.min(1, base + pulse * 0.6 + (heat / HEAT_CAP) * 0.3);
      }
    }

    /* Directional streaks with comet heads between consecutively-touched files. */
    for (const edge of traceEdges) {
      const alpha = traceEdgeAlpha(edge, now, fadeMs);
      if (alpha <= 0.01) continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const color = TRACE_COLORS[edge.kind];
      traceGfx.moveTo(from.x, from.y);
      traceGfx.lineTo(to.x, to.y);
      traceGfx.stroke({ width: 1.5, color, alpha: alpha * 0.55, pixelLine: true });
      const progress = Math.min(1, (now - edge.at) / COMET_MS);
      if (progress < 1) {
        const cx = from.x + (to.x - from.x) * progress;
        const cy = from.y + (to.y - from.y) * progress;
        traceGfx.circle(cx, cy, 3).fill({ color, alpha: 0.9 * (1 - progress * 0.4) });
      }
    }
    return hasActiveAnimation(events, now, fadeMs);
  }

  function frame(): void {
    if (destroyed || !view) return;
    const now = Date.now();
    if (stateDirty) {
      rebuildNodes();
      drawEdges();
      drawBackground();
      recomputeZoomBounds();
      cameraDirty = true;
      stateDirty = false;
      if (view.nodes.length > 0 && cameraTouched && hasValidFit && !cameraSeesNodes(view.nodes)) {
        /* Content moved out from under an already-positioned camera (e.g. a
           big re-index reshaped the layout) — fly back rather than leave the
           user looking at empty space. */
        animateTo(zoomToFit(view.nodes, viewport()));
      }
    }
    /* Cheap and idempotent once fitted (camerasClose-style no-op via the
       cameraTouched guard) — keeps retrying the fit for as long as the
       viewport is still 0x0 or untouched, without special-casing "first
       frame" timing. */
    autoFitIfUntouched();
    /* Advance a fly-to before applying the transform so it lands the same frame. */
    if (anim) {
      const t = easeInOutCubic((now - anim.start) / anim.dur);
      camera = lerpCamera(anim.from, anim.to, t);
      cameraDirty = true;
      if (now - anim.start >= anim.dur) {
        camera = anim.to;
        anim = null;
      }
    }
    if (cameraDirty) {
      applyCameraTransform();
      applyNodeScales();
      callbacks.onCameraChange(camera);
      cameraDirty = false;
    }
    twinklePass(now);
    const animating = animateTraces(now);
    if (document.hidden) {
      app.ticker.stop();
      return;
    }
    /* Reduced motion: no ambient twinkle, so go fully idle when nothing moves. */
    if (reducedMotion && !animating && !anim && !cameraDirty && !stateDirty && !dragging) {
      app.ticker.stop();
    }
  }

  /* ── Interactions ───────────────────────────────────────────── */

  let dragging = false;
  let lastPointer = { x: 0, y: 0 };
  const cleanupInteractions: Array<() => void> = [];

  function updateStageHitArea(): void {
    app.stage.hitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
  }

  function attachInteractions(): void {
    app.stage.eventMode = "static";
    updateStageHitArea();
    app.canvas.style.touchAction = "none";
    app.canvas.style.cursor = "grab";

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      dragging = true;
      lastPointer = { x: event.clientX, y: event.clientY };
      /* Native pointer capture: without this, dragging the mouse past the
         canvas edge (very easy in a narrow sidebar) hands subsequent
         pointermove/pointerup events to whatever element is under the cursor
         instead of this canvas, so the drag would silently stop tracking —
         "can't move around" once the pointer strays off the visible area. */
      try {
        app.canvas.setPointerCapture(event.pointerId);
      } catch { /* pointer id already released or unsupported; drag still works within bounds */ }
      app.canvas.style.cursor = "grabbing";
      requestRender();
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - lastPointer.x;
      const dy = event.clientY - lastPointer.y;
      lastPointer = { x: event.clientX, y: event.clientY };
      setCamera(panCamera(camera, dx, dy));
    };
    const endDrag = (event: PointerEvent) => {
      dragging = false;
      app.canvas.style.cursor = "grab";
      try {
        app.canvas.releasePointerCapture(event.pointerId);
      } catch { /* already released */ }
    };
    const onLostPointerCapture = (): void => {
      dragging = false;
      app.canvas.style.cursor = "grab";
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      const rect = app.canvas.getBoundingClientRect();
      setCamera(zoomAround(camera, viewport(), event.clientX - rect.left, event.clientY - rect.top, factor, minZoom));
    };
    app.canvas.addEventListener("pointerdown", onPointerDown);
    app.canvas.addEventListener("pointermove", onPointerMove);
    app.canvas.addEventListener("pointerup", endDrag);
    app.canvas.addEventListener("pointercancel", endDrag);
    app.canvas.addEventListener("lostpointercapture", onLostPointerCapture);
    app.canvas.addEventListener("wheel", onWheel, { passive: false });
    cleanupInteractions.push(
      () => app.canvas.removeEventListener("pointerdown", onPointerDown),
      () => app.canvas.removeEventListener("pointermove", onPointerMove),
      () => app.canvas.removeEventListener("pointerup", endDrag),
      () => app.canvas.removeEventListener("pointercancel", endDrag),
      () => app.canvas.removeEventListener("lostpointercapture", onLostPointerCapture),
      () => app.canvas.removeEventListener("wheel", onWheel),
    );
  }

  const onVisibility = (): void => {
    if (document.hidden) app.ticker.stop();
    else requestRender();
  };

  /* ── Lifecycle ──────────────────────────────────────────────── */

  void app.init({
    background: BACKGROUND_COLOR,
    resizeTo: host,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  }).then(() => {
    if (destroyed) {
      app.destroy(true);
      return;
    }
    host.appendChild(app.canvas);
    app.ticker.maxFPS = MAX_FPS;
    glowTexture = makeGlowTexture(app);
    nebulaGfx.blendMode = "add";
    bgFarLayer.addChild(nebulaGfx, starsFarGfx);
    bgMidLayer.addChild(starsMidGfx);
    world.addChild(clusterEdgeGfx, edgeGfx, selEdgeGfx, relationGfx, annotationGfx, traceGfx, symbolOrbitGfx, nodeLayer, symbolLayer);
    app.stage.addChild(bgFarLayer, bgMidLayer, world);
    attachInteractions();
    app.ticker.add(frame);
    app.renderer.on("resize", () => {
      updateStageHitArea();
      autoFitIfUntouched(true); /* a legitimate size change re-fits an untouched camera */
      cameraDirty = true;
      requestRender();
    });
    document.addEventListener("visibilitychange", onVisibility);
    ready = true;
    stateDirty = view !== null;
    cameraDirty = true;
    autoFitIfUntouched();
    requestRender();
  }).catch((err: unknown) => {
    /* WebGL unavailable (remote/virtualized hosts). Leave a readable trace
       instead of a silent dead canvas. */
    console.error("Codebase Map renderer failed to initialize:", err);
    callbacks.onInitError?.(err instanceof Error ? err.message : String(err));
  });

  return {
    setState(next: GraphViewState): void {
      const structureChanged =
        !view
        || view.nodes !== next.nodes
        || view.edges !== next.edges
        || view.annotations !== next.annotations
        || view.symbolsByPath !== next.symbolsByPath
        || view.symbolsEnabled !== next.symbolsEnabled
        || view.display !== next.display
        || view.search !== next.search
        || view.selectedNodeId !== next.selectedNodeId;
      const hoverChanged = !view || view.hoveredNodeId !== next.hoveredNodeId;
      const hadNoNodes = !view || view.nodes.length === 0;
      if (view && view.traces !== next.traces) {
        traceEdges = deriveTraceEdges(next.traces);
      }
      view = next;
      if (structureChanged) stateDirty = true;
      if (hoverChanged && !structureChanged) {
        /* Hover only needs emphasis + scale refresh, not a full rebuild. */
        applyEmphasis();
        applyNodeScales();
      }
      if (hadNoNodes && next.nodes.length > 0) {
        hasValidFit = false; /* fresh data: (re)fit once, same as first load */
        if (cameraTouched && !cameraSeesNodes(next.nodes)) cameraTouched = false;
        autoFitIfUntouched();
      }
      requestRender();
    },
    zoomToFitAll(): void {
      if (!view || view.nodes.length === 0) return;
      const points = view.symbolsEnabled
        ? [...view.nodes, ...positionedSymbols(view.nodes, view.symbolsByPath)]
        : view.nodes;
      const fit = zoomToFit(points, viewport());
      minZoom = Math.min(minZoom, fit.zoom * 0.5);
      animateTo(fit);
    },
    focusNode(id: string): void {
      if (!view) return;
      const node = nodeById.get(id) ?? view.nodes.find((n) => n.id === id);
      if (!node) return;
      /* Zoom to a readable neighborhood level — enough to pick the star out of
         its cluster on a huge map, but not slammed to max on a small one — and
         never yank a user who is already zoomed in further back out. */
      animateTo(frameNode(node, camera.zoom, focusZoomFor(fitZoom), minZoom));
    },
    focusWorld(x: number, y: number): void {
      animateTo({ cx: x, cy: y, zoom: camera.zoom });
    },
    panBy(dxPx: number, dyPx: number): void {
      setCamera(panCamera(camera, dxPx, dyPx));
    },
    zoomBy(factor: number): void {
      setCamera(zoomAround(camera, viewport(), app.screen.width / 2, app.screen.height / 2, factor, minZoom));
    },
    destroy(): void {
      destroyed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      for (const cleanup of cleanupInteractions.splice(0)) cleanup();
      if (ready) app.destroy(true, { children: true, texture: true });
      spriteById.clear();
      symbolSpriteById.clear();
      nodeById.clear();
      symbolPositionById.clear();
      baseScaleById.clear();
      baseAlphaById.clear();
      twinkleSeedById.clear();
    },
  };
}
