/* The work graph over headless fixtures: a plan step is traceable to its code, dependencies,
   deliverables and evidence; verified, declared, inferred and missing relations stay distinct;
   cycles, dangling references, stale evidence and repaired links are reported, never repaired. */

import { describe, expect, it } from "vitest";
import { WorkGraph, stronglyConnected } from "../../src/orchestration/work-graph/graph.js";
import { WorkGraphService } from "../../src/orchestration/work-graph/service.js";
import { buildReceipt, type WorkReceipt } from "../../src/orchestration/work-receipt.js";
import { contractFromPlanStep } from "../../src/orchestration/contract-mapping.js";
import { normalizeTicketDocument, type Ticket } from "../../src/ticket-store.js";
import type { TaskPlan } from "../../src/planning-store.js";
import type { WorkContract } from "../../src/orchestration/work-contract.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, status: "backlog", statusSource: "manual", priority: "normal", complexity: "small", labels: [],
    acceptanceCriteria: [], territory: { files: [], areas: [] }, references: [], runIds: [], blockedBy: [], blocks: [], relatedTo: [],
    children: [], assignee: "agent", origin: "user", events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

function plan(): TaskPlan {
  const step = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title: `Step ${id}`, status, notes: [], updatedAt: "", ...extra });
  return {
    id: "plan-1", title: "Billing", status: "active", blocks: [], docs: [], agentCanArchive: false, executionApproved: true, notes: [],
    createdAt: "", updatedAt: "2026-01-02T00:00:00.000Z",
    phases: [
      {
        id: "ph-1", title: "Money", status: "completed", files: ["src/money.ts"], blocks: [], docs: [], notes: [], linkedTodoIds: [], updatedAt: "",
        steps: [step("st-1", "completed", { evidence: { checks: ["npm test"], unverified: [], filesChanged: ["src/money.ts"], at: "2026-01-02T00:00:00.000Z", receiptIds: ["r-1"] } })],
      },
      {
        id: "ph-2", title: "Invoices", status: "in_progress", files: ["src/invoice.ts"], dependsOn: ["ph-1", "ph-9"], complexity: "medium",
        blocks: [], docs: [{ id: "doc-1", kind: "spec", title: "Spec", source: "user", createdAt: "", updatedAt: "", byteSize: 1 }], notes: [], linkedTodoIds: [], updatedAt: "",
        steps: [step("st-1", "in_progress"), step("st-2", "pending")],
      },
    ],
  } as TaskPlan;
}

const BUDGET = { maxToolRounds: 5, maxRuntimeSeconds: 60, idleTimeoutSeconds: 30 };

function stepContract(p: TaskPlan): WorkContract {
  const base = contractFromPlanStep(p, p.phases[1]!, p.phases[1]!.steps[0]!, { id: "wc-2", createdAt: "2026-01-03T00:00:00.000Z", enforcement: "enforce", budget: BUDGET });
  return {
    ...base,
    inputs: [{ kind: "file", id: "src/money.ts", sha256: "a".repeat(64) }, { kind: "receipt", id: "r-1" }],
    outputs: [{ kind: "file_change", ref: "src/invoice.ts", description: "invoice totals" }],
  };
}

function receipt(id: string, subject: WorkReceipt["subject"], files: Array<{ path: string; sha256?: string }>, status: "verified" | "succeeded_unverified", createdAt: string, contractId = `wc-${id}`): WorkReceipt {
  return buildReceipt({
    id,
    contract: { id: contractId, schema: 1, enforcement: "enforce" },
    subject,
    facts: {
      ended: "ok", filesChanged: files.map((file) => ({ path: file.path, change: "M" as const, ...(file.sha256 ? { sha256: file.sha256 } : {}) })),
      coverage: "tool_edits", outOfScope: [],
      checks: status === "verified" ? [{ kind: "check", method: "npm test", passed: files.map((file) => file.path), failed: [], at: createdAt }] : [],
      uncovered: status === "verified" ? [] : files.map((file) => file.path), failedFiles: [], missingOutputs: [], verificationRequired: true,
    },
    evidence: [{ kind: "run", runId: `run-${id}` }],
    usage: { spendPartial: true, toolRounds: 1, elapsedMs: 1 },
    createdAt,
  });
}

function sources() {
  const p = plan();
  const contract = stepContract(p);
  const tickets = [
    ticket("T-1", { territory: { files: ["src/invoice.ts"], areas: [] }, blockedBy: ["T-2"], planId: "plan-1", phaseId: "ph-2", runIds: ["run-x"] }),
    ticket("T-2", { territory: { files: [], areas: ["src"] }, blockedBy: ["T-3"] }),
    ticket("T-3", { territory: { files: ["src/legacy.ts"], areas: [] }, blockedBy: ["T-2"], complexity: "large" }),
    ticket("T-4", { status: "done", territory: { files: ["src/invoice.ts"], areas: [] } }),
  ];
  const receipts = [
    receipt("r-1", { planId: "plan-1", phaseId: "ph-1", stepId: "st-1" }, [{ path: "src/money.ts", sha256: "b".repeat(64) }], "verified", "2026-01-02T00:00:00.000Z", "wc-1"),
    receipt("r-2", { planId: "plan-1", phaseId: "ph-2", stepId: "st-1" }, [{ path: "src/invoice.ts" }], "succeeded_unverified", "2026-01-03T00:00:00.000Z", "wc-2"),
    receipt("r-3", { ticketId: "T-2" }, [{ path: "src/money.ts" }], "verified", "2026-01-04T00:00:00.000Z"),
    receipt("r-4", { planId: "plan-1", phaseId: "ph-1", stepId: "st-1" }, [{ path: "src/money.ts" }], "verified", "2026-01-05T00:00:00.000Z", "wc-1"),
  ];
  const contracts = new Map<string, WorkContract>([["wc-2", contract]]);
  return { tickets, plans: [p], receipts, contract: (id: string) => contracts.get(id) };
}

const files = new Set(["src/money.ts", "src/invoice.ts", "src/report.ts"]);
function graph(extra: Partial<ReturnType<typeof sources>> = {}) {
  const g = new WorkGraph({
    fileExists: (path) => files.has(path),
    dependentsOf: (paths) => (paths.includes("src/money.ts") ? ["src/report.ts"] : []),
    fingerprint: (path) => (path === "src/money.ts" ? "c".repeat(64) : undefined),
  });
  g.update({ ...sources(), ...extra });
  return g;
}

describe("trace", () => {
  it("connects a plan step to its code, dependencies, deliverables and evidence", () => {
    const trace = graph().trace("plan-1/ph-2/st-1");
    expect(trace.node).toMatchObject({ id: "step:plan-1/ph-2/st-1", kind: "step", state: "open" });
    expect(trace.affectedCode.map((edge) => [edge.to, edge.status])).toEqual(expect.arrayContaining([
      ["file:src/invoice.ts", "declared"],
      ["file:src/invoice.ts", "verified"],
    ]));
    expect(trace.dependencies.map((edge) => [edge.to, edge.status])).toEqual(expect.arrayContaining([
      ["step:plan-1/ph-1/st-1", "inferred"],
    ]));
    expect(trace.dependents.map((edge) => edge.from)).toContain("step:plan-1/ph-2/st-2");
    expect(trace.deliverables.map((edge) => edge.to)).toEqual(["file:src/invoice.ts"]);
    expect(trace.evidence.map((edge) => [edge.kind, edge.to])).toEqual([["informed_by", "receipt:r-2"]]);
    expect(trace.consumes.map((edge) => edge.to).sort()).toEqual(["file:src/money.ts", "receipt:r-1"]);
  });

  it("resolves the ways a person names things", () => {
    const g = graph();
    expect(g.resolveRef("T-1")).toBe("ticket:T-1");
    expect(g.resolveRef("plan-1/ph-2")).toBe("phase:plan-1/ph-2");
    expect(g.resolveRef("plan-1")).toBe("plan:plan-1");
    expect(g.resolveRef("src/money.ts")).toBe("file:src/money.ts");
  });
});

describe("relation status", () => {
  it("keeps verified, declared, inferred and missing distinct", () => {
    const statuses = new Set(graph().edges().map((edge) => edge.status));
    expect([...statuses].sort()).toEqual(["declared", "inferred", "missing", "verified"]);
  });

  it("marks a reference to something that does not exist as missing, and reports it", () => {
    const g = graph();
    const missing = g.edges().filter((edge) => edge.status === "missing").map((edge) => edge.to).sort();
    // ph-9 is named twice: by the phase's dependsOn and by the step contract built from it.
    expect(missing).toEqual(["file:src/legacy.ts", "phase:plan-1/ph-9", "phase:plan-1/ph-9"]);
    expect(g.findings().filter((finding) => finding.kind === "missing")).toHaveLength(3);
  });
});

describe("findings", () => {
  it("reports a dependency cycle without breaking it", () => {
    const input = sources();
    const before = JSON.stringify(input.tickets);
    const g = graph();
    const cycles = g.findings().filter((finding) => finding.kind === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodes).toEqual(["ticket:T-2", "ticket:T-3"]);
    expect(g.blockers("T-2").map((entry) => entry.id)).toEqual(["ticket:T-3"]);
    expect(JSON.stringify(input.tickets)).toBe(before);
  });

  it("marks evidence stale when later work or the file itself has moved on", () => {
    const g = graph();
    const stale = g.edges().filter((edge) => edge.freshness === "stale");
    // r-1 recorded money.ts at hash b…; the file is now c…, and T-2 changed it afterwards.
    expect(stale.some((edge) => edge.provenance.ref === "r-1" && edge.kind === "modifies")).toBe(true);
    expect(stale.some((edge) => edge.kind === "verified_by" && edge.to === "receipt:r-1")).toBe(true);
    // r-4 is the latest change to money.ts and has no hash to contradict: still fresh.
    expect(g.edges().find((edge) => edge.provenance.ref === "r-4" && edge.kind === "modifies")?.freshness).toBe("fresh");
  });

  it("flags inputs pinned to a version that changed, and inputs a newer receipt replaced", () => {
    const problems = graph().findings().filter((finding) => finding.kind === "incompatible_input").map((finding) => finding.detail);
    expect(problems.some((detail) => detail.includes("src/money.ts"))).toBe(true);
    expect(problems.some((detail) => detail.includes("newer receipt (receipt:r-4)"))).toBe(true);
  });

  it("shows links the ticket store dropped on read", () => {
    const { document, linkFindings } = normalizeTicketDocument({
      tickets: [ticket("A", { blockedBy: ["GONE", "A"] }), ticket("B", { parentId: "C" }), ticket("C", { parentId: "B" })],
    });
    expect(document.tickets.find((entry) => entry.id === "A")?.blockedBy).toEqual([]);
    expect(linkFindings.map((finding) => `${finding.ticketId}.${finding.link}:${finding.reason}`).sort())
      .toEqual(["A.blockedBy:missing", "A.blockedBy:self", "B.parentId:cycle"]);
    const g = new WorkGraph();
    g.update({ tickets: document.tickets, plans: [], receipts: [], ticketLinkFindings: linkFindings });
    expect(g.findings().filter((finding) => finding.kind === "healed_link")).toHaveLength(3);
  });
});

describe("questions", () => {
  it("finds conflicts between open work, inferred from declarations and observed from receipts", () => {
    const conflicts = graph().conflicts();
    const inferred = conflicts.filter((edge) => edge.status === "inferred").map((edge) => [edge.from, edge.to]);
    // T-1 declares src/invoice.ts; T-2 declares all of src; T-4 is done and conflicts with nothing.
    expect(inferred).toContainEqual(["ticket:T-1", "ticket:T-2"]);
    expect(inferred.flat()).not.toContain("ticket:T-4");
    const observed = conflicts.filter((edge) => edge.status === "verified").map((edge) => [edge.from, edge.to]);
    expect(observed).toContainEqual(["step:plan-1/ph-1/st-1", "ticket:T-2"]);
  });

  it("follows impact through the Codebase Map", () => {
    const impact = graph().impact("src/money.ts");
    expect(impact.find((entry) => entry.id === "ticket:T-2")?.direct).toBe(true);
    expect(impact.map((entry) => entry.via)).toContain("src/money.ts");
  });

  it("computes the critical path over open work, leaving cycles out and saying so", () => {
    const result = graph().criticalPath();
    expect(result.excludedCycles).toEqual([["ticket:T-2", "ticket:T-3"]]);
    expect(result.path.map((entry) => entry.id)).not.toContain("ticket:T-2");
    expect(result.totalWeight).toBeGreaterThan(0);
    const planOnly = graph().criticalPath("plan-1");
    expect(planOnly.path.map((entry) => entry.id)).toEqual(["step:plan-1/ph-2/st-1", "step:plan-1/ph-2/st-2"]);
    expect(planOnly.totalWeight).toBe(6);
  });

  it("walks dependencies transitively", () => {
    expect(graph().walk("T-1", "dependencies", 3).map((entry) => entry.id)).toEqual(["ticket:T-2", "ticket:T-3"]);
  });

  it("finds strongly connected components iteratively", () => {
    const edges: Record<string, string[]> = { a: ["b"], b: ["c"], c: ["a"], d: ["d"], e: [] };
    const components = stronglyConnected(Object.keys(edges), (id) => edges[id] ?? []).map((component) => component.sort());
    expect(components).toEqual(expect.arrayContaining([["a", "b", "c"], ["d"], ["e"]]));
  });
});

describe("work graph service", () => {
  function service(enabled: boolean) {
    const input = sources();
    return new WorkGraphService({ enabled: () => enabled, readTickets: () => ({ tickets: input.tickets }), readPlans: () => input.plans });
  }

  it("answers the tool's questions, bounded", async () => {
    const s = service(true);
    expect(await s.dispatch("blockers", { ref: "T-1" })).toMatchObject({ ok: true, blockers: [{ id: "ticket:T-2" }] });
    const trace = await s.dispatch("trace", { ref: "T-1", limit: 1 }) as { affectedCode: { items: unknown[] } };
    expect(trace.affectedCode.items).toHaveLength(1);
    expect(await s.dispatch("findings", {})).toMatchObject({ ok: true, counts: expect.objectContaining({ cycle: 1 }) });
    expect(await s.dispatch("trace", {})).toMatchObject({ ok: false });
    expect(await s.dispatch("nope", {})).toMatchObject({ ok: false });
  });

  it("refuses while the setting is off", async () => {
    expect(await service(false).dispatch("findings", {})).toMatchObject({ ok: false, error: expect.stringContaining("off") });
  });
});
