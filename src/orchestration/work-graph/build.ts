/**
 * One partition of the work graph per source entity: a ticket, a plan, a receipt.
 *
 * A partition depends only on its own entity, so a change rebuilds exactly the partitions whose
 * entity changed. Anything that depends on two entities at once — whether a target exists, whether
 * evidence is stale, which open work collides — is resolved when the graph is read (graph.ts).
 */

import type { Ticket } from "../../ticket-store.js";
import type { TaskPlan } from "../../planning-store.js";
import type { WorkContract } from "../work-contract.js";
import type { WorkReceipt } from "../work-receipt.js";
import { edgeId, ids, type EdgeSource, type StoredEdgeStatus, type WorkEdge, type WorkNode, type WorkRelation, type WorkState } from "./model.js";

export interface Partition {
  key: string;
  /** Changes whenever anything this partition was built from changes. */
  rev: string;
  nodes: WorkNode[];
  edges: WorkEdge[];
}

const WEIGHT: Record<string, number> = { small: 1, medium: 3, large: 8 };

class PartitionBuilder {
  readonly nodes: WorkNode[] = [];
  readonly edges: WorkEdge[] = [];
  private readonly _seen = new Set<string>();

  node(node: WorkNode): void {
    this.nodes.push(node);
  }

  edge(kind: WorkRelation, from: string, to: string, status: StoredEdgeStatus, source: EdgeSource, ref: string, extra: Partial<WorkEdge> = {}): void {
    const id = edgeId(kind, from, to, source);
    if (this._seen.has(id)) return;
    this._seen.add(id);
    this.edges.push({
      id, kind, from, to, status,
      provenance: { source, ref },
      confidence: status === "inferred" ? extra.confidence ?? 0.5 : 1,
      ...(extra.observedAt ? { observedAt: extra.observedAt } : {}),
      ...(extra.sha256 ? { sha256: extra.sha256 } : {}),
    });
  }

  build(key: string, rev: string): Partition {
    return { key, rev, nodes: this.nodes, edges: this.edges };
  }
}

function ticketState(status: Ticket["status"]): WorkState {
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "blocked";
  return "open";
}

/* Revisions are compared on every update for every entity, so they are joined strings rather than
   JSON: an update over 10k tickets and 20k plan steps spends most of its time here. The separators
   are control characters that cannot appear in ids, titles or paths. */
const F = "\u0001";
const L = "\u0002";

export function ticketRev(ticket: Ticket): string {
  return ticket.updatedAt + F + ticket.status + F + ticket.title + F + (ticket.complexity ?? "") + F + ticket.blockedBy.join(L)
    + F + (ticket.parentId ?? "") + F + ticket.territory.files.join(L) + F + ticket.territory.areas.join(L) + F + ticket.runIds.join(L)
    + F + (ticket.planId ?? "") + F + (ticket.phaseId ?? "");
}

export function ticketPartition(ticket: Ticket): Partition {
  const b = new PartitionBuilder();
  const self = ids.ticket(ticket.id);
  b.node({ id: self, kind: "ticket", title: ticket.title, state: ticketState(ticket.status), weight: WEIGHT[ticket.complexity ?? "small"] ?? 1 });
  for (const blocker of ticket.blockedBy) b.edge("depends_on", self, ids.ticket(blocker), "declared", "ticket.blockedBy", ticket.id);
  // A parent is finished when its subtasks are: an inference about order, not a declared block.
  if (ticket.parentId) b.edge("depends_on", ids.ticket(ticket.parentId), self, "inferred", "ticket.parentId", ticket.id, { confidence: 0.6 });
  for (const file of ticket.territory.files) b.edge("modifies", self, ids.file(file), "declared", "ticket.territory", ticket.id);
  for (const area of ticket.territory.areas) b.edge("modifies", self, ids.area(area), "declared", "ticket.territory", ticket.id);
  for (const runId of ticket.runIds) b.edge("informed_by", self, ids.run(runId), "declared", "ticket.runIds", ticket.id);
  if (ticket.planId && ticket.phaseId) b.edge("informed_by", self, ids.phase(ticket.planId, ticket.phaseId), "declared", "ticket.plan", ticket.id);
  return b.build(ids.ticket(ticket.id), ticketRev(ticket));
}

export function planRev(plan: TaskPlan): string {
  let rev = plan.updatedAt + F + plan.status + F + plan.title;
  for (const phase of plan.phases) {
    rev += L + phase.id + F + phase.status + F + (phase.dependsOn ?? []).join(",") + F + (phase.files ?? []).join(",") + F + (phase.complexity ?? "")
      + F + phase.docs.map((doc) => doc.id).join(",") + F + (phase.runEvidence?.runIds ?? []).join(",");
    for (const step of phase.steps) {
      rev += F + step.id + "=" + step.status + "=" + step.title + "=" + (step.evidence?.at ?? "") + "=" + (step.evidence?.receiptIds ?? []).join(",")
        + "=" + (step.evidence?.filesChanged ?? []).join(",");
    }
  }
  return rev;
}

function stepState(status: string): WorkState {
  return status === "completed" ? "done" : status === "blocked" ? "blocked" : "open";
}

export function planPartition(plan: TaskPlan): Partition {
  const b = new PartitionBuilder();
  const planNode = ids.plan(plan.id);
  b.node({ id: planNode, kind: "plan", title: plan.title, state: plan.status === "completed" ? "done" : plan.status === "cancelled" || plan.status === "archived" ? "cancelled" : "open" });
  const lastStepOf = new Map<string, string>();
  for (const phase of plan.phases) {
    const last = phase.steps.at(-1);
    if (last) lastStepOf.set(phase.id, ids.step(plan.id, phase.id, last.id));
  }
  for (const phase of plan.phases) {
    const phaseNode = ids.phase(plan.id, phase.id);
    const weight = WEIGHT[phase.complexity ?? "small"] ?? 1;
    b.node({ id: phaseNode, kind: "phase", title: phase.title, state: stepState(phase.status) });
    for (const dependency of phase.dependsOn ?? []) {
      b.edge("depends_on", phaseNode, ids.phase(plan.id, dependency), "declared", "phase.dependsOn", `${plan.id}/${phase.id}`);
      // The first step cannot sensibly start before the phase it depends on has finished.
      const first = phase.steps[0];
      const upstream = lastStepOf.get(dependency);
      if (first && upstream) b.edge("depends_on", ids.step(plan.id, phase.id, first.id), upstream, "inferred", "phase.dependsOn", `${plan.id}/${phase.id}`, { confidence: 0.7 });
    }
    for (const file of phase.files ?? []) b.edge("modifies", phaseNode, ids.file(file), "declared", "phase.files", `${plan.id}/${phase.id}`);
    for (const doc of phase.docs) b.edge("consumes", phaseNode, ids.doc(plan.id, doc.id), "declared", "phase.docs", `${plan.id}/${phase.id}`);
    for (const runId of phase.runEvidence?.runIds ?? []) b.edge("informed_by", phaseNode, ids.run(runId), "declared", "phase.runEvidence", `${plan.id}/${phase.id}`);
    let previous: string | undefined;
    for (const step of phase.steps) {
      const stepNode = ids.step(plan.id, phase.id, step.id);
      b.node({ id: stepNode, kind: "step", title: step.title, state: stepState(step.status), weight });
      // Steps are written in the order they are meant to be done: an inference, and a weak one.
      if (previous) b.edge("depends_on", stepNode, previous, "inferred", "step.order", `${plan.id}/${phase.id}`, { confidence: 0.5 });
      previous = stepNode;
      for (const file of phase.files ?? []) b.edge("modifies", stepNode, ids.file(file), "declared", "phase.files", `${plan.id}/${phase.id}`);
      const evidence = step.evidence;
      if (evidence) {
        for (const file of evidence.filesChanged) {
          b.edge("modifies", stepNode, ids.file(file), "verified", "step.evidence", `${plan.id}/${phase.id}/${step.id}`, { observedAt: evidence.at });
        }
        for (const runId of evidence.runIds ?? []) b.edge("informed_by", stepNode, ids.run(runId), "verified", "step.evidence", `${plan.id}/${phase.id}/${step.id}`, { observedAt: evidence.at });
      }
    }
  }
  return b.build(ids.plan(plan.id), planRev(plan));
}

/** The work item a receipt describes. */
export function receiptSubjectNode(receipt: Pick<WorkReceipt, "subject">): string | undefined {
  const subject = receipt.subject;
  if (subject.ticketId) return ids.ticket(subject.ticketId);
  if (subject.planId && subject.phaseId && subject.stepId) return ids.step(subject.planId, subject.phaseId, subject.stepId);
  return undefined;
}

/** Receipts never change once written, so their id is their revision. */
export function receiptPartition(receipt: WorkReceipt, contract: WorkContract | undefined): Partition {
  const b = new PartitionBuilder();
  const self = ids.receipt(receipt.id);
  const ref = receipt.id;
  b.node({ id: self, kind: "receipt", title: receipt.status });
  const subject = receiptSubjectNode(receipt);
  if (subject) {
    // Only a verified receipt verifies its subject; any other receipt is evidence about it.
    b.edge(receipt.status === "verified" ? "verified_by" : "informed_by", subject, self, "verified", "receipt.status", ref, { observedAt: receipt.createdAt });
    for (const change of receipt.observed.filesChanged) {
      b.edge("modifies", subject, ids.file(change.path), "verified", "receipt.observed", ref, {
        observedAt: receipt.createdAt,
        ...(change.sha256 ? { sha256: change.sha256 } : {}),
      });
    }
  }
  for (const item of receipt.evidence) {
    if (item.kind === "run") b.edge("informed_by", self, ids.run(item.runId), "verified", "receipt.evidence", ref, { observedAt: receipt.createdAt });
    if (item.kind === "artifact") b.edge("produces", self, ids.artifact(item.sha256), "verified", "receipt.evidence", ref, { observedAt: receipt.createdAt });
  }
  if (contract) {
    const contractNode = ids.contract(contract.id);
    b.node({ id: contractNode, kind: "contract", title: contract.objective.split("\n")[0]?.slice(0, 120) });
    b.edge("informed_by", self, contractNode, "verified", "receipt.status", ref);
    const holder = subject ?? contractNode;
    for (const dependency of contract.dependencies) {
      const target = dependency.kind === "ticket" ? ids.ticket(dependency.id)
        : dependency.kind === "receipt" ? ids.receipt(dependency.id)
          : dependency.kind === "contract" ? ids.contract(dependency.id)
            : dependency.id.split("/").length === 3 ? `step:${dependency.id}` : `phase:${dependency.id}`;
      b.edge("depends_on", holder, target, "declared", "contract.dependencies", contract.id);
    }
    for (const input of contract.inputs) {
      const target = input.kind === "file" ? ids.file(input.id)
        : input.kind === "receipt" ? ids.receipt(input.id)
          : input.kind === "run" ? ids.run(input.id)
            : input.kind === "artifact" ? ids.artifact(input.sha256 ?? input.id)
              : `doc:${input.id}`;
      b.edge("consumes", holder, target, "declared", "contract.inputs", contract.id, input.sha256 ? { sha256: input.sha256 } : {});
    }
    for (const output of contract.outputs) {
      if (output.kind === "file_change" && output.ref) b.edge("produces", holder, ids.file(output.ref), "declared", "contract.outputs", contract.id);
    }
    if (contract.territory.writable !== "workspace") {
      for (const file of contract.territory.writable.files) b.edge("modifies", holder, ids.file(file), "declared", "contract.territory", contract.id);
      for (const area of contract.territory.writable.areas) b.edge("modifies", holder, ids.area(area), "declared", "contract.territory", contract.id);
    }
  }
  return b.build(self, receipt.id);
}
