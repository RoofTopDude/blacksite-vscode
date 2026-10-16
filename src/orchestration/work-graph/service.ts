/**
 * The work graph as the host keeps it: built on first use, refreshed incrementally when a store
 * says it changed, and answering the agent's `work_graph` tool. No vscode import — the host passes
 * in how to read each store and how to reach the Codebase Map.
 */

import type { Ticket, TicketLinkFinding } from "../../ticket-store.js";
import type { TaskPlan } from "../../planning-store.js";
import type { ReceiptStore } from "../receipt-store.js";
import type { WorkReceipt } from "../work-receipt.js";
import { WorkGraph, type WorkGraphPorts } from "./graph.js";
import type { ResolvedEdge } from "./model.js";

export interface WorkGraphServiceOptions {
  enabled: () => boolean;
  readTickets: () => { tickets: readonly Ticket[]; linkFindings?: readonly TicketLinkFinding[] };
  readPlans: () => readonly TaskPlan[];
  receipts?: ReceiptStore;
  ports?: WorkGraphPorts;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function compact(edge: ResolvedEdge, from: boolean): Record<string, unknown> {
  return {
    [from ? "from" : "to"]: from ? edge.from : edge.to,
    relation: edge.kind,
    status: edge.status,
    ...(edge.freshness === "stale" ? { stale: edge.staleReason } : {}),
    source: edge.provenance.source,
    ...(edge.status === "inferred" ? { confidence: edge.confidence } : {}),
  };
}

export class WorkGraphService {
  private readonly _graph: WorkGraph;
  private _dirty = true;
  /** Receipts never change once written; read each one once. */
  private readonly _receiptCache = new Map<string, WorkReceipt>();

  constructor(private readonly _options: WorkGraphServiceOptions) {
    this._graph = new WorkGraph(_options.ports ?? {});
  }

  enabled(): boolean {
    return this._options.enabled();
  }

  /** A store changed: the next question rebuilds what changed. */
  markDirty(): void {
    this._dirty = true;
  }

  /** The Codebase Map reindexed: which files exist and what depends on what may have moved. */
  mapChanged(): void {
    this._graph.invalidate();
  }

  graph(): WorkGraph {
    if (this._dirty) {
      this._dirty = false;
      const { tickets, linkFindings } = this._options.readTickets();
      const receipts: WorkReceipt[] = [];
      const store = this._options.receipts;
      for (const entry of store?.index() ?? []) {
        let receipt = this._receiptCache.get(entry.id);
        if (!receipt) {
          receipt = store?.getReceipt(entry.id);
          if (receipt) this._receiptCache.set(entry.id, receipt);
        }
        if (receipt) receipts.push(receipt);
      }
      this._graph.update({
        tickets,
        plans: this._options.readPlans(),
        receipts,
        ...(store ? { contract: (id: string) => store.getContract(id) } : {}),
        ...(linkFindings ? { ticketLinkFindings: linkFindings } : {}),
      });
    }
    return this._graph;
  }

  /** The `work_graph` tool. */
  async dispatch(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.enabled()) return { ok: false, error: "The work graph is off. Turn on blacksite.orchestration.workGraph to use it." };
    const limit = Math.min(Math.max(Number(payload.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const ref = typeof payload.ref === "string" ? payload.ref.trim() : "";
    const needsRef = ["trace", "blockers", "dependencies", "dependents", "impact"];
    if (needsRef.includes(op) && !ref) return { ok: false, error: `work_graph ${op} needs a ref: a ticket id, planId/phaseId/stepId, or a file path.` };
    const graph = this.graph();
    switch (op) {
      case "trace": {
        const trace = graph.trace(ref);
        const cap = <T>(list: T[]): { items: T[]; more?: number } => (list.length > limit ? { items: list.slice(0, limit), more: list.length - limit } : { items: list });
        return {
          ok: true,
          node: trace.node,
          affectedCode: cap(trace.affectedCode.map((edge) => compact(edge, false))),
          dependencies: cap(trace.dependencies.map((edge) => compact(edge, false))),
          dependents: cap(trace.dependents.map((edge) => compact(edge, true))),
          deliverables: cap(trace.deliverables.map((edge) => compact(edge, false))),
          consumes: cap(trace.consumes.map((edge) => compact(edge, false))),
          evidence: cap(trace.evidence.map((edge) => compact(edge, false))),
          conflicts: cap(trace.conflicts.map((edge) => ({ with: edge.from === graph.resolveRef(ref) ? edge.to : edge.from, status: edge.status, place: edge.provenance.ref }))),
        };
      }
      case "blockers":
        return { ok: true, ref: graph.resolveRef(ref), blockers: graph.blockers(ref).slice(0, limit) };
      case "dependencies":
      case "dependents": {
        const depth = Number(payload.depth) || 3;
        return { ok: true, ref: graph.resolveRef(ref), [op]: graph.walk(ref, op, depth).slice(0, limit) };
      }
      case "impact":
        return { ok: true, ref: graph.resolveRef(ref), reaches: graph.impact(ref).slice(0, limit) };
      case "critical_path": {
        const scope = typeof payload.scope === "string" && payload.scope.trim() ? payload.scope.trim() : undefined;
        const result = graph.criticalPath(scope);
        return { ok: true, ...result, path: result.path.slice(0, limit), excludedCycles: result.excludedCycles.slice(0, 20) };
      }
      case "conflicts": {
        const conflicts = graph.conflicts();
        return { ok: true, total: conflicts.length, conflicts: conflicts.slice(0, limit).map((edge) => ({ between: [edge.from, edge.to], status: edge.status, place: edge.provenance.ref })) };
      }
      case "findings": {
        const findings = graph.findings();
        const counts: Record<string, number> = {};
        for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
        return { ok: true, counts, findings: findings.slice(0, limit) };
      }
      default:
        return { ok: false, error: `Unknown work_graph op "${op}".` };
    }
  }
}
