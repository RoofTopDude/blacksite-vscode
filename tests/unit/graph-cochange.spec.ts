import { describe, expect, it } from "vitest";
import { cochangeEdges, cochangePairs } from "../../src/graph/cochange.js";
import { parseGitCommits } from "../../src/graph/git-log.js";
import { buildAdjacency, findNodes, traverseImpact } from "../../src/graph/map-queries.js";
import { exclusionPolicy, exclusionPolicyKey } from "../../src/graph/exclusions.js";
import type { GraphNode } from "../../src/graph/graph-model.js";

describe("parseGitCommits", () => {
  it("groups files per commit and drops single-file and bulk commits", () => {
    const bulk = Array.from({ length: 41 }, (_, i) => `gen/f${i}.ts`).join("\n");
    const out = [
      "commit:300", "", "a.ts", "b.ts",
      "commit:200", "", "a.ts",
      "commit:100", "", bulk,
      "commit:50", "", "c.ts", "d.ts", "c.ts",
    ].join("\n");
    expect(parseGitCommits(out)).toEqual([["a.ts", "b.ts"], ["c.ts", "d.ts"]]);
  });
});

describe("co-change", () => {
  const commits = [
    ...Array.from({ length: 4 }, () => ["api/handler.ts", "web/client.ts"]),
    ["api/handler.ts", "web/client.ts", "README.md"],
    ["noisy/a.ts", "noisy/b.ts"],
    ...Array.from({ length: 20 }, (_, i) => [`noisy/a.ts`, `other${i}.ts`]),
    ...Array.from({ length: 20 }, (_, i) => [`noisy/b.ts`, `else${i}.ts`]),
  ];

  it("keeps pairs with enough shared commits and confidence", () => {
    const pairs = cochangePairs(commits);
    const hit = pairs.find((p) => p.a === "api/handler.ts" && p.b === "web/client.ts");
    expect(hit?.support).toBe(5);
    expect(hit?.confidence).toBe(1);
  });

  it("rejects files that change constantly but rarely together", () => {
    const pairs = cochangePairs(commits, { minSupport: 1, minConfidence: 0.3, maxPerFile: 8, maxEdges: 100 });
    expect(pairs.some((p) => p.a === "noisy/a.ts" && p.b === "noisy/b.ts")).toBe(false);
  });

  it("caps partners per file", () => {
    const hub = Array.from({ length: 12 }, (_, i) => Array.from({ length: 3 }, () => ["hub.ts", `p${i}.ts`])).flat();
    const pairs = cochangePairs(hub, { minSupport: 3, minConfidence: 0.1, maxPerFile: 5, maxEdges: 100 });
    expect(pairs.filter((p) => p.a === "hub.ts" || p.b === "hub.ts")).toHaveLength(5);
  });

  it("becomes undirected edges the map queries walk both ways, opt-in", () => {
    const edges = cochangeEdges(cochangePairs(commits));
    expect(edges[0]).toMatchObject({ kind: "cochange", provenance: "history", occurrenceCount: 5 });
    const without = buildAdjacency({ cochangeEdges: edges });
    expect(without.ids.size).toBe(0);
    const adjacency = buildAdjacency({ cochangeEdges: edges, layers: ["history"] });
    const fromClient = traverseImpact(adjacency, ["web/client.ts"], { direction: "dependents", maxDepth: 1, maxNodes: 10 });
    expect(fromClient.hits.map((h) => h.id)).toContain("api/handler.ts");
  });
});

describe("findNodes codebase filter", () => {
  const node = (id: string, codebase?: string): GraphNode => ({ id, dir: ".", lang: "ts", sizeBytes: 1, inDegree: 0, outDegree: 0, x: 0, y: 0, z: 0.2, ...(codebase ? { codebase } : {}) });
  it("matches a codebase by root path or its trailing name", () => {
    const nodes = [node("apps/web/a.ts", "apps/web"), node("services/api/b.ts", "services/api"), node("loose.ts")];
    expect(findNodes(nodes, { codebase: "apps/web" }).files.map((f) => f.path)).toEqual(["apps/web/a.ts"]);
    expect(findNodes(nodes, { codebase: "api" }).files.map((f) => f.path)).toEqual(["services/api/b.ts"]);
    expect(findNodes(nodes, { codebase: "api" }).files[0]?.codebase).toBe("services/api");
  });
});

describe("exclusion policy key", () => {
  it("keys a .gitignore-aware corpus differently, so toggling it rebuilds", () => {
    const base = { excludeDotDirectories: true, dotDirectoryAllowlist: [] };
    expect(exclusionPolicyKey(exclusionPolicy({ ...base, respectGitignore: true })))
      .not.toBe(exclusionPolicyKey(exclusionPolicy({ ...base, respectGitignore: false })));
    expect(exclusionPolicyKey(exclusionPolicy(base))).toBe("dot:1|allow:");
  });
});
