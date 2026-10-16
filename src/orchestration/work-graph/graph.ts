/**
 * The work graph, kept up to date incrementally, and the read-only questions it answers.
 *
 * `update()` rebuilds only the partitions whose source entity changed (build.ts). Everything that
 * spans entities is resolved on read:
 *   - a declared or inferred edge whose target does not exist reads as `missing`;
 *   - an observed change is `stale` once something else changed the same file later, or once the
 *     file's content no longer matches the hash its receipt recorded;
 *   - collisions between open work are computed from what each item says it will modify.
 * Nothing is repaired. Cycles, dangling references, stale evidence and links the ticket store
 * healed on read are all reported as findings.
 *
 * Pure: the host passes in the sources and, optionally, ports onto the Codebase Map and the disk.
 */

import type { Ticket, TicketLinkFinding } from "../../ticket-store.js";
import type { TaskPlan } from "../../planning-store.js";
import type { WorkContract } from "../work-contract.js";
import type { WorkReceipt } from "../work-receipt.js";
import { planPartition, planRev, receiptPartition, ticketPartition, ticketRev, type Partition } from "./build.js";
import {
  edgeId,
  ids,
  isWorkItem,
  kindOf,
  type EdgeStatus,
  type ResolvedEdge,
  type WorkEdge,
  type WorkFinding,
  type WorkNode,
  type WorkState,
} from "./model.js";

export interface WorkGraphSources {
  tickets: readonly Ticket[];
  plans: readonly TaskPlan[];
  receipts: readonly WorkReceipt[];
  contract?: (id: string) => WorkContract | undefined;
  ticketLinkFindings?: readonly TicketLinkFinding[];
}

export interface WorkGraphPorts {
  /** Whether a workspace-relative file is on the Codebase Map. Without it, file targets are never missing. */
  fileExists?: (path: string) => boolean;
  /** The file's current content hash, for judging whether recorded evidence still describes it. */
  fingerprint?: (path: string) => string | undefined;
  /** Files that depend on these files, one hop out on the Codebase Map. */
  dependentsOf?: (paths: readonly string[]) => string[];
}

export interface UpdateResult {
  rebuilt: number;
  removed: number;
  partitions: number;
}

interface Change {
  at: string;
  subject: string;
  sha256?: string;
}

const MAX_RESULTS = 200;
const MAX_CONFLICTS = 1_000;

function stripPrefix(nodeId: string): string {
  return nodeId.slice(nodeId.indexOf(":") + 1);
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) out.push(parts.slice(0, i).join("/"));
  return out;
}

export class WorkGraph {
  private readonly _partitions = new Map<string, Partition>();
  private _linkFindings: readonly TicketLinkFinding[] = [];
  private readonly _derived: Derived;

  constructor(private readonly _ports: WorkGraphPorts = {}) {
    this._derived = new Derived(_ports);
  }

  /** Bring the graph in line with the sources, rebuilding only what changed. */
  update(sources: WorkGraphSources): UpdateResult {
    let rebuilt = 0;
    const wanted = new Set<string>();
    const put = (key: string, rev: string, build: () => Partition): void => {
      wanted.add(key);
      const existing = this._partitions.get(key);
      if (existing?.rev === rev) return;
      const next = build();
      if (existing) this._derived.remove(existing);
      this._derived.add(next);
      this._partitions.set(key, next);
      rebuilt += 1;
    };
    for (const ticket of sources.tickets) put(ids.ticket(ticket.id), ticketRev(ticket), () => ticketPartition(ticket));
    for (const plan of sources.plans) put(ids.plan(plan.id), planRev(plan), () => planPartition(plan));
    for (const receipt of sources.receipts) {
      put(ids.receipt(receipt.id), receipt.id, () => receiptPartition(receipt, sources.contract?.(receipt.contractId)));
    }
    let removed = 0;
    for (const key of [...this._partitions.keys()]) {
      if (!wanted.has(key)) {
        this._derived.remove(this._partitions.get(key)!);
        this._partitions.delete(key);
        removed += 1;
      }
    }
    this._linkFindings = sources.ticketLinkFindings ?? [];
    return { rebuilt, removed, partitions: this._partitions.size };
  }

  /** Forget cached answers, e.g. after the Codebase Map reindexed. */
  invalidate(): void {
    this._derived.touch();
  }

  private get derived(): Derived {
    return this._derived;
  }

  node(id: string): WorkNode | undefined {
    return this.derived.nodes.get(id);
  }

  stats(): { partitions: number; nodes: number; edges: number } {
    return { partitions: this._partitions.size, nodes: this.derived.nodes.size, edges: this.derived.edgeCount };
  }

  /** Every stored edge, resolved. Sorted by id, so two graphs over the same sources compare equal. */
  edges(): ResolvedEdge[] {
    const memo = new Map<string, string | undefined>();
    return this.derived.allEdges().map((edge) => this.derived.resolve(edge, memo));
  }

  /** Accept "BLK-12", "plan-1/ph-2/st-3", "plan-1/ph-2", a file path, or a full node id. */
  resolveRef(ref: string): string {
    const trimmed = ref.trim();
    if (/^(ticket|plan|phase|step|contract|receipt|run|doc|file|area|artifact):/.test(trimmed)) return trimmed;
    if (this.derived.nodes.has(ids.ticket(trimmed))) return ids.ticket(trimmed);
    const parts = trimmed.split("/");
    if (parts.length === 3 && this.derived.nodes.has(`step:${trimmed}`)) return `step:${trimmed}`;
    if (parts.length === 2 && this.derived.nodes.has(`phase:${trimmed}`)) return `phase:${trimmed}`;
    if (this.derived.nodes.has(ids.plan(trimmed))) return ids.plan(trimmed);
    if (this.derived.nodes.has(ids.receipt(trimmed))) return ids.receipt(trimmed);
    return ids.file(trimmed);
  }

  // ── Questions ────────────────────────────────────────────────────────────

  /**
   * Everything known about one piece of work: the code it touches, what it waits on, what waits on
   * it, what it must produce, and the evidence for it — each relation with its status.
   */
  trace(ref: string): {
    node: WorkNode | { id: string; kind: string };
    affectedCode: ResolvedEdge[];
    dependencies: ResolvedEdge[];
    dependents: ResolvedEdge[];
    deliverables: ResolvedEdge[];
    consumes: ResolvedEdge[];
    evidence: ResolvedEdge[];
    conflicts: ResolvedEdge[];
  } {
    const id = this.resolveRef(ref);
    const d = this.derived;
    const memo = new Map<string, string | undefined>();
    const out = (kinds: string[]) => d.outOf(id).filter((edge) => kinds.includes(edge.kind)).map((edge) => d.resolve(edge, memo));
    const into = (kinds: string[]) => d.inOf(id).filter((edge) => kinds.includes(edge.kind)).map((edge) => d.resolve(edge, memo));
    return {
      node: d.nodes.get(id) ?? { id, kind: kindOf(id) },
      affectedCode: out(["modifies"]),
      dependencies: out(["depends_on"]),
      dependents: into(["depends_on"]),
      deliverables: out(["produces"]),
      consumes: out(["consumes"]),
      evidence: out(["verified_by", "informed_by"]),
      conflicts: this.conflicts().filter((edge) => edge.from === id || edge.to === id),
    };
  }

  /** What this work waits on (direction "dependencies") or what waits on it ("dependents"). */
  walk(ref: string, direction: "dependencies" | "dependents", depth = 3): Array<{ id: string; depth: number; state?: WorkState; title?: string; status: EdgeStatus }> {
    const start = this.resolveRef(ref);
    const d = this.derived;
    const memo = new Map<string, string | undefined>();
    const seen = new Set([start]);
    const out: Array<{ id: string; depth: number; state?: WorkState; title?: string; status: EdgeStatus }> = [];
    let frontier = [start];
    for (let level = 1; level <= Math.max(1, Math.min(depth, 10)) && frontier.length; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = direction === "dependencies" ? d.outOf(id) : d.inOf(id);
        for (const edge of edges) {
          if (edge.kind !== "depends_on") continue;
          const other = direction === "dependencies" ? edge.to : edge.from;
          if (seen.has(other)) continue;
          seen.add(other);
          const node = d.nodes.get(other);
          out.push({ id: other, depth: level, ...(node?.state ? { state: node.state } : {}), ...(node?.title ? { title: node.title } : {}), status: d.resolve(edge, memo).status });
          next.push(other);
        }
      }
      frontier = next;
    }
    return out.slice(0, MAX_RESULTS);
  }

  /** What stops this work from being done: dependencies that are not done, or do not exist. */
  blockers(ref: string): Array<{ id: string; title?: string; state?: WorkState; status: EdgeStatus; source: string }> {
    const id = this.resolveRef(ref);
    const d = this.derived;
    const memo = new Map<string, string | undefined>();
    const out: Array<{ id: string; title?: string; state?: WorkState; status: EdgeStatus; source: string }> = [];
    for (const edge of d.outOf(id)) {
      if (edge.kind !== "depends_on") continue;
      const resolved = d.resolve(edge, memo);
      const node = d.nodes.get(edge.to);
      if (resolved.status !== "missing" && node?.state === "done") continue;
      if (node?.state === "cancelled") continue;
      out.push({ id: edge.to, ...(node?.title ? { title: node.title } : {}), ...(node?.state ? { state: node.state } : {}), status: resolved.status, source: edge.provenance.source });
    }
    return out;
  }

  /**
   * The work a change would reach. For a file: the work that modifies it, then the work that
   * modifies files depending on it. For a piece of work: other open work touching what it touches.
   */
  impact(ref: string): Array<{ id: string; title?: string; state?: WorkState; via: string; direct: boolean }> {
    const id = this.resolveRef(ref);
    const d = this.derived;
    const files = kindOf(id) === "file" || kindOf(id) === "area"
      ? [stripPrefix(id)]
      : d.outOf(id).filter((edge) => edge.kind === "modifies").map((edge) => stripPrefix(edge.to));
    const results = new Map<string, { id: string; title?: string; state?: WorkState; via: string; direct: boolean }>();
    const add = (path: string, direct: boolean): void => {
      for (const item of d.itemsTouching(path)) {
        if (item === id || results.has(item)) continue;
        const node = d.nodes.get(item);
        results.set(item, { id: item, ...(node?.title ? { title: node.title } : {}), ...(node?.state ? { state: node.state } : {}), via: path, direct });
      }
    };
    for (const file of files) add(file, true);
    for (const dependent of this._ports.dependentsOf?.(files) ?? []) add(dependent, false);
    return [...results.values()]
      .sort((a, b) => Number(b.direct) - Number(a.direct) || Number(a.state === "done") - Number(b.state === "done") || a.id.localeCompare(b.id))
      .slice(0, MAX_RESULTS);
  }

  /**
   * The longest chain of open work by weight, following dependencies. Work in a dependency cycle
   * has no order and is left out and reported, never quietly broken.
   */
  criticalPath(scope?: string): { path: Array<{ id: string; title?: string; weight: number }>; totalWeight: number; excludedCycles: string[][] } {
    const d = this.derived;
    const inScope = (nodeId: string): boolean => {
      if (!scope) return true;
      if (scope === "tickets") return kindOf(nodeId) === "ticket";
      return nodeId.startsWith(`step:${scope}/`) || nodeId.startsWith(`phase:${scope}/`);
    };
    const open = new Set<string>([...d.nodes.values()]
      .filter((node) => (node.kind === "ticket" || node.kind === "step") && (node.state === "open" || node.state === "blocked") && inScope(node.id))
      .map((node) => node.id)
      .sort());
    const deps = new Map<string, string[]>();
    for (const id of open) deps.set(id, d.outOf(id).filter((edge) => edge.kind === "depends_on" && open.has(edge.to)).map((edge) => edge.to));
    const cycles = stronglyConnected([...open], (id) => deps.get(id) ?? []).filter((component) => component.length > 1 || (deps.get(component[0]!) ?? []).includes(component[0]!));
    const cyclic = new Set(cycles.flat());
    const best = new Map<string, { weight: number; next?: string }>();
    const order = topological([...open].filter((id) => !cyclic.has(id)), (id) => (deps.get(id) ?? []).filter((dep) => !cyclic.has(dep)));
    for (const id of order) {
      const own = d.nodes.get(id)?.weight ?? 1;
      let bestNext: { weight: number; next?: string } = { weight: own };
      for (const dep of deps.get(id) ?? []) {
        const candidate = best.get(dep);
        if (candidate && own + candidate.weight > bestNext.weight) bestNext = { weight: own + candidate.weight, next: dep };
      }
      best.set(id, bestNext);
    }
    let start: string | undefined;
    for (const [id, value] of best) {
      const current = start ? best.get(start)! : undefined;
      if (!current || value.weight > current.weight || (value.weight === current.weight && id < start!)) start = id;
    }
    const path: Array<{ id: string; title?: string; weight: number }> = [];
    for (let cursor = start; cursor; cursor = best.get(cursor)?.next) {
      const node = d.nodes.get(cursor);
      path.push({ id: cursor, ...(node?.title ? { title: node.title } : {}), weight: node?.weight ?? 1 });
    }
    return { path: path.reverse(), totalWeight: start ? best.get(start)!.weight : 0, excludedCycles: cycles.map((cycle) => [...cycle].sort()) };
  }

  /** Inferred and observed collisions between pieces of work, as conflicts_with edges. */
  conflicts(): ResolvedEdge[] {
    return this.derived.conflictEdges();
  }

  /** Everything the graph found wrong with itself. Shown, never repaired. */
  findings(): WorkFinding[] {
    const d = this.derived;
    const memo = new Map<string, string | undefined>();
    const findings: WorkFinding[] = [];
    const dependsOn = (id: string): string[] => d.outOf(id).filter((edge) => edge.kind === "depends_on" && d.nodes.has(edge.to)).map((edge) => edge.to);
    const workItems = [...d.nodes.keys()].filter(isWorkItem).sort();
    for (const component of stronglyConnected(workItems, dependsOn)) {
      const selfLoop = component.length === 1 && dependsOn(component[0]!).includes(component[0]!);
      if (component.length < 2 && !selfLoop) continue;
      const members = new Set(component);
      const edges = component.flatMap((id) => d.outOf(id).filter((edge) => edge.kind === "depends_on" && members.has(edge.to)));
      const declared = edges.every((edge) => edge.status === "declared");
      findings.push({
        kind: "cycle",
        detail: `${component.length} item(s) depend on each other${declared ? "" : " (partly by inference)"}: ${[...component].sort().join(" → ")}`,
        nodes: [...component].sort(),
        edges: edges.map((edge) => edge.id).sort(),
      });
    }
    const all = d.allEdges();
    for (const edge of all) {
      const resolved = d.resolve(edge, memo);
      if (resolved.status === "missing") {
        findings.push({ kind: "missing", detail: `${edge.from} ${edge.kind.replace("_", " ")} ${edge.to}, which does not exist (${edge.provenance.source}).`, nodes: [edge.from, edge.to], edges: [edge.id] });
      } else if (resolved.freshness === "stale") {
        findings.push({ kind: "stale", detail: `${edge.from} → ${edge.to}: ${resolved.staleReason}`, nodes: [edge.from, edge.to], edges: [edge.id] });
      }
    }
    for (const edge of all) {
      if (edge.kind !== "consumes") continue;
      const problem = d.inputProblem(edge, memo);
      if (problem) findings.push({ kind: "incompatible_input", detail: `${edge.from} consumes ${edge.to}: ${problem}`, nodes: [edge.from, edge.to], edges: [edge.id] });
    }
    for (const link of this._linkFindings) {
      findings.push({
        kind: "healed_link",
        detail: `${link.ticketId}.${link.link} → ${link.target} was dropped when the tickets were read (${link.reason === "cycle" ? "it formed a cycle" : link.reason === "self" ? "it pointed at itself" : "that ticket does not exist"}).`,
        nodes: [ids.ticket(link.ticketId), ids.ticket(link.target)],
      });
    }
    for (const edge of d.conflictEdges()) {
      if (edge.status === "verified") findings.push({ kind: "conflict", detail: `${edge.from} and ${edge.to} changed ${edge.provenance.ref} at overlapping times.`, nodes: [edge.from, edge.to], edges: [edge.id] });
    }
    const order = ["cycle", "missing", "stale", "incompatible_input", "healed_link", "conflict"];
    return findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.detail.localeCompare(b.detail));
  }
}

/** Count-keyed membership: an item stays listed while any edge still puts it there. */
class Members {
  private readonly _map = new Map<string, Map<string, number>>();
  add(key: string, value: string): void {
    const inner = this._map.get(key) ?? new Map<string, number>();
    inner.set(value, (inner.get(value) ?? 0) + 1);
    this._map.set(key, inner);
  }
  remove(key: string, value: string): void {
    const inner = this._map.get(key);
    const count = inner?.get(value);
    if (!inner || count === undefined) return;
    if (count > 1) inner.set(value, count - 1);
    else inner.delete(value);
    if (inner.size === 0) this._map.delete(key);
  }
  get(key: string): string[] {
    return [...(this._map.get(key)?.keys() ?? [])];
  }
  entries(): IterableIterator<[string, Map<string, number>]> {
    return this._map.entries();
  }
}

const byId = (a: WorkEdge, b: WorkEdge): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.provenance.ref.localeCompare(b.provenance.ref));

/**
 * The read indexes over every partition, kept in step one partition at a time: adding or removing
 * a partition touches only its own nodes and edges. Answers that span the whole graph (conflicts)
 * are cached and dropped whenever anything changes.
 */
class Derived {
  readonly nodes = new Map<string, WorkNode>();
  /** Several partitions can name the same node (one contract behind several receipts). */
  private readonly _nodeOwners = new Map<string, Map<string, WorkNode>>();
  private readonly _edges = new Set<WorkEdge>();
  private readonly _out = new Map<string, Set<WorkEdge>>();
  private readonly _in = new Map<string, Set<WorkEdge>>();
  /** Observed changes per file. */
  private readonly _changes = new Map<string, Map<WorkEdge, Change>>();
  /** Receipt node → its observed changes, for judging the receipt's own freshness. */
  private readonly _receiptFiles = new Map<string, Set<WorkEdge>>();
  private readonly _declaredFiles = new Members();
  private readonly _declaredAreas = new Members();
  private readonly _observedFiles = new Members();
  /** Subject → its receipts with their time, for "superseded". */
  private readonly _receiptsBySubject = new Map<string, Map<string, string>>();
  private _conflicts: ResolvedEdge[] | undefined;

  constructor(private readonly _ports: WorkGraphPorts) {}

  get edgeCount(): number {
    return this._edges.size;
  }

  touch(): void {
    this._conflicts = undefined;
  }

  add(partition: Partition): void {
    this._conflicts = undefined;
    for (const node of partition.nodes) {
      const owners = this._nodeOwners.get(node.id) ?? new Map<string, WorkNode>();
      owners.set(partition.key, node);
      this._nodeOwners.set(node.id, owners);
      this.nodes.set(node.id, node);
    }
    for (const edge of partition.edges) this._index(edge, true);
  }

  remove(partition: Partition): void {
    this._conflicts = undefined;
    for (const node of partition.nodes) {
      const owners = this._nodeOwners.get(node.id);
      if (!owners) continue;
      owners.delete(partition.key);
      if (owners.size === 0) {
        this._nodeOwners.delete(node.id);
        this.nodes.delete(node.id);
      } else {
        this.nodes.set(node.id, [...owners.values()].at(-1)!);
      }
    }
    for (const edge of partition.edges) this._index(edge, false);
  }

  private _index(edge: WorkEdge, adding: boolean): void {
    const toggle = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
      if (adding) {
        const set = map.get(key) ?? new Set<V>();
        set.add(value);
        map.set(key, set);
      } else {
        const set = map.get(key);
        set?.delete(value);
        if (set && set.size === 0) map.delete(key);
      }
    };
    if (adding) this._edges.add(edge); else this._edges.delete(edge);
    toggle(this._out, edge.from, edge);
    toggle(this._in, edge.to, edge);
    if (edge.kind === "modifies") {
      const target = stripPrefix(edge.to);
      if (edge.status === "verified") {
        const changes = this._changes.get(target) ?? new Map<WorkEdge, Change>();
        if (adding) changes.set(edge, { at: edge.observedAt ?? "", subject: edge.from, ...(edge.sha256 ? { sha256: edge.sha256 } : {}) });
        else changes.delete(edge);
        if (changes.size) this._changes.set(target, changes); else this._changes.delete(target);
        if (adding) this._observedFiles.add(target, edge.from); else this._observedFiles.remove(target, edge.from);
        if (edge.provenance.source === "receipt.observed") toggle(this._receiptFiles, ids.receipt(edge.provenance.ref), edge);
      } else {
        const members = kindOf(edge.to) === "area" ? this._declaredAreas : this._declaredFiles;
        if (adding) members.add(target, edge.from); else members.remove(target, edge.from);
      }
    }
    if ((edge.kind === "verified_by" || edge.kind === "informed_by") && kindOf(edge.to) === "receipt" && edge.provenance.source === "receipt.status") {
      const receipts = this._receiptsBySubject.get(edge.from) ?? new Map<string, string>();
      if (adding) receipts.set(edge.to, edge.observedAt ?? ""); else receipts.delete(edge.to);
      if (receipts.size) this._receiptsBySubject.set(edge.from, receipts); else this._receiptsBySubject.delete(edge.from);
    }
  }

  allEdges(): WorkEdge[] {
    return [...this._edges].sort(byId);
  }

  outOf(id: string): WorkEdge[] {
    return [...(this._out.get(id) ?? [])].sort(byId);
  }

  inOf(id: string): WorkEdge[] {
    return [...(this._in.get(id) ?? [])].sort(byId);
  }

  /** Observed changes to a file, newest first. */
  private _changesTo(path: string): Change[] {
    return [...(this._changes.get(path)?.values() ?? [])].sort((a, b) => b.at.localeCompare(a.at) || a.subject.localeCompare(b.subject));
  }

  /** Receipts for a subject, newest first. */
  private _receiptsFor(subject: string): string[] {
    return [...(this._receiptsBySubject.get(subject) ?? [])]
      .sort((a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]))
      .map(([receipt]) => receipt);
  }

  /** Work that modifies a path, whether declared, observed, or through an area containing it. */
  itemsTouching(path: string): string[] {
    const out = new Set<string>([...this._declaredFiles.get(path), ...this._observedFiles.get(path), ...this._declaredAreas.get(path)]);
    for (const ancestor of ancestors(path)) for (const item of this._declaredAreas.get(ancestor)) out.add(item);
    return [...out].filter((item) => isWorkItem(item)).sort();
  }

  private _targetMissing(edge: WorkEdge): boolean {
    if (edge.status === "verified") return false;
    const kind = kindOf(edge.to);
    if (kind === "ticket" || kind === "phase" || kind === "step" || kind === "plan" || kind === "receipt" || kind === "contract") return !this.nodes.has(edge.to);
    if (kind === "file") return this._ports.fileExists ? !this._ports.fileExists(stripPrefix(edge.to)) : false;
    return false;
  }

  private _fingerprint(path: string, memo: Map<string, string | undefined>): string | undefined {
    if (!this._ports.fingerprint) return undefined;
    if (!memo.has(path)) {
      let value: string | undefined;
      try { value = this._ports.fingerprint(path); } catch { value = undefined; }
      memo.set(path, value);
    }
    return memo.get(path);
  }

  /** Why an observed change no longer describes the file, or undefined while it still does. */
  private _changeStale(edge: WorkEdge, memo: Map<string, string | undefined>): string | undefined {
    const path = stripPrefix(edge.to);
    const later = this._changesTo(path).find((change) => change.subject !== edge.from && change.at > (edge.observedAt ?? ""));
    if (later) return `${later.subject} changed ${path} afterwards.`;
    if (edge.sha256) {
      const now = this._fingerprint(path, memo);
      if (now !== undefined && now !== edge.sha256) return `${path} has changed since the receipt recorded it.`;
    }
    return undefined;
  }

  resolve(edge: WorkEdge, memo: Map<string, string | undefined>): ResolvedEdge {
    const status: EdgeStatus = this._targetMissing(edge) ? "missing" : edge.status;
    let staleReason: string | undefined;
    if (edge.status === "verified" && edge.kind === "modifies") {
      staleReason = this._changeStale(edge, memo);
    } else if (edge.kind === "verified_by" && kindOf(edge.to) === "receipt") {
      for (const change of [...(this._receiptFiles.get(edge.to) ?? [])].sort(byId)) {
        const reason = this._changeStale(change, memo);
        if (reason) { staleReason = `The verification no longer holds: ${reason}`; break; }
      }
    }
    return { ...edge, status, freshness: staleReason ? "stale" : "fresh", ...(staleReason ? { staleReason } : {}) };
  }

  /** A consumed input that no longer matches what was pinned, or that a newer receipt replaced. */
  inputProblem(edge: WorkEdge, memo: Map<string, string | undefined>): string | undefined {
    const kind = kindOf(edge.to);
    if (kind === "file" && edge.sha256) {
      const path = stripPrefix(edge.to);
      const latest = this._changesTo(path).find((change) => change.sha256)?.sha256 ?? this._fingerprint(path, memo);
      if (latest && latest !== edge.sha256) return `it was pinned to a version of ${path} that has since changed.`;
    }
    if (kind === "receipt" && this.nodes.has(edge.to)) {
      for (const subject of [...this._receiptsBySubject.keys()].sort()) {
        const receipts = this._receiptsFor(subject);
        const index = receipts.indexOf(edge.to);
        if (index > 0) return `${subject} has a newer receipt (${receipts[0]!}).`;
      }
    }
    return undefined;
  }

  conflictEdges(): ResolvedEdge[] {
    if (this._conflicts) return this._conflicts;
    const open = (id: string): boolean => {
      const state = this.nodes.get(id)?.state;
      return state === "open" || state === "blocked";
    };
    const pairs = new Map<string, ResolvedEdge>();
    const record = (a: string, b: string, status: "inferred" | "verified", ref: string): void => {
      if (pairs.size >= MAX_CONFLICTS || a === b) return;
      const [from, to] = a < b ? [a, b] : [b, a];
      const source = status === "verified" ? "graph.concurrent_change" : "graph.territory_overlap";
      const id = edgeId("conflicts_with", from, to, source);
      if (pairs.has(id)) return;
      pairs.set(id, { id, kind: "conflicts_with", from, to, status, provenance: { source, ref }, confidence: status === "verified" ? 1 : 0.6, freshness: "fresh" });
    };
    // Inferred: open work that says it will modify the same place. Steps of one plan share their
    // phase's files by construction, so they are not each other's conflicts.
    const samePlan = (a: string, b: string): boolean => kindOf(a) === "step" && kindOf(b) === "step" && a.split("/")[0] === b.split("/")[0];
    const groups = new Map<string, Set<string>>();
    for (const [file, items] of this._declaredFiles.entries()) groups.set(file, new Set(items.keys()));
    for (const [area, items] of this._declaredAreas.entries()) {
      const group = groups.get(area) ?? new Set<string>();
      for (const item of items.keys()) group.add(item);
      groups.set(area, group);
    }
    for (const place of [...groups.keys()].sort()) {
      const holders = [...groups.get(place)!].filter((item) => isWorkItem(item) && kindOf(item) !== "phase" && open(item));
      for (const ancestor of ancestors(place)) for (const item of this._declaredAreas.get(ancestor)) if (kindOf(item) !== "phase" && open(item)) holders.push(item);
      const unique = [...new Set(holders)].sort();
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) if (!samePlan(unique[i]!, unique[j]!)) record(unique[i]!, unique[j]!, "inferred", place);
      }
    }
    // Observed: two pieces of work whose receipts changed the same file within a day of each other.
    const DAY = 24 * 60 * 60 * 1000;
    for (const file of [...this._changes.keys()].sort()) {
      const changes = this._changesTo(file);
      for (let i = 0; i < changes.length; i += 1) {
        for (let j = i + 1; j < changes.length; j += 1) {
          const a = changes[i]!;
          const b = changes[j]!;
          if (a.subject === b.subject || !isWorkItem(a.subject) || !isWorkItem(b.subject)) continue;
          if (Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= DAY) record(a.subject, b.subject, "verified", file);
        }
      }
    }
    this._conflicts = [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
    return this._conflicts;
  }
}

/** Tarjan's algorithm, iterative so a 20k-step plan does not overflow the stack. */
export function stronglyConnected(nodes: readonly string[], next: (id: string) => readonly string[]): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; edges: readonly string[]; i: number }> = [];
    const visit = (id: string): void => {
      index.set(id, counter);
      low.set(id, counter);
      counter += 1;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), i: 0 });
    };
    visit(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.edges.length) {
        const target = frame.edges[frame.i]!;
        frame.i += 1;
        if (!index.has(target)) visit(target);
        else if (onStack.has(target)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(target)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        out.push(component);
      }
    }
  }
  return out;
}

/** Dependencies first. Assumes no cycles among the given nodes. */
function topological(nodes: readonly string[], deps: (id: string) => readonly string[]): string[] {
  const set = new Set(nodes);
  const visited = new Set<string>();
  const order: string[] = [];
  for (const root of [...nodes].sort()) {
    if (visited.has(root)) continue;
    const stack: Array<{ id: string; i: number; edges: readonly string[] }> = [{ id: root, i: 0, edges: deps(root).filter((dep) => set.has(dep)) }];
    visited.add(root);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.i < frame.edges.length) {
        const dep = frame.edges[frame.i]!;
        frame.i += 1;
        if (!visited.has(dep)) {
          visited.add(dep);
          stack.push({ id: dep, i: 0, edges: deps(dep).filter((entry) => set.has(entry)) });
        }
        continue;
      }
      stack.pop();
      order.push(frame.id);
    }
  }
  return order;
}
