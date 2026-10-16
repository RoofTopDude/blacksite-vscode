/* The loop side of #14 signals: a running loop can be woken to re-check its queue, a loop that
   blocks itself says whether only dependencies held it, a blocked loop can be previewed without
   dispatching, and a resume offer lives and dies with the blocked state. Nothing here starts a
   loop except the user's own start(). */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopStore, normalizeLoopDocument } from "../../src/loops/loop-store.js";
import {
  LoopSupervisor,
  type LoopDispatchRequest,
  type LoopDispatchResult,
  type LoopTicketGateway,
} from "../../src/loops/loop-supervisor.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog" as TicketStatus, statusSource: "manual", priority: "normal",
    complexity: "small", labels: [], acceptanceCriteria: [], territory: { files: [`src/${id}.ts`], areas: [] },
    references: [], runIds: [], blockedBy: [], blocks: [], relatedTo: [], children: [], assignee: "unassigned",
    origin: "user", events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

class Tickets implements LoopTicketGateway {
  constructor(public list: Ticket[]) {}
  tickets(): readonly Ticket[] { return this.list; }
  indexedFiles(): readonly string[] { return this.list.flatMap((entry) => entry.territory.files); }
  moveToReview(id: string): void { this.set(id, "review"); }
  noteAttempt(): void { /* not needed */ }
  set(id: string, status: TicketStatus): void { this.list = this.list.map((entry) => (entry.id === id ? { ...entry, status } : entry)); }
}

/** Lanes that finish only when the test says so. */
function heldDispatcher() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  return {
    started,
    finish: (id: string) => release.get(id)?.(),
    dispatch: (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
      started.push(request.ticket.id);
      return new Promise((resolve) => release.set(request.ticket.id, () => resolve({ ok: true, detail: "done", filesTouched: [], runIds: [] })));
    },
  };
}

const tick = async (n = 20): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

let dir: string;
let store: LoopStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loop-signals-"));
  store = new LoopStore(dir);
  store.ensureInitialized();
});
afterEach(() => {
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("waking a running loop", () => {
  it("dispatches newly unblocked work at once instead of after the running lane finishes", async () => {
    const tickets = new Tickets([ticket("A"), ticket("B", { blockedBy: ["C"] }), ticket("C", { status: "in_progress", assignee: "user" })]);
    const dispatcher = heldDispatcher();
    const supervisor = new LoopSupervisor(store, tickets, dispatcher);
    // A status-filtered queue: C is someone else's (in progress), A and B are the loop's backlog.
    const loop = store.create({ title: "wake", workers: { concurrency: 2 } });
    supervisor.start(loop.definition.id);
    await tick();
    expect(dispatcher.started).toEqual(["A"]);

    tickets.set("C", "done");
    await tick();
    // Without a wake the loop is still waiting on A.
    expect(dispatcher.started).toEqual(["A"]);
    supervisor.wake(loop.definition.id);
    await tick();
    expect(dispatcher.started).toEqual(["A", "B"]);

    dispatcher.finish("A");
    dispatcher.finish("B");
    await tick();
    expect(store.get(loop.definition.id)!.definition.status).toBe("drained");
  });

  it("does nothing to a loop that is not running: a wake never starts one", () => {
    const supervisor = new LoopSupervisor(store, new Tickets([ticket("A")]), heldDispatcher());
    const loop = store.create({ title: "idle" });
    supervisor.wake(loop.definition.id);
    expect(supervisor.isRunning(loop.definition.id)).toBe(false);
    expect(store.get(loop.definition.id)!.definition.status).toBe("draft");
  });
});

describe("a loop that blocks itself", () => {
  it("records that only dependencies held it, and previews what it could run without running it", async () => {
    const tickets = new Tickets([ticket("B", { blockedBy: ["C"] }), ticket("C", { status: "in_progress", assignee: "user" })]);
    const dispatcher = heldDispatcher();
    const supervisor = new LoopSupervisor(store, tickets, dispatcher);
    const loop = store.create({ title: "deps", queue: { ids: ["B"] } });
    supervisor.start(loop.definition.id);
    await tick();
    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("blocked");
    expect(record.definition.blockedOn).toBe("dependencies");
    expect(supervisor.previewReady(loop.definition.id)).toEqual([]);

    tickets.set("C", "done");
    expect(supervisor.previewReady(loop.definition.id)).toEqual(["B"]);
    expect(dispatcher.started).toEqual([]);
    expect(store.get(loop.definition.id)!.definition.status).toBe("blocked");
  });

  it("records `mixed` when something other than a dependency held it", async () => {
    const tickets = new Tickets([ticket("B", { blockedBy: ["C"] }), ticket("C", { status: "in_progress", assignee: "user" }), ticket("D", { status: "blocked" })]);
    const supervisor = new LoopSupervisor(store, tickets, heldDispatcher());
    const loop = store.create({ title: "mixed", queue: { ids: ["B", "D"] } });
    store.updateTicketState(loop.definition.id, "D", (state) => { state.parkedOnGate = "write"; });
    supervisor.start(loop.definition.id);
    await tick();
    expect(store.get(loop.definition.id)!.definition.blockedOn).toBe("mixed");
  });
});

describe("the scheduling context (#15)", () => {
  it("schedules as before when the graph cannot be read, and reports why", async () => {
    const errors: unknown[] = [];
    const dispatcher = heldDispatcher();
    const supervisor = new LoopSupervisor(store, new Tickets([ticket("A")]), dispatcher, { onError: (_id, error) => errors.push(error) }, undefined, undefined, {
      scheduling: () => { throw new Error("graph unavailable"); },
    });
    const loop = store.create({ title: "fallback" });
    supervisor.start(loop.definition.id);
    await tick();
    expect(dispatcher.started).toEqual(["A"]);
    expect(String(errors[0])).toContain("graph unavailable");
    dispatcher.finish("A");
    await tick();
  });
});

describe("resume offers", () => {
  it("are held only while blocked, carried into the execution the user starts, then cleared", () => {
    const loop = store.create({ title: "offer" });
    const id = loop.definition.id;
    const offer = { at: "2026-10-16T00:00:00.000Z", ready: ["B"], because: "A is done.", signalIds: ["sig_1"] };
    expect(store.setResumeOffer(id, offer)?.resumeOffer).toBeUndefined();
    store.setStatus(id, "blocked", "blocked");
    store.setBlockedOn(id, "dependencies");
    expect(store.setResumeOffer(id, offer)?.resumeOffer).toEqual(offer);
    const execution = store.beginExecution(id)!;
    expect(execution.offeredBy).toEqual(["sig_1"]);
    const after = store.get(id)!;
    expect(after.resumeOffer).toBeUndefined();
    expect(after.definition.blockedOn).toBeUndefined();
  });

  it("are dropped when the loop is stopped", () => {
    const id = store.create({ title: "offer" }).definition.id;
    store.setStatus(id, "blocked", "blocked");
    store.setResumeOffer(id, { at: "t", ready: ["B"], because: "x", signalIds: [] });
    store.setStatus(id, "stopped", "Stopped.");
    expect(store.get(id)!.resumeOffer).toBeUndefined();
  });

  it("survive a round trip, as do flags and decisions, and an older file without them reads as before", () => {
    const id = store.create({ title: "persist" }).definition.id;
    store.setStatus(id, "blocked", "blocked");
    store.setResumeOffer(id, { at: "t", ready: ["B"], because: "x", signalIds: ["s"] });
    store.addReassessment(id, { signalId: "s1", kind: "contract_conflict", taskId: "ticket:A", detail: "d", at: "t", source: "host" });
    store.addReassessment(id, { signalId: "s1", kind: "contract_conflict", taskId: "ticket:A", detail: "d", at: "t", source: "host" });
    store.appendDecision(id, { at: "t", mode: "graph", chosen: [{ ticketId: "A", score: 3, reasons: ["r"] }], withheld: [] });
    const reread = new LoopStore(dir).get(id)!;
    expect(reread.resumeOffer?.ready).toEqual(["B"]);
    expect(reread.reassessments).toHaveLength(1);
    expect(reread.decisions?.[0]?.chosen[0]?.ticketId).toBe("A");
    const legacy = normalizeLoopDocument({ loops: [{ definition: { id: "old", title: "Old", status: "blocked" } }] }).loops[0]!;
    expect(legacy.resumeOffer).toBeUndefined();
    expect(legacy.definition.blockedOn).toBeUndefined();
    expect(legacy.definition.queue.dependencySatisfiedBy).toBeUndefined();
  });
});
