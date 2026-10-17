import { describe, expect, it } from "vitest";
import {
  evaluateIntegration, sharedPath, type IntegrationCheck, type IntegrationInput, type TaskFacts,
} from "../../src/orchestration/integration-gate.js";

// Parallel work by default: every task's window overlaps every other's.
const task = (id: string, overrides: Partial<TaskFacts> = {}): TaskFacts => ({
  id, revision: `rev-${id}-1`, dependsOn: [], writes: [], verdict: "verified", window: { start: 0, end: 100 }, ...overrides,
});
const sig = (name: string) => `hash-${name}`;
const producerOf = (taskId: string, name: string, revision = `rev-${taskId}-1`, interfaceHash = sig(name)) =>
  ({ taskId, name, revision, interfaceHash });
const consumerOf = (taskId: string, name: string, expectedRevision = `rev-PRODUCER-1`, expectedInterfaceHash = sig(name)) =>
  ({ taskId, name, expectedRevision, expectedInterfaceHash });

const readinessOf = (result: ReturnType<typeof evaluateIntegration>, id: string) => result.readiness.find((entry) => entry.taskId === id)!;

describe("compatibility of consumed interfaces", () => {
  it("unblocks a consumer of a verified producer whose interface and revision it was checked against", () => {
    const result = evaluateIntegration({
      tasks: [task("api"), task("client", { dependsOn: ["api"] })],
      produced: [producerOf("api", "UserApi")],
      consumed: [consumerOf("client", "UserApi", "rev-api-1")],
    });
    expect(readinessOf(result, "client")).toMatchObject({ readiness: "ready", reasons: [] });
    expect(result.integrationRequired).toBe(false);
  });

  it("blocks an incompatible consumer without holding the producer or other consumers", () => {
    const result = evaluateIntegration({
      tasks: [task("api"), task("client"), task("other")],
      produced: [producerOf("api", "UserApi", "rev-api-2", "hash-changed")],
      consumed: [consumerOf("client", "UserApi", "rev-api-1", sig("UserApi")), consumerOf("other", "UserApi", "rev-api-2", "hash-changed")],
    });
    expect(readinessOf(result, "client")).toMatchObject({ readiness: "blocked", reasons: ["incompatible_interface: UserApi from api"] });
    expect(readinessOf(result, "other")).toMatchObject({ readiness: "ready" });
    expect(readinessOf(result, "api")).toMatchObject({ readiness: "ready" });
  });

  it("holds a consumer whose producer changed implementation but kept its interface until re-checked", () => {
    const result = evaluateIntegration({
      tasks: [task("api", { revision: "rev-api-2" }), task("client")],
      produced: [producerOf("api", "UserApi", "rev-api-2")],
      consumed: [consumerOf("client", "UserApi", "rev-api-1")],
    });
    expect(readinessOf(result, "client")).toMatchObject({ readiness: "waiting", reasons: ["producer_revision_moved: UserApi from api; re-check against rev-api-2"] });
  });

  it("waits for an unverified producer and for a producer nobody yet provides", () => {
    const unverified = evaluateIntegration({
      tasks: [task("api", { verdict: "insufficient_evidence" }), task("client")],
      produced: [producerOf("api", "UserApi")],
      consumed: [consumerOf("client", "UserApi")],
    });
    expect(readinessOf(unverified, "client").readiness).toBe("waiting");
    const missing = evaluateIntegration({
      tasks: [task("client")],
      produced: [],
      consumed: [consumerOf("client", "UserApi")],
    });
    expect(readinessOf(missing, "client")).toMatchObject({ readiness: "waiting", reasons: ["no_producer: UserApi"] });
  });

  it("blocks a consumer when more than one task claims the same interface name", () => {
    const result = evaluateIntegration({
      tasks: [task("a"), task("b"), task("client")],
      produced: [producerOf("a", "UserApi"), producerOf("b", "UserApi")],
      consumed: [consumerOf("client", "UserApi")],
    });
    expect(readinessOf(result, "client")).toMatchObject({ readiness: "blocked" });
    expect(readinessOf(result, "client").reasons[0]).toMatch(/^ambiguous_producer: UserApi from a, b$/);
  });

  it("flips readiness deterministically as a verified contract changes and changes back", () => {
    const base = (hash: string): IntegrationInput => ({
      tasks: [task("api"), task("client", { dependsOn: ["api"] })],
      produced: [producerOf("api", "UserApi", "rev-api-1", hash)],
      consumed: [consumerOf("client", "UserApi", "rev-api-1", sig("UserApi"))],
    });
    expect(readinessOf(evaluateIntegration(base(sig("UserApi"))), "client").readiness).toBe("ready");
    expect(readinessOf(evaluateIntegration(base("hash-v2")), "client").readiness).toBe("blocked");
    expect(readinessOf(evaluateIntegration(base(sig("UserApi"))), "client").readiness).toBe("ready");
  });
});

describe("dependencies", () => {
  it("treats an unknown dependency as blocked and a blocked one as blocking", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { dependsOn: ["ghost"] }), task("b", { dependsOn: ["c"] }), task("c", { verdict: "blocked" })],
      produced: [], consumed: [],
    });
    expect(readinessOf(result, "a")).toMatchObject({ readiness: "blocked", reasons: ["unknown_dependency: ghost"] });
    expect(readinessOf(result, "b")).toMatchObject({ readiness: "blocked", reasons: ["dependency_blocked: c"] });
  });

  it("waits, not blocks, on a dependency that needs rework", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { verdict: "rework_required" }), task("b", { dependsOn: ["a"] })],
      produced: [], consumed: [],
    });
    expect(readinessOf(result, "b")).toMatchObject({ readiness: "waiting", reasons: ["dependency_not_verified: a"] });
  });
});

describe("collisions on shared files", () => {
  const colliding = (): IntegrationInput => ({
    tasks: [
      task("a", { writes: ["src/shared.ts", "src/a.ts"] }),
      task("b", { writes: ["src/shared.ts"] }),
      task("c", { writes: ["docs/c.md"] }),
    ],
    produced: [], consumed: [],
  });

  it("holds both colliding tasks until an integration check runs, and leaves unrelated work alone", () => {
    const result = evaluateIntegration(colliding());
    expect(result.integrationRequired).toBe(true);
    expect(result.collisions).toEqual([{ taskIds: ["a", "b"], files: ["src/shared.ts"], state: "pending" }]);
    expect(readinessOf(result, "a")).toMatchObject({ readiness: "waiting", reasons: ["integration_pending: src/shared.ts"] });
    expect(readinessOf(result, "b").readiness).toBe("waiting");
    expect(readinessOf(result, "c").readiness).toBe("ready");
    expect(result.receipts[0]).toMatchObject({ taskIds: ["a", "b"], outcome: "pending", checkIds: [] });
  });

  it("releases the colliding tasks when a check passes at their current revisions", () => {
    const check: IntegrationCheck = { id: "chk-1", taskIds: ["a", "b"], revisions: { a: "rev-a-1", b: "rev-b-1" }, result: "passed" };
    const result = evaluateIntegration({ ...colliding(), checks: [check] });
    expect(result.integrationRequired).toBe(false);
    expect(readinessOf(result, "a").readiness).toBe("ready");
    expect(result.receipts[0]).toMatchObject({ outcome: "integrated", checkIds: ["chk-1"], files: ["src/shared.ts"] });
  });

  it("ignores a check that ran against an older revision of a colliding task", () => {
    const stale: IntegrationCheck = { id: "chk-old", taskIds: ["a", "b"], revisions: { a: "rev-a-0", b: "rev-b-1" }, result: "passed" };
    expect(evaluateIntegration({ ...colliding(), checks: [stale] }).integrationRequired).toBe(true);
  });

  it("does not settle a collision with a check that covers only one of the tasks", () => {
    const partial: IntegrationCheck = { id: "chk-a", taskIds: ["a"], revisions: { a: "rev-a-1" }, result: "passed" };
    expect(evaluateIntegration({ ...colliding(), checks: [partial] }).integrationRequired).toBe(true);
  });

  it("sends back only the tasks a failed integration names, and their consumers wait", () => {
    const failed: IntegrationCheck = { id: "chk-f", taskIds: ["a", "b"], revisions: { a: "rev-a-1", b: "rev-b-1" }, result: "failed" };
    const input: IntegrationInput = {
      ...colliding(),
      tasks: [...colliding().tasks, task("d", { dependsOn: ["a"] })],
      checks: [failed],
    };
    const result = evaluateIntegration(input);
    expect(readinessOf(result, "a")).toMatchObject({ readiness: "rework", targets: ["a", "b"] });
    expect(readinessOf(result, "b")).toMatchObject({ readiness: "rework", targets: ["a", "b"] });
    expect(readinessOf(result, "c")).toMatchObject({ readiness: "ready", reasons: [], targets: [] });
    expect(readinessOf(result, "d")).toMatchObject({ readiness: "waiting", reasons: ["dependency_not_verified: a"] });
    expect(result.receipts[0]).toMatchObject({ outcome: "rework" });
  });

  it("detects a directory write overlapping a file, and reports the concrete file", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { writes: ["src/"] }), task("b", { writes: ["src/parser/tokens.ts"] })],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([{ taskIds: ["a", "b"], files: ["src/parser/tokens.ts"], state: "pending" }]);
    expect(sharedPath("src/", "docs/x.md")).toBeUndefined();
    expect(sharedPath("src/parser/", "src/")).toBe("src/parser/");
  });

  it("joins tasks that collide through a chain of shared files into one collision", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { writes: ["x.ts"] }), task("b", { writes: ["x.ts", "y.ts"] }), task("c", { writes: ["y.ts"] })],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([{ taskIds: ["a", "b", "c"], files: ["x.ts", "y.ts"], state: "pending" }]);
  });

  it("gives the same answer and the same receipt IDs however the inputs are ordered", () => {
    const input: IntegrationInput = {
      tasks: [task("a", { writes: ["s.ts"] }), task("b", { writes: ["s.ts"] }), task("c", { dependsOn: ["a"] })],
      produced: [producerOf("a", "Api")],
      consumed: [consumerOf("c", "Api", "rev-a-1")],
      checks: [{ id: "chk", taskIds: ["a", "b"], revisions: { a: "rev-a-1", b: "rev-b-1" }, result: "passed" }],
    };
    const shuffled: IntegrationInput = {
      tasks: [...input.tasks].reverse(),
      produced: [...input.produced],
      consumed: [...input.consumed],
      checks: [...input.checks!],
    };
    expect(evaluateIntegration(shuffled)).toEqual(evaluateIntegration(input));
  });
});

describe("what counts as a collision", () => {
  it("does not treat sequential work in one working tree as a collision: the later task saw the change", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { writes: ["s.ts"], window: { start: 0, end: 10 } }), task("b", { writes: ["s.ts"], window: { start: 20, end: 30 } })],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([]);
    expect(result.integrationRequired).toBe(false);
  });

  it("does not treat work that depends on the other as a collision, even when it overlapped", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { writes: ["s.ts"] }), task("m", { dependsOn: ["a"] }), task("b", { writes: ["s.ts"], dependsOn: ["m"] })],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([]);
  });

  it("does not guess a collision when it is not known when the work ran", () => {
    const result = evaluateIntegration({
      tasks: [task("a", { writes: ["s.ts"], window: undefined }), task("b", { writes: ["s.ts"], window: undefined })],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([]);
  });

  it("treats work in its own copy as needing integration whenever it ran", () => {
    const result = evaluateIntegration({
      tasks: [
        task("a", { writes: ["s.ts"], window: { start: 0, end: 10 }, isolated: true }),
        task("b", { writes: ["s.ts"], window: { start: 20, end: 30 } }),
      ],
      produced: [], consumed: [],
    });
    expect(result.collisions).toEqual([{ taskIds: ["a", "b"], files: ["s.ts"], state: "pending" }]);
  });
});

describe("invalid input", () => {
  it("refuses duplicate tasks and interfaces that name a task that does not exist", () => {
    expect(() => evaluateIntegration({ tasks: [task("a"), task("a")], produced: [], consumed: [] })).toThrow(/Duplicate task a/);
    expect(() => evaluateIntegration({ tasks: [task("a")], produced: [producerOf("ghost", "Api")], consumed: [] })).toThrow(/unknown task ghost/);
    expect(() => evaluateIntegration({ tasks: [task("a")], produced: [], consumed: [consumerOf("ghost", "Api")] })).toThrow(/unknown task ghost/);
  });
});
