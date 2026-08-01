import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopStore } from "../../src/loops/loop-store.js";
import {
  LoopSupervisor,
  type LoopDispatchRequest,
  type LoopDispatchResult,
  type LoopTicketGateway,
} from "../../src/loops/loop-supervisor.js";
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
    territory: { files: [`src/${id}.ts`], areas: [] },
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

/** An in-memory ticket world the supervisor can actually move tickets through. */
class FakeTickets implements LoopTicketGateway {
  readonly reviewed: Array<{ id: string; note: string }> = [];
  readonly notes: Array<{ id: string; note: string }> = [];

  constructor(private _tickets: Ticket[]) {}

  tickets(): readonly Ticket[] {
    return this._tickets;
  }

  indexedFiles(): readonly string[] {
    return this._tickets.flatMap((t) => t.territory.files);
  }

  moveToReview(ticketId: string, note: string): void {
    this.reviewed.push({ id: ticketId, note });
    this._tickets = this._tickets.map((t) => (t.id === ticketId ? { ...t, status: "review" as TicketStatus } : t));
  }

  noteAttempt(ticketId: string, note: string): void {
    this.notes.push({ id: ticketId, note });
  }
}

let tmpDir: string;
let store: LoopStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loops-"));
  store = new LoopStore(tmpDir);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Resolves each dispatch by looking the ticket up in a script. */
function scriptedDispatcher(script: Record<string, Partial<LoopDispatchResult>>) {
  const seen: LoopDispatchRequest[] = [];
  return {
    seen,
    dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
      seen.push(request);
      const scripted = script[request.ticket.id] ?? {};
      return {
        ok: true,
        detail: "done",
        filesTouched: [],
        runIds: [],
        ...scripted,
      };
    },
  };
}

async function runToCompletion(supervisor: LoopSupervisor, loopId: string): Promise<void> {
  supervisor.start(loopId);
  // The cycle is fire-and-forget; drain the microtask queue until it settles.
  for (let i = 0; i < 200 && supervisor.isRunning(loopId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("LoopSupervisor", () => {
  it("drains a queue and hands every ticket to review rather than closing it", () => {
    // Closure is the user's under user_review. A lane that both did the work and marked it
    // done would be grading its own homework.
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    const dispatcher = scriptedDispatcher({});
    const supervisor = new LoopSupervisor(store, tickets, dispatcher);
    const loop = store.create({ title: "drain" });

    return runToCompletion(supervisor, loop.definition.id).then(() => {
      const record = store.get(loop.definition.id)!;
      expect(record.definition.status).toBe("drained");
      expect(tickets.reviewed.map((entry) => entry.id).sort()).toEqual(["A", "B"]);
      expect(record.totals.succeeded).toBe(2);
    });
  });

  it("respects concurrency: a sequential loop never has two lanes open at once", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C")]);
    let open = 0;
    let peak = 0;
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
        return { ok: true, detail: "done", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "sequential", workers: { concurrency: 1 } });

    await runToCompletion(supervisor, loop.definition.id);
    expect(peak).toBe(1);
    expect(store.get(loop.definition.id)!.totals.dispatched).toBe(3);
  });

  it("runs non-overlapping tickets in parallel when allowed to", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    let open = 0;
    let peak = 0;
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 2));
        open -= 1;
        return { ok: true, detail: "done", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "parallel", workers: { concurrency: 2 } });

    await runToCompletion(supervisor, loop.definition.id);
    expect(peak).toBe(2);
  });

  it("keeps overlapping tickets sequential even at concurrency 2", async () => {
    const tickets = new FakeTickets([
      ticket("A", { territory: { files: ["src/shared.ts"], areas: [] } }),
      ticket("B", { territory: { files: ["src/shared.ts"], areas: [] } }),
    ]);
    let open = 0;
    let peak = 0;
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 2));
        open -= 1;
        return { ok: true, detail: "done", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "conflict", workers: { concurrency: 2 } });

    await runToCompletion(supervisor, loop.definition.id);
    expect(peak).toBe(1);
    expect(store.get(loop.definition.id)!.totals.dispatched).toBe(2);
  });

  it("feeds the previous failure into the retry so the second attempt is not identical", async () => {
    const attempts: Array<string | undefined> = [];
    const tickets = new FakeTickets([ticket("A")]);
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request) => {
        attempts.push(request.priorAttempt);
        return { ok: false, detail: `attempt ${attempts.length} failed`, filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "retry", ceilings: { maxConsecutiveFailures: 10 } });

    await runToCompletion(supervisor, loop.definition.id);
    expect(attempts[0]).toBeUndefined();
    expect(attempts[1]).toBe("attempt 1 failed");
    // Two attempts is the budget; the third never happens.
    expect(attempts).toHaveLength(2);
    expect(store.get(loop.definition.id)!.definition.status).toBe("blocked");
  });

  it("parks on an approval gate without spending an attempt, and frees the slot", async () => {
    // The 3am failure mode: a gate must not consume a worker for the night, and must not
    // count against a retry budget the work never got to fail.
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request) => (request.ticket.id === "A"
        ? { ok: false, detail: "needs approval", filesTouched: [], runIds: [], parkedOnGate: "destructive", parkedSubRequestId: "sub_1" }
        : { ok: true, detail: "done", filesTouched: [], runIds: [] }),
    });
    const loop = store.create({ title: "park" });

    await runToCompletion(supervisor, loop.definition.id);
    const record = store.get(loop.definition.id)!;
    const stateA = record.ticketState.find((s) => s.ticketId === "A")!;

    expect(stateA.parkedOnGate).toBe("destructive");
    expect(stateA.attempts).toBe(0);
    expect(stateA.parkedSubRequestId).toBe("sub_1");
    expect(record.totals.parked).toBe(1);
    // B still got worked — the park did not stall the loop.
    expect(tickets.reviewed.map((entry) => entry.id)).toEqual(["B"]);
    expect(record.definition.status).toBe("blocked");
  });

  it("notifies once per loop about parks, not once per park", async () => {
    const messages: string[] = [];
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => ({ ok: false, detail: "gate", filesTouched: [], runIds: [], parkedOnGate: "write" }),
    }, { notify: (_loopId, message) => messages.push(message) });
    const loop = store.create({ title: "notify" });

    await runToCompletion(supervisor, loop.definition.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("blocked by continuation review");
  });

  it("releasePark makes a parked ticket dispatchable again", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    let gate = true;
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => (gate
        ? { ok: false, detail: "gate", filesTouched: [], runIds: [], parkedOnGate: "write" }
        : { ok: true, detail: "done", filesTouched: [], runIds: [] }),
    });
    const loop = store.create({ title: "release" });

    await runToCompletion(supervisor, loop.definition.id);
    expect(store.get(loop.definition.id)!.definition.status).toBe("blocked");

    gate = false;
    supervisor.releasePark(loop.definition.id, "A");
    await runToCompletion(supervisor, loop.definition.id);

    expect(store.get(loop.definition.id)!.definition.status).toBe("drained");
    expect(tickets.reviewed.map((entry) => entry.id)).toEqual(["A"]);
  });

  it("stops on consecutive failures rather than working through the whole backlog", async () => {
    // The environmental-breakage guard: a per-ticket retry budget cannot see that the build is
    // wedged and every remaining lane will fail identically.
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C"), ticket("D")]);
    const dispatcher = scriptedDispatcher({});
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request) => {
        dispatcher.seen.push(request);
        return { ok: false, detail: "the build is broken", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "failing", ceilings: { maxConsecutiveFailures: 2 } });

    await runToCompletion(supervisor, loop.definition.id);
    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("stopped");
    expect(record.definition.endedReason).toContain("failed in a row");
    expect(record.totals.dispatched).toBe(2);
  });

  it("stops at the ticket ceiling", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C")]);
    const supervisor = new LoopSupervisor(store, tickets, scriptedDispatcher({}));
    const loop = store.create({ title: "capped", ceilings: { maxTickets: 2 } });

    await runToCompletion(supervisor, loop.definition.id);
    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("stopped");
    expect(record.definition.endedReason).toContain("2-ticket ceiling");
    expect(record.totals.dispatched).toBe(2);
  });

  it("widens a ticket's lock with the files its lane actually touched", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => ({ ok: false, detail: "failed", filesTouched: ["src/elsewhere.ts"], runIds: [] }),
    });
    const loop = store.create({ title: "touched", ceilings: { maxConsecutiveFailures: 10 } });

    await runToCompletion(supervisor, loop.definition.id);
    const state = store.get(loop.definition.id)!.ticketState.find((s) => s.ticketId === "A")!;
    expect(state.touchedFiles).toContain("src/elsewhere.ts");
  });

  it("records a thrown dispatcher as a failure instead of taking the loop down", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const errors: unknown[] = [];
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => { throw new Error("provider exploded"); },
    }, { onError: (_id, error) => errors.push(error) });
    const loop = store.create({ title: "throwing", ceilings: { maxConsecutiveFailures: 1 } });

    await runToCompletion(supervisor, loop.definition.id);
    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("stopped");
    expect(record.iterations[0]!.detail).toContain("provider exploded");
    expect(errors).toHaveLength(1);
  });

  it("marks interrupted lanes abandoned on restore and pauses rather than resuming", () => {
    // Silently continuing a paid unattended run after a crash is not a decision this code
    // gets to make.
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "crashed" });
    store.setStatus(loop.definition.id, "running");
    store.appendIteration(loop.definition.id, {
      ticketId: "A",
      runIds: [],
      outcome: "succeeded",
      detail: "",
      startedAt: new Date().toISOString(),
      // no endedAt — this lane was in flight when the host died
    });

    const supervisor = new LoopSupervisor(store, tickets, scriptedDispatcher({}));
    expect(supervisor.restore()).toEqual([loop.definition.id]);

    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("paused");
    expect(record.iterations[0]!.outcome).toBe("abandoned");
    expect(record.iterations[0]!.endedAt).toBeTruthy();
    // Not charged as an attempt: the host killed the lane, not the work.
    expect(record.ticketState.find((s) => s.ticketId === "A")?.attempts ?? 0).toBe(0);
    expect(tickets.notes[0]!.note).toContain("extension restart");
  });

  it("opens an iteration at dispatch so a crash leaves something to reconcile", async () => {
    /* Regression: iterations used to be written only on completion, so a host crash left no
       record of the lane at all — and restore() looks for exactly an iteration with no endedAt.
       Without the open record the crashed lane vanished silently and was never re-dispatched. */
    const tickets = new FakeTickets([ticket("A")]);
    let observed: number | undefined;
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request) => {
        observed = store.get(request.loopId)!.iterations.filter((i) => !i.endedAt).length;
        return { ok: true, detail: "done", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "open-early" });

    await runToCompletion(supervisor, loop.definition.id);
    expect(observed).toBe(1);
    // And it is settled, not duplicated, once the lane finishes.
    const record = store.get(loop.definition.id)!;
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]!.outcome).toBe("succeeded");
    expect(record.iterations[0]!.endedAt).toBeTruthy();
  });

  it("does not let in-flight lanes trip the consecutive-failure ceiling", async () => {
    /* Regression from the fix above: an open iteration folded as a failure, so a loop at
       concurrency 3 with a ceiling of 3 stopped itself the instant it filled its worker slots. */
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C")]);
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { ok: true, detail: "done", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({
      title: "busy",
      workers: { concurrency: 3 },
      ceilings: { maxConsecutiveFailures: 3 },
    });

    await runToCompletion(supervisor, loop.definition.id);
    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("drained");
    expect(record.totals.succeeded).toBe(3);
  });

  it("leaves a settled loop alone on restore", () => {
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "finished" });
    store.setStatus(loop.definition.id, "drained", "done");

    const supervisor = new LoopSupervisor(store, tickets, scriptedDispatcher({}));
    expect(supervisor.restore()).toEqual([]);
    expect(store.get(loop.definition.id)!.definition.status).toBe("drained");
  });

  it("maps ticket complexity onto the lane budget, and honours an override", async () => {
    const tickets = new FakeTickets([ticket("A", { complexity: "large" })]);
    const dispatcher = scriptedDispatcher({});
    const supervisor = new LoopSupervisor(store, tickets, dispatcher);
    const loop = store.create({ title: "budget" });

    await runToCompletion(supervisor, loop.definition.id);
    expect(dispatcher.seen[0]!.complexity).toBe("deep");

    const overridden = store.create({ title: "override", workers: { concurrency: 1, complexityOverride: "small" } });
    const tickets2 = new FakeTickets([ticket("A", { complexity: "large" })]);
    const dispatcher2 = scriptedDispatcher({});
    await runToCompletion(new LoopSupervisor(store, tickets2, dispatcher2), overridden.definition.id);
    expect(dispatcher2.seen[0]!.complexity).toBe("standard");
  });

  it("does not dispatch a draft loop until it is started", () => {
    const tickets = new FakeTickets([ticket("A")]);
    const dispatcher = scriptedDispatcher({});
    const loop = store.create({ title: "draft" });
    expect(loop.definition.status).toBe("draft");
    // Constructing a supervisor must not be enough to spend money.
    void new LoopSupervisor(store, tickets, dispatcher);
    expect(dispatcher.seen).toEqual([]);
  });
});
