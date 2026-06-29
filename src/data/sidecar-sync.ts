// Compute and apply the SQLite → sidecar mirror.
//
// SQLite remains the canonical control plane; the sidecar stores vector-heavy data.
// The sync plan is a pure diff (testable) over content hashes; applying it streams
// the required upserts/deletes through whatever remote vector provider is active.

import type { DatabaseManager } from "./database-manager.js";
import type { VectorProvider, VectorRecord } from "./vector-provider.js";

export interface SyncItem {
  id: string;
  /** Content hash (or any change token); used to detect rows that need re-pushing. */
  hash: string;
}

export interface SyncPlan {
  toUpsert: string[];
  toDelete: string[];
  unchanged: number;
}

/**
 * Diff local vs. remote by id+hash:
 *   - ids present locally but missing/changed remotely → upsert
 *   - ids present remotely but absent locally → delete
 */
export function computeSyncPlan(local: SyncItem[], remote: SyncItem[]): SyncPlan {
  const remoteById = new Map(remote.map((r) => [r.id, r.hash]));
  const localIds = new Set(local.map((l) => l.id));

  const toUpsert: string[] = [];
  let unchanged = 0;
  for (const item of local) {
    const remoteHash = remoteById.get(item.id);
    if (remoteHash === undefined || remoteHash !== item.hash) toUpsert.push(item.id);
    else unchanged++;
  }

  const toDelete: string[] = [];
  for (const item of remote) {
    if (!localIds.has(item.id)) toDelete.push(item.id);
  }

  return { toUpsert, toDelete, unchanged };
}

interface EmbeddingRow extends Record<string, unknown> {
  id: string;
  collection: string;
  model: string | null;
  vector: string;
  payload: string | null;
}

/** Cheap stable hash of a stored vector row, used as the sync change token. */
function rowHash(vector: string, payload: string | null): string {
  let h = 0x811c9dc5;
  const input = `${vector}|${payload ?? ""}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export interface SyncResult {
  upserted: number;
  deleted: number;
  unchanged: number;
}

export class SidecarSync {
  constructor(
    private readonly db: DatabaseManager,
    private readonly remote: VectorProvider,
  ) {}

  /** Snapshot the local embeddings as sync items (id + content hash). */
  localItems(): SyncItem[] {
    const rows = this.db.all<EmbeddingRow>("SELECT id, vector, payload FROM core_embeddings");
    return rows.map((r) => ({ id: r.id, hash: rowHash(r.vector, r.payload) }));
  }

  /**
   * Mirror the local store into the remote vector provider. `remoteItems` is the
   * remote's current id+hash snapshot (the caller supplies it since each backend
   * reports state differently). Deletes are applied first, then changed upserts.
   */
  async mirror(remoteItems: SyncItem[]): Promise<SyncResult> {
    const local = this.localItems();
    const plan = computeSyncPlan(local, remoteItems);

    for (const id of plan.toDelete) {
      await this.remote.delete(id);
    }

    const upsertSet = new Set(plan.toUpsert);
    if (upsertSet.size > 0) {
      const rows = this.db.all<EmbeddingRow>("SELECT id, collection, model, vector, payload FROM core_embeddings");
      const records: VectorRecord[] = [];
      for (const row of rows) {
        if (!upsertSet.has(row.id)) continue;
        let vector: number[];
        try { vector = JSON.parse(row.vector) as number[]; } catch { continue; }
        let payload: Record<string, unknown> | undefined;
        try { payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined; } catch { payload = undefined; }
        records.push({ id: row.id, vector, payload, collection: row.collection, model: row.model ?? undefined });
      }
      await this.remote.upsertBatch(records);
    }

    return { upserted: plan.toUpsert.length, deleted: plan.toDelete.length, unchanged: plan.unchanged };
  }
}
