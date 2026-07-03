/* Non-React pixi renderer for the Codebase Map. Owns the WebGL scene, camera
   interactions, and the per-frame trace animation. React (PixiStage) only
   mounts/unmounts it and pushes view-model state in.

   CPU discipline: the pixi ticker runs only while something animates or the
   user interacts, and stops entirely when the document is hidden — a hidden
   retained webview must not burn a core. */

import { Application, Container, FederatedPointerEvent, Graphics, Sprite, Texture } from "pixi.js";
import {
  clampZoom,
  pan as panCamera,
  zoomAround,
  zoomToFit,
  type Camera,
  type Viewport,
} from "@/lib/graph/camera";
import {
  ANNOTATION_COLOR,
  BACKGROUND_COLOR,
  IMPORT_EDGE_COLOR,
  TRACE_COLORS,
  folderColor,
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
  type TraceEdge,
} from "@/lib/graph/traces";
import { seededRandomForStarfield } from "./starfield";
import type { GraphViewState } from "@/lib/graph/view-model";
import { matchesSearch } from "@/lib/graph/view-model";
import { neighborIds } from "@/lib/graph/view-model";

export interface RendererCallbacks {
  onHover(nodeId: string | null): void;
  onSelect(nodeId: string | null): void;
  onOpen(nodeId: string): void;
  onCameraChange(camera: Camera): void;
}

export interface GraphRenderer {
  setState(view: GraphViewState): void;
  zoomToFitAll(): void;
  destroy(): void;
}

const GLOW_TEXTURE_RADIUS = 48;
const COMET_MS = 700;

function nodeRadius(inDegree: number, outDegree: number): number {
  return 2.5 + Math.min(9, Math.sqrt(inDegree + outDegree) * 1.1);
}

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

export function createGraphRenderer(host: HTMLElement, callbacks: RendererCallbacks): GraphRenderer {
  const app = new Application();
  let destroyed = false;
  let ready = false;

  let view: GraphViewState | null = null;
  let camera: Camera = { cx: 0, cy: 0, zoom: 1 };
  let cameraTouched = false;
  let stateDirty = false;
  let cameraDirty = false;
  let traceEdges: TraceEdge[] = [];

  const spriteById = new Map<string, Sprite>();
  const nodeById = new Map<string, GraphViewState["nodes"][number]>();

  const bgLayer = new Container();
  const bgGfx = new Graphics();
  const world = new Container();
  const edgeGfx = new Graphics();
  const annotationGfx = new Graphics();
  const traceGfx = new Graphics();
  const nodeLayer = new Container();

  let glowTexture: Texture | null = null;

  function viewport(): Viewport {
    return { width: app.screen.width, height: app.screen.height };
  }

  function requestRender(): void {
    if (destroyed || !ready) return;
    if (!app.ticker.started && !document.hidden) app.ticker.start();
  }

  function setCamera(next: Camera): void {
    camera = { ...next, zoom: clampZoom(next.zoom) };
    cameraTouched = true;
    cameraDirty = true;
    requestRender();
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
      const radius = nodeRadius(node.inDegree, node.outDegree);
      sprite.scale.set(radius / 8); /* glow core is ~8px in the texture */
      sprite.tint = folderColor(node.dir);
    }
    applyEmphasis();
  }

  /** Search dimming + selection neighborhood highlighting (cheap, sprite alpha). */
  function applyEmphasis(): void {
    if (!view) return;
    const searching = view.search.trim().length > 0;
    const selected = view.selectedNodeId;
    const neighbors = selected ? neighborIds(selected, view.edges, view.annotations) : null;
    for (const node of view.nodes) {
      const sprite = spriteById.get(node.id);
      if (!sprite) continue;
      const base = 0.4 + 0.6 * node.z;
      let dim = 1;
      if (searching && !matchesSearch(node, view.search)) dim = 0.12;
      if (selected && node.id !== selected && neighbors && !neighbors.has(node.id)) {
        dim = Math.min(dim, 0.18);
      }
      sprite.alpha = base * dim;
    }
  }

  function drawEdges(): void {
    if (!view) return;
    edgeGfx.clear();
    for (const edge of view.edges) {
      if (edge.kind !== "import") continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      edgeGfx.moveTo(from.x, from.y);
      edgeGfx.lineTo(to.x, to.y);
    }
    edgeGfx.stroke({ width: 1, color: IMPORT_EDGE_COLOR, alpha: 0.22, pixelLine: true });

    annotationGfx.clear();
    for (const annotation of view.annotations) {
      const from = nodeById.get(annotation.from);
      const to = nodeById.get(annotation.to);
      if (!from || !to) continue;
      drawDashedLine(annotationGfx, from.x, from.y, to.x, to.y, 7, 5);
    }
    annotationGfx.stroke({ width: 1.5, color: ANNOTATION_COLOR, alpha: 0.85, pixelLine: true });
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

  function drawStarfield(): void {
    if (!view) return;
    bgGfx.clear();
    if (view.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of view.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    const padX = (maxX - minX) * 0.35 + 200;
    const padY = (maxY - minY) * 0.35 + 200;
    const random = seededRandomForStarfield(view.nodes.length);
    for (let i = 0; i < 280; i += 1) {
      const x = minX - padX + random() * (maxX - minX + padX * 2);
      const y = minY - padY + random() * (maxY - minY + padY * 2);
      bgGfx.circle(x, y, random() * 1.3 + 0.3).fill({ color: 0xaab4d4, alpha: 0.08 + random() * 0.1 });
    }
  }

  /* ── Per-frame work ─────────────────────────────────────────── */

  function applyCameraTransform(): void {
    const vp = viewport();
    world.scale.set(camera.zoom);
    world.position.set(vp.width / 2 - camera.cx * camera.zoom, vp.height / 2 - camera.cy * camera.zoom);
    /* Distant starfield drifts slower for depth. */
    const parallax = 0.85;
    bgLayer.scale.set(camera.zoom);
    bgLayer.position.set(vp.width / 2 - camera.cx * parallax * camera.zoom, vp.height / 2 - camera.cy * parallax * camera.zoom);
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
      const radius = nodeRadius(node.inDegree, node.outDegree);
      sprite.scale.set((radius / 8) * (1 + pulse * 0.6 + (heat / HEAT_CAP) * 0.15));
      if (pulse > 0 || heat > 0.02) {
        sprite.alpha = Math.min(1, (0.4 + 0.6 * node.z) + pulse * 0.6 + (heat / HEAT_CAP) * 0.3);
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
    if (cameraDirty) {
      applyCameraTransform();
      callbacks.onCameraChange(camera);
      cameraDirty = false;
    }
    if (stateDirty) {
      rebuildNodes();
      drawEdges();
      drawStarfield();
      stateDirty = false;
    }
    const animating = animateTraces(Date.now());
    if (!animating && !cameraDirty && !stateDirty && !dragging) {
      /* Render this last frame, then go idle. */
      app.ticker.stop();
    }
  }

  /* ── Interactions ───────────────────────────────────────────── */

  let dragging = false;
  let lastPointer = { x: 0, y: 0 };
  let dragMoved = false;

  function attachInteractions(): void {
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;

    app.stage.on("pointerdown", (event: FederatedPointerEvent) => {
      dragging = true;
      dragMoved = false;
      lastPointer = { x: event.global.x, y: event.global.y };
      requestRender();
    });
    app.stage.on("pointermove", (event: FederatedPointerEvent) => {
      if (!dragging) return;
      const dx = event.global.x - lastPointer.x;
      const dy = event.global.y - lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      lastPointer = { x: event.global.x, y: event.global.y };
      setCamera(panCamera(camera, dx, dy));
    });
    const endDrag = () => {
      if (dragging && !dragMoved) callbacks.onSelect(null); /* click empty space clears selection */
      dragging = false;
    };
    app.stage.on("pointerup", endDrag);
    app.stage.on("pointerupoutside", () => { dragging = false; });

    app.canvas.addEventListener("wheel", (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0012);
      const rect = app.canvas.getBoundingClientRect();
      setCamera(zoomAround(camera, viewport(), event.clientX - rect.left, event.clientY - rect.top, factor));
    }, { passive: false });
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
    glowTexture = makeGlowTexture(app);
    bgLayer.addChild(bgGfx);
    world.addChild(edgeGfx, annotationGfx, traceGfx, nodeLayer);
    app.stage.addChild(bgLayer, world);
    attachInteractions();
    app.ticker.add(frame);
    app.renderer.on("resize", () => {
      cameraDirty = true;
      requestRender();
    });
    document.addEventListener("visibilitychange", onVisibility);
    ready = true;
    stateDirty = view !== null;
    cameraDirty = true;
    if (view && view.nodes.length > 0 && !cameraTouched) {
      camera = zoomToFit(view.nodes, viewport());
      cameraTouched = false; /* auto-fit doesn't count as a user move */
    }
    requestRender();
  });

  return {
    setState(next: GraphViewState): void {
      const structureChanged =
        !view
        || view.nodes !== next.nodes
        || view.edges !== next.edges
        || view.annotations !== next.annotations
        || view.search !== next.search
        || view.selectedNodeId !== next.selectedNodeId;
      const hadNoNodes = !view || view.nodes.length === 0;
      if (view && view.traces !== next.traces) {
        traceEdges = deriveTraceEdges(next.traces);
      }
      view = next;
      if (structureChanged) stateDirty = true;
      if (ready && hadNoNodes && next.nodes.length > 0 && !cameraTouched) {
        camera = zoomToFit(next.nodes, viewport());
        cameraDirty = true;
        cameraTouched = false;
      }
      requestRender();
    },
    zoomToFitAll(): void {
      if (!view || view.nodes.length === 0) return;
      camera = zoomToFit(view.nodes, viewport());
      cameraDirty = true;
      requestRender();
    },
    destroy(): void {
      destroyed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (ready) app.destroy(true, { children: true, texture: true });
      spriteById.clear();
      nodeById.clear();
    },
  };
}
