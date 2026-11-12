/* GraphIndexer against in-memory ports: what the indexer asks of its host, and what it does
   without the optional ports. The extension's own wiring (node-ports + vscode-ports) is covered by
   the Map goldens and graph-vscode-ports.spec.ts. */

import { describe, expect, it } from "vitest";
import { GraphIndexer } from "../../src/graph/graph-indexer.js";
import { defaultGraphConfig } from "../golden/map/map-harness.js";
import { Emitter, FakeWatcher, MemoryFiles, MemoryStorage, memoryPorts, rootsOf } from "./helpers/map-memory-ports.js";

const ROOT = "/ws";

async function idle(indexer: GraphIndexer): Promise<void> {
  for (let i = 0; i < 400 && (indexer.isIndexing() || indexer.snapshot() === null); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function workspace(): MemoryFiles {
  return new MemoryFiles({
    [`${ROOT}/src/a.ts`]: "import { b } from \"./b\";\nexport const a = b;\n",
    [`${ROOT}/src/b.ts`]: "export const b = 1;\n",
    [`${ROOT}/.tools/cache.ts`]: "export const hidden = 1;\n",
  });
}

describe("GraphIndexer ports", () => {
  it("discovers through the enumerator when the host has no git", async () => {
    const files = workspace();
    const indexer = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files));

    await indexer.rebuild();

    const snapshot = indexer.snapshot()!;
    expect(snapshot.nodes.map((node) => node.id).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(snapshot.edges.map((edge) => edge.id)).toEqual(["imp:src/a.ts->src/b.ts"]);
    expect(snapshot.hiddenByPolicyCount).toBe(1);
    expect(snapshot.gitignoreApplied).toBe(false);
    expect(indexer.cochangeEdges()).toEqual([]);
    expect(snapshot.nodes.every((node) => node.churn === undefined)).toBe(true);
    indexer.dispose();
  });

  it("indexes nothing, rather than failing, when the host can neither enumerate nor use git", async () => {
    const files = workspace();
    const indexer = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files, { enumerate: undefined }));

    await indexer.rebuild();

    expect(indexer.snapshot()?.nodes).toEqual([]);
    indexer.dispose();
  });

  it("start() subscribes the watcher and the roots event; dispose() releases both", async () => {
    const files = workspace();
    const watcher = new FakeWatcher();
    const roots = new Emitter<void>();
    let rootSubscriptions = 0;
    let rootDisposals = 0;
    const onDidChangeRoots = (listener: (value: void) => unknown) => {
      rootSubscriptions += 1;
      const subscription = roots.event(listener);
      return { dispose: () => { rootDisposals += 1; subscription.dispose(); } };
    };
    const indexer = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files, { watcher, onDidChangeRoots }));

    /* start() kicks off its own rebuild (a rebuild() call while one runs only queues another),
       so wait for indexing to go idle. */
    indexer.start();
    await idle(indexer);
    expect(watcher.onTouch).not.toBeNull();
    expect(rootSubscriptions).toBe(1);

    files.contents.set(`${ROOT}/src/c.ts`, "import { a } from \"./a\";\nexport const c = a;\n");
    watcher.onTouch!(`${ROOT}/src/c.ts`);
    watcher.onTouch!("/elsewhere/not-in-a-root.ts");
    await expect(indexer.flushPending()).resolves.toBe(1);
    expect(indexer.snapshot()?.edges.map((edge) => edge.id).sort()).toEqual(["imp:src/a.ts->src/b.ts", "imp:src/c.ts->src/a.ts"]);

    let rebuilt = false;
    indexer.onIndexingChanged((indexing) => { if (indexing) rebuilt = true; });
    roots.fire();
    expect(rebuilt).toBe(true);

    indexer.dispose();
    expect(watcher.disposed).toBe(true);
    expect(rootDisposals).toBe(1);
  });

  it("persists through storage, and a new indexer paints from it before its first rebuild", async () => {
    const files = workspace();
    const storage = new MemoryStorage();
    const first = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files, { storage }));
    await first.rebuild();
    first.dispose();

    expect([...storage.entries.keys()].sort()).toEqual(["corpus.json", "graph-cache.json"]);
    expect(JSON.parse(storage.read("corpus.json")!).files).toEqual(["src/a.ts", "src/b.ts"]);

    const second = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files, { storage }));
    expect(second.snapshot()?.nodes.map((node) => node.id).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    second.dispose();
  });

  it("treats an unreadable cache as no cache, and keeps indexing when storage refuses writes", async () => {
    const files = workspace();
    const storage = new MemoryStorage();
    storage.write("graph-cache.json", "{ not json");
    storage.write = () => { throw new Error("read-only"); };
    const indexer = new GraphIndexer(rootsOf(ROOT), () => defaultGraphConfig(), memoryPorts(files, { storage }));

    expect(indexer.snapshot()).toBeNull();
    await indexer.rebuild();
    expect(indexer.snapshot()?.nodes).toHaveLength(2);
    indexer.dispose();
  });
});
