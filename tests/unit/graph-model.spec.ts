import { describe, expect, it } from "vitest";
import { assignClusters, clusterDir, sampleAcrossClusters } from "../../src/graph/graph-model.js";

describe("sampleAcrossClusters", () => {
  it("returns everything sorted when under the cap", () => {
    const files = ["b/two.ts", "a/one.ts"];
    expect(sampleAcrossClusters(files, 10)).toEqual(["a/one.ts", "b/two.ts"]);
  });

  it("gives every cluster representation instead of a flat alphabetical cut", () => {
    // "aaa" alone has more files than the cap — a flat sort+slice would show
    // only aaa/* and starve every other cluster off the map entirely.
    const aaa = Array.from({ length: 20 }, (_, i) => `aaa/file${String(i).padStart(2, "0")}.ts`);
    const files = [...aaa, "bbb/one.ts", "ccc/deep/nested/two.ts"];
    const result = sampleAcrossClusters(files, 6);
    expect(result).toHaveLength(6);
    expect(result).toContain("bbb/one.ts");
    expect(result).toContain("ccc/deep/nested/two.ts");
    expect(result.some((f) => f.startsWith("aaa/"))).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const files = Array.from({ length: 50 }, (_, i) => `dir${i % 5}/file${i}.ts`);
    const first = sampleAcrossClusters(files, 12);
    const second = sampleAcrossClusters(files, 12);
    expect(first).toEqual(second);
  });

  it("sorts the final sampled result regardless of input order", () => {
    const files = ["z/a.ts", "a/z.ts", "m/m.ts"];
    const result = sampleAcrossClusters(files, 3);
    expect(result).toEqual(["a/z.ts", "m/m.ts", "z/a.ts"]);
  });
});

describe("assignClusters", () => {
  it("matches clusterDir's 2-segment default when no cluster is oversized", () => {
    const files = ["src/webview/App.tsx", "src/graph/layout.ts", "package.json"];
    const result = assignClusters(files, 40);
    for (const file of files) expect(result.get(file)).toBe(clusterDir(file));
  });

  it("splits an oversized top-level cluster one segment deeper", () => {
    // 50 files under "packages/frontend/src/<n>/file.ts" — way over a cap of 10,
    // so clusterDir's 2-segment "packages/frontend" bucket must get split by
    // its 3rd segment ("packages/frontend/src") instead of staying one blob.
    const files = Array.from({ length: 50 }, (_, i) => `packages/frontend/src/comp${i}/file.ts`);
    const result = assignClusters(files, 10);
    const keys = new Set(result.values());
    expect(keys.size).toBeGreaterThan(1);
    for (const key of keys) expect(key.startsWith("packages/frontend")).toBe(true);
  });

  it("keeps every member of a cluster together once it can't split further", () => {
    // All files live directly in the same single directory — there is no
    // deeper segment to split on, so an oversized cluster here must settle
    // rather than recurse forever.
    const files = Array.from({ length: 50 }, (_, i) => `packages/frontend/file${i}.ts`);
    const result = assignClusters(files, 10);
    const keys = new Set(result.values());
    expect(keys).toEqual(new Set(["packages/frontend"]));
  });

  it("never recurses past maxDepth even for a deeply nested oversized cluster", () => {
    const files = Array.from({ length: 50 }, (_, i) => `a/b/c/d/e/f/g/h/file${i}.ts`);
    const result = assignClusters(files, 5, 4);
    for (const key of result.values()) {
      expect(key.split("/").length).toBeLessThanOrEqual(4);
    }
  });

  it("splits an oversized cluster by import community when maxDepth is reached, not just when out of path segments", () => {
    const groupA = Array.from({ length: 10 }, (_, i) => `a/b/c/d/e/f/g/h/fileA${i}.ts`);
    const groupB = Array.from({ length: 10 }, (_, i) => `a/b/c/d/e/f/g/h/fileB${i}.ts`);
    const files = [...groupA, ...groupB];
    const edges = new Map<string, string[]>([
      [groupA[0]!, groupA.slice(1)],
      [groupB[0]!, groupB.slice(1)],
    ]);
    // maxDepth=4 is reached well before any path segment could distinguish
    // fileA*/fileB* (they all share the same 8-segment directory prefix) —
    // this exercises the depth>=maxDepth "give up" branch specifically,
    // distinct from the "out of path segments" branch the other community
    // test above exercises.
    const result = assignClusters(files, 15, 4, edges);

    const keys = new Set(result.values());
    expect(keys.size).toBeGreaterThan(1); // maxDepth alone used to force one blob here

    const keyA = result.get(groupA[0]!);
    for (const f of groupA) expect(result.get(f)).toBe(keyA);
    const keyB = result.get(groupB[0]!);
    for (const f of groupB) expect(result.get(f)).toBe(keyB);
    expect(keyA).not.toBe(keyB);
  });

  it("clusters root-level files as \".\" regardless of depth", () => {
    const result = assignClusters(["README.md", "package.json"], 1);
    expect(result.get("README.md")).toBe(".");
    expect(result.get("package.json")).toBe(".");
  });

  it("is deterministic for the same input", () => {
    const files = Array.from({ length: 80 }, (_, i) => `pkg/area${i % 3}/mod${i % 7}/file${i}.ts`);
    const first = assignClusters(files, 8);
    const second = assignClusters(files, 8);
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
  });

  it("splits a flat oversized folder by import-graph community when edge data is supplied", () => {
    // Two disjoint 10-file "star" import structures sitting flat in one
    // folder — no deeper path segment exists to split by, so only the
    // import graph can tell the two groups apart.
    const groupA = Array.from({ length: 10 }, (_, i) => `packages/frontend/fileA${i}.ts`);
    const groupB = Array.from({ length: 10 }, (_, i) => `packages/frontend/fileB${i}.ts`);
    const files = [...groupA, ...groupB];
    const edges = new Map<string, string[]>([
      [groupA[0]!, groupA.slice(1)],
      [groupB[0]!, groupB.slice(1)],
    ]);
    const result = assignClusters(files, 15, 6, edges);

    const keys = new Set(result.values());
    expect(keys.size).toBeGreaterThan(1); // no longer one giant blob

    const keyA = result.get(groupA[0]!);
    for (const f of groupA) expect(result.get(f)).toBe(keyA);
    const keyB = result.get(groupB[0]!);
    for (const f of groupB) expect(result.get(f)).toBe(keyB);
    expect(keyA).not.toBe(keyB);
  });

  it("still splits a flat oversized folder with no internal import edges, via alphabetical fallback chunking", () => {
    const files = Array.from({ length: 50 }, (_, i) => `packages/frontend/file${String(i).padStart(2, "0")}.ts`);
    const result = assignClusters(files, 10, 6, new Map());

    const keys = new Set(result.values());
    expect(keys.size).toBeGreaterThan(1);
    for (const key of keys) expect(key.startsWith("packages/frontend")).toBe(true);
    expect(result.get(files[0]!)).not.toBe(result.get(files[49]!));

    const counts = new Map<string, number>();
    for (const key of result.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(10);
  });

  it("is deterministic for the same input with edge data supplied", () => {
    const files = Array.from({ length: 40 }, (_, i) => `packages/frontend/file${i}.ts`);
    const edges = new Map<string, string[]>();
    for (let i = 0; i < 40; i += 2) edges.set(files[i]!, [files[i + 1]!]);
    const first = assignClusters(files, 10, 6, edges);
    const second = assignClusters(files, 10, 6, edges);
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
  });
});
