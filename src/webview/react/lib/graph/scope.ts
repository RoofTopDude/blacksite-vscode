/* Scope and focus-budget folding for the Codebase Map — the model behind the
   Systems overview, the breadcrumb scope bar, and "show as much detail as the
   budget allows around what you are looking at".

   The host sends a hierarchy (root → codebase → project → area; see
   src/graph/hierarchy.ts). The view is described by:
   - `scope`: a breadcrumb of group ids ([] = the whole workspace);
   - `mode`: "systems" (fold everything to codebases), "focus" (fold by budget
     around the scope and whatever is interesting), or "all" (no folding).

   computeFolds() answers, for every file on the canvas, which group (if any)
   it is drawn as. It is the only input deriveDisplayGraph needs to build the
   folded display graph, so the renderer, labels, and search keep working on
   the same display-graph contract they always have. Pure: no DOM, no pixi. */

import type { GraphNode, GroupLevel, MapGroup, MapHierarchy } from "./protocol";

export type ScopeMode = "systems" | "focus" | "all";

export interface ScopeState {
  scope: string[];
  mode: ScopeMode;
}

/** Default number of stars/groups a focused view aims to draw. */
export const DEFAULT_FOCUS_BUDGET = 2500;

export interface GroupIndex {
  byId: ReadonlyMap<string, MapGroup>;
  children: ReadonlyMap<string | null, MapGroup[]>;
  roots: readonly string[];
  /** Project groups, deepest key first, for prefix ownership. */
  projects: readonly MapGroup[];
}

export function indexHierarchy(hierarchy: MapHierarchy | null): GroupIndex {
  const byId = new Map<string, MapGroup>();
  const children = new Map<string | null, MapGroup[]>();
  const projects: MapGroup[] = [];
  for (const group of hierarchy?.groups ?? []) {
    byId.set(group.id, group);
    const list = children.get(group.parent) ?? [];
    list.push(group);
    children.set(group.parent, list);
    if (group.level === "project") projects.push(group);
  }
  projects.sort((a, b) => b.key.length - a.key.length);
  return { byId, children, roots: hierarchy?.roots ?? [], projects };
}

const PREFIX: Record<GroupLevel, string> = { root: "◎", codebase: "◈", project: "▣", area: "▤" };

export function hierarchyGroupId(level: GroupLevel, key: string): string {
  return PREFIX[level] + key;
}

export function isHierarchyGroupId(id: string): boolean {
  return id.startsWith("◎") || id.startsWith("◈") || id.startsWith("▣") || id.startsWith("▤");
}

/** The groups a file belongs to, outermost first — only groups that exist. */
export function groupChain(node: Pick<GraphNode, "id" | "dir" | "codebase" | "neighborhood">, index: GroupIndex): string[] {
  const chain: string[] = [];
  if (index.roots.length > 1) {
    const head = node.id.split("/", 1)[0] ?? "";
    const root = hierarchyGroupId("root", head);
    if (index.byId.has(root)) chain.push(root);
  }
  const codebaseKey = node.codebase ?? node.neighborhood;
  if (codebaseKey) {
    const codebase = hierarchyGroupId("codebase", codebaseKey);
    if (index.byId.has(codebase)) chain.push(codebase);
  }
  const project = index.projects.find((group) => node.id === group.key || node.id.startsWith(`${group.key}/`));
  if (project) chain.push(project.id);
  const area = hierarchyGroupId("area", node.dir);
  if (index.byId.has(area)) chain.push(area);
  return chain;
}

/** Groups the Systems overview draws: every codebase, plus any root (or
    parentless group) that has files no codebase covers. */
export function systemsGroupFor(chain: readonly string[], index: GroupIndex): string | null {
  let pick: string | null = null;
  for (const id of chain) {
    const level = index.byId.get(id)?.level;
    if (level === "root" || level === "codebase") pick = id;
  }
  return pick ?? chain[0] ?? null;
}

export interface LandingDecision {
  mode: ScopeMode;
  reason: string;
}

/** What the map opens on (blacksite.graph.landingView). "auto" picks Systems
    for a multi-codebase workspace over the focus budget, the budgeted focus
    view for a single large codebase, and plain files otherwise. */
export function landingMode(
  hierarchy: MapHierarchy | null,
  setting: "auto" | "systems" | "files" | undefined,
  budget: number,
): LandingDecision {
  if (setting === "files" || !hierarchy || hierarchy.groups.length === 0) return { mode: "all", reason: "files" };
  const index = indexHierarchy(hierarchy);
  const top = new Set<string>();
  for (const group of hierarchy.groups) {
    if (group.level === "codebase" || (group.level === "root" && !(index.children.get(group.id) ?? []).some((c) => c.level === "codebase"))) {
      top.add(group.id);
    }
  }
  if (setting === "systems") return { mode: top.size > 0 ? "systems" : "all", reason: "setting" };
  if (hierarchy.fileCount <= budget) return { mode: "all", reason: "fits" };
  return top.size >= 2 ? { mode: "systems", reason: "multi-codebase" } : { mode: "focus", reason: "large" };
}

export interface FoldOptions {
  budget: number;
  /** Files whose groups should stay expanded when the budget allows
      (selection, live agent activity, search hits). */
  interest: ReadonlySet<string>;
  /** Area dirs the user collapsed by hand; always folded. */
  collapsedDirs: ReadonlySet<string>;
}

export interface FoldResult {
  /** file id → group id it is drawn as. Files absent here draw as themselves. */
  foldOf: Map<string, string>;
  /** Groups expanded by the budget pass (for the outline's open/closed state). */
  expanded: Set<string>;
}

/** Ancestors of a group, outermost first, including itself. */
export function ancestorsOf(groupId: string, index: GroupIndex): string[] {
  const out: string[] = [];
  let current: string | null = groupId;
  let guard = 0;
  while (current && guard < 16) {
    out.unshift(current);
    current = index.byId.get(current)?.parent ?? null;
    guard += 1;
  }
  return out;
}

export function computeFolds(nodes: readonly GraphNode[], index: GroupIndex, state: ScopeState, options: FoldOptions): FoldResult {
  const foldOf = new Map<string, string>();
  const expanded = new Set<string>();
  const files = nodes.filter((node) => !node.kind || node.kind === "file");
  if (index.byId.size === 0) {
    for (const node of files) if (options.collapsedDirs.has(node.dir)) foldOf.set(node.id, hierarchyGroupId("area", node.dir));
    return { foldOf, expanded };
  }
  const chains = new Map<string, string[]>();
  for (const node of files) chains.set(node.id, groupChain(node, index));

  const target = state.scope.length > 0 ? state.scope[state.scope.length - 1]! : null;
  if (!target && state.mode === "systems") {
    for (const node of files) {
      const group = systemsGroupFor(chains.get(node.id)!, index);
      if (group) foldOf.set(node.id, group);
    }
    return { foldOf, expanded };
  }

  const ancestors = new Set(target ? ancestorsOf(target, index) : []);
  const inside: GraphNode[] = [];
  for (const node of files) {
    const chain = chains.get(node.id)!;
    if (!target || chain.includes(target)) {
      inside.push(node);
      continue;
    }
    /* Outside the scope: draw as the first group that is not on the path
       down to the scope — sibling codebases, sibling projects, sibling areas. */
    const outer = chain.find((id) => !ancestors.has(id));
    if (outer) foldOf.set(node.id, outer);
  }

  const budgeted = state.mode !== "all" || Boolean(target);
  if (budgeted && inside.length > options.budget) {
    /* Greedy expansion from the scope's children: interesting groups first,
       then larger ones, as long as the drawn count stays within budget. */
    const membersOf = new Map<string, number>();
    const interesting = new Set<string>();
    for (const node of inside) {
      const chain = chains.get(node.id)!;
      const below = target ? chain.slice(chain.indexOf(target) + 1) : chain;
      for (const id of below) membersOf.set(id, (membersOf.get(id) ?? 0) + 1);
      if (options.interest.has(node.id)) for (const id of below) interesting.add(id);
    }
    const childGroups = (id: string | null): string[] =>
      (index.children.get(id) ?? []).map((group) => group.id).filter((gid) => membersOf.has(gid));
    const frontier = new Set<string>(childGroups(target));
    /* Files directly under the scope with no deeper group count as themselves. */
    let count = frontier.size;
    for (const node of inside) {
      const chain = chains.get(node.id)!;
      const below = target ? chain.slice(chain.indexOf(target) + 1) : chain;
      if (below.length === 0) count += 1;
    }
    const cost = (id: string): number => {
      const group = index.byId.get(id);
      if (group?.level === "area") return membersOf.get(id) ?? 0;
      return Math.max(1, childGroups(id).length);
    };
    let progressed = true;
    while (progressed) {
      progressed = false;
      const candidates = [...frontier].sort((a, b) =>
        Number(interesting.has(b)) - Number(interesting.has(a))
        || (membersOf.get(b) ?? 0) - (membersOf.get(a) ?? 0)
        || a.localeCompare(b));
      for (const id of candidates) {
        const next = count - 1 + cost(id);
        /* Something the user is looking at may overshoot the budget a little
           rather than stay folded, but never unboundedly. */
        const ceiling = interesting.has(id) ? options.budget * 1.5 : options.budget;
        if (next > ceiling) continue;
        frontier.delete(id);
        expanded.add(id);
        count = next;
        if (index.byId.get(id)?.level !== "area") for (const child of childGroups(id)) frontier.add(child);
        progressed = true;
        break;
      }
    }
    for (const node of inside) {
      const chain = chains.get(node.id)!;
      const below = target ? chain.slice(chain.indexOf(target) + 1) : chain;
      const folded = below.find((id) => !expanded.has(id));
      if (folded) foldOf.set(node.id, folded);
    }
  }

  for (const node of inside) {
    if (foldOf.has(node.id) || !options.collapsedDirs.has(node.dir)) continue;
    foldOf.set(node.id, hierarchyGroupId("area", node.dir));
  }
  return { foldOf, expanded };
}

export interface Crumb {
  id: string | null;
  label: string;
  level: GroupLevel | "workspace";
}

export function breadcrumb(scope: readonly string[], index: GroupIndex): Crumb[] {
  const crumbs: Crumb[] = [{ id: null, label: "Workspace", level: "workspace" }];
  for (const id of scope) {
    const group = index.byId.get(id);
    if (!group) break;
    crumbs.push({ id, label: group.label, level: group.level });
  }
  return crumbs;
}

/** Scope path for entering `groupId`: its ancestor chain. */
export function scopeFor(groupId: string, index: GroupIndex): string[] {
  return index.byId.has(groupId) ? ancestorsOf(groupId, index) : [];
}

/** Drop scope entries the current hierarchy no longer has. */
export function validScope(scope: readonly string[], index: GroupIndex): string[] {
  const out: string[] = [];
  for (const id of scope) {
    if (!index.byId.has(id)) break;
    out.push(id);
  }
  return out;
}

/** Innermost group of `id`'s chain inside the current scope — where a search
    pick or a "reveal" should scope into so the file becomes visible. */
export function owningCodebase(node: Pick<GraphNode, "id" | "dir" | "codebase" | "neighborhood">, index: GroupIndex): string | null {
  const chain = groupChain(node, index);
  return chain.find((id) => index.byId.get(id)?.level === "codebase")
    ?? chain.find((id) => index.byId.get(id)?.level === "root")
    ?? null;
}
