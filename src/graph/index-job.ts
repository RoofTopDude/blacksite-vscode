/* One full Codebase Map rebuild as a pure, IO-injected job.

   GraphIndexer used to do all of this on the extension host thread — the same
   thread that runs chat and the agent — reading every file several times in
   50-file slices. The job below is what now runs in the background worker
   (graph/worker/graph-worker.ts). It is equally runnable inline (tests, or a
   host where the worker cannot start), because everything touching the disk
   comes in through `JobIO`.

   Steps: facts (cached, one read per changed file) → resolve context →
   adjacency over the indexed corpus → degrees → clusters → codebases →
   layout over **every indexed file** (so a scope can show files the global
   render sample dropped, at coordinates consistent with the rest of the map)
   → project topology. */

import {
  assignClusters,
  clusterDir,
  depthFromDegree,
  langOf,
  normalizeGraphPath,
  type GraphNode,
} from "./graph-model.js";
import {
  declaredTypeNames,
  extractFileFacts,
  finalizeRefs,
  parseFactsCache,
  refsStillValid,
  serializeFacts,
  type FileFacts,
} from "./file-facts.js";
import { buildResolveContextFromFacts, isResolverManifest, resolveAll } from "./scan-pipeline.js";
import { buildProjectTopology, type ProjectTopology } from "./project-topology.js";
import { assignNeighborhoods, shouldTerritorialize } from "./neighborhoods.js";
import { createLayout } from "./layout.js";
import type { ResolveContext } from "./resolve-imports.js";
import type { GraphNeighborhoodMode } from "./config.js";

/** Files larger than this are still import-scanned (the scanner windows them)
    but a pathological blob cannot stall a rebuild. Unchanged from the indexer. */
export const MAX_IMPORT_FILE_BYTES = 8_000_000;
const MAX_MANIFEST_BYTES = 512_000;
const MAX_TOPOLOGY_MANIFESTS = 20_000;
const READ_CONCURRENCY = 32;
const LAYOUT_TICK_CHUNK = 20;

const TOPOLOGY_MANIFEST_NAMES = new Set([
  "package.json", "pom.xml", "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
  "go.mod", "go.work", "pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json", "nx.json", "turbo.json",
  "rush.json", "cargo.toml", "pyproject.toml", "setup.cfg", "setup.py", "workspace", "workspace.bazel", "module.bazel",
]);
const TOPOLOGY_MANIFEST_EXT_RE = /\.(?:csproj|sln)$/i;

export function isTopologyManifest(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  return TOPOLOGY_MANIFEST_NAMES.has(name) || TOPOLOGY_MANIFEST_EXT_RE.test(name);
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface JobIO {
  stat(rel: string): Promise<FileStat | null>;
  read(rel: string): Promise<string | null>;
  readCache(): Promise<unknown>;
  writeCache(text: string): Promise<void>;
  progress(phase: IndexPhase, fraction: number): void;
  /** Cooperative yield (setImmediate). Inline runs need it; the worker's is a no-op. */
  yieldNow(): Promise<void>;
  cancelled(): boolean;
}

export type IndexPhase = "scan" | "resolve" | "layout";

export interface IndexJobInput {
  corpusFiles: readonly string[];
  indexedFiles: readonly string[];
  renderedFiles: readonly string[];
  rootNames: readonly string[];
  seed: number;
  /** Previous positions (id, x, y) — survivors start (and stay close to) there. */
  prevPositions: ReadonlyArray<readonly [string, number, number]>;
  neighborhoods: GraphNeighborhoodMode;
  /** Git churn / last-commit epoch per node id. */
  git: Readonly<Record<string, readonly [number, number]>>;
}

export interface IndexJobResult {
  /** Every indexed file, laid out, with corpus-wide degrees. */
  indexNodes: GraphNode[];
  /** Resolved import adjacency over the indexed corpus. */
  imports: Array<[string, string[]]>;
  topology: ProjectTopology;
  territorialize: boolean;
  /** Facts for every file that has them — the main thread keeps these for the
      cheap incremental pass. */
  facts: Array<[string, FileFacts]>;
  resolveContext: ResolveContext;
  stats: { factsReused: number; factsRead: number; ms: Record<string, number> };
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>, io: JobIO): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      if (io.cancelled()) return;
      const item = items[index++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Gather facts for `files`, reusing cached entries whose mtime+size match. */
export async function collectFacts(files: readonly string[], io: JobIO): Promise<{ facts: Map<string, FileFacts>; reused: number; read: number }> {
  const cached = parseFactsCache(await io.readCache().catch(() => null));
  const facts = new Map<string, FileFacts>();
  const needRead: string[] = [];
  const reusedCs: string[] = [];
  const reusedPhp: string[] = [];
  let done = 0;
  await mapLimit(files, READ_CONCURRENCY * 4, async (rel) => {
    const stat = await io.stat(rel);
    done += 1;
    if (done % 2000 === 0) io.progress("scan", Math.min(0.5, (done / files.length) * 0.5));
    if (!stat) return;
    const prior = cached?.files[rel];
    if (prior && prior.m === stat.mtimeMs && prior.s === stat.size) {
      facts.set(rel, prior);
      const lang = langOf(rel);
      if (lang === "cs") reusedCs.push(rel);
      else if (lang === "php") reusedPhp.push(rel);
      return;
    }
    needRead.push(rel);
    facts.set(rel, { m: stat.mtimeMs, s: stat.size });
  }, io);

  const readOne = async (rel: string): Promise<void> => {
    const shell = facts.get(rel);
    if (!shell) return;
    const limit = isResolverManifest(rel) ? MAX_MANIFEST_BYTES : MAX_IMPORT_FILE_BYTES;
    const content = shell.s > limit ? "" : (await io.read(rel)) ?? "";
    facts.set(rel, extractFileFacts(rel, content, shell.m, shell.s));
  };
  let readDone = 0;
  await mapLimit(needRead, READ_CONCURRENCY, async (rel) => {
    await readOne(rel);
    readDone += 1;
    if (readDone % 500 === 0) {
      io.progress("scan", 0.5 + 0.5 * (readDone / Math.max(1, needRead.length)));
      await io.yieldNow();
    }
  }, io);

  /* Cached C#/PHP refs were filtered against the names declared back then; a
     newly declared name could be missing from them, so re-read those files. */
  const names = declaredTypeNames(facts);
  const stale = [
    ...(cached && !refsStillValid(cached.csNames, names.cs) ? reusedCs : []),
    ...(cached && !refsStillValid(cached.phpNames, names.php) ? reusedPhp : []),
  ];
  await mapLimit(stale, READ_CONCURRENCY, readOne, io);
  finalizeRefs(facts, names);
  return { facts, reused: files.length - needRead.length - stale.length, read: needRead.length + stale.length };
}

export async function runIndexJob(input: IndexJobInput, io: JobIO): Promise<IndexJobResult> {
  const ms: Record<string, number> = {};
  let started = Date.now();
  const indexedSet = new Set(input.indexedFiles.map(normalizeGraphPath));
  /* Resolver manifests anywhere in the corpus feed the context even when the
     index cap sampled them out. */
  const factFiles = [...new Set([
    ...indexedSet,
    ...input.corpusFiles.filter((rel) => isResolverManifest(rel)),
  ])];
  const { facts, reused, read } = await collectFacts(factFiles, io);
  ms.scan = Date.now() - started;
  if (io.cancelled()) throw new Error("cancelled");

  /* Files that vanished between discovery and the stat are dropped here. */
  const indexedFiles = input.indexedFiles.filter((rel) => facts.has(rel));
  const fileSet = new Set(indexedFiles);

  started = Date.now();
  io.progress("resolve", 0);
  const resolveContext = buildResolveContextFromFacts(facts, fileSet, input.rootNames);
  const adjacency = resolveAll(indexedFiles, facts, fileSet, resolveContext);
  ms.resolve = Date.now() - started;
  await io.yieldNow();

  /* Topology from the manifests' content. Manifests are small and few, and
     their full text (not just the resolver facts) is what topology parses. */
  started = Date.now();
  const manifestPaths = input.corpusFiles.filter(isTopologyManifest).slice(0, MAX_TOPOLOGY_MANIFESTS);
  const manifests: Array<{ path: string; content: string }> = [];
  await mapLimit(manifestPaths, READ_CONCURRENCY, async (rel) => {
    const stat = await io.stat(rel);
    if (!stat || stat.size > MAX_MANIFEST_BYTES) return;
    const content = await io.read(rel);
    if (content !== null) manifests.push({ path: rel, content });
  }, io);
  manifests.sort((a, b) => a.path.localeCompare(b.path));
  const topology = buildProjectTopology(manifests);
  ms.topology = Date.now() - started;

  started = Date.now();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const [from, targets] of adjacency) {
    outDegree.set(from, targets.length);
    for (const to of targets) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  let maxDegree = 0;
  for (const rel of indexedFiles) maxDegree = Math.max(maxDegree, (inDegree.get(rel) ?? 0) + (outDegree.get(rel) ?? 0));

  const clusters = assignClusters(indexedFiles, undefined, undefined, adjacency);
  const codebases = assignNeighborhoods(indexedFiles, topology, adjacency);
  const territorialize = input.neighborhoods !== "off"
    && (input.neighborhoods === "on" || shouldTerritorialize(codebases, indexedFiles.length));

  const nodes: GraphNode[] = indexedFiles.map((rel) => {
    const nIn = inDegree.get(rel) ?? 0;
    const nOut = outDegree.get(rel) ?? 0;
    const git = input.git[rel];
    const codebase = codebases.get(rel);
    return {
      id: rel,
      dir: clusters.get(rel) ?? clusterDir(rel),
      lang: langOf(rel),
      sizeBytes: facts.get(rel)?.s ?? 0,
      inDegree: nIn,
      outDegree: nOut,
      x: 0,
      y: 0,
      z: depthFromDegree(nIn, nOut, maxDegree),
      ...(git ? { churn: git[0], lastCommitAt: git[1] } : {}),
      ...(codebase ? { codebase } : {}),
      ...(territorialize && codebase ? { neighborhood: codebase } : {}),
    };
  });

  io.progress("layout", 0);
  const prevPositions = new Map<string, { x: number; y: number }>();
  for (const [id, x, y] of input.prevPositions) prevPositions.set(id, { x, y });
  const layoutEdges = [];
  for (const [from, targets] of adjacency) {
    for (const to of targets) layoutEdges.push({ id: `imp:${from}->${to}`, from, to, kind: "import" as const });
  }
  const layout = createLayout(nodes, layoutEdges, {
    seed: input.seed,
    prevPositions,
    topology,
    neighborhoods: territorialize ? codebases : undefined,
  });
  let ticks = 0;
  while (layout.tick(LAYOUT_TICK_CHUNK)) {
    if (io.cancelled()) throw new Error("cancelled");
    ticks += 1;
    if (ticks % 5 === 0) {
      io.progress("layout", Math.min(0.95, ticks / 20));
      await io.yieldNow();
    }
  }
  const positions = layout.positions();
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos) {
      node.x = Math.round(pos.x * 100) / 100;
      node.y = Math.round(pos.y * 100) / 100;
    }
  }
  ms.layout = Date.now() - started;

  /* Persist facts last: a cancelled job must not write a half-built cache. */
  await io.writeCache(serializeFacts(facts, declaredTypeNames(facts))).catch(() => undefined);

  return {
    indexNodes: nodes,
    imports: [...adjacency.entries()],
    topology,
    territorialize,
    facts: [...facts.entries()],
    resolveContext,
    stats: { factsReused: reused, factsRead: read, ms },
  };
}
