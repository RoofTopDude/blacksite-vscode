/* Loops under work contracts. Observe mode records the receipt and changes nothing; enforce mode
   lets the receipt, not the lane's own "ok", decide where the ticket goes. A lane lost to a host
   restart still gets a receipt. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../../src/loops/loop-store.js";
import { LoopSupervisor, type LoopDispatchRequest, type LoopDispatchResult, type LoopTicketGateway } from "../../src/loops/loop-supervisor.js";
import { SubagentLoopDispatcher, foldLaneStream, ticketContractFor } from "../../src/loops/loop-dispatcher.js";
import { validateWorkContract } from "../../src/orchestration/work-contract.js";
import type { ReceiptSummary } from "../../src/orchestration/work-receipt.js";
import type { SubagentProviderMessage, SubagentSpawnRequest } from "../../src/agent-session.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog" as TicketStatus, statusSource: "manual", priority: "normal", complexity: "small",
    labels: [], acceptanceCriteria: ["Works"], territory: { files: [`src/${id}.ts`], areas: [] }, references: [], runIds: [],
    blockedBy: [], blocks: [], relatedTo: [], children: [], assignee: "unassigned", origin: "user", events: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  } as Ticket;
}

class FakeTickets implements LoopTicketGateway {
  reviewed: Array<{ id: string; note: string }> = [];
  notes: Array<{ id: string; note: string }> = [];
  constructor(private _tickets: Ticket[]) {}
  tickets(): readonly Ticket[] { return this._tickets; }
  indexedFiles(): readonly string[] { return this._tickets.flatMap((t) => t.territory.files); }
  moveToReview(ticketId: string, note: string): void {
    this.reviewed.push({ id: ticketId, note });
    this._tickets = this._tickets.map((t) => (t.id === ticketId ? { ...t, status: "review" as TicketStatus } : t));
  }
  noteAttempt(ticketId: string, note: string): void { this.notes.push({ id: ticketId, note }); }
}

function receipt(status: ReceiptSummary["status"], enforcement: "observe" | "enforce"): ReceiptSummary {
  return { id: `receipt_${status}`, contractId: "wc_1", enforcement, status, filesChanged: 1, uncovered: [], outOfScope: [], next: "Fix the failing check." };
}

let dir: string;
let store: LoopStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-receipts-"));
  store = new LoopStore(dir);
  store.ensureInitialized();
});
afterEach(() => {
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(supervisor: LoopSupervisor, loopId: string): Promise<void> {
  supervisor.start(loopId);
  for (let i = 0; i < 200 && supervisor.isRunning(loopId); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function dispatcher(result: Partial<LoopDispatchResult>, onRequest?: (request: LoopDispatchRequest) => void) {
  return {
    dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
      onRequest?.(request);
      request.onContract?.("wc_1");
      return { ok: true, detail: "All done, tests pass.", filesTouched: [], runIds: [], ...result };
    },
  };
}

describe("loop outcomes under work contracts", () => {
  it("in observe mode records the receipt and still sends an ok lane to review", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "observe", ceilings: { maxConsecutiveFailures: 5 } });
    await run(new LoopSupervisor(store, tickets, dispatcher({ receipt: receipt("failed", "observe") })), loop.definition.id);
    expect(tickets.reviewed.map((entry) => entry.id)).toEqual(["A"]);
    const iteration = store.get(loop.definition.id)!.iterations[0]!;
    expect(iteration).toMatchObject({ outcome: "succeeded", receiptId: "receipt_failed", receiptStatus: "failed", contractId: "wc_1" });
  });

  it("in enforce mode does not send a lane whose check failed to review", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "enforce", ceilings: { maxConsecutiveFailures: 1 } });
    await run(new LoopSupervisor(store, tickets, dispatcher({ receipt: receipt("failed", "enforce") })), loop.definition.id);
    expect(tickets.reviewed).toEqual([]);
    expect(store.get(loop.definition.id)!.iterations[0]!.outcome).toBe("failed");
    expect(tickets.notes[0]?.note).toContain("receipt_failed");
  });

  it("in enforce mode opens the review note with what was and was not verified", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "enforce" });
    const unverified = { ...receipt("succeeded_unverified", "enforce"), next: "Not verified: no passing check covered src/A.ts." };
    await run(new LoopSupervisor(store, tickets, dispatcher({ receipt: unverified })), loop.definition.id);
    expect(tickets.reviewed[0]?.note).toMatch(/^Not verified \(receipt receipt_succeeded_unverified\)/);
  });

  it("parks a lane whose receipt says it was blocked", async () => {
    const tickets = new FakeTickets([ticket("A")]);
    const loop = store.create({ title: "enforce" });
    await run(new LoopSupervisor(store, tickets, dispatcher({ ok: false, receipt: receipt("blocked", "enforce") })), loop.definition.id);
    expect(store.get(loop.definition.id)!.iterations[0]!.outcome).toBe("parked");
  });

  it("passes the loop's remaining spend to the lane's contract", async () => {
    const seen: LoopDispatchRequest[] = [];
    const loop = store.create({ title: "budget", ceilings: { maxUsd: 3, maxConsecutiveFailures: 3 } });
    await run(new LoopSupervisor(store, new FakeTickets([ticket("A")]), dispatcher({ usd: 1 }, (request) => seen.push(request))), loop.definition.id);
    expect(seen[0]?.maxUsd).toBe(3);
  });

  it("writes a receipt for a contracted lane lost to a restart", () => {
    const loop = store.create({ title: "crash" });
    store.setStatus(loop.definition.id, "running");
    const opened = store.appendIteration(loop.definition.id, { ticketId: "A", runIds: [], outcome: "running", detail: "In flight.", startedAt: "2026-10-16T00:00:00.000Z" });
    store.settleIteration(loop.definition.id, opened!.seq, { contractId: "wc_9" });
    const onAbandonedContract = vi.fn();
    new LoopSupervisor(store, new FakeTickets([ticket("A")]), dispatcher({}), { onAbandonedContract }).restore();
    expect(onAbandonedContract).toHaveBeenCalledWith("wc_9", { loopId: loop.definition.id, ticketId: "A", iterationSeq: opened!.seq });
    expect(store.get(loop.definition.id)!.iterations[0]!.outcome).toBe("abandoned");
  });
});

describe("loop dispatcher contracts", () => {
  const request = {
    loopId: "loop_1", ticket: ticket("A"), complexity: "complex" as const, maxUsd: 2,
    approvals: { reviewer: "continuation" as const, autoApproveTiers: [], onGate: "park" as const, notify: true },
  };
  const budget = { complexity: "complex" as const, idleTimeoutSeconds: 1, maxRuntimeSeconds: 1, maxToolRounds: 1 };

  it("issues a valid contract from the ticket, bounded by the lane's tier and the loop's spend", () => {
    const contract = ticketContractFor(request, "enforce", { id: "wc_x", createdAt: "2026-10-16T00:00:00.000Z" });
    expect(validateWorkContract(contract).ok).toBe(true);
    expect(contract.territory.writable).toEqual({ files: ["src/A.ts"], areas: [] });
    expect(contract.budget).toEqual({ maxToolRounds: 10, maxRuntimeSeconds: 1200, idleTimeoutSeconds: 240, maxUsd: 2 });
    expect(contract.origin).toEqual({ kind: "ticket", ticketId: "A", loopId: "loop_1" });
  });

  it("sends the contract with the spawn only while contracts are on", async () => {
    const spawned: SubagentSpawnRequest[] = [];
    const provider = {
      spawn: async function* (spawn: SubagentSpawnRequest): AsyncGenerator<SubagentProviderMessage> {
        spawned.push(spawn);
        yield { type: "subagent_tool_result", result: { ok: true, subRequestId: "sub_1", answer: "done", toolRounds: 1, usage: null, scratchFiles: [], budget, receipt: receipt("verified", "enforce") } };
      },
    };
    let mode: "off" | "enforce" = "off";
    const contracts: string[] = [];
    const loopDispatcher = new SubagentLoopDispatcher({
      providerFor: () => provider,
      reviewApproval: async () => ({ action: "allow", reason: "ok" }) as never,
      sessionId: () => "s",
      contracts: { mode: () => mode, newId: (prefix) => `${prefix}_1` },
    });
    const off = await loopDispatcher.dispatch({ ...request, signal: new AbortController().signal, onContract: (id) => contracts.push(id) });
    expect(spawned[0]?.contract).toBeUndefined();
    expect(off.receipt?.status).toBe("verified");
    mode = "enforce";
    await loopDispatcher.dispatch({ ...request, signal: new AbortController().signal, onContract: (id) => contracts.push(id) });
    expect(spawned[1]?.contract?.id).toBe("wc_1");
    expect(contracts).toEqual(["wc_1"]);
  });

  it("carries a failed lane's receipt through the fold", async () => {
    async function* stream(): AsyncGenerator<SubagentProviderMessage> {
      yield {
        type: "subagent_tool_result",
        result: {
          ok: false, subRequestId: "s", error: "boom", failureKind: "error", budget, toolRounds: 1, elapsedMs: 1, stopReason: "error",
          partialAnswer: "", executionTrace: [], executionTraceTruncated: false, filesTouched: [], nextStep: "retry", receipt: receipt("failed", "enforce"),
        },
      };
    }
    expect((await foldLaneStream(stream(), {})).receipt?.status).toBe("failed");
  });
});
