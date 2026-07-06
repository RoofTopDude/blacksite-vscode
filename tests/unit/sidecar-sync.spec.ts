import { describe, expect, it } from "vitest";
import { computeSyncPlan, SidecarSync } from "../../src/data/sidecar-sync.js";
import type { DatabaseManager } from "../../src/data/database-manager.js";
import type { VectorProvider, VectorRecord } from "../../src/data/vector-provider.js";

describe("computeSyncPlan", () => {
  it("upserts changed/new ids and deletes remote-only ids", () => {
    const local = [{ id: "a", hash: "1" }, { id: "b", hash: "2" }, { id: "c", hash: "3" }];
    const remote = [{ id: "a", hash: "1" }, { id: "b", hash: "OLD" }, { id: "z", hash: "9" }];
    const plan = computeSyncPlan(local, remote);
    expect([...plan.toUpsert].sort()).toEqual(["b", "c"]); // b changed, c is new
    expect(plan.toDelete).toEqual(["z"]);                  // z exists only remotely
    expect(plan.unchanged).toBe(1);                        // a is identical
  });

  it("treats an empty remote snapshot as a full push with no deletes", () => {
    const local = [{ id: "a", hash: "1" }, { id: "b", hash: "2" }];
    const plan = computeSyncPlan(local, []);
    expect([...plan.toUpsert].sort()).toEqual(["a", "b"]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });
});

describe("SidecarSync.mirror", () => {
  function fakeDb(rows: Array<Record<string, unknown>>): DatabaseManager {
    return { all: () => rows } as unknown as DatabaseManager;
  }

  function fakeRemote(): { provider: VectorProvider; upserted: VectorRecord[]; deleted: string[] } {
    const upserted: VectorRecord[] = [];
    const deleted: string[] = [];
    const provider = {
      upsertBatch: async (records: VectorRecord[]) => { upserted.push(...records); },
      delete: async (id: string) => { deleted.push(id); return true; },
    } as unknown as VectorProvider;
    return { provider, upserted, deleted };
  }

  it("full-pushes every local row and deletes nothing when the remote snapshot is empty", async () => {
    const rows = [
      { id: "a", collection: "default", model: "m1", vector: JSON.stringify([0.1, 0.2]), payload: JSON.stringify({ t: "x" }) },
      { id: "b", collection: "default", model: null, vector: JSON.stringify([0.3, 0.4]), payload: null },
    ];
    const remote = fakeRemote();
    const result = await new SidecarSync(fakeDb(rows), remote.provider).mirror([]);

    expect(result).toEqual({ upserted: 2, deleted: 0, unchanged: 0 });
    expect(remote.upserted.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(remote.deleted).toEqual([]);
    // Vectors are parsed back out of the stored JSON before upserting.
    expect(remote.upserted.find((r) => r.id === "a")?.vector).toEqual([0.1, 0.2]);
  });

  it("skips rows whose stored vector is not valid JSON", async () => {
    const rows = [
      { id: "a", collection: "default", model: null, vector: "not-json", payload: null },
      { id: "b", collection: "default", model: null, vector: JSON.stringify([1]), payload: null },
    ];
    const remote = fakeRemote();
    await new SidecarSync(fakeDb(rows), remote.provider).mirror([]);
    expect(remote.upserted.map((r) => r.id)).toEqual(["b"]);
  });
});
