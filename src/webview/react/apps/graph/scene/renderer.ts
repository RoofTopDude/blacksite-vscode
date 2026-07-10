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
/* VS Code webviews serve a strict CSP with no 'unsafe-eval'. By default pixi
   generates uniform-buffer sync functions via `new Function(...)` for speed,
   which throws under that CSP ("Current environment does not allow
   unsafe-eval") and made app.init() reject on every real VS Code host — not
   just remote/no-GPU ones. This side-effect import swaps in pixi's official
   eval-free polyfills before the Application is constructed below. Must stay
   a top-level import (not inside createGraphRenderer) so it runs before any
   renderer system is instantiated. */
import "pixi.js/unsafe-eval";
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
  territorialCollapseFactor,
  zoomToFit,
  type Camera,
  type Viewport,
} from "@/lib/graph/camera";
import {
  ANNOTATION_COLOR,
  BACKGROUND_COLOR,
  BRIDGE_EDGE_COLOR,
  CYCLE_WARNING_COLOR,
  GIT_WARM_COLOR,
  IMPORT_EDGE_COLOR,
  RELATIONSHIP_EDGE_COLORS,
  SYMBOL_NODE_COLOR,
  SYMBOL_RELATION_COLORS,
  activityColor,
  churnFraction,
  folderColor,
  hashString,
  langBucketColor,
  mixColors,
  recencyFraction,
} from "@/lib/graph/colors";
import {
  HEAT_CAP,
  deriveTraceEdges,
  hasActiveAnimation,
  heatAt,
  pulseAt,
  dominantKind,
  dominantLaneId,
  traceEdgeAlpha,
  twinkleFactor,
  type TraceEdge,
} from "@/lib/graph/traces";
import {
  edgeControlPoint,
  flowPhase,
  quadraticPointAt,
  type Point,
} from "@/lib/graph/edges";
import { approach, approachPoint, easeOutCubic, spawnOrigin, type XY } from "@/lib/graph/motion";
import { paddedHull, type HullPoint } from "@/lib/graph/hull";
import { seededRandomForStarfield } from "./starfield";
import type { GraphViewState } from "@/lib/graph/view-model";
import type { GraphEdge, SymbolRelation, TraceKind } from "@/lib/graph/protocol";
import {
  clusterBackboneEdges,
  edgePresentation,
  gitHeatStats,
  graphNodeRadius,
  matchesSearch,
  neighborIds,
  nodeBounds,
  positionedSymbols,
  serviceRelationshipBackbone,
  serviceRelationshipBundles,
  symbolRelationTargets,
  visibleNodeIds,
  type EdgeRenderStrategy,
  type GitHeatStats,
  type ServiceRelationshipBundle,
} from "@/lib/graph/view-model";

export interface RendererCallbacks {
  onHover(nodeId: string | null): void;
  onSelect(nodeId: string | null): void;
  onOpen(nodeId: string): void;
  onCameraChange(camera: Camera): void;
  /** pixi failed to initialize (no WebGL, or some other init-time failure) —
      otherwise the panel is silently blank forever with only a console line
      to explain why. */
  onInitError?(message: string): void;
}

export interface GraphRenderer {
  setState(view: GraphViewState): void;
  zoomToFitAll(): void;
  /** Smoothly fly the camera to frame a node by id (search result, deep link). */
  focusNode(id: string): void;
  /** Smoothly recenter on a world point at the current zoom (minimap jump). */
  focusWorld(x: number, y: number): void;
  /** Smoothly fly to an arbitrary camera (saved-view restore). */
  flyTo(camera: Camera): void;
  /** Keyboard pan by a pixel delta. */
  panBy(dxPx: number, dyPx: number): void;
  /** Keyboard zoom about the viewport center. */
  zoomBy(factor: number): void;
  destroy(): void;
}

const GLOW_TEXTURE_RADIUS = 34;
const COMET_MS = 700;
/** File-detail views keep a generous hit/read radius. Dense architecture
    overviews use a smaller dynamic floor (minimumNodeScreenPx) so thousands of
    additive glows cannot merge into a single luminous mass. */
const DETAIL_NODE_SCREEN_PX = 4;
const HOVER_POP = 1.4;
const MAX_FPS = 40;
const RELATIONSHIP_KINDS = new Set(["api", "event", "data", "config"]);
/* Activity shimmer: subtle pulses that flow outward along a recently-touched
   file's import edges, in the activity color, so "the agent just read/edited
   this" reads at a glance without a hard flash. */
const ACTIVITY_FLOW_PERIOD_MS = 1600;
const ACTIVITY_PULSES_PER_EDGE = 2;
/** Cap edges lit per active hub so touching a 300-import file stays cheap. */
const MAX_ACTIVITY_EDGES_PER_NODE = 40;
/** Below this decayed heat a file is "cold" — no shimmer. */
const ACTIVITY_HEAT_MIN = 0.06;
/** Per-frame easing toward the target emphasis alpha (~40fps → ~150ms settle).
    Governs how quickly filtered/isolated stars fade to ghosts and back. */
const EMPHASIS_EASE = 0.22;
/** Ghost alpha for a star filtered out of the current focus set — dim enough
    to recede, bright enough to keep the map's overall shape legible. */
const GHOST_ALPHA = 0.05;
/* Fluid motion: stars fly to new layout positions instead of teleporting
   (cluster expand blooms files outward from the super-node; a re-index morphs
   the field into place), newborn stars pop in with an ease-out birth, and the
   hover pop eases instead of snapping. */
const POS_EASE = 0.14;
const HOVER_EASE = 0.3;
const BIRTH_MS = 420;
/** While stars are in flight the static edge layers dip to this multiplier —
    edges are drawn at *target* positions, so leaving them bright would show
    wires anchored to empty space mid-morph. They breathe back in on arrival. */
const EDGE_REVEAL_DIM = 0.25;
const EDGE_REVEAL_EASE = 0.15;
/** Slow outward pulses along the focused node's spotlight arcs. */
const FOCUS_FLOW_PERIOD_MS = 2400;
/** Ambient relationship-edge flow: a slower, calmer pace than the focus
    spotlight so the two don't read as the same beat when both are visible. */
const RELATIONSHIP_FLOW_PERIOD_MS = 3000;
/** Cost cap for the always-on relationship pulse — relationship edges are
    service-to-service (or capped upstream), never the full file-level import
    graph, but this keeps a pathological case bounded regardless. */
const MAX_RELATIONSHIP_FLOW_EDGES = 300;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRelationshipEdge(edge: GraphEdge): boolean {
  return RELATIONSHIP_KINDS.has(edge.kind);
}

function relationshipStroke(edge: GraphEdge, focused: boolean): { width: number; color: number; alpha: number; pixelLine: true } {
  const confidence = clamp01(edge.confidence ?? 0.55);
  return {
    width: 1.05 + confidence * 0.85 + (focused ? 0.35 : 0),
    color: RELATIONSHIP_EDGE_COLORS[edge.kind] ?? IMPORT_EDGE_COLOR,
    alpha: Math.min(0.9, 0.26 + confidence * 0.46 + (focused ? 0.14 : 0)),
    pixelLine: true,
  };
}

/** Every generated glow/badge texture is baked at this multiple of its
    nominal size (renderer.resolution otherwise defaults to 1 on a standard
    display) and sampled with linear filtering — without this, a star scaled
    up past its native texture size (hover pop, git-heat churn scaling, a
    close zoom) visibly pixelates/bands instead of staying smooth. */
const GLOW_TEXTURE_OPTS = { resolution: 3, textureSourceOptions: { scaleMode: "linear" as const } };

function makeGlowTexture(app: Application): Texture {
  const gfx = new Graphics();
  /* A refined star, not a floodlight: a crisp bright core with a tight halo
     that falls off steeply (cubic) to near-nothing well before the texture
     edge. The old wide, shallow halo (radius 48, quadratic falloff, ~0.08
     peak) smeared under additive blending — a few hundred stars in a cluster
     summed to a blown-out white sun. Keeping the halo small and steep means
     an individual star still glows, but density reads as "many distinct
     points of light" rather than one glare. */
  for (let ring = GLOW_TEXTURE_RADIUS; ring > 4; ring -= 1) {
    const t = ring / GLOW_TEXTURE_RADIUS;
    gfx.circle(0, 0, ring).fill({ color: 0xffffff, alpha: 0.012 + 0.03 * Math.pow(1 - t, 3) });
  }
  /* The halo loop above hands off to the bright core circles below at r=4.5 —
     jumping straight from the halo's faint inner edge (~0.03 alpha) to a
     0.8-alpha disc used to show as a visible brightness seam once a star was
     scaled up. Bridge the two with several smaller interpolated steps instead
     of one hard jump, anchored to the same two proven endpoint values so the
     overall brightness balance is unchanged — just spread across a gradient
     instead of a cliff. */
  for (let ring = 4; ring > 2.4; ring -= 0.2) {
    const blend = 1 - (ring - 2.4) / (4 - 2.4); // 0 at ring=4 → 1 at ring=2.4
    gfx.circle(0, 0, ring).fill({ color: 0xffffff, alpha: 0.03 + 0.77 * Math.pow(blend, 2) });
  }
  gfx.circle(0, 0, 2.4).fill({ color: 0xffffff, alpha: 1 });
  return app.renderer.generateTexture({ target: gfx, ...GLOW_TEXTURE_OPTS });
}

/** Small solid dot for explicit note/annotation badges. */
function makeBadgeDotTexture(app: Application): Texture {
  const gfx = new Graphics();
  gfx.circle(0, 0, 3.2).fill({ color: 0xffffff, alpha: 1 });
  return app.renderer.generateTexture({ target: gfx, ...GLOW_TEXTURE_OPTS });
}

/** Small ring for the hub badge — tinted gold, stroke-only so it reads as a
    marker around the star rather than a second star. */
function makeBadgeRingTexture(app: Application): Texture {
  const gfx = new Graphics();
  gfx.circle(0, 0, 5).stroke({ width: 1.3, color: 0xffffff, alpha: 1 });
  return app.renderer.generateTexture({ target: gfx, ...GLOW_TEXTURE_OPTS });
}

export function createGraphRenderer(host: HTMLElement, callbacks: RendererCallbacks, initialCamera?: Camera): GraphRenderer {
  const app = new Application();
  let destroyed = false;
  let ready = false;

  let view: GraphViewState | null = null;
  let camera: Camera = initialCamera ?? { cx: 0, cy: 0, zoom: 1 };
  /** True once the user (or a deliberate fly-to — Fit, search pick, minimap
      jump) has actually positioned the camera *in this session*. Must NOT be
      derived from whether `initialCamera` was supplied: store.ts always
      hands back a defined Camera (defaulting to {0,0,1} rather than
      `undefined` even with nothing ever persisted), so seeding this from
      "was a value provided" made it true on literally every load, which
      permanently suppressed real auto-fit-to-content — the map just showed
      whatever sliver of the project happened to sit near world origin
      instead of the whole thing. `camera` above still starts from
      `initialCamera` so the very first paint isn't a jarring jump from the
      origin, but it's just a starting point: autoFitIfUntouched() below is
      free to (and will) override it the moment real node data lands. */
  let cameraTouched = false;
  let stateDirty = false;
  let cameraDirty = false;
  let traceEdges: TraceEdge[] = [];
  /** Zoom that frames the whole node cloud; refreshed when nodes/viewport change. */
  let fitZoom = 1;
  /** Import count used by the pure edge-LOD policy. Refreshed while drawEdges
      already walks the edge set, never rescanned on camera-only frames. */
  let displayImportEdgeCount = 0;
  /** Last strategy committed to the static edge layers. A zoom-only change
      redraws those layers only when this crosses raw <-> bundled. */
  let lastEdgeRenderStrategy: EdgeRenderStrategy | null = null;
  /** Dynamic wheel-zoom floor: always allows a comfortable overview. */
  let minZoom = MIN_ZOOM;
  /** Active fly-to animation, or null when the camera is at rest / dragged. */
  let anim: { from: Camera; to: Camera; start: number; dur: number } | null = null;
  const FLY_MS = 480;

  const reducedMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const spriteById = new Map<string, Sprite>();
  /** Hub-badge child sprite, present only for nodes above the degree
      percentile computed each structural rebuild (see rebuildNodes). */
  const badgeHubSpriteById = new Map<string, Sprite>();
  /** "Has working-memory notes" badge child sprite, present for any node
      touched by at least one annotation (node- or edge-scoped). */
  const badgeNoteSpriteById = new Map<string, Sprite>();
  /** File-kind badge dot (code/markup/style/data/docs hue) — the third badge
      the Map key documents. Files only; fades in with the other badges. */
  const badgeKindSpriteById = new Map<string, Sprite>();
  const symbolSpriteById = new Map<string, Sprite>();
  const nodeById = new Map<string, GraphViewState["nodes"][number]>();
  const symbolPositionById = new Map<string, { x: number; y: number; parentId: string }>();
  /** Per-node world-space sprite scale after min-px compensation + hover pop. */
  const baseScaleById = new Map<string, number>();
  /** Per-node *target* emphasis alpha (search/selection/filter dimming) — the
      value the animated `liveAlphaById` eases toward, before twinkle/traces. */
  const baseAlphaById = new Map<string, number>();
  /** Per-node animated emphasis alpha: eases toward baseAlphaById each frame so
      filtering, selection, and search fade in/out instead of snapping. */
  const liveAlphaById = new Map<string, number>();
  /** Per-node animated world position, easing toward the layout target — the
      "stars fly, never teleport" layer. Written every frame by motionPass. */
  const livePosById = new Map<string, XY>();
  /** Per-node eased hover-pop level in [0,1]; entries exist only while a node
      is hovered or still relaxing back, so the map stays tiny. */
  const hoverLevelById = new Map<string, number>();
  /** Birth timestamps for sprites created this session — drives the ease-out
      scale pop of newly-revealed stars (cluster expansion, new files). */
  const birthAtById = new Map<string, number>();
  /** Animated multiplier on the static edge layers (see EDGE_REVEAL_DIM). */
  let edgeReveal = 1;
  /** Ids passing the active focus filter, or null when no filter is active
      (everything visible). Recomputed in applyEmphasis; read by drawEdges to
      cull edges into ghosted stars. */
  let visibleIds: Set<string> | null = null;
  /** Per-node base tint (folder hue, or git-heat warm when that lens is on) —
      the color the twinkle/trace passes modulate from, so git heat survives
      alongside activity coloring. */
  const baseTintById = new Map<string, number>();
  /** Git heat reference frame (churn max + commit-time range), recomputed on
      each structural rebuild from the displayed nodes. */
  let gitHeat: GitHeatStats = { hasData: false, maxChurn: 0, oldest: 0, newest: 0 };
  /** Whether the layout is genuinely territorial (≥2 distinct neighborhoods),
      recomputed on each structural rebuild in drawNeighborhoodZones(). Gates
      the semantic-zoom collapse so a single-codebase workspace is provably
      unaffected regardless of zoom. */
  let territorialActive = false;
  /** Stable per-node hash driving each star's twinkle phase. */
  const twinkleSeedById = new Map<string, number>();
  /** Incident import edges per node id, rebuilt on structure change — lets the
      activity shimmer walk a touched file's connections (and ride the exact
      same arc they're drawn as) without an O(edges) scan every animation
      frame. `thisIsFrom` records edge direction so the arc control point can
      be reconstructed identically. */
  const importIncidentById = new Map<string, Array<{ other: string; thisIsFrom: boolean }>>();
  /** Edge count feeding adaptive LOD. File mode uses imports; Service mode uses
      already-aggregated typed routes so duplicate detections do not trip the
      dense-mesh threshold. */
  let displayTopologyNodeCount = 0;
  let displayTopologyEdgeCount = 0;
  /** Service bundles that survived the current kind/focus/visibility gates.
      Shared by static arcs and ambient flow so raw parallel detections are
      never rescanned or animated independently on camera-only frames. */
  let visibleServiceRelationshipBundles: ServiceRelationshipBundle[] = [];
  /** Direct, visible service routes by endpoint. This keeps a hovered or
      selected service inspectable even when the overview is showing only its
      compact backbone, without re-bundling the whole graph per animation frame. */
  const serviceBundlesByNodeId = new Map<string, ServiceRelationshipBundle[]>();

  /* Two parallax background layers give the "deep space" depth cue. */
  const bgFarLayer = new Container();
  const bgMidLayer = new Container();
  const nebulaGfx = new Graphics();
  const starsFarGfx = new Graphics();
  const starsMidGfx = new Graphics();
  const world = new Container();
  /* Neighborhood (codebase-territory) hulls on their own layer, below the
     per-cluster zones, so their alpha can rise independently as the semantic
     zoom feature collapses the map to territory silhouettes at extreme
     zoom-out. */
  const neighborhoodZoneGfx = new Graphics();
  const zoneGfx = new Graphics(); /* territory-zone borders around folder clusters */
  const edgeGfx = new Graphics();
  const clusterEdgeGfx = new Graphics();
  const structuralGfx = new Graphics(); /* cycle-warning + bridge-edge highlights, opt-in layers */
  const relationshipFlowGfx = new Graphics(); /* ambient from->to pulses on service-relationship edges */
  const selEdgeGfx = new Graphics(); /* focus-highlighted edges (hover/selection), full alpha */
  const relationGfx = new Graphics();
  const symbolRelationFlowGfx = new Graphics(); /* ambient from->to pulses on symbol-relation edges */
  const annotationGfx = new Graphics();
  const traceGfx = new Graphics();
  const symbolOrbitGfx = new Graphics();
  const nodeLayer = new Container();
  const symbolLayer = new Container();
  const focusRingGfx = new Graphics(); /* crisp ring around the hovered/selected node */
  const liveGfx = new Graphics(); /* pulsing "agent working here now" rings */

  let glowTexture: Texture | null = null;
  let badgeDotTexture: Texture | null = null;
  let badgeRingTexture: Texture | null = null;

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
    if (!view || view.displayNodes.length === 0) return;
    const fit = zoomToFit(view.displayNodes, viewport());
    fitZoom = fit.zoom;
    minZoom = Math.min(MIN_ZOOM, fitZoom * 0.5);
  }

  function currentEdgeRenderStrategy(): EdgeRenderStrategy {
    if (!view) return "off";
    return edgePresentation(
      view.display.edgeMode,
      view.display.lens,
      displayTopologyNodeCount,
      displayTopologyEdgeCount,
      camera.zoom / Math.max(fitZoom, 1e-6),
    ).strategy;
  }

  /** Camera panning keeps the same strategy and therefore never rebuilds the
      static edge geometry. Zooming redraws exactly on an adaptive LOD boundary. */
  function redrawEdgesForStrategyChange(): void {
    if (lastEdgeRenderStrategy === null) return;
    if (currentEdgeRenderStrategy() !== lastEdgeRenderStrategy) drawEdges();
  }

  /** Screen-space radius floor tuned to the active semantic level. Individual
      files stay easy to hit in raw/focus views; a bundled overview treats them
      as context beneath the architecture routes and progressively tightens
      their data ink as the corpus grows. */
  function minimumNodeScreenPx(): number {
    if (!view || lastEdgeRenderStrategy !== "bundled") return DETAIL_NODE_SCREEN_PX;
    const count = view.displayNodes.length;
    if (count >= 10_000) return 1.35;
    if (count >= 4_000) return 1.6;
    if (count >= 1_500) return 2;
    if (count >= 700) return 2.65;
    return 3.2;
  }

  /** Does the current camera frame overlap the node cloud at all? Initial
      load is now handled unconditionally by autoFitIfUntouched() (see the
      `cameraTouched` comment above) — this function is the *mid-session*
      safety net: once the user has genuinely positioned the camera,
      structural changes leave it alone, but a large re-index can reshape the
      whole layout (or, in principle, a workspace swap on a retained webview)
      out from under it. Rather than leave the user stranded looking at
      nothing with no clue why, callers fly back to a fresh fit when this
      returns false. */
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
    if (!ready || !view || view.displayNodes.length === 0 || cameraTouched) return;
    if (hasValidFit && !force) return;
    const vp = viewport();
    if (vp.width <= 0 || vp.height <= 0) return; /* still not laid out; retry next frame */
    recomputeZoomBounds();
    camera = zoomToFit(view.displayNodes, vp);
    cameraDirty = true;
    hasValidFit = true;
  }

  /* ── Scene (re)construction on state change ─────────────────── */

  /** A node's resting color: its folder hue, or — under the git heat lens —
      warmed toward the ember color in proportion to how recently it changed. */
  function nodeBaseTint(node: GraphViewState["nodes"][number]): number {
    const folder = folderColor(node.dir);
    if (!view?.display.showGitHeat) return folder;
    const recency = recencyFraction(node.lastCommitAt, gitHeat.oldest, gitHeat.newest);
    return mixColors(folder, GIT_WARM_COLOR, recency * 0.85);
  }

  function rebuildNodes(): void {
    if (!view || !glowTexture) return;
    /* Snapshot the outgoing display graph before it's replaced: spawn origins
       (fly newly-expanded files out of their old super-node, and vice versa)
       are resolved against what was on screen a moment ago. */
    const prevNodes = new Map(nodeById);
    nodeById.clear();
    for (const node of view.displayNodes) nodeById.set(node.id, node);
    gitHeat = view.display.showGitHeat ? gitHeatStats(view.displayNodes) : { hasData: false, maxChurn: 0, oldest: 0, newest: 0 };

    for (const [id, sprite] of spriteById) {
      if (!nodeById.has(id)) {
        sprite.destroy({ children: true }); // badge sprites are children — this destroys them too
        spriteById.delete(id);
        badgeHubSpriteById.delete(id);
        badgeNoteSpriteById.delete(id);
        badgeKindSpriteById.delete(id);
        baseScaleById.delete(id);
        baseAlphaById.delete(id);
        liveAlphaById.delete(id);
        livePosById.delete(id);
        hoverLevelById.delete(id);
        birthAtById.delete(id);
        baseTintById.delete(id);
        twinkleSeedById.delete(id);
      }
    }
    /* Hub badge threshold: top ~10% of total degree among currently displayed
       nodes, floored so a small/sparse graph doesn't mark everything a hub. */
    const fileDegrees = view.displayNodes
      .filter((node) => !node.kind || node.kind === "file")
      .map((node) => node.inDegree + node.outDegree)
      .sort((a, b) => a - b);
    const HUB_MIN_DEGREE = 6;
    const hubThreshold = fileDegrees.length > 0
      ? Math.max(HUB_MIN_DEGREE, fileDegrees[Math.floor(fileDegrees.length * 0.9)] ?? HUB_MIN_DEGREE)
      : Infinity;
    /* Nodes touched by at least one working-memory note (node- or edge-scoped). */
    const notedNodeIds = new Set<string>();
    for (const a of view.annotations) {
      notedNodeIds.add(a.from);
      if (a.to) notedNodeIds.add(a.to);
    }

    const bornAt = Date.now();
    for (const node of view.displayNodes) {
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
        /* Birth: pop in with an ease-out, flying from the cluster star it was
           folded into (if any) toward its own layout position. */
        if (!reducedMotion) {
          birthAtById.set(node.id, bornAt);
          const origin = spawnOrigin(node, prevNodes);
          livePosById.set(node.id, origin ?? { x: node.x, y: node.y });
        }
        /* Existing sprites keep their live position and glide — motionPass
           owns sprite.position/scale from here on. */
      }
      const tint = nodeBaseTint(node);
      baseTintById.set(node.id, tint);
      sprite.tint = tint;
      if (!twinkleSeedById.has(node.id)) twinkleSeedById.set(node.id, hashString(node.id));

      /* Badges only decorate real files — a collapsed cluster/service
         super-node stands for many files with mixed languages, so a single
         kind dot or hub ring wouldn't mean anything for it. */
      const isFile = !node.kind || node.kind === "file";
      const isHub = isFile && node.inDegree + node.outDegree >= hubThreshold;
      if (isHub && badgeRingTexture) {
        let ring = badgeHubSpriteById.get(node.id);
        if (!ring) {
          ring = new Sprite(badgeRingTexture);
          ring.anchor.set(0.5);
          ring.tint = ANNOTATION_COLOR;
          sprite.addChild(ring);
          badgeHubSpriteById.set(node.id, ring);
        }
      } else {
        badgeHubSpriteById.get(node.id)?.destroy();
        badgeHubSpriteById.delete(node.id);
      }

      if (isFile && notedNodeIds.has(node.id) && badgeDotTexture) {
        let noteDot = badgeNoteSpriteById.get(node.id);
        if (!noteDot) {
          noteDot = new Sprite(badgeDotTexture);
          noteDot.anchor.set(0.5);
          noteDot.position.set(-6, -6);
          noteDot.tint = ANNOTATION_COLOR;
          sprite.addChild(noteDot);
          badgeNoteSpriteById.set(node.id, noteDot);
        }
      } else {
        badgeNoteSpriteById.get(node.id)?.destroy();
        badgeNoteSpriteById.delete(node.id);
      }

      /* Kind dot: opposite corner from the note dot, slightly smaller so the
         gold note badge keeps visual priority when both are present. */
      if (isFile && badgeDotTexture) {
        let kindDot = badgeKindSpriteById.get(node.id);
        if (!kindDot) {
          kindDot = new Sprite(badgeDotTexture);
          kindDot.anchor.set(0.5);
          kindDot.position.set(6, 6);
          kindDot.scale.set(0.75);
          sprite.addChild(kindDot);
          badgeKindSpriteById.set(node.id, kindDot);
        }
        kindDot.tint = langBucketColor(node.lang);
      } else {
        badgeKindSpriteById.get(node.id)?.destroy();
        badgeKindSpriteById.delete(node.id);
      }
    }
    rebuildSymbols();
    applyEmphasis();
    applyNodeScales();
  }

  function rebuildSymbols(): void {
    if (!view || !glowTexture) return;
    const placements = view.symbolsEnabled ? positionedSymbols(view.displayNodes, view.symbolsByPath) : [];
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
    const neighbors = selected ? neighborIds(selected, view.displayEdges, view.annotations) : null;
    const relationTargets = selected ? symbolRelationTargets(view.symbolsByPath[selected]) : null;
    visibleIds = visibleNodeIds(view.displayNodes, view.displayEdges, view.annotations, view.filter, selected);
    /* Cul-de-sac layer: a node with no import connection to its neighborhood's
       main body reads as probably-unused, so it fades like filtered-out
       content — the same visual vocabulary, not a third alpha tier to learn. */
    const orphanIds = view.display.showCulDeSacs && view.orphanNodeIds.length > 0 ? new Set(view.orphanNodeIds) : null;
    for (const node of view.displayNodes) {
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
      /* Focus filter wins: a filtered-out star ghosts regardless of the rest,
         unless the pointer is hovering it (peek without clearing the filter). */
      if (visibleIds && !visibleIds.has(node.id) && node.id !== view.hoveredNodeId) {
        alpha = Math.min(alpha, GHOST_ALPHA);
      } else if (node.id === selected || node.id === view.hoveredNodeId) {
        alpha = Math.max(alpha, 0.95);
      } else if (orphanIds?.has(node.id)) {
        alpha = Math.min(alpha, GHOST_ALPHA);
      }
      baseAlphaById.set(node.id, alpha);
      /* Every genuinely-new star fades up from dark (first load blooms the
         whole field; a cluster expansion blooms just its files). Existing
         stars keep their live value and glide to the new target. */
      if (!liveAlphaById.has(node.id)) liveAlphaById.set(node.id, 0);
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

  /** Recompute every sprite's *target* world-space scale so nodes keep a
      minimum on-screen size at any zoom. Targets only — motionPass writes the
      actual sprite scale each frame, layering the eased hover pop and birth
      multiplier on top (so a zoom change tracks instantly while hover/birth
      stay springy). Runs on camera or state changes. */
  function applyNodeScales(): void {
    if (!view) return;
    const architectureOverview = lastEdgeRenderStrategy === "bundled";
    for (const node of view.displayNodes) {
      const sprite = spriteById.get(node.id);
      if (!sprite) continue;
      /* Additive light is useful when inspecting a few files, but hundreds of
         overlapping additive sprites bleach a dense overview white. Normal
         compositing keeps each contextual file distinct; focus/live overlays
         retain their dedicated glow layers above it. */
      sprite.blendMode = architectureOverview ? "normal" : "add";
      let scale = nodeSpriteScale(graphNodeRadius(node), camera.zoom, minimumNodeScreenPx());
      if (view.display.showGitHeat) scale *= 1 + churnFraction(node.churn, gitHeat.maxChurn) * 0.7;
      baseScaleById.set(node.id, scale);
    }
    const symbolScale = nodeSpriteScale(1.9, camera.zoom, 2.5);
    for (const sprite of symbolSpriteById.values()) {
      sprite.scale.set(symbolScale);
    }

    /* Badges are per-file detail, illegible (and unwanted) at overview zoom —
       fade them in only once individual stars are worth reading. Inverse of
       how cluster labels fade OUT on zoom-in (see LabelsOverlay). */
    const badgeAlpha = architectureOverview
      ? 0
      : clamp01((camera.zoom / Math.max(fitZoom, 1e-6) - 0.6) / 0.6);
    for (const sprite of badgeHubSpriteById.values()) sprite.alpha = badgeAlpha;
    for (const sprite of badgeNoteSpriteById.values()) sprite.alpha = badgeAlpha;
    /* Kind dots are the quietest badge tier — cap their presence a touch
       lower so a dense zoomed-in field doesn't read as confetti. */
    for (const sprite of badgeKindSpriteById.values()) sprite.alpha = badgeAlpha * 0.85;
  }

  /** Trace a single import edge as a gentle arc onto `gfx`. Import edges bow
      (structural relationships flow) to visually distinguish them from the
      crisp straight lines used for explicit symbol relations and the dashed
      lines used for annotations — and so a dense hub reads as legible strands
      instead of a laser burst through one point. */
  function traceEdgeArc(gfx: Graphics, from: Point, to: Point): void {
    const control = edgeControlPoint(from, to);
    gfx.moveTo(from.x, from.y);
    gfx.quadraticCurveTo(control.x, control.y, to.x, to.y);
  }

  function drawEdges(): void {
    if (!view) return;
    const display = view.display;
    edgeGfx.clear();
    clusterEdgeGfx.clear();
    visibleServiceRelationshipBundles = [];
    serviceBundlesByNodeId.clear();

    /* Import adjacency for the activity shimmer, rebuilt whenever edges are
       redrawn (i.e. on structure change). Independent of display toggles. */
    importIncidentById.clear();
    displayImportEdgeCount = 0;
    const addIncident = (node: string, other: string, thisIsFrom: boolean): void => {
      const list = importIncidentById.get(node);
      if (list) list.push({ other, thisIsFrom });
      else importIncidentById.set(node, [{ other, thisIsFrom }]);
    };
    for (const edge of view.displayEdges) {
      if (edge.kind !== "import") continue;
      displayImportEdgeCount += 1;
      addIncident(edge.from, edge.to, true);
      addIncident(edge.to, edge.from, false);
    }

    /* The same filter that ghosts stars must also project topology. Otherwise
       a bundled overview can leave routes terminating in filtered context and
       its adaptive threshold reports the wrong density. Keep the full import
       adjacency above for focus/activity lookup; only the static projection is
       narrowed here. */
    const topologyNodes = visibleIds
      ? view.displayNodes.filter((node) => visibleIds!.has(node.id))
      : view.displayNodes;
    const topologyEdges = visibleIds
      ? view.displayEdges.filter((edge) => visibleIds!.has(edge.from) && visibleIds!.has(edge.to))
      : view.displayEdges;
    displayTopologyNodeCount = topologyNodes.length;

    const edgeVisible = (kind: string): boolean => {
      if (kind === "import") return display.showImports;
      if (kind === "api") return display.showApi;
      if (kind === "event") return display.showEvents;
      if (kind === "data") return display.showData;
      if (kind === "config") return display.showConfig;
      return false;
    };
    let availableServiceBundles: ServiceRelationshipBundle[] = [];
    if (display.lens === "services") {
      availableServiceBundles = serviceRelationshipBundles(view.displayNodes, view.displayEdges)
        .filter((bundle) => edgeVisible(bundle.kind))
        .filter((bundle) => !visibleIds || (visibleIds.has(bundle.from) && visibleIds.has(bundle.to)));
      for (const bundle of availableServiceBundles) {
        const from = serviceBundlesByNodeId.get(bundle.from);
        if (from) from.push(bundle);
        else serviceBundlesByNodeId.set(bundle.from, [bundle]);
        const to = serviceBundlesByNodeId.get(bundle.to);
        if (to) to.push(bundle);
        else serviceBundlesByNodeId.set(bundle.to, [bundle]);
      }
    }
    displayTopologyEdgeCount = display.lens === "services"
      ? availableServiceBundles.length
      : topologyEdges.reduce((count, edge) => count + (edge.kind === "import" ? 1 : 0), 0);

    const strategy = currentEdgeRenderStrategy();
    lastEdgeRenderStrategy = strategy;
    const showSelectedOnly = strategy === "selected";
    if (display.lens === "services" && strategy !== "off") {
      const selected = view.selectedNodeId;
      const selectedBundles = availableServiceBundles
        .filter((bundle) => !showSelectedOnly || bundle.from === selected || bundle.to === selected)
      visibleServiceRelationshipBundles = strategy === "bundled"
        ? serviceRelationshipBackbone(selectedBundles)
        : selectedBundles;
      for (const bundle of visibleServiceRelationshipBundles) {
        const from = nodeById.get(bundle.from);
        const to = nodeById.get(bundle.to);
        if (!from || !to) continue;
        const fromPos = resolvedPosOf(from);
        const toPos = resolvedPosOf(to);
        if (!fromPos || !toPos) continue;
        const strength = clamp01(Math.log1p(bundle.count) / Math.log1p(32));
        const confidence = clamp01(bundle.averageConfidence);
        const focused = bundle.from === focusNodeId() || bundle.to === focusNodeId();
        traceEdgeArc(edgeGfx, fromPos, toPos);
        edgeGfx.stroke({
          width: 1.05 + strength * 1.95 + (focused ? 0.35 : 0),
          color: RELATIONSHIP_EDGE_COLORS[bundle.kind] ?? IMPORT_EDGE_COLOR,
          alpha: Math.min(0.92, 0.16 + confidence * 0.62 + (focused ? 0.12 : 0)),
          pixelLine: true,
        });
      }
    } else if (strategy === "raw" || strategy === "selected") {
      let hasImportStroke = false;
      /* Relationship edges are deferred and stroked individually *after* the
         batched import stroke commits: a Graphics.stroke() strokes everything
         accumulated since the previous fill/stroke, so styling a relationship
         edge mid-loop would also sweep up every import arc buffered so far and
         tint it in that relationship's color. */
      const deferredRelationships: GraphEdge[] = [];
      for (const edge of view.displayEdges) {
        if (!edgeVisible(edge.kind)) continue;
        if (showSelectedOnly && edge.from !== view.selectedNodeId && edge.to !== view.selectedNodeId) continue;
        /* Don't wire ghosts: an edge into a filtered-out star only re-clutters
           what the filter just cleared. */
        if (visibleIds && (!visibleIds.has(edge.from) || !visibleIds.has(edge.to))) continue;
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        if (isRelationshipEdge(edge)) {
          deferredRelationships.push(edge);
          continue;
        }
        const fromPos = resolvedPosOf(from);
        const toPos = resolvedPosOf(to);
        if (!fromPos || !toPos) continue;
        traceEdgeArc(edgeGfx, fromPos, toPos);
        if (edge.kind === "import") hasImportStroke = true;
      }
    /* Stroke at a moderate base alpha; the layer's container alpha is driven
       by zoom each frame (dimmer at overview, richer zoomed-in). Kept well
       under 1 even here — a well-connected hub file can put hundreds of
       these strokes through the same handful of pixels, and normal alpha
       blending saturates toward fully opaque the more of them overlap
       regardless of how low any single one is, so the ceiling has to come
       from here, not just the container multiplier. */
    if (hasImportStroke) edgeGfx.stroke({ width: 1, color: IMPORT_EDGE_COLOR, alpha: 0.5, pixelLine: true });
    for (const edge of deferredRelationships) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const fromPos = resolvedPosOf(from);
      const toPos = resolvedPosOf(to);
      if (!fromPos || !toPos) continue;
      traceEdgeArc(edgeGfx, fromPos, toPos);
      const focused = edge.from === focusNodeId() || edge.to === focusNodeId();
      edgeGfx.stroke(relationshipStroke(edge, focused));
    }
    } else if (display.showImports && strategy === "bundled") {
      for (const edge of clusterBackboneEdges(topologyNodes, topologyEdges)) {
        const strength = clamp01(Math.log1p(edge.count) / Math.log1p(32));
        traceEdgeArc(clusterEdgeGfx, { x: edge.fromX, y: edge.fromY }, { x: edge.toX, y: edge.toY });
        clusterEdgeGfx.stroke({
          width: 0.9 + strength * 2.1,
          color: IMPORT_EDGE_COLOR,
          alpha: 0.2 + strength * 0.42,
          pixelLine: true,
        });
      }
    }

    /* Spotlight the focused node's own arcs, bright, on a layer that ignores
       the zoom fade. Keyed on hover-or-selection so it also lights up as the
       pointer moves. */
    drawFocusEdges();
    drawFocusRing();
    drawStructuralHighlights();

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

      /* Batch symbol-relation edges by relation so each family (references,
         calls, inheritance) reads as its own colored strand — one stroke per
         color, not per edge, so a hub stays cheap. */
      const byRelation = new Map<SymbolRelation, Array<{ from: Point; to: Point }>>();
      for (const expansion of Object.values(view.symbolsByPath)) {
        for (const edge of expansion.edges) {
          const from = symbolPositionById.get(edge.from);
          if (!from) continue;
          const toSymbol = edge.toSymbol ? symbolPositionById.get(edge.toSymbol) : undefined;
          const to = toSymbol ?? nodeById.get(edge.toPath);
          if (!to) continue;
          const relation = edge.relation ?? "reference";
          const list = byRelation.get(relation);
          if (list) list.push({ from, to });
          else byRelation.set(relation, [{ from, to }]);
        }
      }
      for (const [relation, list] of byRelation) {
        for (const { from, to } of list) {
          relationGfx.moveTo(from.x, from.y);
          relationGfx.lineTo(to.x, to.y);
        }
        relationGfx.stroke({ width: 1.55, color: SYMBOL_RELATION_COLORS[relation], alpha: 0.55, pixelLine: true });
      }
    }

    annotationGfx.clear();
    if (view.display.showAnnotations) for (const annotation of view.annotations) {
      if (annotation.scope === "node" || !annotation.to) continue; // single-file notes don't draw a line
      if (showSelectedOnly && annotation.from !== view.selectedNodeId && annotation.to !== view.selectedNodeId) continue;
      const from = nodeById.get(annotation.from);
      const to = nodeById.get(annotation.to);
      if (!from || !to) continue;
      const fromPos = resolvedPosOf(from);
      const toPos = resolvedPosOf(to);
      if (!fromPos || !toPos) continue;
      drawDashedLine(annotationGfx, fromPos.x, fromPos.y, toPos.x, toPos.y, 7, 5);
    }
    annotationGfx.stroke({ width: 1.8, color: ANNOTATION_COLOR, alpha: 0.68, pixelLine: true });
  }

  /** Cross-project cycle warnings (dashed, on cross-neighborhood import edges
      whose neighborhoods participate in a cycle) and cul-de-sac bridge-edge
      highlights (the sole connection into a pocket subgraph) — both opt-in,
      off by default, drawn on their own layer so they never compete with the
      normal edge palette. A collapsed cluster super-node carries no
      `neighborhood`/original edge id, so both highlights simply go quiet for
      anything currently folded into a cluster rather than mis-highlighting —
      the same graceful-degradation spirit as the rest of this renderer. */
  function drawStructuralHighlights(): void {
    structuralGfx.clear();
    if (!view) return;
    const showCycles = view.display.showCycles && view.cyclicNeighborhoodPairs.length > 0;
    const showBridges = view.display.showCulDeSacs && view.bridgeEdgeIds.length > 0;
    if (!showCycles && !showBridges) return;

    if (showCycles) {
      const cyclicPairKeys = new Set(
        view.cyclicNeighborhoodPairs.map(([a, b]) => (a < b ? `${a} ${b}` : `${b} ${a}`)),
      );
      let drewCycle = false;
      for (const edge of view.displayEdges) {
        if (edge.kind !== "import") continue;
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from?.neighborhood || !to?.neighborhood || from.neighborhood === to.neighborhood) continue;
        const key = from.neighborhood < to.neighborhood
          ? `${from.neighborhood} ${to.neighborhood}`
          : `${to.neighborhood} ${from.neighborhood}`;
        if (!cyclicPairKeys.has(key)) continue;
        const fromPos = resolvedPosOf(from);
        const toPos = resolvedPosOf(to);
        if (!fromPos || !toPos) continue;
        drawDashedLine(structuralGfx, fromPos.x, fromPos.y, toPos.x, toPos.y, 6, 4);
        drewCycle = true;
      }
      if (drewCycle) structuralGfx.stroke({ width: 2, color: CYCLE_WARNING_COLOR, alpha: 0.85, pixelLine: true });
    }

    if (showBridges) {
      const bridgeIds = new Set(view.bridgeEdgeIds);
      let drewBridge = false;
      for (const edge of view.displayEdges) {
        if (!bridgeIds.has(edge.id)) continue;
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        const fromPos = resolvedPosOf(from);
        const toPos = resolvedPosOf(to);
        if (!fromPos || !toPos) continue;
        structuralGfx.moveTo(fromPos.x, fromPos.y);
        structuralGfx.lineTo(toPos.x, toPos.y);
        drewBridge = true;
      }
      if (drewBridge) structuralGfx.stroke({ width: 2.4, color: BRIDGE_EDGE_COLOR, alpha: 0.8, pixelLine: true });
    }
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
      folder clusters plus two parallax starfield layers sized to the world.
      Dense architecture overviews suppress almost all decorative points: at
      that scale every mark must earn its place, and fake stars are otherwise
      indistinguishable from real files. */
  function drawBackground(): void {
    if (!view) return;
    nebulaGfx.clear();
    starsFarGfx.clear();
    starsMidGfx.clear();
    if (view.displayNodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const clusterAgg = new Map<string, { sx: number; sy: number; count: number }>();
    for (const node of view.displayNodes) {
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

    const analyticalOverview = lastEdgeRenderStrategy === "bundled"
      || view.displayNodes.length >= 1_200
      || displayImportEdgeCount >= 1_500;

    /* Nebulae: one soft additive glow per major cluster, in its folder hue. */
    const majors = [...clusterAgg.entries()]
      .filter(([, agg]) => agg.count >= 5)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, analyticalOverview ? 3 : 7);
    for (const [dir, agg] of majors) {
      const cx = agg.sx / agg.count;
      const cy = agg.sy / agg.count;
      const spread = 24 * Math.sqrt(agg.count);
      const color = folderColor(dir);
      /* Quadruple the old ring count (step 1 → 0.25) for a smoother falloff,
         with per-ring alpha divided by the same factor so the accumulated
         (over-compositing) brightness at any given radius is unchanged —
         more, thinner steps read as a continuous gradient instead of ~5
         visible bands, without the nebula getting any brighter overall. */
      for (let ring = 5; ring >= 0.25; ring -= 0.25) {
        const t = ring / 5;
        const densityDim = analyticalOverview ? 0.38 : 1;
        nebulaGfx.circle(cx, cy, spread * (0.7 + 1.5 * t)).fill({ color, alpha: ((0.014 + 0.02 * (1 - t)) / 4) * densityDim });
      }
    }

    /* Starfields: ordinary maps keep the atmospheric layer; analysis-scale
       maps retain only a few extremely quiet depth markers. */
    const span = (maxX - minX) + (maxY - minY);
    const starCount = analyticalOverview
      ? Math.min(72, Math.max(24, Math.round(span / 80)))
      : Math.min(800, Math.max(260, Math.round(span / 8)));
    const starAlpha = analyticalOverview ? 0.35 : 1;
    const padX = (maxX - minX) * 0.35 + 200;
    const padY = (maxY - minY) * 0.35 + 200;
    const farRandom = seededRandomForStarfield(view.nodes.length);
    const farCount = Math.round(starCount * 0.55);
    for (let i = 0; i < farCount; i += 1) {
      const x = minX - padX + farRandom() * (maxX - minX + padX * 2);
      const y = minY - padY + farRandom() * (maxY - minY + padY * 2);
      starsFarGfx.circle(x, y, farRandom() * 1.4 + 0.4).fill({ color: 0xaab4d4, alpha: (0.06 + farRandom() * 0.1) * starAlpha });
    }
    const midRandom = seededRandomForStarfield(view.nodes.length + 7919);
    for (let i = 0; i < starCount - farCount; i += 1) {
      const x = minX - padX + midRandom() * (maxX - minX + padX * 2);
      const y = minY - padY + midRandom() * (maxY - minY + padY * 2);
      starsMidGfx.circle(x, y, midRandom() * 1.0 + 0.3).fill({ color: 0xc4d2f0, alpha: (0.05 + midRandom() * 0.09) * starAlpha });
    }
  }

  /** Trace a smoothed closed border through `points` (already padded/ordered)
      by quadratic-curving through each vertex via the midpoints of its
      adjacent edges — reads as a soft irregular boundary, not a rigid
      polygon, matching the sci-fi "sector" look rather than a UI panel. */
  function drawRoundedPolygon(gfx: Graphics, points: HullPoint[]): void {
    if (points.length < 3) return;
    const mid = (a: HullPoint, b: HullPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(points[points.length - 1]!, points[0]!);
    gfx.moveTo(start.x, start.y);
    for (let i = 0; i < points.length; i += 1) {
      const curr = points[i]!;
      const next = points[(i + 1) % points.length]!;
      const m = mid(curr, next);
      gfx.quadraticCurveTo(curr.x, curr.y, m.x, m.y);
    }
    gfx.closePath();
  }

  const ZONE_MIN_MEMBERS_FOR_HULL = 3;
  const ZONE_MAX_ZONES = 7;
  const ZONE_PADDING_BASE = 36;

  /** Neighborhood (codebase-territory) hulls: one coarse, faint hull per
      codebase, on its own layer so its alpha can be driven independently of
      the per-cluster zones (see applyCameraTransform's semantic-zoom
      handling). Present only when the host territorialized the layout
      (node.neighborhood set); otherwise this loop is empty, territorialActive
      stays false, and nothing about the semantic-zoom feature ever engages. */
  function drawNeighborhoodZones(): void {
    neighborhoodZoneGfx.clear();
    if (!view) {
      territorialActive = false;
      return;
    }
    const byNeighborhood = new Map<string, HullPoint[]>();
    for (const node of view.displayNodes) {
      const nb = node.neighborhood;
      if (!nb) continue;
      const list = byNeighborhood.get(nb);
      if (list) list.push({ x: node.x, y: node.y });
      else byNeighborhood.set(nb, [{ x: node.x, y: node.y }]);
    }
    territorialActive = byNeighborhood.size >= 2;
    for (const [nb, points] of byNeighborhood) {
      if (points.length < ZONE_MIN_MEMBERS_FOR_HULL) continue;
      const color = folderColor(nb);
      const padding = ZONE_PADDING_BASE * 2 + Math.sqrt(points.length) * 5;
      drawRoundedPolygon(neighborhoodZoneGfx, paddedHull(points, padding));
      neighborhoodZoneGfx.fill({ color, alpha: 0.02 }).stroke({ width: 1.1, color, alpha: 0.2 });
    }
  }

  /** "Territory zones" — a bordered, low-alpha region per major folder
      cluster, so the map reads as sectors of a star chart rather than an
      unexplained scatter of nebula haze. Capped and recomputed only on
      structure change, same discipline as drawBackground(); overlapping
      zones are left as-is (additive blend brightens contested space instead
      of fighting over a boundary) rather than attempting clipping. */
  function drawTerritoryZones(): void {
    zoneGfx.clear();
    if (!view) return;

    const byCluster = new Map<string, HullPoint[]>();
    for (const node of view.displayNodes) {
      const list = byCluster.get(node.dir);
      if (list) list.push({ x: node.x, y: node.y });
      else byCluster.set(node.dir, [{ x: node.x, y: node.y }]);
    }

    const zones = [...byCluster.entries()]
      .filter(([, points]) => points.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, ZONE_MAX_ZONES);

    for (const [dir, points] of zones) {
      const color = folderColor(dir);
      if (points.length < ZONE_MIN_MEMBERS_FOR_HULL) {
        /* Two-member cluster: a hull is degenerate, draw a padded circle instead. */
        const [p0, p1] = points as [HullPoint, HullPoint];
        const cx = (p0.x + p1.x) / 2;
        const cy = (p0.y + p1.y) / 2;
        const r = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2 + ZONE_PADDING_BASE;
        zoneGfx.circle(cx, cy, r).fill({ color, alpha: 0.03 }).stroke({ width: 1.4, color, alpha: 0.32 });
        continue;
      }
      const padding = ZONE_PADDING_BASE + Math.sqrt(points.length) * 4;
      const hull = paddedHull(points, padding);
      drawRoundedPolygon(zoneGfx, hull);
      zoneGfx.fill({ color, alpha: 0.03 }).stroke({ width: 1.4, color, alpha: 0.32 });
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
    applyEdgeAlpha();
    /* Semantic zoom: as the map collapses toward territory silhouettes at
       extreme zoom-out, the coarse neighborhood hull brightens (>1 alpha is
       deliberate — both layers use additive blending, so this is a genuine
       brightening headroom, not a clamped no-op) while the finer per-cluster
       zones recede — never fully to 0, matching "ghost, don't remove". Both
       stay untouched (1 / 1) whenever territorialization isn't active, so a
       single-codebase workspace is provably unaffected regardless of zoom. */
    if (territorialActive) {
      const zoomRatio = camera.zoom / Math.max(fitZoom, 1e-6);
      const collapse = territorialCollapseFactor(zoomRatio);
      neighborhoodZoneGfx.alpha = 1 + collapse * 1.5;
      zoneGfx.alpha = Math.max(0.15, 1 - collapse);
    } else {
      neighborhoodZoneGfx.alpha = 1;
      zoneGfx.alpha = 1;
    }
  }

  /** Import-edge layer fades at overview and richens on zoom-in; while a node
      is *selected* the whole layer recedes so the selection's bright arcs read
      as a spotlight through the rest of the graph. Keyed on selection, not
      hover: a global dim that toggled every time the pointer crossed a star
      would flicker. Hover still lights the node's own arcs + ring (a lighter
      touch); committing with a click earns the full spotlight. */
  function applyEdgeAlpha(): void {
    const base = edgeLayerAlpha(camera.zoom / Math.max(fitZoom, 1e-6));
    const dim = view?.selectedNodeId ? 0.4 : 1;
    edgeGfx.alpha = base * dim * edgeReveal;
    clusterEdgeGfx.alpha = base * dim * edgeReveal;
    /* These layers are also drawn at target positions — ride the same reveal
       so nothing stays wired to empty space while stars are in flight. */
    relationGfx.alpha = edgeReveal;
    symbolOrbitGfx.alpha = edgeReveal;
    annotationGfx.alpha = edgeReveal;
    /* Both flow layers stay legible at any zoom (like relationGfx) rather than
       fading at overview like the bulk import graph — distinct, already-sparse
       analytical layers, not something that needs decluttering. */
    relationshipFlowGfx.alpha = edgeReveal;
    symbolRelationFlowGfx.alpha = edgeReveal;
  }

  /** The node the UI is currently focusing: a live hover wins over a sticky
      selection, so moving the mouse re-aims the spotlight instantly. */
  function focusNodeId(): string | null {
    if (!view) return null;
    return view.hoveredNodeId ?? view.selectedNodeId;
  }

  /** A node's on-screen position right now: the animated live position while
      it's flying, its layout target once settled. Dynamic overlays (focus,
      live rings, traces) read this so they track stars in flight. */
  function posOf(node: { id: string; x: number; y: number }): XY {
    return livePosById.get(node.id) ?? node;
  }

  function resolvedPosOf(node: { id: string; x: number; y: number }): XY | null {
    const point = posOf(node);
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }

  /** Bright arcs for the focused node on a layer that ignores the zoom fade —
      the spotlight beam. Cheap: walks only the focused node's incident import
      edges (via importIncidentById), so it can run on every hover change —
      and, when `now` is supplied (per-frame while focused), sends slow pulses
      travelling outward along the arcs so the selection reads as live current
      through the structure rather than a frozen highlight. */
  function drawFocusEdges(now?: number): void {
    selEdgeGfx.clear();
    if (!view || view.display.edgeMode === "off") return;
    const id = focusNodeId();
    const node = id ? nodeById.get(id) : undefined;
    if (!node) return;
    if (view.display.lens === "services") {
      /* The compact overview deliberately renders only a backbone, but the
         service under the cursor must remain fully explainable. Draw its own
         visible typed routes on the focus layer (not the base mesh), using the
         cached endpoint index built in drawEdges so hover stays cheap. */
      const bundles = serviceBundlesByNodeId.get(node.id) ?? [];
      const count = Math.min(bundles.length, 48);
      const pulseCount = Math.min(count, MAX_RELATIONSHIP_FLOW_EDGES);
      const flow = now === undefined || reducedMotion ? 0 : flowPhase(now, FOCUS_FLOW_PERIOD_MS);
      for (let index = 0; index < count; index += 1) {
        const bundle = bundles[index];
        if (!bundle) continue;
        const from = nodeById.get(bundle.from);
        const to = nodeById.get(bundle.to);
        if (!from || !to) continue;
        const a = resolvedPosOf(from);
        const b = resolvedPosOf(to);
        if (!a || !b) continue;
        const color = RELATIONSHIP_EDGE_COLORS[bundle.kind] ?? IMPORT_EDGE_COLOR;
        const strength = clamp01(Math.log1p(bundle.count) / Math.log1p(32));
        const confidence = clamp01(bundle.averageConfidence);
        traceEdgeArc(selEdgeGfx, a, b);
        selEdgeGfx.stroke({
          width: 1.55 + strength * 1.85,
          color,
          alpha: Math.min(0.96, 0.5 + confidence * 0.4),
          pixelLine: true,
        });

        /* A tiny, screen-constant directional chevron retains one-to-many vs
           many-to-one meaning even for reduced-motion users. */
        if (index < 24) {
          const control = edgeControlPoint(a, b);
          const t = 0.82;
          const tip = quadraticPointAt(a, control, b, t);
          const tx = 2 * (1 - t) * (control.x - a.x) + 2 * t * (b.x - control.x);
          const ty = 2 * (1 - t) * (control.y - a.y) + 2 * t * (b.y - control.y);
          const length = Math.hypot(tx, ty);
          if (length > 1e-6) {
            const zoomNow = Math.max(camera.zoom, 1e-6);
            const ux = tx / length;
            const uy = ty / length;
            const px = -uy;
            const py = ux;
            const chevronLength = 5.5 / zoomNow;
            const chevronHalf = 2.6 / zoomNow;
            selEdgeGfx.moveTo(tip.x - ux * chevronLength + px * chevronHalf, tip.y - uy * chevronLength + py * chevronHalf);
            selEdgeGfx.lineTo(tip.x, tip.y);
            selEdgeGfx.lineTo(tip.x - ux * chevronLength - px * chevronHalf, tip.y - uy * chevronLength - py * chevronHalf);
            selEdgeGfx.stroke({ width: 1.45 / zoomNow, color, alpha: 0.86 });
          }
        }

        if (index < pulseCount && now !== undefined && !reducedMotion) {
          const control = edgeControlPoint(a, b);
          const offset = (hashString(bundle.id) % 1000) / 1000;
          const t = (flow + offset) % 1;
          const fade = Math.min(1, t * 6, (1 - t) * 6);
          if (fade > 0.02) {
            const point = quadraticPointAt(a, control, b, t);
            selEdgeGfx.circle(point.x, point.y, 1.7).fill({ color, alpha: 0.22 + fade * 0.58 });
          }
        }
      }
      return;
    }
    if (!view.display.showImports) return;
    const incident = importIncidentById.get(node.id);
    if (!incident) return;
    const highlight = mixColors(folderColor(node.dir), 0xffffff, 0.35);
    const source = resolvedPosOf(node);
    if (!source) return;
    /* Arcs get a generous cap (this now redraws per frame while focused);
       pulses stay tighter — 40 travelling dots already reads as a torrent. */
    const count = Math.min(incident.length, 120);
    const pulseCount = Math.min(incident.length, MAX_ACTIVITY_EDGES_PER_NODE);
    for (let e = 0; e < count; e += 1) {
      const inc = incident[e];
      if (!inc) continue;
      if (visibleIds && !visibleIds.has(inc.other)) continue;
      const other = nodeById.get(inc.other);
      if (!other) continue;
      const otherPos = resolvedPosOf(other);
      if (!otherPos) continue;
      const a = inc.thisIsFrom ? source : otherPos;
      const b = inc.thisIsFrom ? otherPos : source;
      traceEdgeArc(selEdgeGfx, a, b);
    }
    selEdgeGfx.stroke({ width: 1.8, color: highlight, alpha: 0.9, pixelLine: true });

    /* Direction chevrons: a small arrowhead near the target end of each
       spotlight arc, pointing along the arc's tangent — so "who imports whom"
       is legible the moment a node is hovered/selected, not just inferable
       from the pulse direction. Screen-constant size (÷zoom); capped with the
       pulses so a mega-hub stays cheap and uncluttered. */
    const zoomNow = Math.max(camera.zoom, 1e-6);
    const chevLen = 6.5 / zoomNow;
    const chevHalf = 3 / zoomNow;
    let hasChevron = false;
    for (let e = 0; e < pulseCount; e += 1) {
      const inc = incident[e];
      if (!inc) continue;
      if (visibleIds && !visibleIds.has(inc.other)) continue;
      const other = nodeById.get(inc.other);
      if (!other) continue;
      const otherPos = resolvedPosOf(other);
      if (!otherPos) continue;
      const a = inc.thisIsFrom ? source : otherPos;
      const b = inc.thisIsFrom ? otherPos : source;
      const control = edgeControlPoint(a, b);
      const t = 0.82; // just shy of the target star so the head isn't buried in its glow
      const tip = quadraticPointAt(a, control, b, t);
      /* Quadratic Bézier tangent: P'(t) = 2(1−t)(C−A) + 2t(B−C). */
      const tx = 2 * (1 - t) * (control.x - a.x) + 2 * t * (b.x - control.x);
      const ty = 2 * (1 - t) * (control.y - a.y) + 2 * t * (b.y - control.y);
      const tlen = Math.hypot(tx, ty);
      if (tlen < 1e-6) continue;
      const ux = tx / tlen;
      const uy = ty / tlen;
      const px = -uy;
      const py = ux;
      selEdgeGfx.moveTo(tip.x - ux * chevLen + px * chevHalf, tip.y - uy * chevLen + py * chevHalf);
      selEdgeGfx.lineTo(tip.x, tip.y);
      selEdgeGfx.lineTo(tip.x - ux * chevLen - px * chevHalf, tip.y - uy * chevLen - py * chevHalf);
      hasChevron = true;
    }
    if (hasChevron) selEdgeGfx.stroke({ width: 1.6, color: highlight, alpha: 0.85, pixelLine: true });

    /* Spotlight current: one gentle pulse per arc, flowing outward. */
    if (now === undefined || reducedMotion) return;
    const flow = flowPhase(now, FOCUS_FLOW_PERIOD_MS);
    for (let e = 0; e < pulseCount; e += 1) {
      const inc = incident[e];
      if (!inc) continue;
      if (visibleIds && !visibleIds.has(inc.other)) continue;
      const other = nodeById.get(inc.other);
      if (!other) continue;
      const otherPos = resolvedPosOf(other);
      if (!otherPos) continue;
      const a = inc.thisIsFrom ? source : otherPos;
      const b = inc.thisIsFrom ? otherPos : source;
      const control = edgeControlPoint(a, b);
      const offset = (hashString(node.id + "⇢" + inc.other) % 1000) / 1000;
      const travel = (flow + offset) % 1; // 0 → 1 from the focused node outward
      const t = inc.thisIsFrom ? travel : 1 - travel;
      const fade = 1 - travel;
      if (fade <= 0.05) continue;
      const pt = quadraticPointAt(a, control, b, t);
      selEdgeGfx.circle(pt.x, pt.y, 1.6).fill({ color: highlight, alpha: 0.12 + 0.38 * fade });
    }
  }

  /** Ambient directional flow for service-relationship edges (api/event/data/
      config): a small pulse continuously travels from -> to along each
      visible arc, in the relationship's true direction — unlike the import
      spotlight above, this always runs (not just while a node is focused),
      since relationship edges are service-to-service (or capped), never the
      full file-level import graph, so the per-frame cost stays bounded
      regardless of workspace size. Colored per the edge's own kind so the
      flow reinforces the existing color coding rather than adding a new one.
      Respects prefers-reduced-motion like every other pulse in this file. */
  function drawRelationshipFlow(now: number): boolean {
    relationshipFlowGfx.clear();
    if (!view || reducedMotion || view.display.lens !== "services" || visibleServiceRelationshipBundles.length === 0) return false;
    const flow = flowPhase(now, RELATIONSHIP_FLOW_PERIOD_MS);
    let count = 0;
    let drewAny = false;
    for (const bundle of visibleServiceRelationshipBundles) {
      if (count >= MAX_RELATIONSHIP_FLOW_EDGES) break;
      const from = nodeById.get(bundle.from);
      const to = nodeById.get(bundle.to);
      if (!from || !to) continue;
      const a = resolvedPosOf(from);
      const b = resolvedPosOf(to);
      if (!a || !b) continue;
      count += 1;

      const control = edgeControlPoint(a, b);
      const offset = (hashString(bundle.id) % 1000) / 1000;
      const t = (flow + offset) % 1; // 0 -> 1, always a (from) -> b (to): the edge's true direction
      /* Fade in/out near each end so the dot never pops in or out mid-arc. */
      const edgeFade = Math.min(1, t * 6, (1 - t) * 6);
      if (edgeFade <= 0.02) continue;
      const pt = quadraticPointAt(a, control, b, t);
      const color = RELATIONSHIP_EDGE_COLORS[bundle.kind] ?? IMPORT_EDGE_COLOR;
      relationshipFlowGfx.circle(pt.x, pt.y, 1.5).fill({ color, alpha: 0.2 + 0.55 * edgeFade });
      drewAny = true;
    }
    return drewAny;
  }

  /** Ambient directional flow for symbol-relation edges (references/calls/
      implements/extends) — same technique as drawRelationshipFlow, applied to
      the symbol-relation set, which is already small (only currently-expanded
      files, each capped at MAX_EDGES_PER_SYMBOL on the host). These are
      straight lines, not arcs (see relationGfx's own draw), so the pulse
      travels along a plain linear interpolation instead of a quadratic curve. */
  function drawSymbolRelationFlow(now: number): boolean {
    symbolRelationFlowGfx.clear();
    if (!view || reducedMotion || !view.symbolsEnabled || !view.display.showRelations) return false;
    const flow = flowPhase(now, RELATIONSHIP_FLOW_PERIOD_MS);
    let count = 0;
    let drewAny = false;
    for (const [path, expansion] of Object.entries(view.symbolsByPath)) {
      for (const edge of expansion.edges) {
        if (count >= MAX_RELATIONSHIP_FLOW_EDGES) return drewAny;
        const from = symbolPositionById.get(edge.from);
        if (!from) continue;
        const toSymbol = edge.toSymbol ? symbolPositionById.get(edge.toSymbol) : undefined;
        const to = toSymbol ?? nodeById.get(edge.toPath);
        if (!to) continue;
        count += 1;

        const relation = edge.relation ?? "reference";
        const offset = (hashString(`${path}:${edge.from}->${edge.toSymbol ?? edge.toPath}`) % 1000) / 1000;
        const t = (flow + offset) % 1;
        const edgeFade = Math.min(1, t * 6, (1 - t) * 6);
        if (edgeFade <= 0.02) continue;
        const pt = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        symbolRelationFlowGfx.circle(pt.x, pt.y, 1.3).fill({ color: SYMBOL_RELATION_COLORS[relation], alpha: 0.2 + 0.5 * edgeFade });
        drewAny = true;
      }
    }
    return drewAny;
  }

  /** A crisp, non-additive ring around the focused node: a clean "this one"
      affordance that reads clearly without adding to the bloom. Sized in
      screen space (÷zoom) so it stays a constant thickness and margin at any
      zoom, but drawn in world space so it tracks the star under pan/zoom.
      With `now` (per-frame while focused) the ring breathes gently and two
      faint arc accents orbit it — alive, not blinking. */
  function drawFocusRing(now?: number): void {
    focusRingGfx.clear();
    if (!view) return;
    const id = focusNodeId();
    const node = id ? nodeById.get(id) : undefined;
    if (!node) return;
    const zoom = Math.max(camera.zoom, 1e-6);
    const p = resolvedPosOf(node);
    if (!p) return;
    const animate = now !== undefined && !reducedMotion;
    const breathe = animate ? Math.sin(now / 430) : 0;
    const screenR = Math.max(graphNodeRadius(node) * zoom, minimumNodeScreenPx()) + 7 + breathe * 1.3;
    const color = mixColors(folderColor(node.dir), 0xffffff, 0.5);
    focusRingGfx.circle(p.x, p.y, screenR / zoom)
      .stroke({ width: 1.5 / zoom, color, alpha: 0.75 - 0.08 * breathe });
    if (animate) {
      /* Two orbiting arc accents, opposite each other, just outside the ring. */
      const orbitR = (screenR + 4.5) / zoom;
      const phase = (now / 1300) % (Math.PI * 2);
      const span = 0.9; // radians
      for (const offset of [0, Math.PI]) {
        focusRingGfx.arc(p.x, p.y, orbitR, phase + offset, phase + offset + span)
          .stroke({ width: 1 / zoom, color, alpha: 0.35 });
      }
    }
  }

  /** Refresh both focus overlays + the spotlight dim together. */
  function refreshFocus(): void {
    drawFocusEdges();
    drawFocusRing();
    applyEdgeAlpha();
  }

  /** The per-frame motion heart: eases every star's alpha (filter/select/
      search fades), position (fly to layout targets — cluster expansion blooms
      files outward), and scale (birth pop + hover spring), then lays the
      ambient twinkle on top. Also dips the static edge layers while stars are
      in flight (they're drawn at target positions). Single loop over sprites;
      returns true while anything is still settling so the ticker stays awake
      under reduced motion's otherwise-idle loop. */
  function motionPass(now: number): boolean {
    if (!view) return false;
    let settling = false;
    let positionsSettling = false;
    const hoveredId = view.hoveredNodeId;
    /* Position snap threshold ~1/3 px on screen, expressed in world units. */
    const posEpsilon = 0.35 / Math.max(camera.zoom, 1e-6);
    /* Semantic zoom: computed once per frame (not per sprite) — see
       applyCameraTransform for the matching hull-alpha side of this fade. */
    const collapse = territorialActive ? territorialCollapseFactor(camera.zoom / Math.max(fitZoom, 1e-6)) : 0;
    for (const [id, sprite] of spriteById) {
      const node = nodeById.get(id);

      /* Alpha — eased emphasis + twinkle, additionally dimmed toward
         GHOST_ALPHA as the map collapses to territory silhouettes (only for
         nodes that belong to a neighborhood; collapse is 0 whenever
         territorialization is inactive, so this is a no-op otherwise). */
      const rawTarget = baseAlphaById.get(id);
      if (rawTarget !== undefined) {
        const targetAlpha = collapse > 0 && node?.neighborhood
          ? rawTarget + (GHOST_ALPHA - rawTarget) * collapse
          : rawTarget;
        let live = liveAlphaById.get(id) ?? targetAlpha;
        if (reducedMotion) {
          live = targetAlpha;
        } else {
          live = approach(live, targetAlpha, EMPHASIS_EASE, 0.004);
          if (live !== targetAlpha) settling = true;
        }
        liveAlphaById.set(id, live);
        const tw = reducedMotion ? 1 : twinkleFactor(twinkleSeedById.get(id) ?? 1, now);
        sprite.alpha = Math.min(1, live * tw);
      }

      /* Position — glide to the layout target. */
      if (node) {
        if (reducedMotion) {
          sprite.position.set(node.x, node.y);
          livePosById.set(id, { x: node.x, y: node.y });
        } else {
          const current = livePosById.get(id) ?? { x: node.x, y: node.y };
          const { point, settled } = approachPoint(current, node, POS_EASE, posEpsilon);
          if (!settled) {
            settling = true;
            positionsSettling = true;
          }
          livePosById.set(id, point);
          sprite.position.set(point.x, point.y);
        }
      }

      /* Scale — base target × birth pop × eased hover spring. */
      const base = baseScaleById.get(id);
      if (base !== undefined) {
        let mult = 1;
        if (!reducedMotion) {
          const birth = birthAtById.get(id);
          if (birth !== undefined) {
            const t = (now - birth) / BIRTH_MS;
            if (t >= 1) {
              birthAtById.delete(id);
            } else {
              mult *= 0.2 + 0.8 * easeOutCubic(t);
              settling = true;
            }
          }
          const hoverTarget = id === hoveredId ? 1 : 0;
          let level = hoverLevelById.get(id) ?? 0;
          level = approach(level, hoverTarget, HOVER_EASE, 0.02);
          if (level > 0) {
            hoverLevelById.set(id, level);
            if (level !== hoverTarget) settling = true;
          } else {
            hoverLevelById.delete(id);
          }
          mult *= 1 + (HOVER_POP - 1) * level;
        } else if (id === hoveredId) {
          mult = HOVER_POP;
        }
        sprite.scale.set(base * mult);
      }
    }

    /* Edge reveal: recede while the field is morphing, breathe back after. */
    const revealTarget = positionsSettling ? EDGE_REVEAL_DIM : 1;
    const nextReveal = reducedMotion ? revealTarget : approach(edgeReveal, revealTarget, EDGE_REVEAL_EASE, 0.01);
    if (nextReveal !== edgeReveal) {
      edgeReveal = nextReveal;
      applyEdgeAlpha();
      if (edgeReveal !== revealTarget) settling = true;
    }
    return settling;
  }

  /** Subtle "this file is live" shimmer: for each recently-touched file, softly
      tint its import connections in the activity color and send a couple of
      pulses flowing outward along them. Rides the same arc geometry the static
      edges are drawn with, so it reads as energy moving through the real
      structure rather than a separate overlay. Draws onto traceGfx (already
      cleared by animateTraces); skipped entirely when edges are muted. */
  function drawActivityFlow(litNodes: Array<{ path: string; heat: number; kind: TraceKind; laneId: string | null }>, now: number): void {
    if (!view || view.display.edgeMode === "off" || litNodes.length === 0) return;
    const flow = flowPhase(now, ACTIVITY_FLOW_PERIOD_MS);
    for (const lit of litNodes) {
      const sourceNode = nodeById.get(lit.path);
      const incident = importIncidentById.get(lit.path);
      if (!sourceNode || !incident) continue;
      const source = resolvedPosOf(sourceNode);
      if (!source) continue;
      const color = activityColor(lit.kind, lit.laneId);
      const heatFrac = Math.min(1, lit.heat / HEAT_CAP);
      const count = Math.min(incident.length, MAX_ACTIVITY_EDGES_PER_NODE);

      /* One faint tint stroke for all of this node's connections (shared
         color/alpha — batched so a hub is one stroke, not forty). */
      for (let e = 0; e < count; e += 1) {
        const inc = incident[e];
        const other = inc && nodeById.get(inc.other);
        if (!inc || !other) continue;
        const otherPos = resolvedPosOf(other);
        if (!otherPos) continue;
        const a = inc.thisIsFrom ? source : otherPos;
        const b = inc.thisIsFrom ? otherPos : source;
        const control = edgeControlPoint(a, b);
        traceGfx.moveTo(a.x, a.y);
        traceGfx.quadraticCurveTo(control.x, control.y, b.x, b.y);
      }
      traceGfx.stroke({ width: 1, color, alpha: 0.05 + 0.13 * heatFrac, pixelLine: true });

      /* Pulses flowing outward from the touched file, brightest at the source
         and fading as they travel — one fill each (few per edge). */
      for (let e = 0; e < count; e += 1) {
        const inc = incident[e];
        const other = inc && nodeById.get(inc.other);
        if (!inc || !other) continue;
        const otherPos = resolvedPosOf(other);
        if (!otherPos) continue;
        const a = inc.thisIsFrom ? source : otherPos;
        const b = inc.thisIsFrom ? otherPos : source;
        const control = edgeControlPoint(a, b);
        /* Per-edge phase offset so connections don't pulse in lockstep. */
        const offset = (hashString(lit.path + "→" + inc.other) % 1000) / 1000;
        for (let p = 0; p < ACTIVITY_PULSES_PER_EDGE; p += 1) {
          const travel = (flow + offset + p / ACTIVITY_PULSES_PER_EDGE) % 1; // 0→1 from source
          const t = inc.thisIsFrom ? travel : 1 - travel; // source end → other end along the arc
          const fade = (1 - travel) * heatFrac;
          if (fade <= 0.03) continue;
          const pt = quadraticPointAt(a, control, b, t);
          traceGfx.circle(pt.x, pt.y, 1.8).fill({ color, alpha: Math.min(0.85, 0.2 + 0.6 * fade) });
        }
      }
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
    const litNodes: Array<{ path: string; heat: number; kind: TraceKind; laneId: string | null }> = [];
    for (const path of activePaths) {
      const node = nodeById.get(path);
      const sprite = spriteById.get(path);
      if (!node || !sprite) continue;
      const heat = heatAt(events, path, now, fadeMs);
      const pulse = pulseAt(events, path, now);
      const kind = dominantKind(events, path, now, fadeMs);
      const laneId = dominantLaneId(events, path, now, fadeMs);
      const baseColor = baseTintById.get(path) ?? folderColor(node.dir);
      sprite.tint = kind ? mixColors(baseColor, activityColor(kind, laneId), Math.min(1, heat / HEAT_CAP + pulse * 0.5)) : baseColor;
      const baseScale = baseScaleById.get(path) ?? nodeSpriteScale(graphNodeRadius(node), camera.zoom, minimumNodeScreenPx());
      sprite.scale.set(baseScale * (1 + pulse * 0.6 + (heat / HEAT_CAP) * 0.15));
      if (pulse > 0 || heat > 0.02) {
        const base = liveAlphaById.get(path) ?? baseAlphaById.get(path) ?? 0.6;
        sprite.alpha = Math.min(1, base + pulse * 0.6 + (heat / HEAT_CAP) * 0.3);
      }
      if (kind && heat >= ACTIVITY_HEAT_MIN) litNodes.push({ path, heat, kind, laneId });
    }

    drawActivityFlow(litNodes, now);

    /* Directional streaks with comet heads between consecutively-touched files. */
    for (const edge of traceEdges) {
      const alpha = traceEdgeAlpha(edge, now, fadeMs);
      if (alpha <= 0.01) continue;
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!fromNode || !toNode) continue;
      const from = resolvedPosOf(fromNode);
      const to = resolvedPosOf(toNode);
      if (!from || !to) continue;
      const color = activityColor(edge.kind, edge.laneId);
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

  /** Live "agent working here now" rings on the files of in-flight tool calls
      (distinct from the fading trace trail — these persist until the tool
      completes). A steady pulse plus an outward sonar ring reads as active
      presence; under prefers-reduced-motion it's a single static ring.
      Returns whether it wants the ticker kept alive to keep pulsing. */
  function drawLiveActivity(now: number): boolean {
    liveGfx.clear();
    if (!view || view.liveActivity.length === 0) return false;
    const zoom = Math.max(camera.zoom, 1e-6);
    const pulse = reducedMotion ? 0 : (Math.sin(now / 260) + 1) / 2; // 0..1
    for (const live of view.liveActivity) {
      const node = nodeById.get(live.path);
      if (!node) continue;
      const p = resolvedPosOf(node);
      if (!p) continue;
      const color = activityColor(live.kind, live.laneId);
      const baseScreenR = Math.max(graphNodeRadius(node) * zoom, minimumNodeScreenPx()) + 5;
      /* Core ring: breathes gently. */
      liveGfx.circle(p.x, p.y, (baseScreenR + pulse * 4) / zoom)
        .stroke({ width: 2 / zoom, color, alpha: 0.85 - pulse * 0.35 });
      /* Sonar: a fainter ring expanding outward, fading as it grows. */
      if (!reducedMotion) {
        liveGfx.circle(p.x, p.y, (baseScreenR + pulse * 13) / zoom)
          .stroke({ width: 1 / zoom, color, alpha: 0.3 * (1 - pulse) });
      }
    }
    return !reducedMotion;
  }

  function frame(): void {
    if (destroyed || !view) return;
    const now = Date.now();
    if (stateDirty) {
      rebuildNodes();
      /* edgePresentation is relative to fit zoom, so establish the current
         graph's reference frame before its first/state-change edge draw. */
      recomputeZoomBounds();
      drawEdges();
      drawBackground();
      drawNeighborhoodZones();
      drawTerritoryZones();
      cameraDirty = true;
      stateDirty = false;
      if (view.displayNodes.length > 0 && cameraTouched && hasValidFit && !cameraSeesNodes(view.displayNodes)) {
        /* Content moved out from under an already-positioned camera (e.g. a
           big re-index reshaped the layout) — fly back rather than leave the
           user looking at empty space. */
        animateTo(zoomToFit(view.displayNodes, viewport()));
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
      redrawEdgesForStrategyChange();
      applyCameraTransform();
      applyNodeScales();
      drawFocusRing(); /* screen-constant sizing depends on zoom — resize with it */
      callbacks.onCameraChange(camera);
      cameraDirty = false;
    }
    const motionSettling = motionPass(now);
    /* Ambient relationship + symbol-relation flow runs every frame regardless
       of focus — see each function's own doc comment for why this is safe to
       leave unconditional (both sets are already bounded independent of
       workspace size). */
    const relationshipFlowAnimating = drawRelationshipFlow(now);
    const symbolRelationFlowAnimating = drawSymbolRelationFlow(now);
    /* Living focus: while a node is hovered/selected, the ring breathes and
       the spotlight carries current — redrawn per frame (cheap: incident
       edges only). Static under reduced motion (drawn by refreshFocus). */
    if (!reducedMotion && focusNodeId()) {
      drawFocusEdges(now);
      drawFocusRing(now);
    }
    const tracesAnimating = animateTraces(now);
    const liveAnimating = drawLiveActivity(now);
    const animating = tracesAnimating || liveAnimating || motionSettling || relationshipFlowAnimating || symbolRelationFlowAnimating;
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
    badgeDotTexture = makeBadgeDotTexture(app);
    badgeRingTexture = makeBadgeRingTexture(app);
    nebulaGfx.blendMode = "add";
    zoneGfx.blendMode = "add";
    neighborhoodZoneGfx.blendMode = "add";
    /* Flow pulses read as traveling sparks of light (consistent with every
       other "glowing" layer — nodes, nebula, zones) rather than flat matte
       dots; the static edge lines and warning highlights stay normal-blend
       on purpose, since a diagnostic signal should stay crisp and legible,
       not blur into decoration. */
    relationshipFlowGfx.blendMode = "add";
    symbolRelationFlowGfx.blendMode = "add";
    bgFarLayer.addChild(nebulaGfx, starsFarGfx);
    bgMidLayer.addChild(starsMidGfx);
    world.addChild(neighborhoodZoneGfx, zoneGfx, clusterEdgeGfx, edgeGfx, structuralGfx, relationshipFlowGfx, selEdgeGfx, relationGfx, symbolRelationFlowGfx, annotationGfx, traceGfx, symbolOrbitGfx, nodeLayer, symbolLayer, focusRingGfx, liveGfx);
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
    /* No WebGL, a CSP restriction pixi couldn't work around, or some other
       init-time failure. Leave a readable trace instead of a silent dead
       canvas. */
    console.error("Codebase Map renderer failed to initialize:", err);
    callbacks.onInitError?.(err instanceof Error ? err.message : String(err));
  });

  return {
    setState(next: GraphViewState): void {
      const structureChanged =
        !view
        || view.displayNodes !== next.displayNodes
        || view.displayEdges !== next.displayEdges
        || view.annotations !== next.annotations
        || view.symbolsByPath !== next.symbolsByPath
        || view.symbolsEnabled !== next.symbolsEnabled
        || view.display !== next.display
        || view.filter !== next.filter
        || view.search !== next.search
        || view.selectedNodeId !== next.selectedNodeId;
      const hoverChanged = !view || view.hoveredNodeId !== next.hoveredNodeId;
      const hadNoNodes = !view || view.displayNodes.length === 0;
      if (view && view.traces !== next.traces) {
        traceEdges = deriveTraceEdges(next.traces);
      }
      view = next;
      if (structureChanged) stateDirty = true;
      if (hoverChanged && !structureChanged) {
        /* Hover only needs emphasis + scale + focus overlays, not a full
           rebuild — this is what makes the spotlight track the pointer. */
        applyEmphasis();
        applyNodeScales();
        refreshFocus();
      }
      if (hadNoNodes && next.displayNodes.length > 0) {
        hasValidFit = false; /* fresh data: (re)fit once, same as first load */
        if (cameraTouched && !cameraSeesNodes(next.displayNodes)) cameraTouched = false;
        autoFitIfUntouched();
      }
      requestRender();
    },
    zoomToFitAll(): void {
      if (!view || view.displayNodes.length === 0) return;
      const points = view.symbolsEnabled
        ? [...view.displayNodes, ...positionedSymbols(view.displayNodes, view.symbolsByPath)]
        : view.displayNodes;
      const fit = zoomToFit(points, viewport());
      minZoom = Math.min(minZoom, fit.zoom * 0.5);
      animateTo(fit);
    },
    focusNode(id: string): void {
      if (!view) return;
      const node = nodeById.get(id) ?? view.displayNodes.find((n) => n.id === id);
      if (!node) return;
      /* Zoom to a readable neighborhood level — enough to pick the star out of
         its cluster on a huge map, but not slammed to max on a small one — and
         never yank a user who is already zoomed in further back out. */
      animateTo(frameNode(node, camera.zoom, focusZoomFor(fitZoom), minZoom));
    },
    focusWorld(x: number, y: number): void {
      animateTo({ cx: x, cy: y, zoom: camera.zoom });
    },
    flyTo(target: Camera): void {
      animateTo(target);
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
      badgeHubSpriteById.clear();
      badgeNoteSpriteById.clear();
      badgeKindSpriteById.clear();
      symbolSpriteById.clear();
      nodeById.clear();
      symbolPositionById.clear();
      baseScaleById.clear();
      baseAlphaById.clear();
      liveAlphaById.clear();
      livePosById.clear();
      hoverLevelById.clear();
      birthAtById.clear();
      baseTintById.clear();
      twinkleSeedById.clear();
    },
  };
}
