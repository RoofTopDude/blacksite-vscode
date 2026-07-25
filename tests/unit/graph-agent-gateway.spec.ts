import { describe, expect, it } from "vitest";
import { GraphAgentGateway } from "../../src/graph-agent-gateway.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";
import type { GraphAnnotationStore, GraphAnnotation } from "../../src/graph-annotation-store.js";
import type { GraphIndexer } from "../../src/graph/graph-indexer.js";
import type { RelationshipSnapshot } from "../../src/graph/relationship-snapshot.js";
import type { StructuralSnapshot } from "../../src/graph/structural-snapshot.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../../src/graph/graph-model.js";

const roots = buildWorkspaceRoots([{ name: "ws", path: "/repo" }]);

function node(id: string): GraphNode {
  return { id, dir: "src", lang: "cs", sizeBytes: 1, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5 };
}

function importEdge(from: string, to: string): GraphEdge {
  return { id: `imp:${from}->${to}`, from, to, kind: "import" };
}

const baseSnapshot: GraphSnapshot = {
  nodes: [node("src/a.ts"), node("src/b.ts")],
  edges: [importEdge("src/a.ts", "src/b.ts")],
  indexedAt: "2026-07-05T00:00:00.000Z",
  truncated: false,
};

/* A deeper graph for the transitive ops: src/a -> src/b -> src/c, plus an
   unrelated file so "everything is reachable" can't pass by accident. */
const deepSnapshot: GraphSnapshot = {
  nodes: [
    { ...node("src/a.ts"), outDegree: 1 },
    { ...node("src/b.ts"), inDegree: 1, outDegree: 1 },
    { ...node("src/c.ts"), inDegree: 1, churn: 7 },
    node("docs/notes.md"),
  ],
  edges: [importEdge("src/a.ts", "src/b.ts"), importEdge("src/b.ts", "src/c.ts")],
  indexedAt: "2026-07-05T00:00:00.000Z",
  truncated: false,
};

const serviceEdge: GraphEdge = {
  id: "rel:1", from: "svc:a", to: "svc:b", kind: "api",
  label: "GET /widgets", serviceFrom: "svc:a", serviceTo: "svc:b",
  sourcePath: "src/a.ts", targetPath: "src/b.ts", confidence: 0.9, evidence: ["fetch /widgets"],
};

const note: GraphAnnotation = {
  id: "n1", scope: "edge", from: "src/a.ts", to: "src/b.ts", kind: "ai", author: "agent",
  note: "a calls b", createdAt: "", updatedAt: "",
};

let dispatched: Array<{ op: string }> = [];

const symbolEdge: GraphEdge = {
  id: "sym:call:imp:src/a.ts->src/b.ts", from: "src/a.ts", to: "src/b.ts",
  kind: "call", provenance: "symbol", label: "doThing",
};

function makeGateway(
  symbolEdges: GraphEdge[] = [],
  options: { snapshot?: GraphSnapshot; structure?: StructuralSnapshot } = {},
): GraphAgentGateway {
  dispatched = [];
  const snapshot = options.snapshot ?? baseSnapshot;
  const indexer = {
    snapshot: () => snapshot,
    isIndexing: () => false,
    indexedFiles: () => snapshot.nodes.map((entry) => entry.id),
    importEdges: () => snapshot.edges,
    topology: () => ({
      projects: [
        { id: ".", root: ".", name: "workspace", kind: "npm", manifestFiles: ["package.json"] },
        { id: "packages/lib", root: "packages/lib", name: "lib", kind: "npm", manifestFiles: ["packages/lib/package.json"] },
      ],
      references: [{ from: ".", to: "packages/lib", kind: "package", evidence: "workspace dependency" }],
    }),
  } as unknown as GraphIndexer;
  const relationships = {
    get: () => ({ edges: [serviceEdge], truncated: false }),
    full: () => [serviceEdge],
  } as unknown as RelationshipSnapshot;
  const annotations = {
    list: () => [note],
    dispatch: async (op: string) => { dispatched.push({ op }); return { ok: true, op }; },
  } as unknown as GraphAnnotationStore;
  return new GraphAgentGateway(annotations, indexer, relationships, () => roots, () => symbolEdges, options.structure ?? null);
}

describe("GraphAgentGateway.dispatch — relationships", () => {
  it("returns imports, service relations, and notes for a file", async () => {
    const result = await makeGateway().dispatch("relationships", { path: "src/a.ts" }, { sessionId: "s" });
    expect(result.ok).toBe(true);
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.path).toBe("src/a.ts");
    expect(file.onMap).toBe(true);
    expect(file.imports).toEqual(["src/b.ts"]);
    expect(file.importedBy).toEqual([]);
    expect((file.serviceRelations as Record<string, unknown>[])[0]).toMatchObject({
      kind: "api", direction: "outbound", peerFile: "src/b.ts", toService: "svc:b",
    });
    expect(file.notes).toHaveLength(1);
  });

  it("surfaces background symbol edges (call/reference/supertype) when the sweep is on", async () => {
    const result = await makeGateway([symbolEdge]).dispatch("relationships", { path: "src/a.ts" }, { sessionId: "s" });
    expect(result.symbolLayer).toBe("active");
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.symbolRelationCount).toBe(1);
    expect(file).not.toHaveProperty("symbolRelationsUnavailable");
    expect((file.symbolRelations as Record<string, unknown>[])[0]).toMatchObject({
      kind: "call", direction: "outbound", peerFile: "src/b.ts", symbol: "doThing",
    });
  });

  it("flags symbol relations as unavailable when the sweep is off (empty edge set)", async () => {
    const result = await makeGateway().dispatch("relationships", { path: "src/a.ts" }, { sessionId: "s" });
    expect(result.symbolLayer).toBe("inactive");
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.symbolRelationCount).toBe(0);
    expect(file.symbolRelations).toEqual([]);
    /* Empty because not analyzed, not because there are no relations — the
       caller must be able to tell the difference. */
    expect(file.symbolRelationsUnavailable).toBe(true);
  });

  it("reports imported-by from the other direction of the edge", async () => {
    const result = await makeGateway().dispatch("relationships", { path: "src/b.ts" }, { sessionId: "s" });
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.importedBy).toEqual(["src/a.ts"]);
    expect((file.serviceRelations as Record<string, unknown>[])[0]).toMatchObject({ direction: "inbound", peerFile: "src/a.ts" });
  });

  it("accepts an absolute path and flags files that aren't on the map", async () => {
    const result = await makeGateway().dispatch("relationships", { paths: ["/repo/src/a.ts", "src/ghost.ts"] }, { sessionId: "s" });
    const files = result.files as Record<string, unknown>[];
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/ghost.ts"]);
    expect(files[1]!.onMap).toBe(false);
    expect(files[1]!).toHaveProperty("warning");
  });

  it("errors when no path is supplied", async () => {
    const result = await makeGateway().dispatch("relationships", {}, { sessionId: "s" });
    expect(result.ok).toBe(false);
  });

  it("delegates note ops to the annotation store", async () => {
    const gateway = makeGateway();
    await gateway.dispatch("add", { from: "src/a.ts", to: "src/b.ts", note: "n" }, { sessionId: "s" });
    await gateway.dispatch("list", {}, { sessionId: "s" });
    expect(dispatched.map((d) => d.op)).toEqual(["add", "list"]);
  });
});

describe("GraphAgentGateway.dispatch — workspace overview", () => {
  it("returns project topology, ranked areas/hubs, and aggregated service flows", async () => {
    const result = await makeGateway([symbolEdge]).dispatch("overview", { limit: 5 }, { sessionId: "s" });

    expect(result.ok).toBe(true);
    expect(result.coverage).toMatchObject({ indexedFiles: 2, importEdges: 1, serviceEdges: 1, symbolEdges: 1 });
    expect(result.projects).toHaveLength(2);
    expect(result.projectReferences).toEqual([
      expect.objectContaining({ from: ".", to: "packages/lib", kind: "package" }),
    ]);
    expect(result.hubs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/a.ts" })]));
    expect(result.serviceFlows).toEqual([
      expect.objectContaining({ from: "svc:a", to: "svc:b", kind: "api", occurrences: 1 }),
    ]);
  });

  it("formats a compact provider-neutral orientation block for automatic context injection", async () => {
    const text = await makeGateway().workspaceOverview();

    expect(text).toContain("Index: 2 files");
    expect(text).toContain("Projects:");
    expect(text).toContain("Dependency hubs:");
    expect(text).toContain("svc:a -> svc:b");
  });

  it("surfaces the structural analysis the Map already renders for the user", async () => {
    const structure = {
      get: () => ({
        cyclicNeighborhoodPairs: [[".", "packages/lib"]] as Array<[string, string]>,
        orphanNodeIds: ["src/stranded.ts"],
        pocketNodeIds: [],
        bridgeEdgeIds: ["imp:src/a.ts->src/b.ts"],
      }),
    } as unknown as StructuralSnapshot;
    const result = await makeGateway([], { structure }).dispatch("overview", {}, { sessionId: "s" });

    expect(result.structure).toMatchObject({
      projectCycles: [{ between: ["workspace", "lib"] }],
      orphanCount: 1,
      orphans: ["src/stranded.ts"],
      bridgeEdgeCount: 1,
    });
    // Empty categories stay absent rather than rendering as noise.
    expect(result.structure).not.toHaveProperty("pockets");
  });

  it("omits the structural section entirely when the snapshot isn't wired", async () => {
    const result = await makeGateway().dispatch("overview", {}, { sessionId: "s" });
    expect(result).not.toHaveProperty("structure");
  });
});

describe("GraphAgentGateway.dispatch — impact", () => {
  const deep = () => makeGateway([], { snapshot: deepSnapshot });

  it("walks dependents transitively and reports the chain back to the seed", async () => {
    const result = await deep().dispatch("impact", { path: "src/c.ts", depth: 3 }, { sessionId: "s" });

    expect(result.ok).toBe(true);
    expect(result.direction).toBe("dependents");
    expect(result.reachedCount).toBe(2);
    const files = result.files as Record<string, unknown>[];
    expect(files.map((f) => f.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(files[1]).toMatchObject({ depth: 2, relation: "dependent" });
    expect(files[1]!.via).toEqual(["src/a.ts -import-> src/b.ts", "src/b.ts -import-> src/c.ts"]);
  });

  it("respects depth, so a one-hop query matches map_relationships", async () => {
    const result = await deep().dispatch("impact", { path: "src/c.ts", depth: 1 }, { sessionId: "s" });
    expect((result.files as Record<string, unknown>[]).map((f) => f.path)).toEqual(["src/b.ts"]);
  });

  it("walks dependencies the other way when asked", async () => {
    const result = await deep().dispatch("impact", { path: "src/a.ts", direction: "dependencies" }, { sessionId: "s" });
    expect((result.files as Record<string, unknown>[]).map((f) => f.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("groups the radius by area and buckets it by depth", async () => {
    const result = await deep().dispatch("impact", { path: "src/c.ts" }, { sessionId: "s" });
    expect(result.areas).toEqual([{ area: "src", files: 2 }]);
    expect(result.byDepth).toEqual([{ depth: 1, files: 1 }, { depth: 2, files: 1 }]);
  });

  it("flags truncation and says how to widen the query", async () => {
    const result = await deep().dispatch("impact", { path: "src/c.ts", limit: 1 }, { sessionId: "s" });
    expect(result.truncated).toBe(true);
    expect(result.truncationHint).toContain("limit");
  });

  it("errors with the offending paths when nothing resolves", async () => {
    const result = await deep().dispatch("impact", { path: "../outside.ts" }, { sessionId: "s" });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("../outside.ts");
  });

  it("reports partial resolution instead of silently dropping bad paths", async () => {
    const result = await deep().dispatch("impact", { paths: ["src/c.ts", "../outside.ts"] }, { sessionId: "s" });
    expect(result.ok).toBe(true);
    expect(result.unresolved).toEqual(["../outside.ts"]);
  });
});

describe("GraphAgentGateway.dispatch — routes", () => {
  const deep = () => makeGateway([], { snapshot: deepSnapshot });

  it("returns the concrete chain between two files", async () => {
    const result = await deep().dispatch("routes", { from: "src/a.ts", to: "src/c.ts" }, { sessionId: "s" });

    expect(result.ok).toBe(true);
    expect(result.routeCount).toBe(1);
    const route = (result.routes as Record<string, unknown>[])[0]!;
    expect(route.path).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect((route.steps as Record<string, unknown>[])[0]).toMatchObject({
      from: "src/a.ts", to: "src/b.ts", kind: "import", layer: "import",
    });
  });

  it("collapses parallel links into one route instead of spending the budget twice", async () => {
    /* The fixture joins src/a.ts → src/b.ts with both an import edge and an API
       service edge. That's one hop with two kinds, not two routes. */
    const result = await deep().dispatch("routes", { from: "src/a.ts", to: "src/b.ts" }, { sessionId: "s" });
    expect(result.routeCount).toBe(1);
    const step = ((result.routes as Record<string, unknown>[])[0]!.steps as Record<string, unknown>[])[0]!;
    expect(step.alsoLinkedBy).toEqual(["api"]);
  });

  it("answers 'no connection' as a result with a hint, not as a failure", async () => {
    const result = await deep().dispatch("routes", { from: "src/a.ts", to: "docs/notes.md" }, { sessionId: "s" });
    expect(result.ok).toBe(true);
    expect(result.routes).toEqual([]);
    expect(String(result.hint)).toContain("maxHops");
  });

  it("follows arrows strictly under directedOnly", async () => {
    const undirected = await deep().dispatch("routes", { from: "src/c.ts", to: "src/a.ts" }, { sessionId: "s" });
    expect(undirected.routeCount).toBe(1);
    const directed = await deep().dispatch("routes", { from: "src/c.ts", to: "src/a.ts", directedOnly: true }, { sessionId: "s" });
    expect(directed.routes).toEqual([]);
    expect(String(directed.hint)).toContain("directedOnly");
  });

  it("requires both endpoints and rejects a self-query", async () => {
    expect((await deep().dispatch("routes", { from: "src/a.ts" }, { sessionId: "s" })).ok).toBe(false);
    expect((await deep().dispatch("routes", { from: "src/a.ts", to: "src/a.ts" }, { sessionId: "s" })).ok).toBe(false);
  });
});

describe("GraphAgentGateway.dispatch — find", () => {
  const deep = () => makeGateway([], { snapshot: deepSnapshot });

  it("enumerates an area with per-file map facts", async () => {
    const result = await deep().dispatch("find", { area: "src" }, { sessionId: "s" });

    expect(result.ok).toBe(true);
    expect(result.matched).toBe(3);
    const files = result.files as Record<string, unknown>[];
    expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(files[0]).toHaveProperty("dependents");
    expect(files[0]).toHaveProperty("area");
  });

  it("reports how many matches were held back by the limit", async () => {
    const result = await deep().dispatch("find", { area: "src", limit: 1 }, { sessionId: "s" });
    expect(result.returned).toBe(1);
    expect(result.more).toBe(2);
  });

  it("falls back to the default ranking for an unknown sortBy rather than failing", async () => {
    const result = await deep().dispatch("find", { sortBy: "nonsense" }, { sessionId: "s" });
    expect(result.ok).toBe(true);
    expect(result.sortBy).toBe("degree");
  });

  it("flags a missing git layer so a churn ranking isn't read as authoritative", async () => {
    const withGit = await deep().dispatch("find", {}, { sessionId: "s" });
    expect(withGit).not.toHaveProperty("gitLayerUnavailable");
    const withoutGit = await makeGateway().dispatch("find", { sortBy: "churn" }, { sessionId: "s" });
    expect(withoutGit.gitLayerUnavailable).toBe(true);
  });
});

describe("GraphAgentGateway.localOverview", () => {
  it("summarizes the open files' map neighbourhood without a tool call", async () => {
    const text = await makeGateway([], { snapshot: deepSnapshot }).localOverview(["src/b.ts"]);

    expect(text).toContain("src/b.ts [src]");
    expect(text).toContain("1 dependents / 1 dependencies");
    expect(text).toContain("depended on by: src/a.ts");
    expect(text).toContain("depends on: src/c.ts");
  });

  it("attaches the file's durable notes", async () => {
    const text = await makeGateway([], { snapshot: deepSnapshot }).localOverview(["src/a.ts"]);
    expect(text).toContain("note: a calls b");
  });

  it("stays silent for files that aren't on the map, rather than implying they have no relations", async () => {
    expect(await makeGateway().localOverview(["src/ghost.ts"])).toBe("");
    expect(await makeGateway().localOverview([])).toBe("");
  });
});
