/* #15 dependency-aware scheduling: the graph-aware ready set, the opt-in "verified review"
   dependency rule (D6), and the WorkGraph adapter. The legacy scheduler's own spec
   (loop-scheduler.spec.ts) is untouched and must keep passing. */

import { describe, expect, it } from "vitest";
import { defaultQueueSpec, type LoopTicketState } from "../../src/loops/loop-model.js";
import { computeReadySet, GRAPH_SCORE, type SchedulingGraph, type SchedulerInputs } from "../../src/loops/loop-scheduler.js";
import { schedulingGraphFrom } from "../../src/loops/scheduling-graph.js";
import { WorkGraph } from "../../src/orchestration/work-graph/graph.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog" as TicketStatus, statusSource: "manual", priority: "normal",
    complexity: "small", labels: [], acceptanceCriteria: [], territory: { files: [`src/${id}.ts`], areas: [] },
    references: [], runIds: [], blockedBy: [], blocks: [], relatedTo: [], children: [], assignee: "agent",
    origin: "user", events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

/** A SchedulingGraph worked out from the tickets alone, so the scheduler is tested on its own. */
function graphOf(tickets: readonly Ticket[], extra: Partial<SchedulingGraph> = {}): SchedulingGraph {
  const byId = new Map(tickets.map((entry) => [entry.id, entry] as const));
  const done = (id: string) => { const status = byId.get(id)?.status; return status === "done" || status === "cancelled"; };
  const dependents = (id: string): string[] => {
    const out = new Set<string>();
    const walk = (current: string) => {
      for (const candidate of tickets) {
        if (candidate.blockedBy.includes(current) && !done(candidate.id) && !out.has(candidate.id)) {
          out.add(candidate.id);
          walk(candidate.id);
        }
      }
    };
    walk(id);
    return [...out].sort();
  };
  const cycles = new Map<string, string[]>();
  for (const start of tickets) {
    // Follow blockedBy from each ticket; returning to it means it is on a cycle.
    const path: string[] = [];
    const visit = (id: string): boolean => {
      if (path.includes(id)) return id === start.id;
      path.push(id);
      for (const next of byId.get(id)?.blockedBy ?? []) if (byId.has(next) && visit(next)) return true;
      path.pop();
      return false;
    };
    if (visit(start.id)) cycles.set(start.id, [...path].sort());
  }
  return {
    hardBlockers: (id) => (byId.get(id)?.blockedBy ?? []).filter((blocker) => !done(blocker)).map((blocker) => ({ id: blocker, missing: !byId.has(blocker), source: "ticket.blockedBy" })),
    downstreamOpen: dependents,
    criticalPath: () => ({ ids: new Set<string>(), weight: 0 }),
    cycleOf: (id) => cycles.get(id),
    waitingInputs: () => [],
    observedFiles: () => [],
    ...extra,
  };
}

function inputs(tickets: Ticket[], overrides: Partial<SchedulerInputs> = {}): SchedulerInputs {
  return {
    tickets,
    spec: defaultQueueSpec(),
    state: new Map<string, LoopTicketState>(),
    inFlight: [],
    indexedFiles: tickets.flatMap((entry) => entry.territory.files),
    now: Date.parse("2026-01-02T00:00:00.000Z"),
    graph: graphOf(tickets),
    ...overrides,
  };
}

describe("graph-aware ready set", () => {
  it.each(["review", "done", "cancelled"] as const)("releases named %s tickets despite retained attempt state", (status) => {
    const item = ticket("A", { status });
    const spec = { ...defaultQueueSpec(), ids: [item.id] };
    const state = new Map<string, LoopTicketState>([[item.id, { ticketId: item.id, attempts: 1, touchedFiles: [] }]]);
    expect(computeReadySet(inputs([item], { spec, state })).ready).toHaveLength(1);
    expect(computeReadySet(inputs([item], { spec, state, explicitQueueStatusGuard: true }))).toEqual({ ready: [], withheld: [], queueSize: 0 });
  });
  it("never makes ready a ticket with an unmet hard dependency (property, 300 random graphs)", () => {
    let seed = 11;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const statuses: TicketStatus[] = ["backlog", "backlog", "backlog", "review", "done", "in_progress"];
    for (let run = 0; run < 300; run += 1) {
      const count = 3 + Math.floor(random() * 12);
      const ids = Array.from({ length: count }, (_, index) => `T-${index}`);
      const tickets = ids.map((id) => ticket(id, {
        status: statuses[Math.floor(random() * statuses.length)]!,
        priority: (["urgent", "high", "normal", "low"] as const)[Math.floor(random() * 4)]!,
        blockedBy: ids.filter((other) => other !== id && random() < 0.2).concat(random() < 0.05 ? ["GHOST"] : []),
      }));
      const graph = graphOf(tickets);
      const result = computeReadySet(inputs(tickets, { graph }));
      const byId = new Map(tickets.map((entry) => [entry.id, entry] as const));
      for (const entry of result.ready) {
        for (const blocker of entry.ticket.blockedBy) {
          const status = byId.get(blocker)?.status;
          expect(status === "done" || status === "cancelled", `${entry.ticket.id} ran with ${blocker} unmet`).toBe(true);
        }
      }
      for (const held of result.withheld) {
        if (graph.cycleOf(held.ticket.id) || held.ticket.blockedBy.includes("GHOST")) expect(held.reason).toBe("incoherent");
      }
    }
  });

  it("decides the same way whatever order the tickets come in", () => {
    const tickets = Array.from({ length: 12 }, (_, index) => ticket(`T-${index}`, {
      priority: index % 3 === 0 ? "high" : "normal",
      blockedBy: index > 8 ? [`T-${index - 9}`] : [],
    }));
    const expected = computeReadySet(inputs(tickets)).ready.map((entry) => entry.ticket.id);
    let seed = 3;
    for (let round = 0; round < 20; round += 1) {
      const shuffled = [...tickets].sort(() => { seed = (seed * 48_271) % 2_147_483_647; return seed % 2 ? 1 : -1; });
      expect(computeReadySet(inputs(shuffled)).ready.map((entry) => entry.ticket.id)).toEqual(expected);
    }
  });

  it("explains every choice", () => {
    const tickets = [ticket("A"), ticket("B", { blockedBy: ["A"], status: "in_progress", assignee: "user" })];
    const [first] = computeReadySet(inputs(tickets)).ready;
    expect(first?.reasons).toContain("unblocks 1 ticket (B)");
    expect(first?.score).toBeGreaterThan(0);
  });

  it("ranks critical-path work up, and credits a ready ticket for every pass it waited", () => {
    const tickets = [ticket("A", { priority: "high" }), ticket("B", { priority: "low" })];
    const critical = graphOf(tickets, { criticalPath: () => ({ ids: new Set(["B"]), weight: 9 }) });
    const plain = computeReadySet(inputs(tickets, { graph: critical }));
    expect(plain.ready.map((entry) => entry.ticket.id)).toEqual(["A", "B"]);
    const waited = new Map<string, LoopTicketState>([["B", { ticketId: "B", attempts: 0, touchedFiles: [], passedOver: 4 }]]);
    const credited = computeReadySet(inputs(tickets, { graph: critical, state: waited }));
    expect(credited.ready[0]?.ticket.id).toBe("B");
    expect(credited.ready[0]?.reasons).toEqual(expect.arrayContaining(["on the critical path (weight 9)", "passed over 4 times"]));
    expect(GRAPH_SCORE.passedOver).toBeGreaterThan(0);
  });

  it("holds back work whose files another lane is writing (#19 claims)", () => {
    const tickets = [ticket("A"), ticket("B")];
    const result = computeReadySet(inputs(tickets, { held: new Map([["src/a.ts", "BLK-9's lane"]]) }));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["B"]);
    expect(result.withheld[0]).toMatchObject({ reason: "territory", detail: "BLK-9's lane is writing files this ticket covers." });
  });

  it("runs large work and work that collided last time alone", () => {
    const tickets = [ticket("A", { complexity: "large", priority: "urgent" }), ticket("B")];
    const alone = computeReadySet(inputs(tickets));
    expect(alone.ready.map((entry) => entry.ticket.id)).toEqual(["A"]);
    const busy = computeReadySet(inputs(tickets, { inFlight: [new Set(["src/other.ts"])] }));
    expect(busy.ready.map((entry) => entry.ticket.id)).toEqual(["B"]);
    expect(busy.withheld[0]?.detail).toContain("runs only when nothing else is running");
  });

  it("does not start a lane the remaining budget would not cover, once there are enough samples", () => {
    const tickets = [ticket("A")];
    expect(computeReadySet(inputs(tickets, { budget: { remainingUsd: 0.5, medianUsd: { small: 2 } } })).withheld[0]?.reason).toBe("budget");
    expect(computeReadySet(inputs(tickets, { budget: { remainingUsd: 0.5, medianUsd: {} } })).ready).toHaveLength(1);
  });
});

describe("verified review as a met dependency (D6)", () => {
  const tickets = [ticket("A", { status: "review" }), ticket("B", { blockedBy: ["A"] })];

  it("is off by default: a blocker in review still blocks, in either scheduler", () => {
    const latestReceipt = () => "verified";
    expect(computeReadySet(inputs(tickets, { graph: undefined, latestReceipt })).ready).toEqual([]);
    expect(computeReadySet(inputs(tickets, { latestReceipt })).ready).toEqual([]);
  });

  it("counts a blocker in review with a verified receipt as met when the loop opts in, in either scheduler", () => {
    const spec = { ...defaultQueueSpec(), dependencySatisfiedBy: "verified_review" as const };
    for (const graph of [undefined, graphOf(tickets)]) {
      expect(computeReadySet(inputs(tickets, { spec, graph, latestReceipt: () => "verified" })).ready.map((entry) => entry.ticket.id)).toEqual(["B"]);
      // Anything short of verified still blocks.
      for (const status of ["succeeded_unverified", "partial", undefined]) {
        expect(computeReadySet(inputs(tickets, { spec, graph, latestReceipt: () => status })).ready).toEqual([]);
      }
    }
  });
});

describe("the WorkGraph adapter", () => {
  it("reads blockers, dependents, cycles and the critical path from the real graph", () => {
    const tickets = [
      ticket("A"),
      ticket("B", { blockedBy: ["A"] }),
      ticket("C", { blockedBy: ["B"], complexity: "large" }),
      ticket("X", { blockedBy: ["Z"] }),
      ticket("Y", { blockedBy: ["X"] }),
      ticket("Z", { blockedBy: ["Y"] }),
      ticket("M", { blockedBy: ["NOPE"] }),
    ];
    const graph = new WorkGraph();
    graph.update({ tickets, plans: [], receipts: [] });
    const view = schedulingGraphFrom(graph);
    expect(view.hardBlockers("B")).toEqual([{ id: "A", missing: false, source: "ticket.blockedBy" }]);
    expect(view.hardBlockers("M")).toEqual([{ id: "NOPE", missing: true, source: "ticket.blockedBy" }]);
    expect(view.downstreamOpen("A")).toEqual(["B", "C"]);
    expect(view.cycleOf("X")).toEqual(["X", "Y", "Z"]);
    expect(view.cycleOf("A")).toBeUndefined();
    expect([...view.criticalPath().ids].sort()).toEqual(["A", "B", "C"]);
    const result = computeReadySet(inputs(tickets, { graph: view }));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["A"]);
    expect(result.withheld.filter((entry) => entry.reason === "incoherent").map((entry) => entry.ticket.id).sort()).toEqual(["M", "X", "Y", "Z"]);
  });
});
