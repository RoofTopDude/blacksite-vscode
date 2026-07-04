import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_DISPLAY_OPTIONS,
  annotationEdges,
  annotationsForNode,
  applyMessage,
  baseName,
  clusterEdges,
  collapseSymbols,
  graphNodeRadius,
  initialState,
  matchesSearch,
  neighborIds,
  nodeBounds,
  positionedSymbols,
  searchMatches,
  selectedEdgeLabels,
  shortClusterLabel,
  symbolRelationTargets,
  traceKindVerb,
} from "../../src/webview/react/lib/graph/view-model.js";
import {
  MIN_ZOOM,
  camerasClose,
  clampZoom,
  easeInOutCubic,
  edgeLayerAlpha,
  frameNode,
  lerpCamera,
  nodeSpriteScale,
  visibleWorldRect,
  zoomAround,
  zoomToFit,
  pan,
  screenToWorld,
  worldToScreen,
} from "../../src/webview/react/lib/graph/camera.js";
import { folderColor, mixColors } from "../../src/webview/react/lib/graph/colors.js";
import type { GraphAnnotation, GraphHostMessage, GraphNode } from "../../src/webview/react/lib/graph/protocol.js";

function node(id: string, dir = "src"): GraphNode {
  return { id, dir, lang: "ts", sizeBytes: 10, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5 };
}

function annotation(id: string, from: string, to: string): GraphAnnotation {
  return { id, from, to, kind: "ai", author: "agent", note: "n", createdAt: "t", updatedAt: "t" };
}

const GRAPH_STATE: GraphHostMessage = {
  type: "graph_state",
  nodes: [node("src/a.ts"), node("src/b.ts")],
  edges: [{ id: "imp:src/a.ts->src/b.ts", from: "src/a.ts", to: "src/b.ts", kind: "import" }],
  annotations: [annotation("g1", "src/a.ts", "src/b.ts")],
  config: DEFAULT_CONFIG,
  indexing: false,
  truncated: true,
  indexedAt: "2026-07-02T00:00:00.000Z",
};

describe("applyMessage", () => {
  it("applies graph_state and clears dangling selection", () => {
    let state = {
      ...initialState(),
      selectedNodeId: "gone.ts",
      hoveredNodeId: "src/a.ts",
      symbolsByPath: {
        "src/a.ts": {
          symbols: [{ id: "src/a.ts#f@1", path: "src/a.ts", name: "f", kind: "function", startLine: 1, endLine: 3 }],
          edges: [],
        },
        "gone.ts": {
          symbols: [{ id: "gone.ts#x@1", path: "gone.ts", name: "x", kind: "function", startLine: 1, endLine: 2 }],
          edges: [],
        },
      },
    };
    state = applyMessage(state, GRAPH_STATE, 0);
    expect(state.nodes.length).toBe(2);
    expect(state.truncated).toBe(true);
    expect(state.selectedNodeId).toBeNull();
    expect(state.hoveredNodeId).toBe("src/a.ts");
    expect(Object.keys(state.symbolsByPath)).toEqual(["src/a.ts"]);
  });

  it("applies graph_indexing / graph_config / annotations_changed", () => {
    let state = initialState();
    state = applyMessage(state, { type: "graph_indexing", indexing: true }, 0);
    expect(state.indexing).toBe(true);
    state = applyMessage(state, { type: "graph_config", config: { ...DEFAULT_CONFIG, traceFadeSeconds: 9 } }, 0);
    expect(state.config.traceFadeSeconds).toBe(9);
    state = applyMessage(state, { type: "annotations_changed", annotations: [annotation("g2", "a", "b")] }, 0);
    expect(state.annotations.map((a) => a.id)).toEqual(["g2"]);
  });

  it("merges and prunes trace batches", () => {
    let state = applyMessage(initialState(), GRAPH_STATE, 0);
    state = applyMessage(state, {
      type: "trace_batch",
      events: [{ id: "e1", path: "src/a.ts", kind: "read", at: 1000 }],
    }, 1000);
    expect(state.traces.length).toBe(1);
    state = applyMessage(state, {
      type: "trace_batch",
      events: [{ id: "e2", path: "src/b.ts", kind: "write", at: 500_000 }],
    }, 500_000);
    /* e1 is far past 3× fade at now=500000 — pruned. */
    expect(state.traces.map((e) => e.id)).toEqual(["e2"]);
  });

  it("replaces live activity wholesale (host sends the current in-flight set)", () => {
    let state = applyMessage(initialState(), GRAPH_STATE, 0);
    expect(state.liveActivity).toEqual([]);
    state = applyMessage(state, {
      type: "live_activity",
      active: [{ path: "src/a.ts", kind: "edit", at: 1000 }],
    }, 1000);
    expect(state.liveActivity).toEqual([{ path: "src/a.ts", kind: "edit", at: 1000 }]);
    /* A later snapshot with nothing in flight clears it. */
    state = applyMessage(state, { type: "live_activity", active: [] }, 2000);
    expect(state.liveActivity).toEqual([]);
  });

  it("stores and collapses symbol expansions", () => {
    let state = applyMessage(initialState(), {
      type: "symbols_state",
      path: "src/a.ts",
      symbols: [{ id: "src/a.ts#f@1", path: "src/a.ts", name: "f", kind: "function", startLine: 1, endLine: 3 }],
      edges: [],
    }, 0);
    expect(state.symbolsByPath["src/a.ts"]?.symbols[0]?.name).toBe("f");
    state = collapseSymbols(state, "src/a.ts");
    expect(state.symbolsByPath["src/a.ts"]).toBeUndefined();
  });
});

describe("search + neighbors + annotations", () => {
  it("traceKindVerb and baseName format the live-activity chip", () => {
    expect(traceKindVerb("edit")).toBe("Editing");
    expect(traceKindVerb("read")).toBe("Reading");
    expect(traceKindVerb("shell")).toBe("Running in");
    expect(baseName("apps/vscode-extension/src/graph-provider.ts")).toBe("graph-provider.ts");
    expect(baseName("top.ts")).toBe("top.ts");
  });

  it("matchesSearch is case-insensitive substring", () => {
    expect(matchesSearch(node("src/GraphApp.tsx"), "graphapp")).toBe(true);
    expect(matchesSearch(node("src/a.ts"), "zzz")).toBe(false);
    expect(matchesSearch(node("src/a.ts"), "  ")).toBe(true);
  });

  it("searchMatches respects the limit", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node(`src/file${i}.ts`));
    expect(searchMatches(nodes, "file", 5).length).toBe(5);
    expect(searchMatches(nodes, "", 5)).toEqual([]);
  });

  it("neighborIds unions imports and annotations", () => {
    const ids = neighborIds(
      "src/a.ts",
      [{ id: "e", from: "src/a.ts", to: "src/b.ts", kind: "import" }],
      [annotation("g", "src/c.ts", "src/a.ts")],
    );
    expect(ids).toEqual(new Set(["src/b.ts", "src/c.ts"]));
  });

  it("annotationsForNode and annotationEdges round-trip", () => {
    const list = [annotation("g1", "a", "b"), annotation("g2", "c", "d")];
    expect(annotationsForNode("a", list).map((a) => a.id)).toEqual(["g1"]);
    expect(annotationEdges(list)[0]).toMatchObject({ id: "g1", kind: "ai", note: "n" });
  });

  it("derives positioned symbols and relation targets for an expanded file", () => {
    const nodes = [node("src/a.ts"), node("src/b.ts")];
    const symbolsByPath = {
      "src/a.ts": {
        symbols: [
          { id: "src/a.ts#f@1", path: "src/a.ts", name: "f", kind: "function", startLine: 1, endLine: 3 },
          { id: "src/a.ts#g@5", path: "src/a.ts", name: "g", kind: "function", startLine: 5, endLine: 8 },
        ],
        edges: [
          { from: "src/a.ts#f@1", toPath: "src/b.ts" },
          { from: "src/a.ts#g@5", toPath: "src/b.ts" },
        ],
      },
    };
    const placements = positionedSymbols(nodes, symbolsByPath);
    expect(placements).toHaveLength(2);
    expect(placements.every((placement) => placement.parent.id === "src/a.ts")).toBe(true);
    expect(symbolRelationTargets(symbolsByPath["src/a.ts"])).toEqual(new Set(["src/b.ts"]));
    expect(graphNodeRadius(node("x"))).toBeGreaterThan(0);
  });

  it("derives selected edge labels across imports, annotations, and symbol relations", () => {
    const a = { ...node("src/a.ts"), x: 0, y: 0 };
    const b = { ...node("src/b.ts"), x: 20, y: 0 };
    const labels = selectedEdgeLabels(
      "src/a.ts",
      [a, b],
      [{ id: "imp:src/a.ts->src/b.ts", from: "src/a.ts", to: "src/b.ts", kind: "import" }],
      [annotation("note1", "src/b.ts", "src/a.ts")],
      {
        "src/a.ts": {
          symbols: [{ id: "src/a.ts#f@1", path: "src/a.ts", name: "f", kind: "function", startLine: 1, endLine: 2 }],
          edges: [{ from: "src/a.ts#f@1", toPath: "src/b.ts" }],
        },
      },
      DEFAULT_DISPLAY_OPTIONS,
    );
    expect(labels.map((label) => label.kind)).toEqual(["import", "annotation", "relation"]);
    /* Import label rides the arc midpoint (edges bow), so x stays at the chord
       midpoint but y is offset onto the curve. */
    expect(labels[0]?.label).toBe("imports");
    expect(labels[0]?.x).toBeCloseTo(10);
    expect(labels[0]?.y).toBeGreaterThan(0);
  });

  it("aggregates import edges between clusters for large overview rendering", () => {
    const nodes = [
      { ...node("src/a.ts", "src"), x: 0, y: 0 },
      { ...node("src/b.ts", "src"), x: 10, y: 0 },
      { ...node("test/a.ts", "test"), x: 100, y: 0 },
    ];
    const edges = clusterEdges(nodes, [
      { id: "e1", from: "src/a.ts", to: "test/a.ts", kind: "import" },
      { id: "e2", from: "src/b.ts", to: "test/a.ts", kind: "import" },
    ]);
    expect(edges).toEqual([
      expect.objectContaining({ fromDir: "src", toDir: "test", fromX: 5, toX: 100, count: 2 }),
    ]);
  });
});

describe("camera math", () => {
  const vp = { width: 800, height: 600 };

  it("worldToScreen and screenToWorld invert each other", () => {
    const camera = { cx: 50, cy: -20, zoom: 2 };
    const screen = worldToScreen(camera, vp, 130, 40);
    const world = screenToWorld(camera, vp, screen.x, screen.y);
    expect(world.x).toBeCloseTo(130);
    expect(world.y).toBeCloseTo(40);
  });

  it("pan shifts the center opposite the drag", () => {
    const camera = pan({ cx: 0, cy: 0, zoom: 2 }, 100, 0);
    expect(camera.cx).toBe(-50);
  });

  it("zoomAround keeps the anchor stationary", () => {
    const camera = { cx: 0, cy: 0, zoom: 1 };
    const anchorBefore = screenToWorld(camera, vp, 100, 100);
    const zoomed = zoomAround(camera, vp, 100, 100, 2);
    const anchorAfter = screenToWorld(zoomed, vp, 100, 100);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y);
  });

  it("zoomToFit frames all points", () => {
    const camera = zoomToFit([{ x: -100, y: -100 }, { x: 100, y: 100 }], vp);
    expect(camera.cx).toBe(0);
    expect(camera.cy).toBe(0);
    const corner = worldToScreen(camera, vp, 100, 100);
    expect(corner.x).toBeLessThanOrEqual(vp.width);
    expect(corner.y).toBeLessThanOrEqual(vp.height);
  });

  it("zoomToFit returns the identity camera for a 0x0 viewport (detectable, not silently wrong)", () => {
    // Regression: a webview host element can report 0x0 for a tick after
    // mount. The renderer must recognize this exact degenerate case and
    // retry the fit once the viewport is real, rather than baking in
    // {cx:0,cy:0,zoom:1} forever — that bug made the map render only
    // whatever tiny fragment of a huge layout happens to sit near the
    // world origin, with nothing else reachable by pan/click.
    const camera = zoomToFit([{ x: 500, y: 500 }, { x: 2000, y: 2000 }], { width: 0, height: 0 });
    expect(camera).toEqual({ cx: 0, cy: 0, zoom: 1 });
  });

  it("zoomToFit is NOT floored at MIN_ZOOM — huge layouts must fit whole", () => {
    // Regression: a 30k-unit world in a sidebar viewport needs zoom ≈ 0.01;
    // the old MIN_ZOOM clamp made only the central 1-2 clusters visible.
    const camera = zoomToFit([{ x: -15_000, y: -15_000 }, { x: 15_000, y: 15_000 }], vp);
    expect(camera.zoom).toBeLessThan(MIN_ZOOM);
    const corner = worldToScreen(camera, vp, 15_000, 15_000);
    expect(corner.x).toBeLessThanOrEqual(vp.width);
    expect(corner.y).toBeLessThanOrEqual(vp.height);
  });

  it("clampZoom and zoomAround honor a dynamic minZoom floor", () => {
    expect(clampZoom(0.001, 0.005)).toBe(0.005);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    const camera = { cx: 0, cy: 0, zoom: 0.02 };
    const zoomedOut = zoomAround(camera, vp, 400, 300, 0.5, 0.005);
    expect(zoomedOut.zoom).toBeCloseTo(0.01);
  });

  it("nodeSpriteScale enforces a minimum on-screen size when zoomed out", () => {
    // Zoomed in: natural world radius wins (5 world units ≥ 4px at zoom 2).
    expect(nodeSpriteScale(5, 2, 4)).toBeCloseTo(5 / 8);
    // Zoomed way out: 5 world units × 0.01 zoom = 0.05px — must compensate
    // so the star still renders at ~4px on screen.
    const compensated = nodeSpriteScale(5, 0.01, 4);
    expect(compensated * 8 * 0.01).toBeCloseTo(4);
  });

  it("edgeLayerAlpha fades at overview and richens on zoom-in, bounded", () => {
    const overview = edgeLayerAlpha(0.5);
    const atFit = edgeLayerAlpha(1);
    const detail = edgeLayerAlpha(2.5);
    expect(overview).toBeLessThan(atFit);
    expect(atFit).toBeLessThan(detail);
    for (const ratio of [0.01, 0.5, 1, 3, 100]) {
      const alpha = edgeLayerAlpha(ratio);
      expect(alpha).toBeGreaterThanOrEqual(0.1);
      expect(alpha).toBeLessThanOrEqual(0.9);
    }
  });
});

describe("camera fly-to math", () => {
  const vp = { width: 800, height: 600 };

  it("easeInOutCubic is pinned at the ends and symmetric about the midpoint", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(-1)).toBe(0); // clamped
    expect(easeInOutCubic(2)).toBe(1); // clamped
  });

  it("lerpCamera interpolates position linearly and zoom geometrically", () => {
    const from = { cx: 0, cy: 0, zoom: 1 };
    const to = { cx: 100, cy: -40, zoom: 4 };
    const mid = lerpCamera(from, to, 0.5);
    expect(mid.cx).toBeCloseTo(50);
    expect(mid.cy).toBeCloseTo(-20);
    expect(mid.zoom).toBeCloseTo(2); // geometric mean of 1 and 4
    expect(lerpCamera(from, to, 0)).toEqual(from);
    expect(lerpCamera(from, to, 1).zoom).toBeCloseTo(4);
  });

  it("frameNode centers the node and never zooms a detail view back out", () => {
    const node = { x: 30, y: -12 };
    const framed = frameNode(node, 5, 2, MIN_ZOOM); // already zoomed in past desired
    expect(framed.cx).toBe(30);
    expect(framed.cy).toBe(-12);
    expect(framed.zoom).toBe(5); // keeps the closer zoom
    expect(frameNode(node, 0.5, 3, MIN_ZOOM).zoom).toBe(3); // zooms in from overview
  });

  it("camerasClose detects arrival within epsilon", () => {
    const a = { cx: 0, cy: 0, zoom: 1 };
    expect(camerasClose(a, { cx: 0.2, cy: -0.1, zoom: 1.005 })).toBe(true);
    expect(camerasClose(a, { cx: 50, cy: 0, zoom: 1 })).toBe(false);
    expect(camerasClose(a, { cx: 0, cy: 0, zoom: 2 })).toBe(false);
  });

  it("visibleWorldRect matches the inverse-projected viewport corners", () => {
    const camera = { cx: 10, cy: 20, zoom: 2 };
    const rect = visibleWorldRect(camera, vp);
    const topLeft = screenToWorld(camera, vp, 0, 0);
    expect(rect.x).toBeCloseTo(topLeft.x);
    expect(rect.y).toBeCloseTo(topLeft.y);
    expect(rect.width).toBeCloseTo(vp.width / camera.zoom);
    expect(rect.height).toBeCloseTo(vp.height / camera.zoom);
  });
});

describe("colors", () => {
  it("folderColor is stable and distinct-ish", () => {
    expect(folderColor("src/webview")).toBe(folderColor("src/webview"));
    expect(folderColor("src/webview")).not.toBe(folderColor("packages/local-runtime"));
  });
  it("mixColors interpolates and clamps", () => {
    expect(mixColors(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColors(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColors(0x000000, 0xffffff, 2)).toBe(0xffffff);
  });
});

describe("shortClusterLabel", () => {
  it("leaves a root or 1-2 segment cluster untouched", () => {
    expect(shortClusterLabel(".")).toBe(".");
    expect(shortClusterLabel("src")).toBe("src");
    expect(shortClusterLabel("src/webview")).toBe("src/webview");
  });

  it("shows an ellipsis + last two segments for deep adaptive clusters", () => {
    expect(shortClusterLabel("packages/frontend/src/components")).toBe("…/src/components");
  });
});

describe("nodeBounds (minimap)", () => {
  it("returns a padded box enclosing every node", () => {
    const b = nodeBounds([{ x: -10, y: -10 }, { x: 10, y: 30 }], 0.1);
    expect(b.minX).toBeLessThanOrEqual(-10);
    expect(b.maxX).toBeGreaterThanOrEqual(10);
    expect(b.minY).toBeLessThanOrEqual(-10);
    expect(b.maxY).toBeGreaterThanOrEqual(30);
    // 10% padding on a 20-wide span ⇒ ±2.
    expect(b.minX).toBeCloseTo(-12);
    expect(b.maxX).toBeCloseTo(12);
  });

  it("returns a safe unit box for an empty set", () => {
    expect(nodeBounds([])).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
  });
});
