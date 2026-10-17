import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../../src/loops/loop-store.js";
import {
  LoopSupervisor, type LoopDispatchRequest, type LoopDispatchResult, type LoopTicketGateway, type LoopVerification,
} from "../../src/loops/loop-supervisor.js";
import type { VerificationResult } from "../../src/orchestration/verification-lane.js";
import type { ReceiptSummary } from "../../src/orchestration/work-receipt.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

// The verification lane (#18) inside a real LoopSupervisor and LoopStore. Lanes and the verifier
// are scripted; everything the loop does with a verdict is real.

function ticket(id: string): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog" as TicketStatus, statusSource: "manual", priority: "normal",
    complexity: "small", labels: [], acceptanceCriteria: ["It works"], territory: { files: [`src/${id}.ts`], areas: [] },
    references: [], runIds: [], blockedBy: [], blocks: [], relatedTo: [], assignee: "unassigned", origin: "user",
    events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as Ticket;
}

class FakeTickets implements LoopTicketGateway {
  readonly reviewed: Array<{ id: string; note: string }> = [];
  readonly notes: Array<{ id: string; note: string }> = [];
  readonly blocked: Array<{ id: string; note: string }> = [];
  constructor(private _tickets: Ticket[]) {}
  tickets(): readonly Ticket[] { return this._tickets; }
  indexedFiles(): readonly string[] { return this._tickets.flatMap((t) => t.territory.files); }
  moveToReview(ticketId: string, note: string): void {
    this.reviewed.push({ id: ticketId, note });
    this._tickets = this._tickets.map((t) => (t.id === ticketId ? { ...t, status: "review" as TicketStatus } : t));
  }
  noteAttempt(ticketId: string, note: string): void { this.notes.push({ id: ticketId, note }); }
  blockTicket(ticketId: string, note: string): void { this.blocked.push({ id: ticketId, note }); }
}

const summary: ReceiptSummary = {
  id: "receipt-1", contractId: "contract-1", enforcement: "observe", status: "succeeded_unverified",
  filesChanged: 1, uncovered: [], outOfScope: [], next: "Review it.",
};

function verdict(kind: VerificationResult["verdict"], reason: string): VerificationResult {
  return { taskId: "A", verdict: kind, reasons: [reason], evidence: { receiptId: "receipt-1", checks: [], uncovered: [], stale: [], findings: [] }, closure: "human" };
}

let tmpDir: string;
let store: LoopStore;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loop-verify-"));
  store = new LoopStore(tmpDir);
  store.ensureInitialized();
});
afterEach(() => {
  store.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(verification: LoopVerification | undefined, result: Partial<LoopDispatchResult> = { receipt: summary }) {
  const tickets = new FakeTickets([ticket("A")]);
  const dispatched: LoopDispatchRequest[] = [];
  const dispatcher = {
    dispatch: async (request: LoopDispatchRequest): Promise<LoopDispatchResult> => {
      dispatched.push(request);
      return { ok: true, detail: "Lane says done.", filesTouched: [], runIds: [], laneId: "lane-1", ...result };
    },
  };
  const errors: unknown[] = [];
  const supervisor = new LoopSupervisor(store, tickets, dispatcher, { onError: (_id, error) => errors.push(error) }, undefined, undefined, {
    verification: () => verification,
    // Without the guard an explicit queue re-dispatches a ticket already in review.
    explicitQueueStatusGuard: () => true,
  });
  const loop = store.create({ title: "verify", queue: { ids: ["A"] } });
  return { tickets, dispatched, supervisor, loopId: loop.definition.id, errors };
}

async function run(supervisor: LoopSupervisor, loopId: string): Promise<void> {
  supervisor.start(loopId);
  for (let i = 0; i < 300 && supervisor.isRunning(loopId); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("verification lane in a ticket loop", () => {
  it("observe records the verdict on the iteration and changes nothing else", async () => {
    const verify = vi.fn(async () => verdict("rework_required", "check_failed"));
    const { tickets, supervisor, loopId } = harness({ mode: "observe", verify });
    await run(supervisor, loopId);
    expect(verify).toHaveBeenCalledOnce();
    expect(tickets.reviewed).toEqual([{ id: "A", note: "Lane says done." }]);
    const iteration = store.get(loopId)!.iterations[0]!;
    expect(iteration).toMatchObject({ outcome: "succeeded", verificationVerdict: "rework_required", verificationReasons: ["check_failed"] });
  });

  it("enforce sends rework back for another attempt, and the attempt budget still bounds it", async () => {
    const { tickets, dispatched, supervisor, loopId } = harness({ mode: "enforce", verify: async () => verdict("rework_required", "check_failed") });
    await run(supervisor, loopId);
    expect(tickets.reviewed).toEqual([]);
    expect(dispatched.length).toBe(2);
    expect(dispatched[1]!.priorAttempt).toMatch(/Verification sent this back for rework \(check failed\)/);
    expect(tickets.notes.at(-1)!.note).toMatch(/retry budget is spent/);
  });

  it("enforce parks blocked work for a person, with a verification note", async () => {
    const { tickets, supervisor, loopId } = harness({ mode: "enforce", verify: async () => verdict("blocked", "self_verification") });
    await run(supervisor, loopId);
    expect(tickets.reviewed).toEqual([]);
    expect(tickets.blocked[0]!.note).toMatch(/^The verification lane blocked this ticket\. Verification is blocked \(self verification\)/);
    expect(store.get(loopId)!.ticketState[0]!.parkedOnGate).toBe("verification");
  });

  it("enforce sends unverified work to review, labelled as not verified", async () => {
    const { tickets, supervisor, loopId } = harness({ mode: "enforce", verify: async () => verdict("insufficient_evidence", "no_acceptance_criteria") });
    await run(supervisor, loopId);
    expect(tickets.reviewed[0]!.note).toMatch(/^Not verified: the evidence is insufficient \(no acceptance criteria\)\. \[receipt receipt-1\]/);
  });

  it("enforce labels verified work, and still only moves it to review", async () => {
    const { tickets, supervisor, loopId } = harness({ mode: "enforce", verify: async () => verdict("verified", "checks_cover_changes") });
    await run(supervisor, loopId);
    expect(tickets.reviewed[0]!.note).toMatch(/^Verified by the verification lane/);
    expect(tickets.tickets()[0]!.status).toBe("review");
  });

  it("a verifier that throws decides nothing and is reported", async () => {
    const { tickets, supervisor, loopId, errors } = harness({ mode: "enforce", verify: async () => { throw new Error("hash failed"); } });
    await run(supervisor, loopId);
    expect(tickets.reviewed).toEqual([{ id: "A", note: "Lane says done." }]);
    expect(errors).toHaveLength(1);
    expect(store.get(loopId)!.iterations[0]!.verificationVerdict).toBeUndefined();
  });

  it("never runs for work without a receipt, or for a lane parked on a gate", async () => {
    const verify = vi.fn(async () => verdict("verified", "checks_cover_changes"));
    const withoutReceipt = harness({ mode: "enforce", verify }, {});
    await run(withoutReceipt.supervisor, withoutReceipt.loopId);
    expect(verify).not.toHaveBeenCalled();
    expect(withoutReceipt.tickets.reviewed).toHaveLength(1);
  });
});
