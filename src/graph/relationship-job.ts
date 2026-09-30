/* The service-relationship pass as an IO-injected job, so it runs in the
   background worker instead of reading the whole corpus on the extension host
   thread. The result is cached against a corpus fingerprint — every candidate
   file's (id, mtime, size) plus the topology shape — so reopening an unchanged
   workspace skips the pass entirely. */

import { createHash } from "node:crypto";
import { isDocLang, langOf, type GraphEdge } from "./graph-model.js";
import { buildServiceRelationships, isTestPath, type IndexedFileContent } from "./relationship-indexer.js";
import type { ProjectTopology } from "./project-topology.js";
import { isClientConfigPath } from "./client-config.js";
import type { FileStat } from "./index-job.js";

const MAX_FILE_BYTES = 512_000;
const READ_CONCURRENCY = 32;
export const RELATIONSHIP_CACHE_VERSION = 1;

export interface RelationshipJobInput {
  files: readonly string[];
  topology: ProjectTopology | null;
}

export interface RelationshipJobIO {
  stat(rel: string): Promise<FileStat | null>;
  read(rel: string): Promise<string | null>;
  readCache(): Promise<unknown>;
  writeCache(text: string): Promise<void>;
  yieldNow(): Promise<void>;
  cancelled(): boolean;
}

export interface RelationshipJobResult {
  edges: GraphEdge[];
  fromCache: boolean;
}

/** Whether a file can influence service relationships. Docs and tests are
    excluded upstream of every collector (see buildServiceRelationships), but
    service-root detection still wants every path — which the indexer passes
    separately as `files` — so only *content* is limited to this set. */
export function relationshipContentCandidate(rel: string): boolean {
  if (isClientConfigPath(rel)) return true;
  return !isDocLang(langOf(rel)) && !isTestPath(rel);
}

export function relationshipFingerprint(
  stats: ReadonlyArray<readonly [string, number, number]>,
  topology: ProjectTopology | null,
): string {
  const hash = createHash("sha256");
  hash.update(`v${RELATIONSHIP_CACHE_VERSION}\n`);
  for (const [id, m, s] of stats) hash.update(`${id}\0${m}\0${s}\n`);
  hash.update(`topology:${topology?.projects.length ?? 0}:${topology?.references.length ?? 0}`);
  for (const project of topology?.projects ?? []) hash.update(`\n${project.root}|${project.kind}|${project.containerRoot ?? ""}`);
  return hash.digest("hex");
}

export async function runRelationshipJob(input: RelationshipJobInput, io: RelationshipJobIO): Promise<RelationshipJobResult> {
  const stats: Array<[string, number, number]> = [];
  const candidates = input.files.filter(relationshipContentCandidate);
  let index = 0;
  const statWorkers = Array.from({ length: Math.min(READ_CONCURRENCY * 4, candidates.length) }, async () => {
    while (index < candidates.length) {
      const rel = candidates[index++]!;
      const stat = await io.stat(rel);
      if (stat) stats.push([rel, stat.mtimeMs, stat.size]);
    }
  });
  await Promise.all(statWorkers);
  stats.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const fingerprint = relationshipFingerprint(stats, input.topology);

  const cached = await io.readCache().catch(() => null) as { fingerprint?: unknown; edges?: unknown } | null;
  if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.edges)) {
    return { edges: cached.edges as GraphEdge[], fromCache: true };
  }

  const contents: IndexedFileContent[] = [];
  const readable = stats.filter(([, , size]) => size <= MAX_FILE_BYTES).map(([rel]) => rel);
  const contentByPath = new Map<string, string>();
  let next = 0;
  const readers = Array.from({ length: Math.min(READ_CONCURRENCY, readable.length) }, async () => {
    while (next < readable.length) {
      if (io.cancelled()) return;
      const rel = readable[next++]!;
      const content = await io.read(rel);
      if (content !== null) contentByPath.set(rel, content);
      if (next % 500 === 0) await io.yieldNow();
    }
  });
  await Promise.all(readers);
  if (io.cancelled()) throw new Error("cancelled");
  /* Paths without readable content still take part in service detection. */
  for (const rel of input.files) contents.push({ path: rel, content: contentByPath.get(rel) ?? "" });
  const result = buildServiceRelationships(contents, Infinity, input.topology);
  await io.writeCache(JSON.stringify({ fingerprint, edges: result.edges })).catch(() => undefined);
  return { edges: result.edges, fromCache: false };
}
