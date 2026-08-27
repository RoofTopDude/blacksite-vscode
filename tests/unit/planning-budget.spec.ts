import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlanningStore } from "../../src/planning-store.js";

let root: string;
let store: PlanningStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-plan-budget-"));
  store = new PlanningStore(root);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plan cost budgets", () => {
  it("warns at the configured threshold and pauses execution at the hard ceiling", async () => {
    const created = await store.dispatch("create", {
      title: "Budgeted work",
      executionApproved: true,
      maxUsd: 1,
      phases: [{ title: "Implementation", steps: [{ title: "Build it" }] }],
    }, { sessionId: "session-a", requestId: "request-a" }) as { planId: string };

    expect(store.recordSpendForSession("session-a", 0.79, false, 80).warningReached).toBe(false);
    expect(store.recordSpendForSession("session-a", 0.02, false, 80)).toMatchObject({
      planId: created.planId,
      spentUsd: 0.81,
      warningReached: true,
      exceededNow: false,
    });
    expect(store.recordSpendForSession("session-a", 0.20, false, 80).exceededNow).toBe(true);

    const plan = store.read().plans.find((entry) => entry.id === created.planId)!;
    expect(plan.budget).toMatchObject({ maxUsd: 1, spentUsd: 1.01, warned: true, exceeded: true });
    expect(plan.status).toBe("on_hold");
    expect(plan.executionApproved).toBe(false);
    expect(plan.notes.some((note) => note.includes("paused automatically"))).toBe(true);
  });

  it("attributes spend to the sole active budgeted plan when work continues in a new session", async () => {
    const created = await store.dispatch("create", {
      title: "Continued work",
      maxUsd: 2,
      phases: [{ title: "Implementation" }],
    }, { sessionId: "original-session" }) as { planId: string };

    expect(store.recordSpendForSession("new-session", 0.5, true)).toMatchObject({
      planId: created.planId,
      spentUsd: 0.5,
    });
    expect(store.read().plans[0]?.budget).toMatchObject({ spentUsd: 0.5, partial: true });
  });

  it("recalculates warning state when a budget is raised or cleared", async () => {
    const created = await store.dispatch("create", {
      title: "Adjustable budget",
      maxUsd: 1,
      phases: [{ title: "Implementation" }],
    }, { sessionId: "session-a" }) as { planId: string };
    store.recordSpendForSession("session-a", 0.9, false);

    store.setCostBudget(created.planId, 5);
    expect(store.read().plans[0]?.budget).toMatchObject({ maxUsd: 5, warned: false, exceeded: false });

    store.setCostBudget(created.planId, undefined);
    expect(store.read().plans[0]?.budget).toMatchObject({ maxUsd: undefined, warned: false, exceeded: false });
  });

  it("rejects non-finite budget values instead of silently turning them into a maximum", async () => {
    await store.dispatch("create", {
      title: "Finite only",
      maxUsd: Number.POSITIVE_INFINITY,
      phases: [{ title: "Implementation" }],
    }, { sessionId: "session-a" });

    expect(store.read().plans[0]?.budget).toBeUndefined();
  });
});
