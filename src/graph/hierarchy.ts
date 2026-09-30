/* The workspace as a hierarchy: root → codebase → project → area → file.

   The map used to be one flat star field with the hierarchy only implied by
   territory hulls and folder colors. This module makes it explicit, over the
   **indexed** corpus (true counts, not the render sample), so the webview can
   open on a Systems overview, fold anything outside the current scope, and
   draw group-to-group relationships with real weights.

   Levels:
   - root: a workspace folder (only when more than one is open);
   - codebase: a neighborhood (graph/neighborhoods.ts) — a solution/monorepo
     container or a project root, else a top path segment;
   - project: a topology project, only when its codebase holds more than one;
   - area: the adaptive cluster dir (node.dir), the existing folder unit.

   Relationship edges are aggregated per level and kind from imports, service
   routes, co-change, and manifest-declared project references. Two findings
   compare the layers: a manifest dependency with no import or route behind it
   ("declared but unused"), and cross-project imports no manifest declares
   ("used but undeclared"). Co-change between two codebases that nothing
   structural explains is flagged as hidden coupling. Pure. */

import type { EdgeKind, GraphEdge, GraphNode } from "./graph-model.js";
import { owningProjectForPath, type ProjectTopology } from "./project-topology.js";
import { neighborhoodLabel } from "./neighborhoods.js";

export type GroupLevel = "root" | "codebase" | "project" | "area";

/* Id prefixes can never begin a workspace path. `▤` + dir is the existing
   cluster super-node id, kept so persisted collapse state stays valid. */
export const GROUP_PREFIX: Record<GroupLevel, string> = {
  root: "◎",
  codebase: "◈",
  project: "▣",
  area: "▤",
};

export function groupId(level: GroupLevel, key: string): string {
  return GROUP_PREFIX[level] + key;
}

export function isGroupId(id: string): boolean {
  return id.startsWith("◎") || id.startsWith("◈") || id.startsWith("▣") || id.startsWith("▤");
}

export interface HierarchyGroup {
  id: string;
  level: GroupLevel;
  /** Path key (root name, codebase root, project root, or area dir). */
  key: string;
  label: string;
  parent: string | null;
  /** Indexed files in the group (the true count). */
  fileCount: number;
  /** Of those, how many the render sample draws. */
  renderedCount: number;
  /** Top languages by file count. */
  langs: Array<[string, number]>;
  churn: number;
  lastCommitAt: number;
  /** Centroid and bounding radius from the full layout. */
  x: number;
  y: number;
  radius: number;
  /** Project kind (npm, dotnet, …) for project groups and single-project codebases. */
  projectKind?: string;
}

export type HierarchyEdgeKind = Extract<EdgeKind, "import" | "api" | "event" | "data" | "config" | "cochange" | "project_ref">;

/** Edge aggregation levels: every group level above areas, plus "systems" —
    the node each file folds to in the Systems overview (its codebase, else
    its workspace folder), which mixes codebase and root groups. */
export type EdgeLevel = Exclude<GroupLevel, "area"> | "systems";

export interface HierarchyEdge {
  id: string;
  level: EdgeLevel;
  from: string;
  to: string;
  kind: HierarchyEdgeKind;
  /** File-level relationships the edge stands for (declared refs count 1). */
  count: number;
  confidence?: number;
  /** Co-change between two groups no import, route, or declared reference
      connects — "hidden coupling". */
  unexplained?: boolean;
  evidence?: string[];
}

export interface DependencyFinding {
  fromProject: string;
  toProject: string;
  fromName: string;
  toName: string;
  kind: string;
  imports: number;
}

export interface WorkspaceHierarchy {
  groups: HierarchyGroup[];
  edges: HierarchyEdge[];
  /** Workspace folder names when multi-root, else []. */
  roots: string[];
  declaredUnused: DependencyFinding[];
  usedUndeclared: DependencyFinding[];
  /** file id → innermost group id (its area), for callers without node data. */
  fileCount: number;
}

export interface HierarchyInput {
  nodes: readonly GraphNode[];
  renderedIds: ReadonlySet<string>;
  rootNames: readonly string[];
  topology: ProjectTopology | null;
  importEdges: readonly GraphEdge[];
  serviceEdges: readonly GraphEdge[];
  cochangeEdges: readonly GraphEdge[];
}

/** Ecosystems whose manifest dependencies are expected to show up as file
    imports the map can resolve; declared-but-unused is only reported for these. */
const IMPORT_VISIBLE_KINDS = new Set(["npm", "rust", "python", "go", "dotnet"]);
const MAX_EDGES_PER_LEVEL = 4000;
const MAX_FINDINGS = 50;

interface Accumulator {
  count: number;
  langs: Map<string, number>;
  churn: number;
  lastCommitAt: number;
  sx: number;
  sy: number;
  members: Array<[number, number]>;
  rendered: number;
}

function rootOf(id: string, rootNames: readonly string[]): string | null {
  if (rootNames.length < 2) return null;
  const head = id.split("/", 1)[0] ?? "";
  return rootNames.includes(head) ? head : null;
}

/** The chain of group ids a file belongs to, outermost first. */
export interface FileGroups {
  root: string | null;
  codebase: string | null;
  project: string | null;
  area: string;
  /** What the Systems overview draws this file as. */
  systems: string | null;
}

export function buildHierarchy(input: HierarchyInput): WorkspaceHierarchy {
  const { nodes, rootNames, topology } = input;
  const acc = new Map<string, Accumulator>();
  const meta = new Map<string, { level: GroupLevel; key: string; label: string; parents: Map<string, number>; projectKind?: string }>();
  const fileGroups = new Map<string, FileGroups>();

  /* Codebases that hold more than one topology project get a project level. */
  const projectsPerCodebase = new Map<string, Set<string>>();
  const projectOf = new Map<string, { root: string; name: string; kind: string } | null>();
  for (const node of nodes) {
    const project = owningProjectForPath(topology, node.id);
    projectOf.set(node.id, project ? { root: project.root, name: project.name, kind: project.kind } : null);
    const codebase = node.codebase ?? node.neighborhood;
    if (project && codebase) {
      const set = projectsPerCodebase.get(codebase) ?? new Set();
      set.add(project.root);
      projectsPerCodebase.set(codebase, set);
    }
  }

  const touch = (id: string, level: GroupLevel, key: string, label: string, parent: string | null, node: GraphNode, projectKind?: string): void => {
    let entry = acc.get(id);
    if (!entry) {
      entry = { count: 0, langs: new Map(), churn: 0, lastCommitAt: 0, sx: 0, sy: 0, members: [], rendered: 0 };
      acc.set(id, entry);
      meta.set(id, { level, key, label, parents: new Map(), ...(projectKind ? { projectKind } : {}) });
    }
    entry.count += 1;
    if (node.lang) entry.langs.set(node.lang, (entry.langs.get(node.lang) ?? 0) + 1);
    entry.churn += node.churn ?? 0;
    entry.lastCommitAt = Math.max(entry.lastCommitAt, node.lastCommitAt ?? 0);
    entry.sx += node.x;
    entry.sy += node.y;
    entry.members.push([node.x, node.y]);
    if (input.renderedIds.has(node.id)) entry.rendered += 1;
    const m = meta.get(id)!;
    if (parent) m.parents.set(parent, (m.parents.get(parent) ?? 0) + 1);
    else m.parents.set("", (m.parents.get("") ?? 0) + 1);
  };

  for (const node of nodes) {
    const rootName = rootOf(node.id, rootNames);
    const root = rootName ? groupId("root", rootName) : null;
    if (root) touch(root, "root", rootName!, rootName!, null, node);

    const codebaseKey = node.codebase ?? node.neighborhood ?? null;
    /* In multi-root, a codebase that *is* a whole folder (the top-segment
       fallback) would just repeat the root; the root stands in for it. */
    let codebase: string | null = null;
    /* "." is the loose top-level-files bucket of a single-root workspace; it
       becomes its own group so the Systems overview accounts for every file. */
    if (codebaseKey && codebaseKey !== rootName) {
      codebase = groupId("codebase", codebaseKey);
      const single = projectOf.get(node.id);
      const kind = single && single.root === codebaseKey ? single.kind : undefined;
      touch(codebase, "codebase", codebaseKey, neighborhoodLabel(codebaseKey), root, node, kind);
    }

    let project: string | null = null;
    const owning = projectOf.get(node.id);
    if (owning && codebaseKey && (projectsPerCodebase.get(codebaseKey)?.size ?? 0) > 1 && owning.root !== codebaseKey) {
      project = groupId("project", owning.root);
      touch(project, "project", owning.root, owning.name || neighborhoodLabel(owning.root), codebase ?? root, node, owning.kind);
    }

    const area = groupId("area", node.dir);
    touch(area, "area", node.dir, node.dir.split("/").slice(-2).join("/") || node.dir, project ?? codebase ?? root, node);
    fileGroups.set(node.id, { root, codebase, project, area, systems: codebase ?? root });
  }

  const groups: HierarchyGroup[] = [];
  for (const [id, entry] of acc) {
    const m = meta.get(id)!;
    const x = entry.sx / entry.count;
    const y = entry.sy / entry.count;
    let radius = 0;
    for (const [mx, my] of entry.members) radius = Math.max(radius, Math.hypot(mx - x, my - y));
    /* Majority parent: an area's files can straddle codebases when import
       affinity pulled loose files across; the area sits under most of them. */
    const parent = [...m.parents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
    groups.push({
      id,
      level: m.level,
      key: m.key,
      label: m.label,
      parent,
      fileCount: entry.count,
      renderedCount: entry.rendered,
      langs: [...entry.langs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3),
      churn: entry.churn,
      lastCommitAt: entry.lastCommitAt,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      radius: Math.round(radius * 100) / 100,
      ...(m.projectKind ? { projectKind: m.projectKind } : {}),
    });
  }
  const levelOrder: Record<GroupLevel, number> = { root: 0, codebase: 1, project: 2, area: 3 };
  groups.sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || b.fileCount - a.fileCount || a.id.localeCompare(b.id));

  /* ---- relationship aggregation ---- */
  const edgeAcc = new Map<string, HierarchyEdge>();
  const structural = new Set<string>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const add = (level: EdgeLevel, from: string | null, to: string | null, kind: HierarchyEdgeKind, weight: number, confidence?: number, evidence?: string): void => {
    if (!from || !to || from === to) return;
    const id = `grp:${level === "systems" ? "sys:" : ""}${kind}:${from}->${to}`;
    const existing = edgeAcc.get(id);
    if (existing) {
      existing.count += weight;
      if (confidence !== undefined) existing.confidence = Math.max(existing.confidence ?? 0, confidence);
      if (evidence && (existing.evidence?.length ?? 0) < 3 && !existing.evidence?.includes(evidence)) {
        existing.evidence = [...(existing.evidence ?? []), evidence];
      }
    } else {
      edgeAcc.set(id, {
        id, level, from, to, kind, count: weight,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(evidence ? { evidence: [evidence] } : {}),
      });
    }
    if (kind !== "cochange") structural.add(`${level}:${pairKey(from, to)}`);
  };
  const levels: EdgeLevel[] = ["root", "codebase", "project", "systems"];
  const addFileEdge = (fromId: string | undefined, toId: string | undefined, kind: HierarchyEdgeKind, confidence?: number, evidence?: string): void => {
    if (!fromId || !toId) return;
    const from = fileGroups.get(fromId);
    const to = fileGroups.get(toId);
    if (!from || !to) return;
    for (const level of levels) {
      add(level, from[level], to[level], kind, 1, confidence, evidence);
    }
  };
  for (const edge of input.importEdges) addFileEdge(edge.from, edge.to, "import");
  for (const edge of input.serviceEdges) {
    if (edge.kind !== "api" && edge.kind !== "event" && edge.kind !== "data" && edge.kind !== "config") continue;
    addFileEdge(edge.sourcePath ?? edge.from, edge.targetPath ?? edge.to, edge.kind, edge.confidence, edge.label);
  }

  /* Manifest-declared project references, and the declared-vs-used check. */
  const projectName = new Map((topology?.projects ?? []).map((p) => [p.root, p]));
  /* Group chain of any one file a project owns — all of them share the
     root/codebase/project levels. */
  const groupsByProjectRoot = new Map<string, FileGroups>();
  for (const [fileId, g] of fileGroups) {
    const owner = projectOf.get(fileId);
    if (owner && !groupsByProjectRoot.has(owner.root)) groupsByProjectRoot.set(owner.root, g);
  }
  const projectGroups = (root: string): FileGroups | null => groupsByProjectRoot.get(root) ?? null;
  const importsBetweenProjects = new Map<string, number>();
  for (const edge of input.importEdges) {
    const a = projectOf.get(edge.from);
    const b = projectOf.get(edge.to);
    if (!a || !b || a.root === b.root) continue;
    const key = `${a.root}\u0000${b.root}`;
    importsBetweenProjects.set(key, (importsBetweenProjects.get(key) ?? 0) + 1);
  }
  const declared = new Set<string>();
  const declaredUnused: DependencyFinding[] = [];
  for (const ref of topology?.references ?? []) {
    declared.add(`${ref.from}\u0000${ref.to}`);
    const from = projectGroups(ref.from);
    const to = projectGroups(ref.to);
    if (from && to) {
      for (const level of levels) add(level, from[level], to[level], "project_ref", 1, undefined, ref.evidence ?? ref.kind);
    }
    const imports = importsBetweenProjects.get(`${ref.from}\u0000${ref.to}`) ?? 0;
    const fromProject = projectName.get(ref.from);
    if (imports === 0 && fromProject && IMPORT_VISIBLE_KINDS.has(fromProject.kind) && ref.kind !== "build") {
      declaredUnused.push({
        fromProject: ref.from,
        toProject: ref.to,
        fromName: fromProject.name,
        toName: projectName.get(ref.to)?.name ?? ref.to,
        kind: ref.kind,
        imports: 0,
      });
    }
  }
  const usedUndeclared: DependencyFinding[] = [];
  for (const [key, imports] of importsBetweenProjects) {
    if (declared.has(key)) continue;
    const [from, to] = key.split("\u0000") as [string, string];
    usedUndeclared.push({
      fromProject: from,
      toProject: to,
      fromName: projectName.get(from)?.name ?? from,
      toName: projectName.get(to)?.name ?? to,
      kind: "import",
      imports,
    });
  }
  usedUndeclared.sort((a, b) => b.imports - a.imports || a.fromProject.localeCompare(b.fromProject));

  for (const edge of input.cochangeEdges) addFileEdge(edge.from, edge.to, "cochange", edge.confidence);
  const edges: HierarchyEdge[] = [];
  const perLevel = new Map<EdgeLevel, HierarchyEdge[]>();
  for (const edge of edgeAcc.values()) {
    if (edge.kind === "cochange" && !structural.has(`${edge.level}:${pairKey(edge.from, edge.to)}`)) edge.unexplained = true;
    const list = perLevel.get(edge.level) ?? [];
    list.push(edge);
    perLevel.set(edge.level, list);
  }
  for (const list of perLevel.values()) {
    list.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    edges.push(...list.slice(0, MAX_EDGES_PER_LEVEL));
  }

  return {
    groups,
    edges,
    roots: rootNames.length > 1 ? [...rootNames] : [],
    declaredUnused: declaredUnused.slice(0, MAX_FINDINGS),
    usedUndeclared: usedUndeclared.slice(0, MAX_FINDINGS),
    fileCount: nodes.length,
  };
}
