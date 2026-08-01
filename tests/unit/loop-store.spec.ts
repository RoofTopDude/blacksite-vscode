import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopStore, MAX_LOOP_CONCURRENCY, MAX_RETAINED_ITERATIONS, normalizeLoopDocument } from "../../src/loops/loop-store.js";

let tmpDir: string;
let store: LoopStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loopstore-"));
  store = new LoopStore(tmpDir);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalizeLoopDocument", () => {
  it("reads a sparse document as a valid one, so an older file needs no migration", () => {
    const document = normalizeLoopDocument({ loops: [{ definition: { title: "Just a title" } }] });
    const definition = document.loops[0]!.definition;
    expect(definition.title).toBe("Just a title");
    expect(definition.queue.statuses).toEqual(["backlog", "triage"]);
    expect(definition.queue.respectBlockedBy).toBe(true);
    expect(definition.workers.concurrency).toBe(1);
    expect(definition.approvals).toEqual({ reviewer: "continuation", autoApproveTiers: [], onGate: "park", notify: true });
    expect(definition.closure).toBe("user_review");
  });

  it("drops a loop with no title rather than inventing one", () => {
    expect(normalizeLoopDocument({ loops: [{ definition: {} }] }).loops).toEqual([]);
  });

  it("preserves a stored `running` status as the evidence of a crash", () => {
    // Not a resume: `running` on disk means the host died mid-loop, and it is precisely what
    // LoopSupervisor.restore looks for. Normalizing it away would hide the crash, and the
    // abandoned lanes would never be reconciled. The pause happens there, not here.
    const document = normalizeLoopDocument({
      loops: [{ definition: { title: "x", status: "running" } }],
    });
    expect(document.loops[0]!.definition.status).toBe("running");
  });

  it("clamps concurrency to the blast-radius ceiling", () => {
    const document = normalizeLoopDocument({
      loops: [{ definition: { title: "x", workers: { concurrency: 999 } } }],
    });
    expect(document.loops[0]!.definition.workers.concurrency).toBe(MAX_LOOP_CONCURRENCY);
  });

  it("rejects unknown statuses and priorities instead of trusting the file", () => {
    const document = normalizeLoopDocument({
      loops: [{
        definition: {
          title: "x",
          status: "cranking",
          queue: { statuses: ["backlog", "nonsense"], priorities: ["urgent", "made-up"] },
        },
      }],
    });
    const definition = document.loops[0]!.definition;
    expect(definition.status).toBe("draft");
    expect(definition.queue.statuses).toEqual(["backlog"]);
    expect(definition.queue.priorities).toEqual(["urgent"]);
  });

  it("de-duplicates loops sharing an id", () => {
    const document = normalizeLoopDocument({
      loops: [
        { definition: { id: "dup", title: "first" } },
        { definition: { id: "dup", title: "second" } },
      ],
    });
    expect(document.loops).toHaveLength(1);
    expect(document.loops[0]!.definition.title).toBe("first");
  });

  it("recomputes totals from the iteration list rather than trusting stored ones", () => {
    const document = normalizeLoopDocument({
      loops: [{
        definition: { title: "x" },
        totals: { dispatched: 999, succeeded: 999, failed: 0, parked: 0, usd: 999, consecutiveFailures: 0 },
        iterations: [
          { ticketId: "A", seq: 1, outcome: "succeeded", usd: 1 },
          { ticketId: "B", seq: 2, outcome: "failed", usd: 2 },
        ],
      }],
    });
    expect(document.loops[0]!.totals).toMatchObject({ dispatched: 2, succeeded: 1, failed: 1, usd: 3 });
  });

  it("does not let a park reset or advance the consecutive-failure count", () => {
    // A park says nothing about whether the work is failing, so it must neither trip the
    // environmental-breakage ceiling nor forgive a run of real failures.
    const document = normalizeLoopDocument({
      loops: [{
        definition: { title: "x" },
        iterations: [
          { ticketId: "A", seq: 1, outcome: "failed" },
          { ticketId: "B", seq: 2, outcome: "parked" },
          { ticketId: "C", seq: 3, outcome: "failed" },
        ],
      }],
    });
    expect(document.loops[0]!.totals.consecutiveFailures).toBe(2);
    expect(document.loops[0]!.totals.parked).toBe(1);
  });
});

describe("LoopStore", () => {
  it("creates every loop as a draft", () => {
    // Starting a loop is a user action. A loop that dispatched the moment it was described
    // would make an hours-long unattended spend a side effect of asking for one.
    expect(store.create({ title: "x" }).definition.status).toBe("draft");
  });

  it("round-trips through disk", () => {
    const created = store.create({ title: "Drain auth backlog", workers: { concurrency: 3 } });
    const reread = new LoopStore(tmpDir).get(created.definition.id)!;
    expect(reread.definition.title).toBe("Drain auth backlog");
    expect(reread.definition.workers.concurrency).toBe(3);
  });

  it("stamps startedAt once, so a wall-clock ceiling measures elapsed time", () => {
    const loop = store.create({ title: "x" });
    store.setStatus(loop.definition.id, "running");
    const first = store.get(loop.definition.id)!.definition.startedAt;
    store.setStatus(loop.definition.id, "paused");
    store.setStatus(loop.definition.id, "running");
    expect(store.get(loop.definition.id)!.definition.startedAt).toBe(first);
  });

  it("tracks spend and outcomes separately for each execution", () => {
    const loop = store.create({ title: "metered" });
    const first = store.beginExecution(loop.definition.id)!;
    const firstIteration = store.appendIteration(loop.definition.id, {
      ticketId: "A", runIds: [], outcome: "running", detail: "", startedAt: "2026-01-01T00:00:00.000Z",
    })!;
    store.settleIteration(loop.definition.id, firstIteration.seq, {
      outcome: "succeeded", endedAt: "2026-01-01T00:01:00.000Z", usd: 1.25,
    });
    store.setStatus(loop.definition.id, "paused", "checkpoint");

    const second = store.beginExecution(loop.definition.id)!;
    const secondIteration = store.appendIteration(loop.definition.id, {
      ticketId: "B", runIds: [], outcome: "running", detail: "", startedAt: "2026-01-01T01:00:00.000Z",
    })!;
    store.settleIteration(loop.definition.id, secondIteration.seq, {
      outcome: "failed", endedAt: "2026-01-01T01:01:00.000Z", usd: 0.5,
    });
    store.setStatus(loop.definition.id, "stopped", "done");

    const reread = store.get(loop.definition.id)!;
    expect(reread.executions.find((execution) => execution.id === first.id)?.totals)
      .toMatchObject({ dispatched: 1, succeeded: 1, usd: 1.25 });
    expect(reread.executions.find((execution) => execution.id === second.id)?.totals)
      .toMatchObject({ dispatched: 1, failed: 1, usd: 0.5 });
    expect(reread.totals.usd).toBe(1.75);
  });

  it("clears the ended fields when a terminal loop is restarted", () => {
    const loop = store.create({ title: "x" });
    store.setStatus(loop.definition.id, "stopped", "ran out of budget");
    expect(store.get(loop.definition.id)!.definition.endedReason).toBe("ran out of budget");
    store.setStatus(loop.definition.id, "running");
    expect(store.get(loop.definition.id)!.definition.endedAt).toBeUndefined();
    expect(store.get(loop.definition.id)!.definition.endedReason).toBeUndefined();
  });

  it("assigns monotonic iteration sequence numbers", () => {
    const loop = store.create({ title: "x" });
    const base = { runIds: [], outcome: "succeeded" as const, detail: "", startedAt: "2026-01-01T00:00:00.000Z" };
    expect(store.appendIteration(loop.definition.id, { ...base, ticketId: "A" })!.seq).toBe(1);
    expect(store.appendIteration(loop.definition.id, { ...base, ticketId: "B" })!.seq).toBe(2);
  });

  it("creates ticket state on first touch", () => {
    const loop = store.create({ title: "x" });
    store.updateTicketState(loop.definition.id, "A", (state) => { state.attempts += 1; });
    store.updateTicketState(loop.definition.id, "A", (state) => { state.attempts += 1; });
    const state = store.get(loop.definition.id)!.ticketState;
    expect(state).toHaveLength(1);
    expect(state[0]!.attempts).toBe(2);
  });

  it("reads an unreadable file as empty rather than throwing", () => {
    fs.writeFileSync(store.filePath(), "{ not json", "utf8");
    expect(store.read().loops).toEqual([]);
  });

  it("skips the write when a mutation reports no change", () => {
    const loop = store.create({ title: "x" });
    let fired = 0;
    const subscription = store.onDidChange(() => { fired += 1; });
    store.setStatus(loop.definition.id, "draft");
    expect(fired).toBe(0);
    subscription.dispose();
  });
});

/* These two compress several hundred durable writes into a tight loop. Each one is a real
   temp-file-plus-rename (see shared/durable-file.ts), so they are bulk-I/O stress rather than
   the logic tests the 5s default timeout is calibrated for, and they go over that budget when
   the full suite has every worker competing for the disk. Production never writes at this
   cadence: one write per lane per *iteration*, and an iteration is a subagent doing real work.
   The generous timeout is about the compression, not about the writes being slow. */
const RETENTION_TIMEOUT_MS = 30_000;

describe("iteration retention", () => {
  it("bounds the retained history without losing the arithmetic", () => {
    /* An hours-long drain re-reads and re-writes this document on every lane. Keeping every
       iteration forever makes that quadratic — but the totals must survive the trim, or a
       long-running loop would silently under-report what it did. */
    const loop = store.create({ title: "long", ceilings: { maxConsecutiveFailures: 50 } });
    const total = MAX_RETAINED_ITERATIONS + 120;
    for (let i = 0; i < total; i += 1) {
      store.appendIteration(loop.definition.id, {
        ticketId: `T-${i}`,
        runIds: [],
        outcome: "succeeded",
        detail: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:01:00.000Z",
        usd: 0.01,
      });
    }

    const record = store.get(loop.definition.id)!;
    expect(record.iterations.length).toBeLessThanOrEqual(MAX_RETAINED_ITERATIONS);
    expect(record.totals.dispatched).toBe(total);
    expect(record.totals.succeeded).toBe(total);
    expect(record.totals.usd).toBeCloseTo(total * 0.01, 5);
    // The window keeps the most recent, which is the half anyone would actually read back.
    expect(record.iterations[record.iterations.length - 1]!.ticketId).toBe(`T-${total - 1}`);
  }, RETENTION_TIMEOUT_MS);

  it("survives the trim across a reload", () => {
    const loop = store.create({ title: "long", ceilings: { maxConsecutiveFailures: 50 } });
    for (let i = 0; i < MAX_RETAINED_ITERATIONS + 10; i += 1) {
      store.appendIteration(loop.definition.id, {
        ticketId: `T-${i}`, runIds: [], outcome: "succeeded", detail: "",
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", usd: 1,
      });
    }
    const reread = new LoopStore(tmpDir).get(loop.definition.id)!;
    expect(reread.totals.dispatched).toBe(MAX_RETAINED_ITERATIONS + 10);
    expect(reread.totals.usd).toBe(MAX_RETAINED_ITERATIONS + 10);
  }, RETENTION_TIMEOUT_MS);

  it("does not let a retired failure streak outlive a later success", () => {
    // consecutiveFailures is a streak, not a sum. Carrying a retired streak past a success in
    // the retained window would stop a healthy loop for failures it already recovered from.
    const document = normalizeLoopDocument({
      loops: [{
        definition: { title: "x" },
        retired: { dispatched: 5, succeeded: 0, failed: 5, parked: 0, usd: 0, consecutiveFailures: 5 },
        iterations: [{ ticketId: "A", seq: 6, outcome: "succeeded" }],
      }],
    });
    expect(document.loops[0]!.totals.consecutiveFailures).toBe(0);
    expect(document.loops[0]!.totals.dispatched).toBe(6);
  });

  it("carries a retired streak forward when the window has settled nothing since", () => {
    const document = normalizeLoopDocument({
      loops: [{
        definition: { title: "x" },
        retired: { dispatched: 3, succeeded: 0, failed: 3, parked: 0, usd: 0, consecutiveFailures: 3 },
        iterations: [{ ticketId: "A", seq: 4, outcome: "running" }],
      }],
    });
    expect(document.loops[0]!.totals.consecutiveFailures).toBe(3);
  });
});
