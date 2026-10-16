/* The work graph at scale. Targets (plan §7.6): a cold build of 10k tickets, 500 plans × 40
   steps and 5k receipts over a 50k-file map in ≤ 2 s; a one-ticket update in ≤ 25 ms; the
   critical path over 20k steps in ≤ 200 ms. Asserted at three times those numbers so a slow CI
   runner does not flake; set WORK_GRAPH_PERF_STRICT=1 to assert the targets themselves. Lives in
   the eval suite because coverage instrumentation slows it several-fold. */

import { describe, expect, it } from "vitest";
import { WorkGraph, type WorkGraphSources } from "../../../src/orchestration/work-graph/graph.js";
import { buildReceipt, type WorkReceipt } from "../../../src/orchestration/work-receipt.js";
import type { Ticket, TicketStatus } from "../../../src/ticket-store.js";
import type { TaskPlan } from "../../../src/planning-store.js";

/** mulberry32: a small seeded PRNG, so every run builds the same graph. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES: TicketStatus[] = ["backlog", "triage", "in_progress", "blocked", "review", "done"];

function makeTicket(index: number, rand: () => number, ticketCount: number, fileCount: number): Ticket {
  const file = (n: number) => `pkg${n % 200}/src/file${n}.ts`;
  const blockers: string[] = [];
  if (rand() < 0.3 && index > 0) blockers.push(`T-${Math.floor(rand() * Math.min(index, ticketCount))}`);
  return {
    id: `T-${index}`, title: `Ticket ${index}`, status: STATUSES[Math.floor(rand() * STATUSES.length)]!, statusSource: "manual", priority: "normal",
    complexity: (["small", "medium", "large"] as const)[Math.floor(rand() * 3)], labels: [], acceptanceCriteria: [],
    territory: { files: [file(Math.floor(rand() * fileCount)), file(Math.floor(rand() * fileCount))], areas: rand() < 0.05 ? [`pkg${index % 200}`] : [] },
    references: [], runIds: [], blockedBy: blockers, blocks: [], relatedTo: [], children: [], assignee: "agent", origin: "user", events: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: `2026-01-01T00:00:00.${String(index % 1000).padStart(3, "0")}Z`,
  } as Ticket;
}

function makePlan(index: number, steps: number, rand: () => number, fileCount: number): TaskPlan {
  const phases = [];
  const perPhase = 8;
  for (let p = 0; p < Math.ceil(steps / perPhase); p += 1) {
    phases.push({
      id: `ph-${p}`, title: `Phase ${p}`, status: "in_progress", files: [`pkg${(index + p) % 200}/src/file${Math.floor(rand() * fileCount)}.ts`],
      dependsOn: p > 0 ? [`ph-${p - 1}`] : [], blocks: [], docs: [], notes: [], linkedTodoIds: [], updatedAt: "",
      steps: Array.from({ length: Math.min(perPhase, steps - p * perPhase) }, (_, s) => ({
        id: `st-${s}`, title: `Step ${s}`, status: rand() < 0.4 ? "completed" : "pending", notes: [], updatedAt: "",
      })),
    });
  }
  return {
    id: `plan-${index}`, title: `Plan ${index}`, status: "active", phases, blocks: [], docs: [], agentCanArchive: false,
    executionApproved: true, notes: [], createdAt: "", updatedAt: `2026-01-01T00:00:00.000Z#${index}`,
  } as TaskPlan;
}

function makeReceipt(index: number, rand: () => number, ticketCount: number, fileCount: number): WorkReceipt {
  return buildReceipt({
    id: `r-${index}`,
    contract: { id: `wc-${index}`, schema: 1, enforcement: "observe" },
    subject: { ticketId: `T-${Math.floor(rand() * ticketCount)}` },
    facts: {
      ended: "ok", filesChanged: [{ path: `pkg${index % 200}/src/file${Math.floor(rand() * fileCount)}.ts`, change: "M" }],
      coverage: "tool_edits", outOfScope: [], checks: [], uncovered: [], failedFiles: [], missingOutputs: [], verificationRequired: false,
    },
    usage: { spendPartial: true, toolRounds: 1, elapsedMs: 1 },
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  });
}

function canonical(graph: WorkGraph): string {
  return JSON.stringify({ edges: graph.edges(), findings: graph.findings(), conflicts: graph.conflicts() });
}

describe("incremental updates", () => {
  it("always agree with a full rebuild, through a seeded sequence of edits", () => {
    const rand = random(42);
    const files = 400;
    const tickets: Ticket[] = Array.from({ length: 120 }, (_, i) => makeTicket(i, rand, 120, files));
    let plans: TaskPlan[] = Array.from({ length: 6 }, (_, i) => makePlan(i, 16, rand, files));
    const receipts: WorkReceipt[] = Array.from({ length: 40 }, (_, i) => makeReceipt(i, rand, 120, files));
    const sources = (): WorkGraphSources => ({ tickets: [...tickets], plans: [...plans], receipts: [...receipts] });
    const incremental = new WorkGraph();
    incremental.update(sources());
    let nextTicket = tickets.length;
    let nextReceipt = receipts.length;
    for (let edit = 0; edit < 150; edit += 1) {
      const roll = rand();
      if (roll < 0.25) {
        const i = Math.floor(rand() * tickets.length);
        tickets[i] = { ...tickets[i]!, status: STATUSES[Math.floor(rand() * STATUSES.length)]!, updatedAt: `edit-${edit}` };
      } else if (roll < 0.4) {
        const i = Math.floor(rand() * tickets.length);
        tickets[i] = { ...tickets[i]!, blockedBy: [...tickets[i]!.blockedBy, `T-${Math.floor(rand() * nextTicket)}`], updatedAt: `edit-${edit}` };
      } else if (roll < 0.5) {
        tickets.push(makeTicket(nextTicket, rand, nextTicket, files));
        nextTicket += 1;
      } else if (roll < 0.6 && tickets.length > 10) {
        tickets.splice(Math.floor(rand() * tickets.length), 1);
      } else if (roll < 0.8) {
        const p = Math.floor(rand() * plans.length);
        const plan = structuredClone(plans[p]!);
        const phase = plan.phases[Math.floor(rand() * plan.phases.length)]!;
        const step = phase.steps[Math.floor(rand() * phase.steps.length)]!;
        step.status = step.status === "completed" ? "pending" : "completed";
        plan.updatedAt = `edit-${edit}`;
        plans = plans.map((entry, index) => (index === p ? plan : entry));
      } else if (roll < 0.9) {
        receipts.push(makeReceipt(nextReceipt, rand, nextTicket, files));
        nextReceipt += 1;
      } else if (plans.length > 2) {
        plans = plans.filter((_, index) => index !== Math.floor(rand() * plans.length));
      }
      incremental.update(sources());
      const full = new WorkGraph();
      full.update(sources());
      expect(canonical(incremental), `after edit ${edit}`).toBe(canonical(full));
    }
  });

  it("rebuilds only what changed", () => {
    const rand = random(7);
    const tickets = Array.from({ length: 50 }, (_, i) => makeTicket(i, rand, 50, 100));
    const graph = new WorkGraph();
    expect(graph.update({ tickets, plans: [], receipts: [] }).rebuilt).toBe(50);
    expect(graph.update({ tickets, plans: [], receipts: [] }).rebuilt).toBe(0);
    tickets[3] = { ...tickets[3]!, status: "done", updatedAt: "later" };
    expect(graph.update({ tickets, plans: [], receipts: [] })).toMatchObject({ rebuilt: 1, removed: 0 });
    expect(graph.update({ tickets: tickets.slice(1), plans: [], receipts: [] })).toMatchObject({ rebuilt: 0, removed: 1 });
  });
});

describe("scale", () => {
  it("builds and answers over 10k tickets, 20k steps, 5k receipts and a 50k-file map", () => {
    const strict = process.env.WORK_GRAPH_PERF_STRICT === "1";
    const slack = strict ? 1 : 3;
    const rand = random(2026);
    const fileCount = 50_000;
    const mapFiles = new Set(Array.from({ length: fileCount }, (_, n) => `pkg${n % 200}/src/file${n}.ts`));
    const tickets = Array.from({ length: 10_000 }, (_, i) => makeTicket(i, rand, 10_000, fileCount));
    const plans = Array.from({ length: 500 }, (_, i) => makePlan(i, 40, rand, fileCount));
    const receipts = Array.from({ length: 5_000 }, (_, i) => makeReceipt(i, rand, 10_000, fileCount));
    const graph = new WorkGraph({ fileExists: (path) => mapFiles.has(path) });

    let started = performance.now();
    graph.update({ tickets, plans, receipts });
    const stats = graph.stats();
    const cold = performance.now() - started;

    // The median of several one-ticket edits: the first update after a cold build is still warming up.
    const samples: number[] = [];
    let result = graph.update({ tickets, plans, receipts });
    for (let edit = 0; edit < 7; edit += 1) {
      const index = 1234 + edit * 101;
      tickets[index] = { ...tickets[index]!, status: edit % 2 ? "done" : "in_progress", updatedAt: `changed-${edit}` };
      started = performance.now();
      result = graph.update({ tickets, plans, receipts });
      graph.stats();
      samples.push(performance.now() - started);
    }
    const incremental = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

    started = performance.now();
    const critical = graph.criticalPath();
    const criticalMs = performance.now() - started;

    started = performance.now();
    const findings = graph.findings();
    const findingsMs = performance.now() - started;

    started = performance.now();
    graph.trace("plan-42/ph-2/st-3");
    graph.blockers("T-9999");
    graph.impact("T-5000");
    const queriesMs = performance.now() - started;

    console.log(`[work-graph scale] nodes=${stats.nodes} edges=${stats.edges} cold=${cold.toFixed(0)}ms incremental=${incremental.toFixed(1)}ms `
      + `criticalPath=${criticalMs.toFixed(0)}ms (length ${critical.path.length}) findings=${findingsMs.toFixed(0)}ms (${findings.length}) queries=${queriesMs.toFixed(1)}ms`);
    expect(stats.nodes).toBeGreaterThan(30_000);
    expect(result).toMatchObject({ rebuilt: 1, removed: 0 });
    expect(critical.path.length).toBeGreaterThan(0);
    expect(cold).toBeLessThan(2_000 * slack);
    expect(incremental).toBeLessThan(25 * slack);
    expect(criticalMs).toBeLessThan(200 * slack);
  }, 120_000);
});
