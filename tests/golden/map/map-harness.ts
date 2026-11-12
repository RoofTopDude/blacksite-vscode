/* Golden harness for the Codebase Map: build the real pipeline the extension builds (indexer →
   relationship / structural / hierarchy snapshots → notes store → agent gateway) over a workspace
   on disk, run it, and reduce what it produced to stable JSON.

   This is the "no drift" guard for docs/map-sdk-implementation-plan.md: the outputs recorded
   through today's code paths must stay identical while the code underneath is moved and
   re-plumbed. When the plumbing changes, only buildPipeline() and touch() below should need to
   change — never the reduced output. A golden that changes is a behavior change, so never update
   one just to make a run pass; find out what moved first. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { GraphIndexer } from "../../../src/graph/graph-indexer.js";
import { RelationshipSnapshot } from "../../../src/graph/relationship-snapshot.js";
import { StructuralSnapshot } from "../../../src/graph/structural-snapshot.js";
import { HierarchySnapshot } from "../../../src/graph/hierarchy-snapshot.js";
import { GraphAnnotationStore } from "../../../src/graph-annotation-store.js";
import { GraphAgentGateway } from "../../../src/graph-agent-gateway.js";
import { buildWorkspaceRoots, fromNodeId, type WorkspaceRoot } from "../../../src/graph/workspace-roots.js";
import { resolveGraphCapacity, resolveGraphExclusions, type GraphConfig } from "../../../src/graph/config.js";
import type { GraphEdge, GraphNode } from "../../../src/graph/graph-model.js";

/** 2026-01-01T00:00:00Z. Fixture commits are dated from here, a day apart. */
export const FIXTURE_EPOCH = 1_767_225_600;
const DAY = 86_400;

export const GOLDEN_CONTEXT = { sessionId: "golden" };

function git(cwd: string, args: readonly string[], epoch?: number): void {
  const date = epoch === undefined ? undefined : `${epoch} +0000`;
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

export function makeTempDir(label: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `map-golden-${label}-`)));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

function writeFile(root: string, rel: string, content: string): void {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

/** Write `files` into a fresh temp directory, commit them, then replay `history` one dated
    commit at a time (each touched file gets a line appended). */
export function materializeFixture(
  label: string,
  files: Readonly<Record<string, string>>,
  history: ReadonlyArray<{ message: string; touch: readonly string[] }> = [],
): string {
  const dir = makeTempDir(label);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"], FIXTURE_EPOCH);
  history.forEach((commit, index) => {
    for (const rel of commit.touch) {
      const absolute = path.join(dir, rel);
      const marker = rel.endsWith(".py") ? "#" : "//";
      fs.appendFileSync(absolute, `${marker} revision ${index + 1}\n`, "utf8");
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", commit.message], FIXTURE_EPOCH + DAY * (index + 1));
  });
  return dir;
}

/** Commit an existing directory as one dated commit (for trees that arrive without history). */
export function commitTree(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "snapshot"], FIXTURE_EPOCH);
}

/** The extension's defaults (readGraphConfig with no settings). */
export function defaultGraphConfig(): GraphConfig {
  return {
    ...resolveGraphCapacity({}),
    ...resolveGraphExclusions({}),
    traceFadeSeconds: 45,
    traceShellEvents: true,
    neighborhoods: "auto",
    backgroundSymbols: false,
    landingView: "auto",
  };
}

export interface MapPipeline {
  roots: WorkspaceRoot[];
  indexer: GraphIndexer;
  relationships: RelationshipSnapshot;
  structure: StructuralSnapshot;
  hierarchy: HierarchySnapshot;
  annotations: GraphAnnotationStore;
  gateway: GraphAgentGateway;
  /** Index (or re-index) and wait for the relationship pass of that generation. */
  rebuild(): Promise<void>;
  dispose(): void;
}

/** Wire the pipeline exactly as extension.ts does, inline (no worker script). */
export function buildPipeline(folders: ReadonlyArray<{ name: string; path: string }>): MapPipeline {
  const roots = buildWorkspaceRoots(folders);
  const getRoots = () => roots;
  const config = defaultGraphConfig();
  const annotations = new GraphAnnotationStore(getRoots);
  const indexer = new GraphIndexer(getRoots, () => config, { workerScript: null });
  annotations.setNodeLookup(() => {
    const files = indexer.indexedFiles();
    return files.length > 0 ? new Set(files) : null;
  });
  const relationships = new RelationshipSnapshot(
    indexer,
    (input) => indexer.runRelationshipJob(input.files, input.topology).promise,
    () => config,
  );
  const structure = new StructuralSnapshot(indexer);
  const hierarchy = new HierarchySnapshot(indexer, relationships, getRoots);
  const gateway = new GraphAgentGateway(annotations, indexer, relationships, getRoots, () => [], structure, hierarchy);
  return {
    roots,
    indexer,
    relationships,
    structure,
    hierarchy,
    annotations,
    gateway,
    async rebuild() {
      await indexer.rebuild();
      await relationships.fullAsync();
    },
    dispose() {
      indexer.dispose();
      annotations.dispose();
    },
  };
}

/** Report a file change the way the workspace watcher would. */
export function touch(pipeline: MapPipeline, id: string): void {
  const absolute = fromNodeId(pipeline.roots, id);
  if (!absolute) throw new Error(`Not under a fixture root: ${id}`);
  (pipeline.indexer as unknown as { _markDirty(uri: vscode.Uri): void })._markDirty(vscode.Uri.file(absolute));
}

/* ── Reduction ──────────────────────────────────────────────────────────────────────────── */

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const NOTE_ID = /gl_[0-9a-z]+_[0-9a-z]+/g;

/** Replace what legitimately varies run to run: wall-clock timestamps, generated note ids, and
    the temp directory the fixture was written to. */
export function createNormalizer(roots: readonly WorkspaceRoot[]): <T>(value: T) => T {
  const noteIds = new Map<string, string>();
  const rootPaths = roots.map((root) => ({
    forward: root.path,
    back: root.path.replace(/\//g, "\\"),
    token: `<root:${root.name}>`,
  }));
  const fixString = (value: string): string => {
    if (ISO_TIME.test(value)) return "<time>";
    let out = value.replace(NOTE_ID, (id) => {
      if (!noteIds.has(id)) noteIds.set(id, `<note:${noteIds.size + 1}>`);
      return noteIds.get(id)!;
    });
    for (const root of rootPaths) out = out.split(root.forward).join(root.token).split(root.back).join(root.token);
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return fixString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry);
      return out;
    }
    return value;
  };
  return <T>(value: T): T => walk(value) as T;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function nodeRow(node: GraphNode): unknown[] {
  return [
    node.id, node.dir, node.codebase ?? null, node.neighborhood ?? null, node.lang, node.sizeBytes,
    node.inDegree, node.outDegree, node.z, node.churn ?? null, node.lastCommitAt ?? null,
  ];
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

/** Either the value itself, or its size and fingerprint when the fixture is too big to store. */
function section(value: unknown[], full: boolean): unknown {
  return full ? value : { count: value.length, digest: digest(value) };
}

/** Everything the index produced, reduced to stable JSON. `full: false` keeps counts and
    fingerprints instead of the bulky arrays (large fixtures). */
export async function captureIndex(pipeline: MapPipeline, full: boolean): Promise<Record<string, unknown>> {
  const { indexer } = pipeline;
  const snapshot = indexer.snapshot();
  if (!snapshot) throw new Error("captureIndex needs an indexed pipeline");
  const index = [...indexer.nodeIndex()].sort(byId);
  const serviceEdges = [...await pipeline.relationships.fullAsync()].sort(byId);
  const projection = pipeline.relationships.get();
  return {
    counts: {
      corpus: indexer.corpusFiles().length,
      indexed: index.length,
      rendered: snapshot.nodes.length,
      importEdges: indexer.importEdges().length,
      serviceEdges: serviceEdges.length,
      cochangeEdges: indexer.cochangeEdges().length,
    },
    flags: {
      truncated: snapshot.truncated,
      indexedTruncated: snapshot.indexedTruncated ?? null,
      renderedTruncated: snapshot.renderedTruncated ?? null,
      indexedFileCount: snapshot.indexedFileCount ?? null,
      renderedNodeCount: snapshot.renderedNodeCount ?? null,
      indexedImportEdgeCount: snapshot.indexedImportEdgeCount ?? null,
      renderedImportEdgeCount: snapshot.renderedImportEdgeCount ?? null,
      hiddenByPolicyCount: snapshot.hiddenByPolicyCount ?? null,
      gitignoreApplied: snapshot.gitignoreApplied ?? null,
    },
    corpus: section([...indexer.corpusFiles()].sort(), full),
    nodes: section(index.map(nodeRow), full),
    positions: section(index.map((node) => [node.id, Math.round(node.x), Math.round(node.y)]), full),
    rendered: {
      nodes: section(snapshot.nodes.map((node) => node.id).sort(), full),
      edges: section(snapshot.edges.map(edgeKey).sort(), full),
    },
    importEdges: section(indexer.importEdges().map(edgeKey).sort(), full),
    serviceEdges: section(serviceEdges, full),
    serviceProjection: {
      truncated: projection.truncated,
      totalEdgeCount: projection.totalEdgeCount,
      edges: section(projection.edges.map((edge) => edge.id).sort(), full),
    },
    cochange: section([...indexer.cochangeEdges()].sort(byId), full),
    topology: full ? indexer.topology() : { digest: digest(indexer.topology()) },
    structure: full ? pipeline.structure.get() : { digest: digest(pipeline.structure.get()) },
    hierarchy: full ? pipeline.hierarchy.get() : { digest: digest(pipeline.hierarchy.get()) },
  };
}

/** The delta an incremental pass posted, reduced to ids. */
export function captureDelta(pipeline: MapPipeline): unknown {
  const delta = pipeline.indexer.snapshot()?.delta;
  if (!delta) return null;
  return {
    upsertNodes: delta.upsertNodes.map(nodeRow).sort(),
    removeNodeIds: [...delta.removeNodeIds].sort(),
    addEdges: delta.addEdges.map(edgeKey).sort(),
    removeEdgeIds: [...delta.removeEdgeIds].sort(),
  };
}

export function goldenJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
