/**
 * The work graph: tickets, plans, code, runs and receipts, and how they relate.
 *
 * It is derived, never authoritative. Every node id reuses the id its own store already gives it,
 * and nothing here is written back. An edge records what its source said — declared intent,
 * the graph's own inference, or something the host observed — and where it came from. Whether
 * its target still exists and whether the evidence behind it is still current are worked out
 * when the graph is read, so they are never stale themselves and never silently repaired.
 *
 * Pure. See docs/orchestration-p0-implementation-plan.md §7.
 */

export type WorkNodeKind =
  | "ticket" | "plan" | "phase" | "step"
  | "contract" | "receipt" | "run" | "doc"
  | "file" | "area" | "artifact";

/** Whether a piece of work is still to do. Everything that is not work has no state. */
export type WorkState = "open" | "done" | "blocked" | "cancelled";

export interface WorkNode {
  id: string;
  kind: WorkNodeKind;
  title?: string;
  state?: WorkState;
  /** Relative effort for critical-path weighting: small 1, medium 3, large 8. */
  weight?: number;
}

export type WorkRelation =
  | "depends_on" | "modifies" | "consumes" | "produces"
  | "conflicts_with" | "verified_by" | "informed_by";

export const WORK_RELATIONS: readonly WorkRelation[] = [
  "depends_on", "modifies", "consumes", "produces", "conflicts_with", "verified_by", "informed_by",
];

/**
 * What an edge's source said. `missing` is never stored: it is what a declared or inferred edge
 * becomes when read while its target does not exist.
 */
export type StoredEdgeStatus = "verified" | "declared" | "inferred";
export type EdgeStatus = StoredEdgeStatus | "missing";

export type EdgeSource =
  | "ticket.blockedBy" | "ticket.parentId" | "ticket.territory" | "ticket.runIds" | "ticket.plan"
  | "phase.dependsOn" | "phase.files" | "phase.docs" | "phase.runEvidence" | "step.order" | "step.evidence"
  | "contract.dependencies" | "contract.inputs" | "contract.outputs" | "contract.territory"
  | "receipt.observed" | "receipt.status" | "receipt.evidence"
  | "graph.territory_overlap" | "graph.concurrent_change";

export interface WorkEdge {
  id: string;
  kind: WorkRelation;
  from: string;
  to: string;
  status: StoredEdgeStatus;
  provenance: { source: EdgeSource; ref: string };
  /** 1 for verified and declared edges; the inference's strength otherwise. */
  confidence: number;
  observedAt?: string;
  /** For a verified change: the file's content hash when the receipt was written. */
  sha256?: string;
}

/** An edge as a reader sees it: its status resolved and its freshness judged. */
export interface ResolvedEdge extends Omit<WorkEdge, "status"> {
  status: EdgeStatus;
  freshness: "fresh" | "stale";
  staleReason?: string;
}

export function edgeId(kind: WorkRelation, from: string, to: string, source: EdgeSource): string {
  return `${kind}:${from}->${to}:${source}`;
}

// ── Node ids ──────────────────────────────────────────────────────────────────

export const ids = {
  ticket: (id: string) => `ticket:${id}`,
  plan: (id: string) => `plan:${id}`,
  phase: (planId: string, phaseId: string) => `phase:${planId}/${phaseId}`,
  step: (planId: string, phaseId: string, stepId: string) => `step:${planId}/${phaseId}/${stepId}`,
  contract: (id: string) => `contract:${id}`,
  receipt: (id: string) => `receipt:${id}`,
  run: (id: string) => `run:${id}`,
  doc: (planId: string, docId: string) => `doc:${planId}/${docId}`,
  file: (path: string) => `file:${path.replace(/\\/g, "/").replace(/^\.\//, "")}`,
  area: (path: string) => `area:${path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")}`,
  artifact: (sha256: string) => `artifact:sha256:${sha256}`,
};

export function kindOf(nodeId: string): WorkNodeKind {
  return nodeId.slice(0, nodeId.indexOf(":")) as WorkNodeKind;
}

/** Work items: the nodes that have a state and can block, depend and be scheduled. */
export function isWorkItem(nodeId: string): boolean {
  const kind = kindOf(nodeId);
  return kind === "ticket" || kind === "step" || kind === "phase" || kind === "plan";
}

export interface WorkFinding {
  kind: "cycle" | "missing" | "stale" | "incompatible_input" | "healed_link" | "conflict";
  /** One sentence for a person. */
  detail: string;
  nodes: string[];
  edges?: string[];
}
