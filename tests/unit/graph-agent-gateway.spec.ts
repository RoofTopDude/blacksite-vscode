import { describe, expect, it } from "vitest";
import { GraphAgentGateway } from "../../src/graph-agent-gateway.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";
import type { GraphAnnotationStore, GraphAnnotation } from "../../src/graph-annotation-store.js";
import type { GraphIndexer } from "../../src/graph/graph-indexer.js";
import type { RelationshipSnapshot } from "../../src/graph/relationship-snapshot.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../../src/graph/graph-model.js";

const roots = buildWorkspaceRoots([{ name: "ws", path: "/repo" }]);

function node(id: string): GraphNode {
  return { id, dir: "src", lang: "cs", sizeBytes: 1, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.5 };
}

function importEdge(from: string, to: string): GraphEdge {
  return { id: `imp:${from}->${to}`, from, to, kind: "import" };
}

const snapshot: GraphSnapshot = {
  nodes: [node("src/a.ts"), node("src/b.ts")],
  edges: [importEdge("src/a.ts", "src/b.ts")],
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

function makeGateway(symbolEdges: GraphEdge[] = []): GraphAgentGateway {
  dispatched = [];
  const indexer = { snapshot: () => snapshot } as unknown as GraphIndexer;
  const relationships = {
    get: () => ({ edges: [serviceEdge], truncated: false }),
    full: () => [serviceEdge],
  } as unknown as RelationshipSnapshot;
  const annotations = {
    list: () => [note],
    dispatch: async (op: string) => { dispatched.push({ op }); return { ok: true, op }; },
  } as unknown as GraphAnnotationStore;
  return new GraphAgentGateway(annotations, indexer, relationships, () => roots, () => symbolEdges);
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
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.symbolRelationCount).toBe(1);
    expect((file.symbolRelations as Record<string, unknown>[])[0]).toMatchObject({
      kind: "call", direction: "outbound", peerFile: "src/b.ts", symbol: "doThing",
    });
  });

  it("omits symbol relations when the sweep is off (empty edge set)", async () => {
    const result = await makeGateway().dispatch("relationships", { path: "src/a.ts" }, { sessionId: "s" });
    const file = (result.files as Record<string, unknown>[])[0]!;
    expect(file.symbolRelationCount).toBe(0);
    expect(file.symbolRelations).toEqual([]);
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
