/**
 * The work graph, as the loop scheduler reads it (#15).
 *
 * Built once per scheduling pass over the graph as it stands; every question is answered from the
 * graph's own queries (blockers, dependents, critical path, findings) and memoised for the pass.
 * Ticket ids go in and come out bare ("BLK-12"). Inferred dependencies (a parent waiting on its
 * children) inform ranking only; only declared and observed ones can hold a ticket back.
 *
 * Pure apart from reading the graph.
 */

import type { WorkGraph } from "../orchestration/work-graph/graph.js";
import type { SchedulingGraph } from "./loop-scheduler.js";

const TICKET = "ticket:";
const bare = (id: string): string | undefined => (id.startsWith(TICKET) ? id.slice(TICKET.length) : undefined);

export function schedulingGraphFrom(graph: WorkGraph): SchedulingGraph {
  let critical: { ids: ReadonlySet<string>; weight: number } | undefined;
  let cycles: Map<string, string[]> | undefined;
  const blockers = new Map<string, Array<{ id: string; missing: boolean; source: string }>>();
  const downstream = new Map<string, string[]>();

  const cycleIndex = (): Map<string, string[]> => {
    if (cycles) return cycles;
    cycles = new Map();
    for (const finding of graph.findings()) {
      if (finding.kind !== "cycle") continue;
      const members = finding.nodes.map(bare).filter((id): id is string => !!id).sort();
      // Only declared or observed cycles hold work back; an inferred one is a suggestion.
      const declared = (finding.edges ?? []).length === 0 || (finding.edges ?? []).every((edge) => !edge.includes(":graph.") && !edge.endsWith(":ticket.parentId") && !edge.endsWith(":step.order"));
      if (!declared) continue;
      for (const id of members) cycles.set(id, members);
    }
    return cycles;
  };

  return {
    hardBlockers(ticketId) {
      const cached = blockers.get(ticketId);
      if (cached) return cached;
      const out = graph.blockers(`${TICKET}${ticketId}`)
        .filter((entry) => entry.status !== "inferred")
        .flatMap((entry) => {
          const id = bare(entry.id);
          return id ? [{ id, missing: entry.status === "missing", source: entry.source }] : [];
        });
      blockers.set(ticketId, out);
      return out;
    },
    downstreamOpen(ticketId) {
      const cached = downstream.get(ticketId);
      if (cached) return cached;
      const out = graph.walk(`${TICKET}${ticketId}`, "dependents", 10)
        .filter((entry) => entry.status !== "inferred" && entry.status !== "missing" && (entry.state === "open" || entry.state === "blocked"))
        .map((entry) => bare(entry.id))
        .filter((id): id is string => !!id)
        .sort();
      downstream.set(ticketId, out);
      return out;
    },
    criticalPath() {
      if (!critical) {
        const path = graph.criticalPath("tickets");
        critical = {
          ids: new Set(path.path.length > 1 ? path.path.map((entry) => bare(entry.id)).filter((id): id is string => !!id) : []),
          weight: path.totalWeight,
        };
      }
      return critical;
    },
    cycleOf(ticketId) {
      return cycleIndex().get(ticketId);
    },
    waitingInputs() {
      // Contract inputs produced by other open work become `consumes` edges once #17 lands.
      return [];
    },
    observedFiles(ticketId) {
      return graph.trace(`${TICKET}${ticketId}`).affectedCode
        .filter((edge) => edge.status === "verified" && edge.to.startsWith("file:"))
        .map((edge) => edge.to.slice("file:".length));
    },
  };
}
