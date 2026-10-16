/* #14 typed orchestration signals: the model, derivation from host facts, the journal, the
   consumers and the service that ties them together. See
   docs/orchestration-p1-implementation-plan.md §3. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONSUMERS,
  loopUnblocked,
  loopWake,
  reassess,
  ticketNotes,
  type ReconcileReads,
} from "../../src/orchestration/signals/consumers.js";
import {
  deriveContractOverlap,
  deriveFromIterations,
  deriveFromPlanRunEvent,
  deriveFromReceipt,
  deriveFromTicketChange,
  deriveIntegrationReady,
  snapshotTicket,
} from "../../src/orchestration/signals/derive.js";
import { SignalJournal } from "../../src/orchestration/signals/journal.js";
import {
  finalizeSignal,
  mayChangeState,
  readSignal,
  signalId,
  type OrchestrationSignal,
  type SignalDraft,
} from "../../src/orchestration/signals/model.js";
import { createSignalPorts } from "../../src/orchestration/signals/ports.js";
import { SignalService, type SignalPorts } from "../../src/orchestration/signals/service.js";
import type { LoopIteration } from "../../src/loops/loop-model.js";
import type { WorkContract } from "../../src/orchestration/work-contract.js";
import type { WorkReceipt } from "../../src/orchestration/work-receipt.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

const T0 = Date.parse("2026-10-16T00:00:00.000Z");

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog" as TicketStatus, statusSource: "manual", priority: "normal",
    complexity: "small", labels: [], acceptanceCriteria: [], territory: { files: [], areas: [] }, references: [],
    runIds: [], blockedBy: [], blocks: [], relatedTo: [], children: [], assignee: "unassigned", origin: "user",
    events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

function receipt(overrides: Partial<WorkReceipt> & { status: WorkReceipt["status"] }): WorkReceipt {
  return {
    schema: 1, id: "receipt_1", contractId: "wc_1", contractSchema: 1, enforcement: "enforce",
    subject: { ticketId: "BLK-1", loopId: "loop_1", laneId: "lane_1" }, basis: [],
    observed: { filesChanged: [], coverage: "tool_edits", outOfScope: [], granted: [], refused: [] },
    evidence: [], verification: { required: true, result: "passed", uncovered: [] },
    usage: { spendPartial: false, toolRounds: 1, elapsedMs: 1 }, selfReport: { answerExcerpt: "" },
    next: { guidance: "", retryable: false }, createdAt: "2026-10-16T00:00:00.000Z",
    ...overrides,
  } as WorkReceipt;
}

function draft(overrides: Partial<SignalDraft> = {}): SignalDraft {
  return {
    kind: "work_completed", taskId: "ticket:BLK-1", causeId: "receipt_1",
    provenance: { source: "host", observer: "receipt" }, detail: "BLK-1 finished.",
    ...overrides,
  };
}

function signal(overrides: Partial<SignalDraft> = {}, seq = 1): OrchestrationSignal {
  return { ...finalizeSignal(draft(overrides), () => T0), seq };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-signals-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("signal model", () => {
  it("gives the same fact the same id, and a different cause a different one", () => {
    expect(signalId("work_completed", "ticket:A", "r1")).toBe(signalId("work_completed", "ticket:A", "r1"));
    expect(signalId("work_completed", "ticket:A", "r1")).not.toBe(signalId("work_completed", "ticket:A", "r2"));
    expect(signalId("work_completed", "ticket:A", "r1")).not.toBe(signalId("verification_failed", "ticket:A", "r1"));
  });

  it("carries a stable task id, a cause, provenance, a time and evidence (AC 1)", () => {
    const value = finalizeSignal(draft({ evidence: [{ kind: "receipt", ref: "receipt_1" }] }), () => T0);
    expect(value).toMatchObject({ v: 1, kind: "work_completed", taskId: "ticket:BLK-1", causeId: "receipt_1", at: "2026-10-16T00:00:00.000Z", provenance: { source: "host" } });
    expect(value.evidence).toEqual([{ kind: "receipt", ref: "receipt_1" }]);
    expect(readSignal(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("rejects a stored signal that is incomplete or whose id does not match its fact", () => {
    const value = finalizeSignal(draft(), () => T0);
    expect(readSignal({ ...value, provenance: undefined })).toBeNull();
    expect(readSignal({ ...value, at: "" })).toBeNull();
    expect(readSignal({ ...value, causeId: "something else" })).toBeNull();
    expect(readSignal({ ...value, kind: "invented" })).toBeNull();
  });

  it("lets only host and user signals with their evidence change readiness (D3)", () => {
    expect(mayChangeState({ provenance: { source: "host", observer: "x" } })).toBe(true);
    expect(mayChangeState({ provenance: { source: "user", observer: "x" } })).toBe(true);
    expect(mayChangeState({ provenance: { source: "model", observer: "x" } })).toBe(false);
    expect(mayChangeState({ provenance: { source: "reviewer", observer: "x" } })).toBe(false);
    expect(mayChangeState({ provenance: { source: "host", observer: "x" }, data: { evidenceMissing: true } })).toBe(false);
  });
});

describe("deriving signals from host facts", () => {
  it("turns a verified receipt into work_completed, and a failed check into verification_failed", () => {
    expect(deriveFromReceipt(receipt({ status: "verified" })).map((entry) => entry.kind)).toEqual(["work_completed"]);
    const failed = deriveFromReceipt(receipt({
      status: "failed",
      verification: { required: true, result: "failed", uncovered: [] },
      evidence: [{ kind: "check", method: "npm test", passed: [], failed: ["src/a.ts"], at: "x" }],
    }));
    expect(failed.map((entry) => entry.kind)).toEqual(["verification_failed"]);
    expect(failed[0]!.data).toEqual({ failed: ["src/a.ts"] });
    expect(failed[0]!.scope).toMatchObject({ loopId: "loop_1", laneId: "lane_1", contractId: "wc_1" });
  });

  it("reports scope that grew, and whether anything approved it", () => {
    const granted = deriveFromReceipt(receipt({ status: "verified", observed: { filesChanged: [], coverage: "tool_edits", outOfScope: [], granted: ["docs/x.md"], refused: [] } }));
    expect(granted.find((entry) => entry.kind === "scope_expanded")!.data).toMatchObject({ authorized: true, granted: ["docs/x.md"] });
    const unapproved = deriveFromReceipt(receipt({ status: "partial", observed: { filesChanged: [], coverage: "tool_edits", outOfScope: ["etc/y"], granted: [], refused: [] } }));
    expect(unapproved[0]!.data).toMatchObject({ authorized: false });
  });

  it("says nothing for a cancelled or abandoned lane", () => {
    expect(deriveFromReceipt(receipt({ status: "cancelled" }))).toEqual([]);
    expect(deriveFromReceipt(receipt({ status: "abandoned" }))).toEqual([]);
  });

  it("treats the first read of a ticket as learning, not as a change", () => {
    expect(deriveFromTicketChange(undefined, ticket("A", { status: "done" }))).toEqual([]);
  });

  it("attributes a closure to whoever made it, from the ticket's own timeline", () => {
    const before = snapshotTicket(ticket("A"));
    const byUser = deriveFromTicketChange(before, ticket("A", { status: "done", updatedAt: "2026-10-16T01:00:00.000Z", events: [{ id: "e1", at: "x", actor: "user", kind: "status", to: "done" }] }));
    expect(byUser).toHaveLength(1);
    expect(byUser[0]).toMatchObject({ kind: "work_completed", provenance: { source: "user" } });
    const byAgent = deriveFromTicketChange(before, ticket("A", { status: "done", updatedAt: "2026-10-16T01:00:00.000Z", events: [{ id: "e1", at: "x", actor: "agent", kind: "status", to: "done" }] }));
    expect(byAgent[0]!.provenance.source).toBe("model");
  });

  it("reports a reopened ticket and a newly declared dependency", () => {
    const reopened = deriveFromTicketChange(snapshotTicket(ticket("A", { status: "done" })), ticket("A", { status: "backlog", updatedAt: "t2" }));
    expect(reopened.map((entry) => entry.kind)).toEqual(["verification_failed"]);
    const linked = deriveFromTicketChange(snapshotTicket(ticket("A")), ticket("A", { blockedBy: ["B"], updatedAt: "t2", events: [{ id: "e", at: "x", actor: "user", kind: "link" }] }));
    expect(linked).toEqual([expect.objectContaining({ kind: "dependency_discovered", data: { dependsOn: ["B"] }, provenance: { source: "user", observer: "ticket.blockedBy" } })]);
  });

  it("finds work made ready by a completion: all blockers closed, or every child in review", () => {
    const tickets = [
      ticket("A", { status: "done" }),
      ticket("B", { blockedBy: ["A"] }),
      ticket("C", { blockedBy: ["A", "D"] }),
      ticket("D"),
      ticket("P", { children: ["A", "E"] }),
      ticket("E", { status: "review" }),
    ];
    const ready = deriveIntegrationReady(tickets, ["A"], { id: "sig_x", source: "user" });
    expect(ready.map((entry) => `${entry.taskId}:${String(entry.data?.reason)}`).sort()).toEqual(["ticket:B:dependencies_met", "ticket:P:children_ready"]);
  });

  it("takes a lane's claim that it needs another ticket as the agent's account, not an observation", () => {
    const base: LoopIteration = { loopId: "L", executionId: "e", ticketId: "A", seq: 1, runIds: [], outcome: "running", detail: "", startedAt: "s", activity: [] };
    const out = deriveFromIterations("L", [base], [{ ...base, outcome: "failed", endedAt: "t", detail: "Cannot finish: this is blocked by BLK-9 landing first." }]);
    expect(out).toEqual([expect.objectContaining({ kind: "dependency_discovered", provenance: { source: "model", observer: "lane.report" }, data: { dependsOn: ["BLK-9"] } })]);
    // Already settled when the host looked: not news.
    expect(deriveFromIterations("L", [{ ...base, outcome: "failed", endedAt: "t" }], [{ ...base, outcome: "failed", endedAt: "t", detail: "blocked by BLK-9" }])).toEqual([]);
  });

  it("separates a step finished with evidence from one only ticked off", () => {
    const withEvidence = deriveFromPlanRunEvent("run_1", "plan", { type: "step_completed", at: 5, phaseId: "p", stepId: "s", title: "S", evidence: { checks: ["npm test"], unverified: [], filesChanged: ["a.ts"], at: "x" } });
    expect(withEvidence[0]).toMatchObject({ kind: "work_completed", taskId: "step:plan/p/s", provenance: { source: "host" } });
    const ticked = deriveFromPlanRunEvent("run_1", "plan", { type: "step_completed", at: 6, phaseId: "p", stepId: "s", title: "S" });
    expect(ticked[0]!.provenance.source).toBe("model");
    expect(withEvidence[0]!.causeId).not.toBe(ticked[0]!.causeId);
    expect(deriveFromPlanRunEvent("run_1", "plan", { type: "tripwire", at: 7, kind: "check_regressed", detail: "npm test fails again" })[0]!.kind).toBe("verification_failed");
  });

  it("reports two live contracts with overlapping explicit territory, and ignores workspace-wide ones", () => {
    const contract = (id: string, writable: WorkContract["territory"]["writable"]): WorkContract => ({ id, territory: { writable, readable: "workspace", source: "declared" } } as unknown as WorkContract);
    const a = contract("wc_a", { files: ["src/a.ts"], areas: ["src/lib"] });
    const b = contract("wc_b", { files: ["src/lib/x.ts"], areas: [] });
    const c = contract("wc_c", { files: ["docs/readme.md"], areas: [] });
    expect(deriveContractOverlap(a, [b, c]).map((entry) => entry.data?.with)).toEqual(["wc_b"]);
    expect(deriveContractOverlap(contract("wc_w", "workspace"), [a])).toEqual([]);
  });
});

describe("signal journal", () => {
  it("assigns a total order, drops repeats, and remembers both across a restart", () => {
    const journal = new SignalJournal(dir);
    const first = journal.append(signal({ causeId: "r1" }));
    const second = journal.append(signal({ causeId: "r2" }));
    expect([first?.seq, second?.seq]).toEqual([1, 2]);
    expect(journal.append(signal({ causeId: "r1" }))).toBeNull();
    const reopened = new SignalJournal(dir);
    expect(reopened.append(signal({ causeId: "r1" }))).toBeNull();
    expect(reopened.append(signal({ causeId: "r3" }))?.seq).toBe(3);
  });

  it("keeps a cursor per consumer and returns what each has not seen", () => {
    const journal = new SignalJournal(dir);
    for (const cause of ["a", "b", "c"]) journal.append(signal({ causeId: cause }));
    journal.setCursor("x", 2);
    const reopened = new SignalJournal(dir);
    expect(reopened.cursor("x")).toBe(2);
    expect(reopened.signalsAfter(2).map((entry) => entry.causeId)).toEqual(["c"]);
  });

  it("skips a torn last line rather than failing", () => {
    const journal = new SignalJournal(dir);
    journal.append(signal({ causeId: "a" }));
    fs.appendFileSync(path.join(journal.dir, "journal.jsonl"), "{\"type\":\"signal\",\"v\":1,\"kind\":");
    expect(new SignalJournal(dir).signalsAfter(0)).toHaveLength(1);
  });
});

// ── Consumers ──────────────────────────────────────────────────────────────

interface FakeLoop { id: string; title: string; status: "running" | "blocked" | "paused" | "stopped" | "drained"; blockedOn?: "dependencies" | "mixed"; resumeOffer?: { ready: string[] }; ticketIds: string[] }

function reads(loops: FakeLoop[], options: { running?: string[]; ready?: Record<string, string[]>; open?: string[] } = {}): ReconcileReads {
  return {
    loops: () => loops,
    isRunning: (id) => (options.running ?? loops.filter((loop) => loop.status === "running").map((loop) => loop.id)).includes(id),
    wouldDispatch: (id) => options.ready?.[id] ?? [],
    ticketOpen: (id) => (options.open ?? []).includes(id),
  };
}

describe("consumers", () => {
  it("wake only running loops, and only for what the host saw or a person did (C1, D3)", () => {
    const loops: FakeLoop[] = [
      { id: "run", title: "R", status: "running", ticketIds: [] },
      { id: "paused", title: "P", status: "paused", ticketIds: [] },
    ];
    expect(loopWake.reconcile([signal({ provenance: { source: "user", observer: "ticket.status" } })], reads(loops))).toEqual([
      { type: "wake_loop", loopId: "run", signalIds: [expect.any(String)] },
    ]);
    expect(loopWake.reconcile([signal({ provenance: { source: "model", observer: "plan.step" } })], reads(loops))).toEqual([]);
  });

  it("offer a resume for a loop blocked only on dependencies, never for a paused or mixed one (C2, D5)", () => {
    const loops: FakeLoop[] = [
      { id: "deps", title: "Deps", status: "blocked", blockedOn: "dependencies", ticketIds: [] },
      { id: "mixed", title: "Mixed", status: "blocked", blockedOn: "mixed", ticketIds: [] },
      { id: "paused", title: "Paused", status: "paused", ticketIds: [] },
    ];
    const ready = { deps: ["BLK-2"], mixed: ["BLK-3"], paused: ["BLK-4"] };
    const actions = loopUnblocked.reconcile([signal({ provenance: { source: "user", observer: "ticket.status" } })], reads(loops, { ready }));
    expect(actions).toEqual([expect.objectContaining({ type: "offer_resume", loopId: "deps", ready: ["BLK-2"] })]);
    expect((actions[0] as { because: string }).because).toContain("BLK-1");
  });

  it("does not offer twice for the same ready set, and withdraws when nothing is ready", () => {
    const offered: FakeLoop = { id: "deps", title: "D", status: "blocked", blockedOn: "dependencies", resumeOffer: { ready: ["BLK-2"] }, ticketIds: [] };
    const trigger = [signal({ provenance: { source: "host", observer: "receipt" } })];
    expect(loopUnblocked.reconcile(trigger, reads([offered], { ready: { deps: ["BLK-2"] } }))).toEqual([]);
    expect(loopUnblocked.reconcile(trigger, reads([offered], { ready: { deps: [] } }))).toEqual([expect.objectContaining({ type: "withdraw_offer", loopId: "deps" })]);
  });

  it("flag what needs judgment where it belongs, including anything only the agent claimed (C3)", () => {
    const loops: FakeLoop[] = [{ id: "L", title: "L", status: "running", ticketIds: ["BLK-1"] }];
    const actions = reassess.reconcile([
      signal({ kind: "verification_failed", causeId: "c1" }),
      signal({ kind: "work_completed", causeId: "c2", provenance: { source: "model", observer: "lane.report" } }),
      signal({ kind: "work_completed", causeId: "c3" }),
      signal({ kind: "progress_stalled", causeId: "c4", taskId: "planrun:run_1", scope: { planRunId: "run_1" } }),
    ], reads(loops));
    expect(actions.map((action) => `${action.type}:${action.type === "flag" ? JSON.stringify(action.target) : ""}`)).toEqual([
      'flag:{"loopId":"L"}', 'flag:{"loopId":"L"}', 'flag:{"planRunId":"run_1"}',
    ]);
  });

  it("note host collisions and failed checks on open tickets only, never on closed ones (C4)", () => {
    const batch = [signal({ kind: "contract_conflict", causeId: "c1" }), signal({ kind: "verification_failed", causeId: "c2", taskId: "ticket:BLK-2" })];
    expect(ticketNotes.reconcile(batch, reads([], { open: ["BLK-1"] })).map((action) => action.type === "note_ticket" && action.ticketId)).toEqual(["BLK-1"]);
  });

  it("decide the same way for the same batch in any order (out-of-order delivery)", () => {
    const loops: FakeLoop[] = [{ id: "deps", title: "D", status: "blocked", blockedOn: "dependencies", ticketIds: ["BLK-1"] }];
    const batch = [signal({ causeId: "a" }), signal({ kind: "integration_ready", causeId: "b", taskId: "ticket:BLK-2" }), signal({ kind: "verification_failed", causeId: "c" })];
    for (const consumer of DEFAULT_CONSUMERS) {
      const forward = consumer.reconcile(batch, reads(loops, { ready: { deps: ["BLK-2"] }, open: ["BLK-1"] }));
      const backward = consumer.reconcile([...batch].reverse(), reads(loops, { ready: { deps: ["BLK-2"] }, open: ["BLK-1"] }));
      const key = (actions: unknown[]) => actions.map((action) => JSON.stringify({ ...(action as object), signalIds: undefined })).sort();
      expect(key(backward)).toEqual(key(forward));
    }
  });
});

// ── Service ────────────────────────────────────────────────────────────────

function spyPorts(): SignalPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    wakeLoop: (id) => calls.push(`wake:${id}`),
    offerResume: (id, offer) => calls.push(`offer:${id}:${offer.ready.join(",")}`),
    withdrawOffer: (id) => calls.push(`withdraw:${id}`),
    flag: (target) => calls.push(`flag:${target.loopId ?? target.planRunId}`),
    noteTicket: (id) => calls.push(`note:${id}`),
  };
}

function service(mode: "off" | "observe" | "act", options: { loops?: FakeLoop[]; ready?: Record<string, string[]>; tickets?: Ticket[]; journal?: SignalJournal; ports?: SignalPorts } = {}) {
  const ports = options.ports ?? spyPorts();
  const journal = options.journal ?? new SignalJournal(dir);
  const svc = new SignalService({
    mode: () => mode,
    journal,
    reads: reads(options.loops ?? [], { ready: options.ready ?? {} }),
    ports,
    ...(options.tickets ? { tickets: () => options.tickets! } : {}),
    now: () => T0,
    schedule: () => ({ cancel: () => undefined }),
  });
  return { svc, ports: ports as SignalPorts & { calls: string[] }, journal };
}

describe("signal service", () => {
  it("writes nothing at all when off", () => {
    const { svc } = service("off");
    svc.observeReceipt(receipt({ status: "verified" }));
    svc.flush();
    expect(fs.existsSync(path.join(dir, ".blacksite"))).toBe(false);
  });

  it("records what it would do in observe mode and does none of it", () => {
    const loops: FakeLoop[] = [{ id: "L", title: "L", status: "running", ticketIds: [] }];
    const { svc, ports, journal } = service("observe", { loops });
    svc.observeReceipt(receipt({ status: "verified" }));
    svc.flush();
    expect(ports.calls).toEqual([]);
    const records = journal.lines().filter((line) => line.type === "reconcile");
    expect(records).toEqual([expect.objectContaining({ consumer: "loop-wake", action: "wake_loop", applied: false })]);
  });

  it("applies the same actions in act mode", () => {
    const loops: FakeLoop[] = [{ id: "L", title: "L", status: "running", ticketIds: [] }];
    const { svc, ports } = service("act", { loops });
    svc.observeReceipt(receipt({ status: "verified" }));
    svc.flush();
    expect(ports.calls).toEqual(["wake:L"]);
  });

  it("collapses a storm into one wake per loop, and drops the repeats (AC 5)", () => {
    const loops: FakeLoop[] = [{ id: "L", title: "L", status: "running", ticketIds: [] }];
    const { svc, ports, journal } = service("act", { loops });
    for (let i = 0; i < 500; i += 1) svc.observeReceipt(receipt({ status: "verified", id: `r${i % 50}` }));
    svc.flush();
    expect(ports.calls).toEqual(["wake:L"]);
    expect(journal.lines().filter((line) => line.type === "signal")).toHaveLength(50);
  });

  it("works out what a closure made ready while the board is at hand", () => {
    const tickets = [ticket("A", { status: "done" }), ticket("B", { blockedBy: ["A"] })];
    const { svc, journal } = service("observe", { tickets });
    svc.observeTickets([ticket("A"), ticket("B", { blockedBy: ["A"] })]);
    svc.observeTickets([ticket("A", { status: "done", updatedAt: "t2", events: [{ id: "e", at: "x", actor: "user", kind: "status", to: "done" }] }), ticket("B", { blockedBy: ["A"] })]);
    const kinds = journal.lines().filter((line) => line.type === "signal").map((line) => (line as unknown as OrchestrationSignal).kind);
    expect(kinds).toEqual(["work_completed", "integration_ready"]);
  });

  it("never starts a loop, whatever it is fed (D4, D5)", () => {
    // The ports are the whole of what signals can do; none of them starts anything. Feed every
    // kind from every source and check that only the permitted effects are ever asked for.
    const loops: FakeLoop[] = [
      { id: "run", title: "R", status: "running", ticketIds: ["BLK-1"] },
      { id: "deps", title: "D", status: "blocked", blockedOn: "dependencies", ticketIds: ["BLK-1"] },
      { id: "paused", title: "P", status: "paused", ticketIds: ["BLK-1"] },
    ];
    const { svc, ports } = service("act", { loops, ready: { run: ["X"], deps: ["X"], paused: ["X"] } });
    const kinds = ["work_completed", "integration_ready", "dependency_discovered", "verification_failed", "scope_expanded", "contract_conflict", "progress_stalled"] as const;
    for (const kind of kinds) for (const source of ["host", "user", "reviewer", "model"] as const) {
      svc.emit(draft({ kind, causeId: `${kind}:${source}`, provenance: { source, observer: "test" }, data: { authorized: false } }));
    }
    svc.flush();
    expect(ports.calls.every((call) => /^(wake:run|offer:deps:X|flag:(run|deps|paused)|note:BLK-1)$/.test(call))).toBe(true);
    expect(ports.calls.some((call) => call.startsWith("wake:paused") || call.startsWith("offer:paused"))).toBe(false);
  });

  it("ignores changes its own consumers caused (no feedback loops)", () => {
    const { svc, journal } = service("act");
    svc.emit(draft({ causeId: "reconcile:sig_x" }));
    expect(journal.lines()).toEqual([]);
  });

  it("replays what consumers had not reconciled after a restart, and only that (AC 4)", () => {
    const loops: FakeLoop[] = [{ id: "deps", title: "D", status: "blocked", blockedOn: "dependencies", ticketIds: [] }];
    const journal = new SignalJournal(dir);
    // A crash after the journal append and before any consumer ran: the cursor was never saved.
    journal.append(signal({ causeId: "r1", provenance: { source: "user", observer: "ticket.status" } }));
    const first = service("act", { loops, ready: { deps: ["BLK-2"] }, journal: new SignalJournal(dir) });
    first.svc.replayPending();
    expect(first.ports.calls).toEqual(["offer:deps:BLK-2"]);
    const second = service("act", { loops, ready: { deps: ["BLK-2"] }, journal: new SignalJournal(dir) });
    second.svc.replayPending();
    expect(second.ports.calls).toEqual([]);
  });
});

describe("signal ports", () => {
  it("offer and withdraw through the loop store and attention, and flag plan runs", () => {
    const raised: string[] = [];
    const resolved: string[] = [];
    const offers: Array<string | undefined> = [];
    const planFlags: string[] = [];
    const record = { definition: { id: "L", title: "Nightly", status: "blocked" }, resumeOffer: { ready: ["B"] }, reassessments: [{}] };
    const ports = createSignalPorts({
      loops: {
        get: () => record as never,
        setResumeOffer: (_id, offer) => { offers.push(offer?.because); return record as never; },
        addReassessment: () => undefined,
      },
      supervisor: { wake: vi.fn() },
      attention: () => ({ raise: (item) => { raised.push(`${item.kind}:${item.id}`); return true; }, resolve: (id) => { resolved.push(id); } }),
      planRuns: () => ({ noteReassessment: (runId) => { planFlags.push(runId); } }),
      noteTicket: vi.fn(),
      now: () => T0,
    });
    ports.offerResume("L", { ready: ["B"], because: "A is done.", signalIds: ["s"] });
    ports.withdrawOffer("L");
    ports.flag({ planRunId: "run_1" }, { signalId: "s", kind: "progress_stalled", taskId: "planrun:run_1", detail: "d", at: "x", source: "host" });
    ports.flag({ loopId: "L" }, { signalId: "s2", kind: "contract_conflict", taskId: "ticket:A", detail: "d", at: "x", source: "host" });
    expect(offers).toEqual(["A is done.", undefined]);
    expect(raised).toEqual(["loop_can_continue:loop:L:can_continue", "loop_reassess:loop:L:reassess"]);
    expect(resolved).toEqual(["loop:L:can_continue"]);
    expect(planFlags).toEqual(["run_1"]);
  });
});
