import { describe, expect, it } from "vitest";
import {
  analyzeQueue,
  estimateLoopCost,
  proposeLoop,
  recommendConcurrency,
} from "../../src/loops/loop-proposal.js";
import { defaultQueueSpec } from "../../src/loops/loop-model.js";
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
    acceptanceCriteria: ["it works"],
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

const INDEX = ["src/A.ts", "src/B.ts", "src/C.ts", "src/shared.ts"];
const SPEC = defaultQueueSpec();

describe("estimateLoopCost", () => {
  it("scales with complexity tier", () => {
    const cheap = estimateLoopCost([ticket("A", { complexity: "small" })]);
    const dear = estimateLoopCost([ticket("A", { complexity: "large" })]);
    expect(dear.usd).toBeGreaterThan(cheap.usd);
    expect(dear.byTier.deep).toBe(1);
  });

  it("reports a worst case that accounts for retries", () => {
    // An estimate that reads low is far worse than one that reads high when the user is
    // deciding whether to leave this running overnight.
    const estimate = estimateLoopCost([ticket("A"), ticket("B")], 2);
    expect(estimate.worstCaseUsd).toBeCloseTo(estimate.usd * 2, 5);
  });

  it("treats an untriaged ticket as the cheapest tier rather than crashing", () => {
    const estimate = estimateLoopCost([ticket("A", { complexity: undefined as never })]);
    expect(estimate.byTier.standard).toBe(1);
    expect(estimate.usd).toBeGreaterThan(0);
  });

  it("says plainly that it is an order of magnitude, not a quote", () => {
    expect(estimateLoopCost([ticket("A")]).basis).toContain("order of magnitude");
  });
});

describe("recommendConcurrency", () => {
  it("never recommends more workers than can actually run side by side", () => {
    // Recommending 4 for a queue where everything collides reads as a promise of speed the
    // territory lock will not deliver.
    expect(recommendConcurrency(1, 8)).toMatchObject({ concurrency: 1 });
    expect(recommendConcurrency(1, 8).basis).toContain("would idle");
  });

  it("caps the recommendation regardless of how wide the queue is", () => {
    expect(recommendConcurrency(50, 50).concurrency).toBe(4);
  });

  it("recommends sequential for a single ticket", () => {
    expect(recommendConcurrency(1, 1)).toMatchObject({ concurrency: 1 });
  });
});

describe("analyzeQueue", () => {
  it("flags tickets with no acceptance criteria", () => {
    const concerns = analyzeQueue([ticket("A", { acceptanceCriteria: [] })], SPEC, INDEX);
    const found = concerns.find((c) => c.kind === "no_acceptance_criteria");
    expect(found?.ticketIds).toEqual(["A"]);
    expect(found?.suggestion).toContain("cannot judge");
  });

  it("explains that an untenanted ticket defeats concurrency", () => {
    const concerns = analyzeQueue([ticket("A", { territory: { files: [], areas: [] } })], SPEC, INDEX);
    const found = concerns.find((c) => c.kind === "untenanted");
    expect(found).toBeTruthy();
    expect(found!.suggestion).toContain("conflicts with everything");
  });

  it("reports colliding territory as serialization, not as an error", () => {
    const concerns = analyzeQueue([
      ticket("A", { territory: { files: ["src/shared.ts"], areas: [] } }),
      ticket("B", { territory: { files: ["src/shared.ts"], areas: [] } }),
    ], SPEC, INDEX);
    const found = concerns.find((c) => c.kind === "territory_collision");
    expect(found?.suggestion).toContain("Not an error");
  });

  it("distinguishes a blocker inside the queue from one the loop can never work", () => {
    // The second is the one that matters: the loop will end "blocked" with real work left.
    const inQueue = analyzeQueue([
      ticket("A"),
      ticket("B", { blockedBy: ["A"] }),
    ], SPEC, INDEX);
    expect(inQueue.find((c) => c.kind === "blocked_by_open")).toBeTruthy();

    const outside = analyzeQueue([
      ticket("B", { blockedBy: ["Z"] }),
      ticket("Z", { status: "in_progress" }),
    ], SPEC, INDEX);
    const found = outside.find((c) => c.kind === "unblockable");
    expect(found).toBeTruthy();
    expect(found!.suggestion).toContain("cannot unblock these");
  });

  it("raises duplicate titles as a question rather than acting on them", () => {
    const concerns = analyzeQueue([
      ticket("A", { title: "Fix the login bug" }),
      ticket("B", { title: "fix the login bug!" }),
    ], SPEC, INDEX);
    const found = concerns.find((c) => c.kind === "possible_duplicate");
    expect(found?.ticketIds.sort()).toEqual(["A", "B"]);
    expect(found!.suggestion).toContain("territory locking cannot catch");
  });

  it("is quiet about a well-formed queue", () => {
    const concerns = analyzeQueue([ticket("A"), ticket("B")], SPEC, INDEX);
    expect(concerns).toEqual([]);
  });
});

describe("proposeLoop", () => {
  it("reports what would run first and what would wait, with a cost", () => {
    const proposal = proposeLoop([
      ticket("A"),
      ticket("B"),
      ticket("C", { territory: { files: ["src/A.ts"], areas: [] } }),
    ], SPEC, INDEX);

    expect(proposal.matchedTicketIds.sort()).toEqual(["A", "B", "C"]);
    expect(proposal.withheld.find((entry) => entry.ticketId === "C")).toMatchObject({ reason: "territory" });
    expect(proposal.firstWave.length).toBeGreaterThan(0);
    expect(proposal.estimate.usd).toBeGreaterThan(0);
  });

  it("recommends a concurrency the territory can actually sustain", () => {
    const colliding = [
      ticket("A", { territory: { files: ["src/shared.ts"], areas: [] } }),
      ticket("B", { territory: { files: ["src/shared.ts"], areas: [] } }),
      ticket("C", { territory: { files: ["src/shared.ts"], areas: [] } }),
    ];
    expect(proposeLoop(colliding, SPEC, INDEX).recommendedConcurrency).toBe(1);
  });

  it("matches nothing when the queue is empty", () => {
    const proposal = proposeLoop([], SPEC, INDEX);
    expect(proposal.matchedTicketIds).toEqual([]);
    expect(proposal.estimate.usd).toBe(0);
    expect(proposal.recommendedConcurrency).toBe(1);
  });
});
