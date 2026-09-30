import { afterEach, describe, expect, it } from "vitest";
import {
  breadcrumb,
  computeFolds,
  groupChain,
  indexHierarchy,
  landingMode,
  scopeFor,
  validScope,
} from "../../src/webview/react/lib/graph/scope.js";
import {
  DEFAULT_DISPLAY_OPTIONS,
  applyMessage,
  graphNodeRadius,
  initialState,
  normalizeDisplayOptions,
  setScope,
  withDisplayGraph,
  type GraphViewState,
} from "../../src/webview/react/lib/graph/view-model.js";
import { folderColor, setColorCodebases } from "../../src/webview/react/lib/graph/colors.js";
import { flowParticles, signatureForEdgeKind } from "../../src/webview/react/lib/graph/flow-signature.js";
import type { GraphEdge, GraphNode, MapGroup, MapHierarchy } from "../../src/webview/react/lib/graph/protocol.js";

function group(id: string, level: MapGroup["level"], key: string, parent: string | null, fileCount: number, renderedCount = fileCount): MapGroup {
  return { id, level, key, label: key.split("/").pop() ?? key, parent, fileCount, renderedCount, langs: [], churn: 0, lastCommitAt: 0, x: 0, y: 0, radius: 0 };
}

function file(id: string, codebase: string, dir: string, x = 0, y = 0): GraphNode {
  return { id, dir, codebase, lang: "ts", sizeBytes: 100, inDegree: 0, outDegree: 0, x, y, z: 0.2 };
}

/* Two codebases; `web` has two areas, `api` one. */
const hierarchy: MapHierarchy = {
  groups: [
    group("◈web", "codebase", "web", null, 5),
    group("◈api", "codebase", "api", null, 2, 1),
    group("▤web/ui", "area", "web/ui", "◈web", 3),
    group("▤web/data", "area", "web/data", "◈web", 2),
    group("▤api/src", "area", "api/src", "◈api", 2, 1),
  ],
  edges: [
    { id: "grp:sys:import:◈web->◈api", level: "systems", from: "◈web", to: "◈api", kind: "import", count: 42 },
    { id: "grp:sys:cochange:◈web->◈api", level: "systems", from: "◈web", to: "◈api", kind: "cochange", count: 3, unexplained: false },
  ],
  roots: [],
  declaredUnused: [],
  usedUndeclared: [],
  fileCount: 7,
};
const nodes = [
  file("web/ui/a.ts", "web", "web/ui", 0, 0),
  file("web/ui/b.ts", "web", "web/ui", 10, 0),
  file("web/ui/c.ts", "web", "web/ui", 20, 0),
  file("web/data/d.ts", "web", "web/data", 0, 20),
  file("web/data/e.ts", "web", "web/data", 10, 20),
  file("api/src/f.ts", "api", "api/src", 300, 0),
];
const index = indexHierarchy(hierarchy);
const noOptions = { budget: 100, interest: new Set<string>(), collapsedDirs: new Set<string>() };

describe("scope model", () => {
  it("walks a file's group chain outermost first", () => {
    expect(groupChain(nodes[0]!, index)).toEqual(["◈web", "▤web/ui"]);
  });

  it("folds every file to its codebase in the Systems view", () => {
    const { foldOf } = computeFolds(nodes, index, { scope: [], mode: "systems" }, noOptions);
    expect(foldOf.get("web/ui/a.ts")).toBe("◈web");
    expect(foldOf.get("api/src/f.ts")).toBe("◈api");
  });

  it("shows the scoped codebase's files and folds siblings to their codebase", () => {
    const { foldOf } = computeFolds(nodes, index, { scope: ["◈web"], mode: "focus" }, noOptions);
    expect(foldOf.has("web/ui/a.ts")).toBe(false);
    expect(foldOf.get("api/src/f.ts")).toBe("◈api");
  });

  it("folds areas when the scope exceeds the focus budget, keeping interest expanded", () => {
    const tight = { budget: 4, interest: new Set(["web/data/d.ts"]), collapsedDirs: new Set<string>() };
    const { foldOf, expanded } = computeFolds(nodes, index, { scope: ["◈web"], mode: "focus" }, tight);
    /* Expanding web/data (2 files) keeps the count at 1 + 2 = 3; web/ui (3 more)
       would reach 5 > 4, so it stays folded. */
    expect(expanded.has("▤web/data")).toBe(true);
    expect(foldOf.get("web/ui/a.ts")).toBe("▤web/ui");
    expect(foldOf.has("web/data/d.ts")).toBe(false);
  });

  it("always folds a folder the user collapsed by hand", () => {
    const { foldOf } = computeFolds(nodes, index, { scope: [], mode: "all" }, { ...noOptions, collapsedDirs: new Set(["web/data"]) });
    expect(foldOf.get("web/data/d.ts")).toBe("▤web/data");
    expect(foldOf.has("web/ui/a.ts")).toBe(false);
  });

  it("chooses the landing mode from size and codebase count", () => {
    expect(landingMode(hierarchy, "auto", 5).mode).toBe("systems");
    expect(landingMode(hierarchy, "auto", 100).mode).toBe("all");
    expect(landingMode(hierarchy, "files", 5).mode).toBe("all");
    expect(landingMode(hierarchy, "systems", 100).mode).toBe("systems");
    const single = { ...hierarchy, groups: hierarchy.groups.filter((g) => g.id !== "◈api" && g.id !== "▤api/src") };
    expect(landingMode(single, "auto", 5).mode).toBe("focus");
  });

  it("builds breadcrumbs and scope paths, dropping unknown groups", () => {
    expect(scopeFor("▤web/ui", index)).toEqual(["◈web", "▤web/ui"]);
    expect(breadcrumb(["◈web", "▤web/ui"], index).map((c) => c.label)).toEqual(["Workspace", "web", "ui"]);
    expect(validScope(["◈web", "◈gone"], index)).toEqual(["◈web"]);
  });
});

describe("scoped display graph", () => {
  function stateWith(overrides: Partial<GraphViewState> = {}): GraphViewState {
    const edges: GraphEdge[] = [
      { id: "imp:web/ui/a.ts->api/src/f.ts", from: "web/ui/a.ts", to: "api/src/f.ts", kind: "import" },
      { id: "imp:web/ui/a.ts->web/data/d.ts", from: "web/ui/a.ts", to: "web/data/d.ts", kind: "import" },
    ];
    return withDisplayGraph({ ...initialState(), nodes, edges, hierarchy, ...overrides });
  }

  it("draws codebases as labelled super-nodes with true counts and host group edges", () => {
    const state = stateWith({ scopeMode: "systems" });
    const web = state.displayNodes.find((n) => n.id === "◈web")!;
    expect(web).toMatchObject({ kind: "cluster", groupLevel: "codebase", groupLabel: "web", fileCount: 5 });
    const api = state.displayNodes.find((n) => n.id === "◈api")!;
    /* One of api's two files is outside the render sample; the host count wins. */
    expect(api.fileCount).toBe(2);
    const imports = state.displayEdges.filter((e) => e.kind === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ from: "◈web", to: "◈api", occurrenceCount: 42 });
    /* Explained co-change stays hidden unless the co-change layer is on. */
    expect(state.displayEdges.some((e) => e.kind === "cochange")).toBe(false);
    expect(graphNodeRadius(web)).toBeGreaterThan(graphNodeRadius({ inDegree: 0, outDegree: 0 }));
  });

  it("enters a codebase and remaps edges onto the folded sibling", () => {
    const state = setScope(stateWith({ scopeMode: "systems" }), ["◈web"], "focus");
    expect(state.displayNodes.some((n) => n.id === "web/ui/a.ts")).toBe(true);
    expect(state.displayEdges.find((e) => e.from === "web/ui/a.ts" && e.to === "◈api")).toBeTruthy();
  });

  it("applies the landing rule once when the hierarchy arrives", () => {
    const base = withDisplayGraph({ ...initialState(), nodes, display: { ...DEFAULT_DISPLAY_OPTIONS, focusBudget: 5 } });
    const landed = applyMessage(base, { type: "graph_hierarchy", hierarchy }, 0);
    expect(landed.scopeMode).toBe("systems");
    expect(landed.landingApplied).toBe(true);
    const user = { ...landed, scopeMode: "all" as const };
    expect(applyMessage(user, { type: "graph_hierarchy", hierarchy }, 0).scopeMode).toBe("all");
  });

  it("merges a scope's off-sample files only for the generation it was fetched against", () => {
    const state = stateWith({ seq: 4, scope: ["◈api"], scopeMode: "focus" });
    const detail = file("api/src/g.ts", "api", "api/src", 310, 0);
    const stale = applyMessage(state, { type: "scope_detail", groupId: "◈api", seq: 3, nodes: [detail], edges: [] }, 0);
    expect(stale.nodes.some((n) => n.id === "api/src/g.ts")).toBe(false);
    const fresh = applyMessage(state, { type: "scope_detail", groupId: "◈api", seq: 4, nodes: [detail], edges: [] }, 0);
    expect(fresh.nodes.some((n) => n.id === "api/src/g.ts")).toBe(true);
    expect(fresh.detailGroups).toContain("◈api");
  });
});

describe("graph_delta", () => {
  const base = withDisplayGraph({
    ...initialState(),
    seq: 7,
    nodes: [file("a.ts", ".", "."), file("b.ts", ".", ".")],
    edges: [{ id: "imp:a.ts->b.ts", from: "a.ts", to: "b.ts", kind: "import" }],
  });

  it("patches nodes and edges on top of the matching generation", () => {
    const next = applyMessage(base, {
      type: "graph_delta",
      seq: 8,
      baseSeq: 7,
      upsertNodes: [{ ...file("b.ts", ".", "."), inDegree: 2 }, file("c.ts", ".", ".")],
      removeNodeIds: ["a.ts"],
      addEdges: [{ id: "imp:c.ts->b.ts", from: "c.ts", to: "b.ts", kind: "import" }],
      removeEdgeIds: [],
    }, 0);
    expect(next.seq).toBe(8);
    expect(next.nodes.map((n) => n.id)).toEqual(["b.ts", "c.ts"]);
    expect(next.nodes[0]!.inDegree).toBe(2);
    /* The removed node's edges go with it. */
    expect(next.edges.map((e) => e.id)).toEqual(["imp:c.ts->b.ts"]);
  });

  it("flags a refresh instead of applying a delta for another generation", () => {
    const next = applyMessage(base, { type: "graph_delta", seq: 9, baseSeq: 8, upsertNodes: [], removeNodeIds: [], addEdges: [], removeEdgeIds: [] }, 0);
    expect(next.needsRefresh).toBe(true);
    expect(next.nodes).toBe(base.nodes);
  });
});

describe("display options, colors, and motion", () => {
  afterEach(() => setColorCodebases([]));

  it("clamps the focus budget and defaults the new layers", () => {
    const normalized = normalizeDisplayOptions({ ...DEFAULT_DISPLAY_OPTIONS, focusBudget: 5 });
    expect(normalized.focusBudget).toBe(200);
    expect(normalized.showCochange).toBe(false);
    expect(normalized.showProjectRefs).toBe(true);
  });

  it("gives folders of one codebase a shared hue family once there are several codebases", () => {
    const before = folderColor("web/ui");
    expect(setColorCodebases(["web", "api"])).toBe(true);
    expect(setColorCodebases(["api", "web"])).toBe(false);
    const hue = (color: number): number => {
      const r = ((color >> 16) & 0xff) / 255, g = ((color >> 8) & 0xff) / 255, b = (color & 0xff) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const distance = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    expect(distance(hue(folderColor("web/ui")), hue(folderColor("web")))).toBeLessThanOrEqual(16);
    expect(distance(hue(folderColor("web/data")), hue(folderColor("web")))).toBeLessThanOrEqual(16);
    setColorCodebases([]);
    expect(folderColor("web/ui")).toBe(before);
  });

  it("animates co-change as two particles meeting, then silence", () => {
    const signature = signatureForEdgeKind("cochange");
    expect(signature.motion).toBe("echo");
    const early = flowParticles(signature, 0, signature.periodMs * 0.2);
    expect(early).toHaveLength(2);
    expect(early[0]!.t).toBeLessThan(0.5);
    expect(early[1]!.t).toBeGreaterThan(0.5);
    expect(flowParticles(signature, 0, signature.periodMs * 0.75)).toEqual([]);
  });
});
