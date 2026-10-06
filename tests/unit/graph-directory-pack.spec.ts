import { describe, expect, it } from "vitest";
import { packEnclose } from "d3-hierarchy";
import { clusterBaseDir, couplingKey, packDirectoryTree, type PackCluster } from "../../src/graph/directory-pack.js";
import { computeLayout, LARGE_GRAPH_LAYOUT_THRESHOLD } from "../../src/graph/layout.js";
import type { GraphNode } from "../../src/graph/graph-model.js";

/* Directory-first placement: a folder's subtree is one region of the map, so
   sibling services never interleave and an oversized folder's chunks stay
   together. These pin that contract at the packer and through both layout paths. */

const gap = (): number => 20;
type Point = { x: number; y: number };
type Circle = { x: number; y: number; r: number };

function cluster(dir: string, radius = 30, count = 10, territory?: string): PackCluster {
  return { dir, radius, count, ...(territory ? { territory } : {}) };
}

/** Smallest circle holding every cluster disc of a subtree. It lies inside the
    subtree's own disc, so two of these overlap only if the subtrees do. */
function region(centers: ReadonlyMap<string, Point>, clusters: readonly PackCluster[], prefix: string): Circle {
  const inside = clusters.filter((c) => clusterBaseDir(c.dir) === prefix || c.dir.startsWith(`${prefix}/`));
  return packEnclose(inside.map((c) => ({ ...centers.get(c.dir)!, r: c.radius })))!;
}

function expectDisjoint(a: Circle, b: Circle): void {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1e-6);
}

describe("packDirectoryTree", () => {
  it("keeps every sibling subtree in its own region (services never interleave)", () => {
    const clusters = [
      ...["handlers", "db", "jobs", "util"].map((leaf) => cluster(`services/auth/${leaf}`)),
      ...["handlers", "db", "jobs"].map((leaf) => cluster(`services/billing/${leaf}`)),
      ...["api", "queue"].map((leaf) => cluster(`services/search/${leaf}`)),
      cluster("web/src", 60, 40),
    ];
    const { centers } = packDirectoryTree(clusters, { gap });
    const auth = region(centers, clusters, "services/auth");
    const billing = region(centers, clusters, "services/billing");
    const search = region(centers, clusters, "services/search");
    expectDisjoint(auth, billing);
    expectDisjoint(auth, search);
    expectDisjoint(billing, search);
    /* And no two cluster discs overlap anywhere. */
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = centers.get(clusters[i]!.dir)!;
        const b = centers.get(clusters[j]!.dir)!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(clusters[i]!.radius + clusters[j]!.radius - 1e-6);
      }
    }
  });

  it("packs the chunks of an oversized folder together inside that folder", () => {
    const clusters = [
      ...Array.from({ length: 8 }, (_, i) => cluster(`tests/unit#${i}`)),
      ...Array.from({ length: 3 }, (_, i) => cluster(`src#${i}`)),
      cluster("src/graph#0"), cluster("src/graph#1"), cluster("src/webview"),
    ];
    const { centers } = packDirectoryTree(clusters, { gap });
    expectDisjoint(region(centers, clusters, "tests/unit"), region(centers, clusters, "src"));
    expectDisjoint(region(centers, clusters, "src/graph"), region(centers, clusters, "src/webview"));
  });

  it("turns a subtree so the folder coupled to another part of the map faces it", () => {
    const clusters = [cluster("apps/web"), cluster("services/orders"), cluster("services/users")];
    const couplings = new Map([[couplingKey("apps/web", "services/orders"), 5]]);
    const { centers } = packDirectoryTree(clusters, { gap, couplings });
    const d = (a: string, b: string): number => Math.hypot(centers.get(a)!.x - centers.get(b)!.x, centers.get(a)!.y - centers.get(b)!.y);
    expect(d("apps/web", "services/orders")).toBeLessThan(d("apps/web", "services/users"));
  });

  it("puts codebase territories above the folder tree", () => {
    /* `shared/utils` is assigned to codebase "web" (say a manifest claims it),
       so it packs inside web's region even though its path is elsewhere. */
    const clusters = [
      cluster("web/src", 30, 10, "web"), cluster("web/lib", 30, 10, "web"), cluster("shared/utils", 30, 10, "web"),
      cluster("api/src", 30, 10, "api"), cluster("api/db", 30, 10, "api"),
    ];
    const { centers } = packDirectoryTree(clusters, { gap: (depth) => (depth === 1 ? 80 : 20) });
    const of = (dirs: string[]): Circle => packEnclose(dirs.map((dir) => ({ ...centers.get(dir)!, r: 30 })))!;
    expectDisjoint(of(["web/src", "web/lib", "shared/utils"]), of(["api/src", "api/db"]));
  });

  it("is deterministic and centres a lone cluster", () => {
    const clusters = [cluster("a/b"), cluster("a/c"), cluster("d")];
    const couplings = new Map([[couplingKey("a/b", "d"), 2]]);
    expect([...packDirectoryTree(clusters, { gap, couplings }).centers]).toEqual([...packDirectoryTree([...clusters].reverse(), { gap, couplings }).centers]);
    expect(packDirectoryTree([cluster("only")], { gap }).centers.get("only")).toEqual({ x: 0, y: 0 });
  });
});

describe("layout, directory first", () => {
  function nodesFor(dirs: Record<string, number>): GraphNode[] {
    return Object.entries(dirs).flatMap(([dir, count]) => Array.from({ length: count }, (_, i): GraphNode => ({
      id: `${dir}/f${i}.ts`, dir, lang: "ts", sizeBytes: 100, inDegree: i % 3, outDegree: 0, x: 0, y: 0, z: 0.5,
    })));
  }

  /** The files of two subtrees occupy disjoint regions of the map. */
  function expectSeparated(nodes: GraphNode[], positions: ReadonlyMap<string, Point>, a: string, b: string): void {
    const box = (prefix: string): Circle => packEnclose(nodes
      .filter((n) => n.dir === prefix || n.dir.startsWith(`${prefix}/`))
      .map((n) => ({ ...positions.get(n.id)!, r: 0 })))!;
    expectDisjoint(box(a), box(b));
  }

  it("keeps sibling services apart in the force layout despite cross-service imports", () => {
    const nodes = nodesFor({ "services/auth/a": 12, "services/auth/b": 10, "services/billing/a": 12, "services/billing/b": 9, web: 15 });
    /* Heavy coupling between auth/a and billing/b used to drag them together. */
    const edges = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, from: `services/auth/a/f${i}.ts`, to: `services/billing/b/f${i}.ts`, kind: "import" as const }));
    const positions = computeLayout(nodes, edges, { seed: 3 });
    expectSeparated(nodes, positions, "services/auth", "services/billing");
    expectSeparated(nodes, positions, "services/auth", "web");
  });

  it("keeps sibling services apart in the large-workspace layout", () => {
    const per = Math.ceil(LARGE_GRAPH_LAYOUT_THRESHOLD / 6);
    const nodes = nodesFor({
      "services/auth/a#0": per, "services/auth/a#1": per, "services/billing/a": per,
      "services/billing/b": per, "web/src": per, "web/lib": per,
    });
    const positions = computeLayout(nodes, [], { seed: 5 });
    expectSeparated(nodes, positions, "services/auth", "services/billing");
    expectSeparated(nodes, positions, "services", "web");
  });
});
