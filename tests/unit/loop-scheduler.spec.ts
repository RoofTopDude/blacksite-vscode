import { describe, expect, it } from "vitest";
import {
  computeReadySet,
  matchesQueue,
  nextSupervisorAction,
  territoryConflicts,
  territoryOf,
  UNTENANTED,
} from "../../src/loops/loop-scheduler.js";
import { defaultQueueSpec, type LoopTicketState } from "../../src/loops/loop-model.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    status: "backlog" as TicketStatus,
    statusSource: "manual",
    priority: "normal",
    complexity: "small",
    labels: [],
    acceptanceCriteria: [],
    territory: { files: [], areas: [] },
    references: [],
    runIds: [],
    blockedBy: [],
    blocks: [],
    relatedTo: [],
    assignee: "unassigned",
    origin: "user",
    events: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

const INDEX = ["src/a.ts", "src/b.ts", "src/auth/login.ts", "src/auth/session.ts", "docs/x.md"];

function inputs(tickets: Ticket[], overrides: Partial<Parameters<typeof computeReadySet>[0]> = {}) {
  return {
    tickets,
    spec: defaultQueueSpec(),
    state: new Map<string, LoopTicketState>(),
    inFlight: [] as ReadonlyArray<ReadonlySet<string>>,
    indexedFiles: INDEX,
    ...overrides,
  };
}

describe("matchesQueue", () => {
  it("treats an explicit id list as the whole queue", () => {
    // A user who named twelve tickets one by one meant those twelve. Making them also satisfy
    // the status filter would silently drop the ones already in progress.
    const spec = { ...defaultQueueSpec(), ids: ["BLK-1"], statuses: ["backlog" as TicketStatus] };
    expect(matchesQueue(ticket("BLK-1", { status: "in_progress" }), spec)).toBe(true);
    expect(matchesQueue(ticket("BLK-2"), spec)).toBe(false);
  });

  it("never admits a closed ticket through the filters", () => {
    const spec = { ...defaultQueueSpec(), statuses: [] };
    expect(matchesQueue(ticket("BLK-1", { status: "done" }), spec)).toBe(false);
    expect(matchesQueue(ticket("BLK-2", { status: "cancelled" }), spec)).toBe(false);
  });

  it("matches an area against both declared areas and declared files", () => {
    const spec = { ...defaultQueueSpec(), areas: ["src/auth"] };
    expect(matchesQueue(ticket("a", { territory: { files: [], areas: ["src/auth"] } }), spec)).toBe(true);
    expect(matchesQueue(ticket("b", { territory: { files: ["src/auth/login.ts"], areas: [] } }), spec)).toBe(true);
    expect(matchesQueue(ticket("c", { territory: { files: ["docs/x.md"], areas: [] } }), spec)).toBe(false);
  });

  it("treats labels and priorities as any-of filters", () => {
    const spec = { ...defaultQueueSpec(), labels: ["perf", "flake"], priorities: ["urgent" as const] };
    expect(matchesQueue(ticket("a", { labels: ["flake"], priority: "urgent" }), spec)).toBe(true);
    expect(matchesQueue(ticket("b", { labels: ["flake"], priority: "low" }), spec)).toBe(false);
    expect(matchesQueue(ticket("c", { labels: ["docs"], priority: "urgent" }), spec)).toBe(false);
  });
});

describe("territory", () => {
  it("resolves an area to its member files", () => {
    const resolved = territoryOf(ticket("a", { territory: { files: [], areas: ["src/auth"] } }), INDEX);
    expect([...resolved].sort()).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("keeps a declared file that is missing from the index rather than shrinking the lock", () => {
    // A path absent from the index may be renamed or gitignored. Dropping it would quietly
    // narrow the claim and let a colliding ticket schedule alongside.
    const resolved = territoryOf(ticket("a", { territory: { files: ["src/gone.ts"], areas: [] } }), INDEX);
    expect(resolved.has("src/gone.ts")).toBe(true);
  });

  it("makes an untenanted ticket conflict with everything, not nothing", () => {
    const untenanted = territoryOf(ticket("a"), INDEX);
    expect(untenanted.has(UNTENANTED)).toBe(true);
    expect(territoryConflicts(untenanted, new Set(["src/a.ts"]))).toBe(true);
    expect(territoryConflicts(new Set(["src/a.ts"]), untenanted)).toBe(true);
    expect(territoryConflicts(untenanted, untenanted)).toBe(true);
  });

  it("detects overlap regardless of which side is larger", () => {
    expect(territoryConflicts(new Set(["src/a.ts"]), new Set(["src/a.ts", "src/b.ts"]))).toBe(true);
    expect(territoryConflicts(new Set(["src/a.ts", "src/b.ts"]), new Set(["src/a.ts"]))).toBe(true);
    expect(territoryConflicts(new Set(["src/a.ts"]), new Set(["src/b.ts"]))).toBe(false);
  });

  it("widens the lock with files the lane actually touched", () => {
    const resolved = territoryOf(
      ticket("a", { territory: { files: ["src/a.ts"], areas: [] } }),
      INDEX,
      ["src/b.ts"],
    );
    expect([...resolved].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("computeReadySet", () => {
  it("withholds a ticket whose blocker is still open, and reports why", () => {
    const tickets = [
      ticket("BLK-1", { territory: { files: ["src/a.ts"], areas: [] } }),
      ticket("BLK-2", { blockedBy: ["BLK-1"], territory: { files: ["src/b.ts"], areas: [] } }),
    ];
    const result = computeReadySet(inputs(tickets));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["BLK-1"]);
    expect(result.withheld[0]).toMatchObject({ reason: "blocked" });
    expect(result.withheld[0]!.detail).toContain("BLK-1");
  });

  it("releases the blocked ticket once its blocker closes", () => {
    const tickets = [
      ticket("BLK-1", { status: "done", territory: { files: ["src/a.ts"], areas: [] } }),
      ticket("BLK-2", { blockedBy: ["BLK-1"], territory: { files: ["src/b.ts"], areas: [] } }),
    ];
    const result = computeReadySet(inputs(tickets));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["BLK-2"]);
  });

  it("ignores blockedBy when the loop opts out", () => {
    const tickets = [
      ticket("BLK-1", { territory: { files: ["src/a.ts"], areas: [] } }),
      ticket("BLK-2", { blockedBy: ["BLK-1"], territory: { files: ["src/b.ts"], areas: [] } }),
    ];
    const spec = { ...defaultQueueSpec(), respectBlockedBy: false };
    const result = computeReadySet(inputs(tickets, { spec }));
    expect(result.ready).toHaveLength(2);
  });

  it("never admits two ready tickets that would collide with each other", () => {
    // The concurrency-2 trap: both halves of a collision look individually schedulable, and a
    // scheduler that only checks against in-flight work dispatches both.
    const tickets = [
      ticket("BLK-1", { priority: "urgent", territory: { files: [], areas: ["src/auth"] } }),
      ticket("BLK-2", { territory: { files: ["src/auth/login.ts"], areas: [] } }),
    ];
    const result = computeReadySet(inputs(tickets));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["BLK-1"]);
    expect(result.withheld[0]).toMatchObject({ reason: "territory" });
  });

  it("withholds a ticket that overlaps a lane already running", () => {
    const tickets = [ticket("BLK-1", { territory: { files: ["src/a.ts"], areas: [] } })];
    const result = computeReadySet(inputs(tickets, { inFlight: [new Set(["src/a.ts"])] }));
    expect(result.ready).toEqual([]);
    expect(result.withheld[0]).toMatchObject({ reason: "territory" });
  });

  it("serializes untenanted tickets instead of running them all at once", () => {
    const tickets = [ticket("BLK-1"), ticket("BLK-2"), ticket("BLK-3")];
    const result = computeReadySet(inputs(tickets));
    expect(result.ready).toHaveLength(1);
    expect(result.withheld).toHaveLength(2);
    expect(result.withheld[0]!.detail).toContain("No declared territory");
  });

  it("withholds a parked ticket until its gate is answered", () => {
    const tickets = [ticket("BLK-1", { territory: { files: ["src/a.ts"], areas: [] } })];
    const state = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 0, parkedOnGate: "destructive", touchedFiles: [] }],
    ]);
    expect(computeReadySet(inputs(tickets, { state })).withheld[0]).toMatchObject({ reason: "parked" });

    const released = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 0, touchedFiles: [] }],
    ]);
    expect(computeReadySet(inputs(tickets, { state: released })).ready).toHaveLength(1);
  });

  it("stops retrying a ticket once its attempt budget is spent", () => {
    const tickets = [ticket("BLK-1", { territory: { files: ["src/a.ts"], areas: [] } })];
    const state = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 2, touchedFiles: [] }],
    ]);
    const result = computeReadySet(inputs(tickets, { state, maxAttempts: 2 }));
    expect(result.ready).toEqual([]);
    expect(result.withheld[0]).toMatchObject({ reason: "exhausted" });
  });

  it("keeps a ticket it already attempted, even once its status leaves the query", () => {
    // The bug this covers: a lane fails partway and leaves the ticket `in_progress`, which the
    // backlog+triage query no longer matches. Without retention the queue reads as empty and
    // the loop reports "drained" — all work complete — over a half-finished ticket.
    const tickets = [
      ticket("BLK-1", { status: "in_progress", territory: { files: ["src/a.ts"], areas: [] } }),
    ];
    const state = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 1, touchedFiles: [] }],
    ]);
    const result = computeReadySet(inputs(tickets, { state }));
    expect(result.queueSize).toBe(1);
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["BLK-1"]);
  });

  it("keeps a ticket it attempted that then became blocked, and reports it as blocked", () => {
    // "Everything is blocked" and "there is nothing to do" are different situations, and the
    // supervisor picks a different terminal state for each.
    const tickets = [
      ticket("BLK-1", { status: "blocked", territory: { files: ["src/a.ts"], areas: [] } }),
    ];
    const state = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 1, touchedFiles: [] }],
    ]);
    const result = computeReadySet(inputs(tickets, { state }));
    expect(result.queueSize).toBe(1);
    expect(result.ready).toEqual([]);
    expect(result.withheld[0]).toMatchObject({ reason: "blocked" });
  });

  it("releases a ticket once it reaches review or closes", () => {
    const state = new Map<string, LoopTicketState>([
      ["BLK-1", { ticketId: "BLK-1", attempts: 1, touchedFiles: [] }],
    ]);
    for (const status of ["review", "done", "cancelled"] as const) {
      const result = computeReadySet(inputs([ticket("BLK-1", { status })], { state }));
      expect(result.queueSize).toBe(0);
    }
  });

  it("does not adopt an untouched ticket just because it is open", () => {
    const state = new Map<string, LoopTicketState>();
    const result = computeReadySet(inputs([ticket("BLK-1", { status: "in_progress" })], { state }));
    expect(result.queueSize).toBe(0);
  });

  it("orders by the same ranking the board uses", () => {
    const tickets = [
      ticket("LOW", { priority: "low", territory: { files: ["src/a.ts"], areas: [] } }),
      ticket("URGENT", { priority: "urgent", territory: { files: ["src/b.ts"], areas: [] } }),
    ];
    const result = computeReadySet(inputs(tickets));
    expect(result.ready.map((entry) => entry.ticket.id)).toEqual(["URGENT", "LOW"]);
    expect(result.ready[0]!.reasons.join(" ")).toContain("urgent");
  });
});

describe("nextSupervisorAction", () => {
  const empty = { ready: [], withheld: [], queueSize: 0 };

  it("drains only when the queue is empty and nothing is still running", () => {
    expect(nextSupervisorAction(empty, 0, 1)).toBe("drained");
    expect(nextSupervisorAction(empty, 1, 0)).toBe("wait");
  });

  it("blocks when tickets remain, none are ready, and nothing is in flight", () => {
    const withheld = { ready: [], withheld: [], queueSize: 3 };
    expect(nextSupervisorAction(withheld, 0, 2)).toBe("blocked");
  });

  it("waits rather than blocking while a lane could still free something up", () => {
    const withheld = { ready: [], withheld: [], queueSize: 3 };
    expect(nextSupervisorAction(withheld, 1, 1)).toBe("wait");
  });

  it("waits rather than dispatching when every worker slot is busy", () => {
    const ready = { ready: [{}], withheld: [], queueSize: 1 } as never;
    expect(nextSupervisorAction(ready, 2, 0)).toBe("wait");
  });
});
