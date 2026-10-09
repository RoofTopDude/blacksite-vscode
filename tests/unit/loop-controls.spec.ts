/* What a Ticket Loop owes the person who walked away from it:
   - Pause means "no more lanes", and the lanes already running finish (the docs always said so;
     the code used to cancel them and charge them as failures).
   - Stop cancels the lanes, and a lane cut off is not a failed one.
   - A crash with lanes in flight must not trip the failure ceiling when the loop resumes.
   - The loop says out loud when it ended or parked a ticket, and counts spend while it happens. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldLaneStream } from "../../src/loops/loop-dispatcher.js";
import { LoopStore } from "../../src/loops/loop-store.js";
import {
  LoopSupervisor,
  type LoopDispatchRequest,
  type LoopDispatchResult,
  type LoopTicketGateway,
} from "../../src/loops/loop-supervisor.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";
import type { SubagentProviderMessage } from "../../src/chat/subagent-lanes.js";

function ticket(id: string): Ticket {
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
  } as Ticket;
}

class FakeTickets implements LoopTicketGateway {
  readonly reviewed: string[] = [];
  readonly notes: Array<{ id: string; note: string }> = [];
  constructor(private _tickets: Ticket[]) {}
  tickets(): readonly Ticket[] { return this._tickets; }
  indexedFiles(): readonly string[] { return this._tickets.flatMap((entry) => entry.territory.files); }
  moveToReview(ticketId: string): void {
    this.reviewed.push(ticketId);
    this._tickets = this._tickets.map((entry) => (entry.id === ticketId ? { ...entry, status: "review" as TicketStatus } : entry));
  }
  noteAttempt(ticketId: string, note: string): void { this.notes.push({ id: ticketId, note }); }
}

let dir: string;
let store: LoopStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loop-controls-"));
  store = new LoopStore(dir);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, max = 300): Promise<void> {
  for (let i = 0; i < max && !condition(); i += 1) await tick();
}

describe("pause and stop", () => {
  it("lets a lane that is running finish when the loop is paused, and records it as the success it was", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    let laneSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
        laneSignal = request.signal;
        await gate;
        return { ok: true, detail: "finished", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "pause", workers: { concurrency: 1 } });
    supervisor.start(loop.definition.id);
    await until(() => !!laneSignal);

    supervisor.pause(loop.definition.id);
    // The loop will dispatch no more, but the lane is not told to stop.
    expect(laneSignal!.aborted).toBe(false);
    release();
    await until(() => !supervisor.isRunning(loop.definition.id));

    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("paused");
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]!.outcome).toBe("succeeded");
    expect(tickets.reviewed).toEqual(["A"]);
  });

  it("cancels the lanes on stop, and charges them neither an attempt nor a failure", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
        started();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, detail: "cancelled", filesTouched: [], runIds: [] };
      },
    });
    const loop = store.create({ title: "stop", workers: { concurrency: 1 } });
    supervisor.start(loop.definition.id);
    await running;
    supervisor.stop(loop.definition.id, "Stopped by the user.");
    await until(() => !supervisor.isRunning(loop.definition.id));

    const record = store.get(loop.definition.id)!;
    expect(record.definition.status).toBe("stopped");
    expect(record.iterations[0]!.outcome).toBe("abandoned");
    expect(record.totals.consecutiveFailures).toBe(0);
    expect(record.ticketState.find((entry) => entry.ticketId === "A")?.attempts ?? 0).toBe(0);
    expect(tickets.notes.at(-1)!.note).toContain("not charged an attempt");
  });

  it("does not let lanes cut off by a crash trip the failure ceiling when the loop resumes", () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C"), ticket("D")]);
    const loop = store.create({ title: "crashed", ceilings: { maxConsecutiveFailures: 3 } });
    store.setStatus(loop.definition.id, "running");
    for (const id of ["A", "B", "C", "D"]) {
      store.appendIteration(loop.definition.id, { ticketId: id, runIds: [], outcome: "running", detail: "", startedAt: new Date().toISOString() });
    }
    new LoopSupervisor(store, tickets, { dispatch: async () => ({ ok: true, detail: "", filesTouched: [], runIds: [] }) }).restore();
    const record = store.get(loop.definition.id)!;
    expect(record.iterations.every((entry) => entry.outcome === "abandoned")).toBe(true);
    expect(record.totals.consecutiveFailures).toBe(0);
  });
});

describe("telling the user", () => {
  it("reports a loop that ended by itself and a ticket parked on a refused approval", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B")]);
    const settled: string[] = [];
    const parked: string[] = [];
    const supervisor = new LoopSupervisor(
      store,
      tickets,
      {
        dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => request.ticket.id === "B"
          ? { ok: false, detail: "refused", filesTouched: [], runIds: [], parkedOnGate: "network" }
          : { ok: true, detail: "ok", filesTouched: [], runIds: [] },
      },
      {
        onSettled: (_loopId, title, status) => { settled.push(`${title}:${status}`); },
        onParked: (_loopId, _title, ticketId, gate) => { parked.push(`${ticketId}:${gate}`); },
      },
    );
    const loop = store.create({ title: "notify", workers: { concurrency: 1 } });
    supervisor.start(loop.definition.id);
    await until(() => !supervisor.isRunning(loop.definition.id));
    expect(parked).toEqual(["B:network"]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatch(/^notify:(drained|blocked)$/);
  });

  it("does not say anything when the user pauses it", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const settled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = new LoopSupervisor(
      store,
      tickets,
      { dispatch: async () => { await gate; return { ok: true, detail: "ok", filesTouched: [], runIds: [] }; } },
      { onSettled: (_loopId, _title, status) => { settled.push(status); } },
    );
    const loop = store.create({ title: "quiet", workers: { concurrency: 1 } });
    supervisor.start(loop.definition.id);
    await tick();
    supervisor.pause(loop.definition.id);
    release();
    await until(() => !supervisor.isRunning(loop.definition.id));
    expect(settled).toEqual([]);
  });

  it("counts spend while a lane is still running, so a loop already past its ceiling stops", async () => {
    const tickets = new FakeTickets([ticket("A"), ticket("B"), ticket("C")]);
    const dispatched: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = new LoopSupervisor(store, tickets, {
      dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
        dispatched.push(request.ticket.id);
        request.onSpend?.(3);
        await gate;
        return { ok: true, detail: "ok", filesTouched: [], runIds: [], usd: 3 };
      },
    });
    const loop = store.create({ title: "ceiling", workers: { concurrency: 1 }, ceilings: { maxUsd: 2 } });
    supervisor.start(loop.definition.id);
    await until(() => dispatched.length > 0);
    release();
    await until(() => !supervisor.isRunning(loop.definition.id));
    // With one lane at a time, the first one's $3 is already past $2 before it ends; the others never start.
    expect(dispatched).toEqual(["A"]);
    expect(store.get(loop.definition.id)!.definition.status).toBe("stopped");
  });
});

describe("foldLaneStream", () => {
  const budget = { complexity: "standard", idleTimeoutSeconds: 120, maxRuntimeSeconds: 600, maxToolRounds: 6 } as const;
  async function* streamOf(messages: SubagentProviderMessage[]): AsyncGenerator<SubagentProviderMessage> {
    for (const message of messages) yield message;
  }

  it("reports each priced model call as it happens, and the files the lane changed even when it succeeded", async () => {
    const spent: number[] = [];
    const result = await foldLaneStream(streamOf([
      { type: "subagent_lane_start", parentToolCallId: "parent", laneId: "lane_1", subRequestId: "sub_1", label: "L", task: "t" } as SubagentProviderMessage,
      {
        type: "subagent_lane_event", parentToolCallId: "parent", laneId: "lane_1",
        event: { type: "usage_update", inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as SubagentProviderMessage,
      {
        type: "subagent_lane_event", parentToolCallId: "parent", laneId: "lane_1",
        event: {
          type: "tool_call_result", toolCallId: "t1", toolName: "file_edit", ok: true, summary: "edited", result: {}, elapsedMs: 5,
          diffs: [{ path: "src/limiter.ts", additions: 3, deletions: 1, line: 1 }],
        },
      } as SubagentProviderMessage,
      {
        type: "subagent_tool_result",
        result: { ok: true, subRequestId: "sub_1", answer: "Done.", toolRounds: 1, usage: null, scratchFiles: [], budget },
      } as SubagentProviderMessage,
    ]), { onSpend: (usd: number) => { spent.push(usd); } }, (usage) => usage.inputTokens / 1_000_000);

    expect(spent).toEqual([0.002]);
    expect(result.filesTouched).toEqual(["src/limiter.ts"]);
    expect(result.ok).toBe(true);
  });
});
