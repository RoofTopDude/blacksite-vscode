import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_DISPLAY_OPTIONS,
  annotationEdges,
  annotationsForNode,
  applyMessage,
  baseName,
  clusterBackboneEdges,
  clusterEdges,
  clusterHubKey,
  clusterHubLabel,
  clusterNodeId,
  clusterSubgroupLabel,
  collapseAllClusters,
  collapseSymbols,
  deriveDisplayGraph,
  edgePresentation,
  expandAllClusters,
  filterIsActive,
  gitHeatStats,
  graphNodeRadius,
  initialState,
  isClusterNode,
  isClusterNodeId,
  languageCounts,
  matchesSearch,
  nodesWithinHops,
  setClusterCollapsed,
  visibleNodeIds,
  type GraphFilter,
  type ClusterEdge,
  neighborIds,
  nodeBounds,
  positionedSymbols,
  searchMatches,
  selectedEdgeLabels,
  serviceRelationshipBackbone,
  serviceRelationshipBundles,
  shortClusterLabel,
  symbolRelationTargets,
  traceKindVerb,
  withDisplayGraph,
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
  territorialCollapseFactor,
  visibleWorldRect,
  zoomAround,
  zoomToFit,
  pan,
  screenToWorld,
  worldToScreen,
} from "../../src/webview/react/lib/graph/camera.js";
import { TRACE_COLORS, activityColor, agentLaneColor, churnFraction, folderColor, mixColors, recencyFraction } from "../../src/webview/react/lib/graph/colors.js";
import type { GraphAnnotation, GraphEdge, GraphHostMessage, GraphNode } from "../../src/webview/react/lib/graph/protocol.js";

function node(id: string, dir = "src"): GraphNode {
  return { id, dir, lang: "ts", sizeBytes: 10, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5 };
}

function annotation(id: string, from: string, to: string): GraphAnnotation {
  return { id, from, to, kind: "ai", author: "agent", note: "n", createdAt: "t", updatedAt: "t" };
}

/** Build a settled view state (with a derived display graph) from a file set. */
function withStateFrom(nodes: GraphNode[], edges: GraphEdge[]) {
  return applyMessage(initialState(), {
    type: "graph_state",
    nodes,
    edges,
    annotations: [],
    config: DEFAULT_CONFIG,
    indexing: false,
    truncated: false,
    indexedAt: null,
  }, 0);
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

  it("balances dependency and dependent labels for a high-degree selection", () => {
    const center = { ...node("src/center.ts"), x: 0, y: 0 };
    const dependencies = Array.from({ length: 4 }, (_, index) => ({ ...node(`src/dep-${index}.ts`), x: 40, y: index * 20 }));
    const dependents = Array.from({ length: 4 }, (_, index) => ({ ...node(`src/user-${index}.ts`), x: -40, y: index * 20 }));
    const edges: GraphEdge[] = [
      ...dependencies.map((item, index) => ({ id: `out-${index}`, from: center.id, to: item.id, kind: "import" as const })),
      ...dependents.map((item, index) => ({ id: `in-${index}`, from: item.id, to: center.id, kind: "import" as const })),
    ];
    const labels = selectedEdgeLabels(center.id, [center, ...dependencies, ...dependents], edges, [], {}, DEFAULT_DISPLAY_OPTIONS, 4);
    expect(labels.map((label) => label.label)).toEqual(["imports", "imported by", "imports", "imported by"]);
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

describe("edge presentation LOD", () => {
  it("bundles a screenshot-class file graph at fit and reveals raw edges at detail zoom", () => {
    const overview = edgePresentation("all", "files", 1022, 3099, 1);
    expect(overview).toMatchObject({ strategy: "bundled", dense: true });
    expect(overview.density).toBeCloseTo(3099 / 1022);
    expect(overview.detailZoom).toBeCloseTo(1.8);
    expect(edgePresentation("all", "files", 1022, 3099, 1.79).strategy).toBe("bundled");
    expect(edgePresentation("all", "files", 1022, 3099, 1.8).strategy).toBe("raw");
    expect(edgePresentation("all", "files", 1022, 3099, 3).strategy).toBe("raw");
  });

  it("keeps low-density one-to-many and small graphs raw", () => {
    expect(edgePresentation("all", "files", 1022, 1021, 1)).toMatchObject({ strategy: "raw", dense: false });
    expect(edgePresentation("all", "files", 120, 3000, 1)).toMatchObject({ strategy: "raw", dense: false });
  });

  it("honors explicit modes and adaptively compacts dense service meshes", () => {
    expect(edgePresentation("clusters", "files", 10, 0, 4).strategy).toBe("bundled");
    expect(edgePresentation("selected", "files", 1022, 3099, 1).strategy).toBe("selected");
    expect(edgePresentation("off", "files", 1022, 3099, 1).strategy).toBe("off");
    expect(edgePresentation("all", "services", 48, 180, 1)).toMatchObject({ strategy: "bundled", dense: true });
    expect(edgePresentation("all", "services", 48, 180, 1.64).strategy).toBe("bundled");
    expect(edgePresentation("all", "services", 48, 180, 1.65).strategy).toBe("raw");
    expect(edgePresentation("all", "services", 12, 96, 1)).toMatchObject({ strategy: "raw", dense: false });
  });
});

describe("cluster backbone", () => {
  const connectedDirs = (edges: readonly ClusterEdge[], start: string): Set<string> => {
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      adjacency.set(edge.fromDir, [...(adjacency.get(edge.fromDir) ?? []), edge.toDir]);
      adjacency.set(edge.toDir, [...(adjacency.get(edge.toDir) ?? []), edge.fromDir]);
    }
    const seen = new Set([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i += 1) {
      for (const next of adjacency.get(queue[i]!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  it("does not disconnect a one-to-many graph even when its cap is too small", () => {
    const nodes = [node("hub/file.ts", "hub")];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 8; i += 1) {
      nodes.push(node(`leaf-${i}/file.ts`, `leaf-${i}`));
      edges.push({ id: `hub-${i}`, from: "hub/file.ts", to: `leaf-${i}/file.ts`, kind: "import" });
    }
    const backbone = clusterBackboneEdges(nodes, edges, 2);
    expect(backbone).toHaveLength(8);
    expect(connectedDirs(backbone, "hub").size).toBe(9);
  });

  it("keeps a deterministic maximum spanning backbone plus the strongest extra routes", () => {
    const dirs = ["a", "b", "c", "d", "e", "f"];
    const nodes = dirs.map((dir) => node(`${dir}/file.ts`, dir));
    const weights = new Map<string, number>([
      ["a-b", 100], ["a-c", 90], ["b-c", 80], ["a-d", 70],
      ["d-e", 60], ["e-f", 50], ["a-e", 40],
    ]);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < dirs.length; i += 1) {
      for (let j = i + 1; j < dirs.length; j += 1) {
        const from = dirs[i]!;
        const to = dirs[j]!;
        const count = weights.get(`${from}-${to}`) ?? (30 - i * dirs.length - j);
        for (let n = 0; n < count; n += 1) {
          edges.push({ id: `${from}-${to}-${n}`, from: `${from}/file.ts`, to: `${to}/file.ts`, kind: "import" });
        }
      }
    }

    const backbone = clusterBackboneEdges(nodes, edges, 7);
    const reversed = clusterBackboneEdges([...nodes].reverse(), [...edges].reverse(), 7);
    const defaultBackbone = clusterBackboneEdges(nodes, edges);
    expect(backbone).toHaveLength(7);
    expect(backbone.length).toBeLessThan(clusterEdges(nodes, edges).length);
    expect(defaultBackbone).toHaveLength(12);
    expect(defaultBackbone.length).toBeLessThan(clusterEdges(nodes, edges).length);
    expect(connectedDirs(backbone, "a")).toEqual(new Set(dirs));
    expect(backbone.map((edge) => [edge.id, edge.count])).toEqual(reversed.map((edge) => [edge.id, edge.count]));
    expect(backbone.map((edge) => edge.id)).toEqual([
      "cluster:a->b",
      "cluster:a->c",
      "cluster:b->c",
      "cluster:a->d",
      "cluster:d->e",
      "cluster:e->f",
      "cluster:a->e",
    ]);
  });
});

describe("cluster collapse", () => {
  const files = [
    { ...node("src/a.ts", "src"), x: 0, y: 0, inDegree: 1, outDegree: 1, sizeBytes: 100 },
    { ...node("src/b.ts", "src"), x: 10, y: 0, inDegree: 0, outDegree: 1, sizeBytes: 200 },
    { ...node("test/a.ts", "test"), x: 100, y: 20, inDegree: 2, outDegree: 0, sizeBytes: 50 },
  ];
  const edges: GraphEdge[] = [
    { id: "imp:src/a.ts->src/b.ts", from: "src/a.ts", to: "src/b.ts", kind: "import" },
    { id: "imp:src/a.ts->test/a.ts", from: "src/a.ts", to: "test/a.ts", kind: "import" },
    { id: "imp:src/b.ts->test/a.ts", from: "src/b.ts", to: "test/a.ts", kind: "import" },
  ];

  it("returns the inputs untouched (same refs) when nothing is collapsed", () => {
    const out = deriveDisplayGraph(files, edges, []);
    expect(out.displayNodes).toBe(files);
    expect(out.displayEdges).toBe(edges);
  });

  it("replaces a collapsed cluster's files with one centroid super-node", () => {
    const { displayNodes } = deriveDisplayGraph(files, edges, ["src"]);
    const ids = displayNodes.map((n) => n.id);
    expect(ids).toContain("test/a.ts");
    expect(ids).not.toContain("src/a.ts");
    expect(ids).not.toContain("src/b.ts");
    const superNode = displayNodes.find((n) => n.id === clusterNodeId("src"))!;
    expect(isClusterNode(superNode)).toBe(true);
    expect(superNode.fileCount).toBe(2);
    expect(superNode.sizeBytes).toBe(300);
    expect(superNode.x).toBeCloseTo(5); // centroid of x=0 and x=10
    expect(superNode.y).toBeCloseTo(0);
  });

  it("preserves the dominant neighborhood and derives degrees from visible remapped edges", () => {
    const clustered = [
      { ...node("pkg/a.ts", "pkg"), neighborhood: "apps/alpha" },
      { ...node("pkg/b.ts", "pkg"), neighborhood: "apps/alpha" },
      { ...node("pkg/c.ts", "pkg"), neighborhood: "apps/beta" },
      node("outside/x.ts", "outside"),
      node("outside/y.ts", "outside"),
    ];
    const crossing: GraphEdge[] = [
      { id: "internal", from: "pkg/a.ts", to: "pkg/b.ts", kind: "import" },
      { id: "out-a", from: "pkg/a.ts", to: "outside/x.ts", kind: "import" },
      { id: "out-b", from: "pkg/b.ts", to: "outside/x.ts", kind: "import" },
      { id: "in-x", from: "outside/x.ts", to: "pkg/a.ts", kind: "import" },
      { id: "in-y", from: "outside/y.ts", to: "pkg/c.ts", kind: "import" },
    ];

    const { displayNodes, displayEdges } = deriveDisplayGraph(clustered, crossing, ["pkg"]);
    const superNode = displayNodes.find((item) => item.id === clusterNodeId("pkg"))!;
    expect(superNode).toMatchObject({
      neighborhood: "apps/alpha",
      inDegree: 2,
      outDegree: 1,
    });
    expect(displayEdges).toHaveLength(3);
    expect(displayEdges.filter((edge) => edge.from === superNode.id)).toHaveLength(1);
    expect(displayEdges.filter((edge) => edge.to === superNode.id)).toHaveLength(2);
  });

  it("breaks a neighborhood-count tie deterministically", () => {
    const tied = [
      { ...node("pkg/a.ts", "pkg"), neighborhood: "zeta" },
      { ...node("pkg/b.ts", "pkg"), neighborhood: "alpha" },
    ];
    const superNode = deriveDisplayGraph(tied, [], ["pkg"]).displayNodes[0];
    expect(superNode?.neighborhood).toBe("alpha");
  });

  it("remaps edges onto the super-node, dropping intra-cluster and merging parallels", () => {
    const { displayEdges } = deriveDisplayGraph(files, edges, ["src"]);
    /* a→b is wholly inside src (dropped); a→test and b→test both become
       src-super→test/a.ts and merge into one. */
    expect(displayEdges).toEqual([
      { id: `imp:${clusterNodeId("src")}->test/a.ts`, from: clusterNodeId("src"), to: "test/a.ts", kind: "import" },
    ]);
  });

  it("collapseAllClusters then expandAllClusters round-trips to the file view", () => {
    let state = withStateFrom(files, edges);
    state = collapseAllClusters(state);
    expect(new Set(state.collapsedClusters)).toEqual(new Set(["src", "test"]));
    /* Two clusters → two super-nodes, no cross edges left both-ends-collapsed. */
    expect(state.displayNodes.every(isClusterNode)).toBe(true);
    expect(state.displayNodes).toHaveLength(2);
    state = expandAllClusters(state);
    expect(state.collapsedClusters).toEqual([]);
    expect(state.displayNodes).toBe(state.nodes);
  });

  it("setClusterCollapsed toggles a single cluster and is idempotent", () => {
    let state = withStateFrom(files, edges);
    state = setClusterCollapsed(state, "src", true);
    expect(state.collapsedClusters).toEqual(["src"]);
    const same = setClusterCollapsed(state, "src", true);
    expect(same).toBe(state); // no-op returns the same reference
    state = setClusterCollapsed(state, "src", false);
    expect(state.collapsedClusters).toEqual([]);
  });

  it("prunes collapsed dirs that no longer exist after a re-index", () => {
    let state = withStateFrom(files, edges);
    state = collapseAllClusters(state); // collapses src + test
    state = applyMessage(state, {
      type: "graph_state",
      nodes: [node("src/a.ts", "src")],
      edges: [],
      annotations: [],
      config: DEFAULT_CONFIG,
      indexing: false,
      truncated: false,
      indexedAt: null,
    }, 0);
    expect(state.collapsedClusters).toEqual(["src"]); // "test" retired
  });

  it("isClusterNodeId recognizes super-node ids and rejects file paths", () => {
    expect(isClusterNodeId(clusterNodeId("src/webview"))).toBe(true);
    expect(isClusterNodeId("src/webview/App.tsx")).toBe(false);
  });

  it("a collapsed super-node sums churn and takes the newest commit of its members", () => {
    const withGit = [
      { ...node("src/a.ts", "src"), churn: 3, lastCommitAt: 1000 },
      { ...node("src/b.ts", "src"), churn: 5, lastCommitAt: 1500 },
    ];
    const superNode = deriveDisplayGraph(withGit, [], ["src"]).displayNodes
      .find((n) => n.id === clusterNodeId("src"))!;
    expect(superNode.churn).toBe(8);
    expect(superNode.lastCommitAt).toBe(1500);
  });
});

describe("service lens", () => {
  it("clears an incompatible file selection and isolate filter when switching to services", () => {
    const files = [
      { ...node("services/web/src/client.ts", "services/web"), x: 0, y: 0 },
      { ...node("services/users/src/routes.ts", "services/users"), x: 100, y: 0 },
    ];
    const relationship: GraphEdge = {
      id: "rel:web-users",
      from: "svc:services/web",
      to: "svc:services/users",
      kind: "api",
      serviceFrom: "services/web",
      serviceTo: "services/users",
    };
    const state = withDisplayGraph({
      ...withStateFrom(files, []),
      relationshipEdges: [relationship],
      selectedNodeId: files[0]!.id,
      hoveredNodeId: files[0]!.id,
      filter: { langs: [], minDegree: 0, isolateDepth: 2 },
      display: { ...DEFAULT_DISPLAY_OPTIONS, lens: "services" },
    });
    expect(state.selectedNodeId).toBeNull();
    expect(state.hoveredNodeId).toBeNull();
    expect(state.filter.isolateDepth).toBe(0);
  });

  it("does not ghost service nodes because of file-language filters", () => {
    const services = [
      { ...node("svc:web", "web"), kind: "service" as const, lang: "service" },
      { ...node("svc:api", "api"), kind: "service" as const, lang: "service" },
    ];
    const ids = visibleNodeIds(services, [], [], { langs: ["ts"], minDegree: 20, isolateDepth: 0 }, null)!;
    expect(ids).toEqual(new Set(["svc:web", "svc:api"]));
  });

  it("derives synthetic service nodes and filters relationship layers", () => {
    const files = [
      { ...node("services/web/src/client.ts", "services/web"), x: 0, y: 0, sizeBytes: 100 },
      { ...node("services/users/src/routes.ts", "services/users"), x: 100, y: 0, sizeBytes: 200 },
    ];
    const relationships: GraphEdge[] = [
      {
        id: "rel:web-users",
        from: "svc:services/web",
        to: "svc:services/users",
        kind: "api",
        serviceFrom: "services/web",
        serviceTo: "services/users",
        label: "GET /users/{id}",
      },
      {
        id: "rel:web-topic",
        from: "svc:services/web",
        to: "svc:services/users",
        kind: "event",
        serviceFrom: "services/web",
        serviceTo: "services/users",
        label: "user.created",
      },
    ];

    const { displayNodes, displayEdges } = deriveDisplayGraph(files, relationships, [], {
      ...DEFAULT_DISPLAY_OPTIONS,
      lens: "services",
      showEvents: false,
    });

    expect(displayNodes.map((service) => service.id).sort()).toEqual(["svc:services/users", "svc:services/web"]);
    expect(displayNodes.find((service) => service.id === "svc:services/web")).toMatchObject({
      kind: "service",
      fileCount: 1,
      outDegree: 1,
    });
    expect(displayEdges).toEqual([
      expect.objectContaining({
        kind: "api",
        from: "svc:services/web",
        to: "svc:services/users",
        label: "GET /users/{id}",
      }),
    ]);
  });

  it("pulls repeatedly connected services closer together than unrelated ones", () => {
    const files = [
      { ...node("services/a/src/a.ts", "services/a"), x: 0, y: 0, sizeBytes: 100 },
      { ...node("services/b/src/b.ts", "services/b"), x: 600, y: 0, sizeBytes: 100 },
      { ...node("services/c/src/c.ts", "services/c"), x: -250, y: 0, sizeBytes: 100 },
    ];
    const relationships: GraphEdge[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `rel:a-b:${i}`,
        from: "svc:services/a",
        to: "svc:services/b",
        kind: "api" as const,
        serviceFrom: "services/a",
        serviceTo: "services/b",
        confidence: 0.95,
        label: `GET /pair/${i}`,
      })),
      {
        id: "rel:a-c",
        from: "svc:services/a",
        to: "svc:services/c",
        kind: "api",
        serviceFrom: "services/a",
        serviceTo: "services/c",
        confidence: 0.2,
        label: "GET /weak",
      },
    ];

    const { displayNodes } = deriveDisplayGraph(files, relationships, [], {
      ...DEFAULT_DISPLAY_OPTIONS,
      lens: "services",
    });
    const a = displayNodes.find((service) => service.id === "svc:services/a")!;
    const b = displayNodes.find((service) => service.id === "svc:services/b")!;
    const c = displayNodes.find((service) => service.id === "svc:services/c")!;

    expect(Math.abs(a.x - b.x)).toBeLessThan(Math.abs(a.x - c.x));
  });

  it("keeps a dense many-to-many service mesh collision-separated", () => {
    const files = Array.from({ length: 7 }, (_, index) => ({
      ...node(`services/s${index}/src/index.ts`, `services/s${index}`),
      x: index * 4,
      y: index * 3,
      sizeBytes: 100,
    }));
    const relationships: GraphEdge[] = [];
    for (let from = 0; from < files.length; from += 1) {
      for (let to = from + 1; to < files.length; to += 1) {
        relationships.push({
          id: `mesh:${from}:${to}`,
          from: `svc:services/s${from}`,
          to: `svc:services/s${to}`,
          kind: "api",
          serviceFrom: `services/s${from}`,
          serviceTo: `services/s${to}`,
          confidence: 0.9,
        });
      }
    }
    const { displayNodes } = deriveDisplayGraph(files, relationships, [], { ...DEFAULT_DISPLAY_OPTIONS, lens: "services" });
    let minimum = Infinity;
    for (let i = 0; i < displayNodes.length; i += 1) {
      for (let j = i + 1; j < displayNodes.length; j += 1) {
        minimum = Math.min(minimum, Math.hypot(displayNodes[i]!.x - displayNodes[j]!.x, displayNodes[i]!.y - displayNodes[j]!.y));
      }
    }
    expect(minimum).toBeGreaterThan(70);
  });

  it("counts each source file once per service across duplicate raw relationships", () => {
    const files = [
      { ...node("services/a/src/one.ts", "services/a"), sizeBytes: 10, x: 0 },
      { ...node("services/a/src/two.ts", "services/a"), sizeBytes: 20, x: 20 },
      { ...node("services/b/src/api.ts", "services/b"), sizeBytes: 30, x: 100 },
    ];
    const relationships: GraphEdge[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `api-${i}`,
        from: "svc:services/a",
        to: "svc:services/b",
        kind: "api" as const,
        serviceFrom: "services/a",
        serviceTo: "services/b",
        confidence: 0.8,
      })),
      {
        id: "event",
        from: "svc:services/a",
        to: "svc:services/b",
        kind: "event",
        serviceFrom: "services/a",
        serviceTo: "services/b",
        confidence: 0.6,
      },
    ];

    const { displayNodes, displayEdges } = deriveDisplayGraph(files, relationships, [], {
      ...DEFAULT_DISPLAY_OPTIONS,
      lens: "services",
    });
    expect(displayNodes.find((service) => service.id === "svc:services/a")).toMatchObject({
      fileCount: 2,
      sizeBytes: 30,
      outDegree: 5,
    });
    expect(displayNodes.find((service) => service.id === "svc:services/b")).toMatchObject({
      fileCount: 1,
      sizeBytes: 30,
      inDegree: 5,
    });
    expect(displayEdges).toHaveLength(5);
  });

  it("assigns nested and workspace-root services a single, most-specific file membership", () => {
    const files = [
      { ...node("apps/payments/src/index.ts", "apps/payments"), sizeBytes: 10, x: 10, y: 10 },
      { ...node("apps/web/src/index.ts", "apps/web"), sizeBytes: 20, x: 30, y: 10 },
      { ...node("tooling/build.ts", "tooling"), sizeBytes: 30, x: 50, y: 10 },
    ];
    const relationships: GraphEdge[] = [
      { id: "parent-child", from: "svc:apps", to: "svc:apps/payments", kind: "api", serviceFrom: "apps", serviceTo: "apps/payments" },
      { id: "root-parent", from: "svc:.", to: "svc:apps", kind: "api", serviceFrom: ".", serviceTo: "apps" },
    ];
    const { displayNodes } = deriveDisplayGraph(files, relationships, [], { ...DEFAULT_DISPLAY_OPTIONS, lens: "services" });

    expect(displayNodes.find((service) => service.id === "svc:apps/payments")).toMatchObject({ fileCount: 1, sizeBytes: 10 });
    expect(displayNodes.find((service) => service.id === "svc:apps")).toMatchObject({ fileCount: 1, sizeBytes: 20 });
    expect(displayNodes.find((service) => service.id === "svc:.")).toMatchObject({ fileCount: 1, sizeBytes: 30 });
  });

  it("bundles parallel relationships by direction and kind with stable confidence metadata", () => {
    const services = [
      { ...node("svc:a", "a"), kind: "service" as const, x: 10, y: 20 },
      { ...node("svc:b", "b"), kind: "service" as const, x: 110, y: 220 },
    ];
    const high: GraphEdge = { id: "high", from: "svc:a", to: "svc:b", kind: "api", confidence: 0.9, label: "GET /best", evidence: ["high"] };
    const low: GraphEdge = { id: "low", from: "svc:a", to: "svc:b", kind: "api", confidence: 0.3, label: "GET /weak", evidence: ["low"] };
    const event: GraphEdge = { id: "event", from: "svc:a", to: "svc:b", kind: "event", confidence: 0.5 };
    const reverse: GraphEdge = { id: "reverse", from: "svc:b", to: "svc:a", kind: "api", confidence: 0.7 };
    const importEdge: GraphEdge = { id: "import", from: "svc:a", to: "svc:b", kind: "import" };
    const raw = [low, reverse, event, high, importEdge];

    const bundles = serviceRelationshipBundles(services, raw);
    expect(bundles).toHaveLength(3);
    expect(bundles[0]).toMatchObject({
      id: "service:api:svc:a->svc:b",
      from: "svc:a",
      to: "svc:b",
      kind: "api",
      fromX: 10,
      fromY: 20,
      toX: 110,
      toY: 220,
      count: 2,
      averageConfidence: 0.6,
      minConfidence: 0.3,
      maxConfidence: 0.9,
      representative: high,
    });
    expect(bundles.map((bundle) => [bundle.from, bundle.to, bundle.kind, bundle.count])).toEqual([
      ["svc:a", "svc:b", "api", 2],
      ["svc:a", "svc:b", "event", 1],
      ["svc:b", "svc:a", "api", 1],
    ]);
    expect(serviceRelationshipBundles([...services].reverse(), [...raw].reverse())).toEqual(bundles);
  });

  it("keeps a deterministic, connectivity-preserving service backbone under a route budget", () => {
    const services = ["a", "b", "c", "d", "e"].map((name, index) => ({
      ...node(`svc:${name}`, name), kind: "service" as const, x: index * 100, y: 0,
    }));
    const raw: GraphEdge[] = [];
    const add = (from: string, to: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        raw.push({ id: `${from}-${to}-${index}`, from: `svc:${from}`, to: `svc:${to}`, kind: "api", confidence: 0.8 });
      }
    };
    add("a", "b", 10);
    add("b", "c", 9);
    add("c", "d", 8);
    add("d", "e", 7);
    add("a", "c", 6);
    add("b", "d", 5);
    add("a", "e", 4);

    const bundles = serviceRelationshipBundles(services, raw);
    const backbone = serviceRelationshipBackbone(bundles, 4);
    const constrained = serviceRelationshipBackbone(bundles, 2);

    expect(backbone.map((bundle) => bundle.id)).toEqual([
      "service:api:svc:a->svc:b",
      "service:api:svc:b->svc:c",
      "service:api:svc:c->svc:d",
      "service:api:svc:d->svc:e",
    ]);
    /* A too-small cap never disconnects an otherwise connected service graph. */
    expect(constrained.map((bundle) => bundle.id)).toEqual(backbone.map((bundle) => bundle.id));
    expect(serviceRelationshipBackbone([...bundles].reverse(), 4)).toEqual(backbone);
  });
});

describe("git heat", () => {
  it("churnFraction is log-scaled, 0 for no/absent churn, 1 at the max", () => {
    expect(churnFraction(undefined, 10)).toBe(0);
    expect(churnFraction(5, 0)).toBe(0);
    expect(churnFraction(10, 10)).toBeCloseTo(1);
    expect(churnFraction(3, 10)).toBeGreaterThan(0);
    expect(churnFraction(3, 10)).toBeLessThan(1);
  });

  it("recencyFraction spreads commit times across [oldest, newest]", () => {
    expect(recencyFraction(2000, 1000, 2000)).toBe(1); // newest
    expect(recencyFraction(1000, 1000, 2000)).toBe(0); // oldest
    expect(recencyFraction(1500, 1000, 2000)).toBeCloseTo(0.5);
    expect(recencyFraction(undefined, 1000, 2000)).toBe(0); // untracked
    expect(recencyFraction(1234, 5000, 5000)).toBe(1); // degenerate range
  });

  it("gitHeatStats reports the range and flags an ungit workspace", () => {
    const stats = gitHeatStats([
      { ...node("a.ts"), churn: 2, lastCommitAt: 1000 },
      { ...node("b.ts"), churn: 9, lastCommitAt: 3000 },
      { ...node("c.ts") }, // untracked
    ]);
    expect(stats).toEqual({ hasData: true, maxChurn: 9, oldest: 1000, newest: 3000 });
    expect(gitHeatStats([node("x.ts")])).toEqual({ hasData: false, maxChurn: 0, oldest: 0, newest: 0 });
  });
});

describe("focus filter", () => {
  const F = (over: Partial<GraphFilter> = {}): GraphFilter => ({ langs: [], minDegree: 0, isolateDepth: 0, ...over });
  const nodes: GraphNode[] = [
    { ...node("src/a.ts", "src"), lang: "ts", inDegree: 3, outDegree: 1 },
    { ...node("src/b.css", "src"), lang: "css", inDegree: 0, outDegree: 0 },
    { ...node("src/c.ts", "src"), lang: "ts", inDegree: 1, outDegree: 0 },
    { ...node("docs/d.md", "docs"), lang: "md", inDegree: 0, outDegree: 0 },
  ];
  const edges: GraphEdge[] = [
    { id: "e1", from: "src/a.ts", to: "src/c.ts", kind: "import" },
    { id: "e2", from: "src/c.ts", to: "docs/d.md", kind: "import" },
  ];

  it("filterIsActive ignores isolate without a selection", () => {
    expect(filterIsActive(F(), false)).toBe(false);
    expect(filterIsActive(F({ langs: ["ts"] }), false)).toBe(true);
    expect(filterIsActive(F({ minDegree: 2 }), false)).toBe(true);
    expect(filterIsActive(F({ isolateDepth: 2 }), false)).toBe(false);
    expect(filterIsActive(F({ isolateDepth: 2 }), true)).toBe(true);
  });

  it("returns null (everything visible) when nothing is active", () => {
    expect(visibleNodeIds(nodes, edges, [], F(), null)).toBeNull();
  });

  it("keeps only the chosen languages", () => {
    const ids = visibleNodeIds(nodes, edges, [], F({ langs: ["ts"] }), null)!;
    expect([...ids].sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("drops files below the min-degree threshold", () => {
    const ids = visibleNodeIds(nodes, edges, [], F({ minDegree: 2 }), null)!;
    expect([...ids]).toEqual(["src/a.ts"]); // only node with in+out ≥ 2
  });

  it("isolate keeps only nodes within N hops of the selection (plus the root)", () => {
    const oneHop = visibleNodeIds(nodes, edges, [], F({ isolateDepth: 1 }), "src/a.ts")!;
    expect([...oneHop].sort()).toEqual(["src/a.ts", "src/c.ts"]);
    const twoHop = visibleNodeIds(nodes, edges, [], F({ isolateDepth: 2 }), "src/a.ts")!;
    expect([...twoHop].sort()).toEqual(["docs/d.md", "src/a.ts", "src/c.ts"]);
  });

  it("always keeps the selected node visible even if it fails the base filter", () => {
    const ids = visibleNodeIds(nodes, edges, [], F({ langs: ["ts"] }), "docs/d.md")!;
    expect(ids.has("docs/d.md")).toBe(true);
  });

  it("cluster super-nodes bypass the lang/degree gates", () => {
    const withCluster = [...nodes, { ...node("▤src", "src"), kind: "cluster" as const, lang: "", inDegree: 0, outDegree: 0 }];
    const ids = visibleNodeIds(withCluster, edges, [], F({ langs: ["ts"], minDegree: 5 }), null)!;
    expect(ids.has("▤src")).toBe(true);
  });

  it("nodesWithinHops does an undirected BFS including the root", () => {
    expect(nodesWithinHops("src/a.ts", edges, [], 0)).toEqual(new Set(["src/a.ts"]));
    expect(nodesWithinHops("docs/d.md", edges, [], 2)).toEqual(new Set(["docs/d.md", "src/c.ts", "src/a.ts"]));
  });

  it("languageCounts ranks present languages and skips clusters", () => {
    const counts = languageCounts(nodes);
    expect(counts[0]).toEqual({ lang: "ts", count: 2 });
    expect(counts.map((c) => c.lang)).toEqual(["ts", "css", "md"]);
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

  it("territorialCollapseFactor is inert until well past the whole-map fit, then ramps to 1", () => {
    expect(territorialCollapseFactor(1)).toBe(0);
    expect(territorialCollapseFactor(0.55)).toBe(0);
    expect(territorialCollapseFactor(0.22)).toBe(1);
    expect(territorialCollapseFactor(0.01)).toBe(1);
    const mid = territorialCollapseFactor(0.385); // halfway between 0.55 and 0.22
    expect(mid).toBeCloseTo(0.5, 1);
    expect(territorialCollapseFactor(Number.NaN)).toBe(0);
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
  it("assigns stable lane colors and falls back to kind colors for the parent agent", () => {
    expect(agentLaneColor("lane-a")).toBe(agentLaneColor("lane-a"));
    expect(agentLaneColor("lane-a")).not.toBeNull();
    expect(activityColor("edit")).toBe(TRACE_COLORS.edit);
    expect(activityColor("edit", "lane-a")).toBe(agentLaneColor("lane-a"));
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

describe("cluster hub labels", () => {
  it("derives a stable parent hub key from the first one or two segments", () => {
    expect(clusterHubKey(".")).toBe(".");
    expect(clusterHubKey("src")).toBe("src");
    expect(clusterHubKey("packages/frontend/src/components")).toBe("packages/frontend");
  });

  it("labels the root hub as the workspace and leaves normal hubs readable", () => {
    expect(clusterHubLabel(".")).toBe("workspace");
    expect(clusterHubLabel("src/webview")).toBe("src/webview");
  });

  it("extracts a compact subgroup label beneath a parent hub", () => {
    expect(clusterSubgroupLabel("src/webview")).toBeNull();
    expect(clusterSubgroupLabel("packages/frontend/src/components")).toBe("src/components");
    expect(clusterSubgroupLabel("packages/frontend/src/components/forms/inputs")).toBe("…/forms/inputs");
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
