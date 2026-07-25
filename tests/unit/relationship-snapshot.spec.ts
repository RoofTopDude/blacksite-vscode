import { describe, expect, it } from "vitest";
import { RelationshipSnapshot } from "../../src/graph/relationship-snapshot.js";
import type { GraphIndexer } from "../../src/graph/graph-indexer.js";
import type { GraphConfig } from "../../src/graph/config.js";

/* A failed relationship build is meant to degrade to "keep the previous good
   generation". It must not degrade to a retry spin: the end-of-build "still
   stale? rebuild" check will happily restart an identical failing build, and
   when the throw happens before the first await that loop never yields, so the
   extension host stops responding entirely rather than just losing one lens. */

function fakeIndexer(indexedAt: string): GraphIndexer {
  return {
    indexedFiles: () => ["a.ts"],
    topology: () => null,
    snapshot: () => ({ indexedAt, nodes: [], edges: [] }),
  } as unknown as GraphIndexer;
}

const config = () => ({ maxRelationshipEdges: 10 }) as unknown as GraphConfig;

/** Drains microtasks and timers for a while — long enough that an unbounded
 *  retry loop would run up a large attempt count (or wedge the loop outright). */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("RelationshipSnapshot failure handling", () => {
  it("stops retrying a generation whose build threw", async () => {
    let attempts = 0;
    const snapshot = new RelationshipSnapshot(
      () => { attempts += 1; throw new Error("roots unavailable"); },
      fakeIndexer("T1"),
      config,
    );

    void snapshot.full();
    await settle();

    expect(attempts).toBe(1);
    expect(snapshot.isIndexing()).toBe(false);
  });

  it("does not rebuild on every read while the generation is unchanged", async () => {
    let attempts = 0;
    const snapshot = new RelationshipSnapshot(
      () => { attempts += 1; throw new Error("roots unavailable"); },
      fakeIndexer("T1"),
      config,
    );

    void snapshot.full();
    await settle();
    for (let i = 0; i < 5; i += 1) snapshot.get();
    await settle();

    expect(attempts).toBe(1);
  });

  it("retries once the graph generation actually changes", async () => {
    let attempts = 0;
    let generation = "T1";
    const snapshot = new RelationshipSnapshot(
      () => { attempts += 1; throw new Error("roots unavailable"); },
      { indexedFiles: () => ["a.ts"], topology: () => null, snapshot: () => ({ indexedAt: generation, nodes: [], edges: [] }) } as unknown as GraphIndexer,
      config,
    );

    void snapshot.full();
    await settle();
    expect(attempts).toBe(1);

    generation = "T2"; // a save re-indexed the workspace
    void snapshot.full();
    await settle();
    expect(attempts).toBe(2);
  });

  it("keeps serving the last good edge set after a failure", async () => {
    let generation = "T1";
    let shouldThrow = false;
    const snapshot = new RelationshipSnapshot(
      () => {
        if (shouldThrow) throw new Error("roots unavailable");
        return [{ name: "workspace", path: "/ws" }];
      },
      { indexedFiles: () => [], topology: () => null, snapshot: () => ({ indexedAt: generation, nodes: [], edges: [] }) } as unknown as GraphIndexer,
      config,
    );

    void snapshot.full();
    await settle();
    const good = snapshot.full();

    shouldThrow = true;
    generation = "T2";
    void snapshot.full();
    await settle();

    expect(snapshot.full()).toEqual(good);
  });
});
