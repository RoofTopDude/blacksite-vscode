import { describe, expect, it } from "vitest";
import { RelationshipSnapshot, type RelationshipJobRunner } from "../../src/graph/relationship-snapshot.js";
import type { MapIndexReader } from "../../src/graph/index-reader.js";
import type { GraphConfig } from "../../src/graph/config.js";

/* A failed relationship build is meant to degrade to "keep the previous good
   generation". It must not degrade to a retry spin: the end-of-build "still
   stale? rebuild" check will happily restart an identical failing build, and
   when the throw happens before the first await that loop never yields, so the
   extension host stops responding entirely rather than just losing one lens. */

function fakeIndex(indexedAt: () => string, files: string[] = ["a.ts"]): MapIndexReader {
  return {
    indexedFiles: () => files,
    topology: () => null,
    snapshot: () => ({ indexedAt: indexedAt(), nodes: [], edges: [] }),
  } as unknown as MapIndexReader;
}

const config = () => ({ maxRelationshipEdges: 10 }) as unknown as GraphConfig;

/** A job runner that throws synchronously, before its first await, the hardest case for the
    retry loop. */
function failingJob(onAttempt: () => void): RelationshipJobRunner {
  return () => {
    onAttempt();
    throw new Error("relationship pass failed");
  };
}

/** Drains microtasks and timers for a while — long enough that an unbounded
 *  retry loop would run up a large attempt count (or wedge the loop outright). */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("RelationshipSnapshot failure handling", () => {
  it("stops retrying a generation whose build threw", async () => {
    let attempts = 0;
    const snapshot = new RelationshipSnapshot(fakeIndex(() => "T1"), failingJob(() => { attempts += 1; }), config);

    void snapshot.full();
    await settle();

    expect(attempts).toBe(1);
    expect(snapshot.isIndexing()).toBe(false);
  });

  it("does not rebuild on every read while the generation is unchanged", async () => {
    let attempts = 0;
    const snapshot = new RelationshipSnapshot(fakeIndex(() => "T1"), failingJob(() => { attempts += 1; }), config);

    void snapshot.full();
    await settle();
    for (let i = 0; i < 5; i += 1) snapshot.get();
    await settle();

    expect(attempts).toBe(1);
  });

  it("retries once the graph generation actually changes", async () => {
    let attempts = 0;
    let generation = "T1";
    const snapshot = new RelationshipSnapshot(fakeIndex(() => generation), failingJob(() => { attempts += 1; }), config);

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
    const edge = { id: "rel:1", from: "svc:a", to: "svc:b", kind: "api" as const };
    const snapshot = new RelationshipSnapshot(
      fakeIndex(() => generation, []),
      async () => {
        if (shouldThrow) throw new Error("relationship pass failed");
        return { edges: [edge], fromCache: false };
      },
      config,
    );

    void snapshot.full();
    await settle();
    const good = snapshot.full();
    expect(good).toEqual([edge]);

    shouldThrow = true;
    generation = "T2";
    void snapshot.full();
    await settle();

    expect(snapshot.full()).toEqual(good);
  });

  it("hands the job the indexed files and topology of the current generation", async () => {
    const seen: unknown[] = [];
    const snapshot = new RelationshipSnapshot(
      fakeIndex(() => "T1", ["a.ts", "b.ts"]),
      async (input) => {
        seen.push(input);
        return { edges: [], fromCache: false };
      },
      config,
    );

    await snapshot.fullAsync();

    expect(seen).toEqual([{ files: ["a.ts", "b.ts"], topology: null }]);
  });
});
