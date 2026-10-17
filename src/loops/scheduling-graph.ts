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
import { isWorkItem, type ResolvedEdge } from "../orchestration/work-graph/model.js";
import {
  evaluateIntegration, type ConsumedInterface, type ProducedInterface, type TaskFacts,
} from "../orchestration/integration-gate.js";
import type { SchedulingGraph } from "./loop-scheduler.js";

const TICKET = "ticket:";
const bare = (id: string): string | undefined => (id.startsWith(TICKET) ? id.slice(TICKET.length) : undefined);

export interface SchedulingGraphOptions {
  /**
   * #21. Hold a ticket whose contract consumes something other open work has declared it will
   * produce, until that work is verified or closed and what it produced matches what the consumer
   * pinned. Off: `waitingInputs` holds nothing, as before.
   */
  inputs?: boolean;
}

/** Revisions of file contents carry no separate interface, so only the content can move. */
const CONTENT = "content";

export function schedulingGraphFrom(graph: WorkGraph, options: SchedulingGraphOptions = {}): SchedulingGraph {
  let critical: { ids: ReadonlySet<string>; weight: number } | undefined;
  let cycles: Map<string, string[]> | undefined;
  const blockers = new Map<string, Array<{ id: string; missing: boolean; source: string }>>();
  const waiting = new Map<string, string[]>();
  let producers: Map<string, ResolvedEdge[]> | undefined;

  /** Declared deliverables of work items, by what they produce. Built once per pass. */
  const producersOf = (nodeId: string): ResolvedEdge[] => {
    if (!producers) {
      producers = new Map();
      for (const edge of graph.edges()) {
        if (edge.kind !== "produces" || edge.status === "missing" || !isWorkItem(edge.from)) continue;
        producers.set(edge.to, [...(producers.get(edge.to) ?? []), edge]);
      }
    }
    return producers.get(nodeId) ?? [];
  };

  /** The content the producer last left in a file it modified, when a receipt recorded it. */
  const producedRevision = (producer: string, nodeId: string): string => {
    const change = graph.trace(producer).affectedCode
      .filter((edge) => edge.to === nodeId && edge.status === "verified" && edge.sha256)
      .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""))[0];
    return change?.sha256 ?? "unproduced";
  };

  /**
   * One line per consumed input the gate holds this ticket on, judged one input at a time so each
   * line names exactly what is awaited.
   */
  const inputsWaitedOn = (ticketId: string): string[] => {
    const self = `${TICKET}${ticketId}`;
    const out: string[] = [];
    for (const edge of graph.trace(self).consumes) {
      if (edge.status === "missing") continue;
      const sources = producersOf(edge.to).filter((source) => source.from !== self);
      // An input nobody open has said they will produce is just an input: nothing to wait for.
      if (sources.length === 0) continue;
      const tasks: TaskFacts[] = [{ id: self, revision: "consumer", dependsOn: [], writes: [] }];
      const produced: ProducedInterface[] = [];
      for (const source of sources) {
        const verified = graph.node(source.from)?.state === "done"
          || graph.trace(source.from).evidence.some((item) => item.kind === "verified_by");
        tasks.push({ id: source.from, revision: source.from, dependsOn: [], writes: [], ...(verified ? { verdict: "verified" as const } : {}) });
        produced.push({ taskId: source.from, name: edge.to, revision: producedRevision(source.from, edge.to), interfaceHash: CONTENT });
      }
      // Unpinned, the consumer accepts whatever its single producer leaves.
      const expectedRevision = edge.sha256 ?? (produced.length === 1 ? produced[0]!.revision : "unpinned");
      const consumed: ConsumedInterface[] = [{ taskId: self, name: edge.to, expectedRevision, expectedInterfaceHash: CONTENT }];
      const verdict = evaluateIntegration({ tasks, produced, consumed }).readiness.find((entry) => entry.taskId === self);
      if (!verdict || verdict.readiness === "ready") continue;
      const who = sources.map((source) => bare(source.from) ?? source.from).sort().join(", ");
      const what = edge.to.replace(/^file:/, "");
      out.push(verdict.reasons.some((reason) => reason.startsWith("producer_revision_moved"))
        ? `${who} to produce ${what} again (it changed after this ticket pinned it)`
        : `${who} to produce ${what}`);
    }
    return out;
  };
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
    waitingInputs(ticketId) {
      if (!options.inputs) return [];
      const cached = waiting.get(ticketId);
      if (cached) return cached;
      const out = inputsWaitedOn(ticketId);
      waiting.set(ticketId, out);
      return out;
    },
    observedFiles(ticketId) {
      return graph.trace(`${TICKET}${ticketId}`).affectedCode
        .filter((edge) => edge.status === "verified" && edge.to.startsWith("file:"))
        .map((edge) => edge.to.slice("file:".length));
    },
  };
}
