import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { schedulingGraphFrom } from "../../src/loops/scheduling-graph.js";
import { contractFromTicket } from "../../src/orchestration/contract-mapping.js";
import { WorkGraph } from "../../src/orchestration/work-graph/graph.js";
import type { WorkContract } from "../../src/orchestration/work-contract.js";
import { buildReceipt, type ReceiptFacts, type WorkReceipt } from "../../src/orchestration/work-receipt.js";
import { receiptStillCurrent } from "../../src/orchestration/verification-service.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

// #21 in the graph scheduler: a ticket whose contract consumes what another open ticket's contract
// says it will produce waits for that work, through the real WorkGraph and the integration gate.

const AT = "2026-10-16T10:00:00.000Z";
const hex = (char: string) => char.repeat(64);

function ticket(id: string, status: TicketStatus = "backlog"): Ticket {
  return {
    id, title: `Ticket ${id}`, status, statusSource: "manual", priority: "normal", complexity: "small", labels: [],
    acceptanceCriteria: [], territory: { files: [], areas: [] }, references: [], runIds: [], blockedBy: [], blocks: [],
    relatedTo: [], assignee: "unassigned", origin: "user", events: [], createdAt: AT, updatedAt: AT,
  } as Ticket;
}

function contract(id: string, owner: Ticket, io: Pick<WorkContract, "inputs" | "outputs">): WorkContract {
  return {
    ...contractFromTicket(owner, { id, enforcement: "observe", budget: { maxToolRounds: 10, maxRuntimeSeconds: 600, idleTimeoutSeconds: 120 }, createdAt: AT }),
    ...io,
  };
}

function receipt(id: string, contractId: string, ticketId: string, facts: Partial<ReceiptFacts> = {}): WorkReceipt {
  return buildReceipt({
    id, contract: { id: contractId, schema: 1, enforcement: "observe" }, subject: { ticketId },
    facts: {
      ended: "ok", filesChanged: [], coverage: "tool_edits", outOfScope: [], checks: [], uncovered: [],
      failedFiles: [], missingOutputs: [], verificationRequired: true, ...facts,
    },
    usage: { spendPartial: false, toolRounds: 1, elapsedMs: 10 }, createdAt: AT,
  });
}

/** A produces src/api.ts; B consumes it, optionally pinned to a version. */
function world(options: { producerStatus?: TicketStatus; producerVerified?: boolean; pin?: string; produced?: string } = {}) {
  const a = ticket("A", options.producerStatus ?? "in_progress");
  const b = ticket("B");
  const produced = options.produced ?? hex("2");
  const contracts = new Map<string, WorkContract>([
    ["wc-a", contract("wc-a", a, { inputs: [], outputs: [{ kind: "file_change", ref: "src/api.ts", description: "The API" }] })],
    ["wc-b", contract("wc-b", b, { inputs: [{ kind: "file", id: "src/api.ts", ...(options.pin ? { sha256: options.pin } : {}) }], outputs: [] })],
  ]);
  const producerFacts: Partial<ReceiptFacts> = {
    filesChanged: [{ path: "src/api.ts", change: "M", sha256: produced }],
    ...(options.producerVerified ? { checks: [{ kind: "check", method: "npm test", passed: ["src/api.ts"], failed: [], at: AT }] } : { uncovered: ["src/api.ts"] }),
  };
  const graph = new WorkGraph();
  graph.update({
    tickets: [a, b],
    plans: [],
    receipts: [receipt("r-a", "wc-a", "A", producerFacts), receipt("r-b", "wc-b", "B")],
    contract: (id) => contracts.get(id),
  });
  return graph;
}

describe("waiting on inputs other open work produces", () => {
  it("holds nothing while the gate is off, exactly as before", () => {
    expect(schedulingGraphFrom(world()).waitingInputs("B")).toEqual([]);
  });

  it("holds a consumer until its producer is verified or closed", () => {
    expect(schedulingGraphFrom(world(), { inputs: true }).waitingInputs("B")).toEqual(["A to produce src/api.ts"]);
    expect(schedulingGraphFrom(world({ producerVerified: true }), { inputs: true }).waitingInputs("B")).toEqual([]);
    expect(schedulingGraphFrom(world({ producerStatus: "done" }), { inputs: true }).waitingInputs("B")).toEqual([]);
  });

  it("holds a consumer whose pinned version no longer matches what the producer left", () => {
    const moved = world({ producerVerified: true, pin: hex("1"), produced: hex("2") });
    expect(schedulingGraphFrom(moved, { inputs: true }).waitingInputs("B")).toEqual(["A to produce src/api.ts again (it changed after this ticket pinned it)"]);
    const matching = world({ producerVerified: true, pin: hex("2"), produced: hex("2") });
    expect(schedulingGraphFrom(matching, { inputs: true }).waitingInputs("B")).toEqual([]);
  });

  it("never holds the producer itself, or a ticket whose inputs nobody is producing", () => {
    const view = schedulingGraphFrom(world(), { inputs: true });
    expect(view.waitingInputs("A")).toEqual([]);
    expect(view.waitingInputs("NOPE")).toEqual([]);
  });
});

describe("a verification that no longer describes the files", () => {
  it("is current until a file it verified changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-current-"));
    try {
      fs.writeFileSync(path.join(root, "api.ts"), "v1");
      const verified = receipt("r", "wc", "A", {
        filesChanged: [{ path: "api.ts", change: "M", sha256: createHash("sha256").update("v1").digest("hex") }],
        checks: [{ kind: "check", method: "npm test", passed: ["api.ts"], failed: [], at: AT }],
      });
      expect(receiptStillCurrent(root, verified)).toBe(true);
      fs.writeFileSync(path.join(root, "api.ts"), "v2");
      expect(receiptStillCurrent(root, verified)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
