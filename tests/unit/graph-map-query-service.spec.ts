import { describe, expect, it } from "vitest";
import { MapQueryService, formatWorkspaceOverview } from "../../src/graph/map-query-service.js";
import { GraphAgentGateway } from "../../src/graph-agent-gateway.js";
import type { MapIndexReader, ServiceRelationshipReader } from "../../src/graph/index-reader.js";
import type { GraphAnnotationStore } from "../../src/graph-annotation-store.js";
import type { GraphNode, GraphSnapshot } from "../../src/graph/graph-model.js";
import { buildWorkspaceRoots } from "../../src/graph/workspace-roots.js";

/* The query service's own contract: failures carry a code and a neutral message; the extension's
   gateway turns codes back into the map_* tools' wording (covered by the Map goldens). */

const roots = buildWorkspaceRoots([{ name: "ws", path: "/repo" }]);

function node(id: string, inDegree = 0, outDegree = 0): GraphNode {
  return { id, dir: "src", lang: "ts", sizeBytes: 1, inDegree, outDegree, x: 0, y: 0, z: 0.5 };
}

function index(snapshot: GraphSnapshot | null, indexing = false): MapIndexReader {
  return {
    snapshot: () => snapshot,
    nodeIndex: () => snapshot?.nodes ?? [],
    indexedFiles: () => snapshot?.nodes.map((entry) => entry.id) ?? [],
    corpusFiles: () => snapshot?.nodes.map((entry) => entry.id) ?? [],
    importEdges: () => snapshot?.edges ?? [],
    cochangeEdges: () => [],
    topology: () => null,
    isIndexing: () => indexing,
    isExcludedPath: (id) => id.startsWith(".tools/"),
    flushPending: async () => 0,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

const relationships: ServiceRelationshipReader = { full: () => [], fullAsync: async () => [] };
const notes = { list: () => [] };

const snapshot: GraphSnapshot = {
  nodes: [node("src/a.ts", 0, 1), node("src/b.ts", 1, 0)],
  edges: [{ id: "imp:src/a.ts->src/b.ts", from: "src/a.ts", to: "src/b.ts", kind: "import" }],
  indexedAt: "2026-11-12T00:00:00.000Z",
  truncated: false,
};

function service(current: GraphSnapshot | null, indexing = false): MapQueryService {
  return new MapQueryService({ index: index(current, indexing), relationships, roots: () => roots, notes });
}

describe("MapQueryService failures", () => {
  it("reports not_indexed before the first index, with whether a build is running on the overview", async () => {
    const queries = service(null, true);
    expect(await queries.overview({})).toEqual({ ok: false, code: "not_indexed", message: expect.any(String), indexing: true });
    for (const result of [
      await queries.find({}),
      await queries.relationships({ path: "src/a.ts" }),
      await queries.impact({ path: "src/a.ts" }),
      await queries.routes({ from: "src/a.ts", to: "src/b.ts" }),
    ]) {
      expect(result).toEqual({ ok: false, code: "not_indexed", message: expect.any(String) });
    }
    expect(await queries.workspaceOverview()).toBe("The index has not finished building yet — try again shortly.");
    expect(await queries.localOverview(["src/a.ts"])).toBe("");
  });

  it("reports bad_request and unresolved with the reason", async () => {
    const queries = service(snapshot);
    expect(await queries.relationships({})).toMatchObject({ ok: false, code: "bad_request" });
    expect(await queries.impact({ paths: [] })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await queries.routes({ from: "src/a.ts" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await queries.routes({ from: "src/a.ts", to: "./src/a.ts" })).toMatchObject({ ok: false, code: "bad_request", message: "`from` and `to` are the same file." });
    expect(await queries.impact({ path: "../outside.ts" })).toMatchObject({ ok: false, code: "unresolved", message: expect.stringContaining("../outside.ts") });
    expect(await queries.routes({ from: "src/a.ts", to: "../outside.ts" })).toMatchObject({ ok: false, code: "unresolved" });
  });

  it("names nothing product-specific in its own not-indexed message", async () => {
    const result = await service(null).find({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toMatch(/map_|Codebase Map|Blacksite/i);
  });
});

describe("MapQueryService answers", () => {
  it("answers relationships, impact and routes over the index", async () => {
    const queries = service(snapshot);
    const relationshipsResult = await queries.relationships({ path: "src/a.ts" });
    expect(relationshipsResult).toMatchObject({ ok: true, files: [{ path: "src/a.ts", imports: ["src/b.ts"], importedBy: [] }], symbolLayer: "inactive" });
    expect(await queries.impact({ path: "src/b.ts" })).toMatchObject({ ok: true, reachedCount: 1, files: [{ path: "src/a.ts", depth: 1 }] });
    expect(await queries.routes({ from: "src/a.ts", to: "src/b.ts" })).toMatchObject({ ok: true, routeCount: 1 });
    expect(queries.isMapIndexable(".tools/x.ts")).toBe(false);
    expect(queries.importDependents(["src/b.ts"])).toEqual(["src/a.ts"]);
  });

  it("formats the overview as the per-turn context block", async () => {
    const overview = await service(snapshot).overview({ limit: 5 });
    expect(overview.ok).toBe(true);
    if (overview.ok) expect(formatWorkspaceOverview(overview)).toContain("Index: 2 files, 1 import edges, 0 service edges, 0 symbol edges.");
  });

  it("is what the extension's gateway returns for a successful query, unchanged", async () => {
    const annotations = { list: () => [], dispatch: async () => ({ ok: true }) } as unknown as GraphAnnotationStore;
    const gateway = new GraphAgentGateway(annotations, index(snapshot), relationships, () => roots);
    const direct = await service(snapshot).impact({ path: "src/b.ts", depth: 2 });
    expect(await gateway.dispatch("impact", { path: "src/b.ts", depth: 2 }, { sessionId: "s" })).toEqual(direct);
  });
});
