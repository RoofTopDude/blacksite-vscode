import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  annotationEdges,
  annotationsForNode,
  applyMessage,
  collapseSymbols,
  initialState,
  matchesSearch,
  neighborIds,
  searchMatches,
} from "../../src/webview/react/lib/graph/view-model.js";
import { zoomAround, zoomToFit, pan, screenToWorld, worldToScreen } from "../../src/webview/react/lib/graph/camera.js";
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
    let state = { ...initialState(), selectedNodeId: "gone.ts", hoveredNodeId: "src/a.ts" };
    state = applyMessage(state, GRAPH_STATE, 0);
    expect(state.nodes.length).toBe(2);
    expect(state.truncated).toBe(true);
    expect(state.selectedNodeId).toBeNull();
    expect(state.hoveredNodeId).toBe("src/a.ts");
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
