/**
 * Artifact-aware integration (#21): decides which dependent work may advance, from whether the
 * artifacts it consumes are compatible with what was actually produced, and where parallel work
 * collided on the same files, what integration has to settle before anyone builds on it.
 *
 * Pure. The host supplies facts it already holds: the verification verdict for each task (#18),
 * the interfaces each task produced and consumed (exchange references, #17), the files each task
 * wrote, and any integration checks run against exact revisions. The output is a readiness for
 * each task, and a receipt for each collision. It never merges, edits, reruns a check, or closes a
 * ticket.
 *
 * Rules that hold throughout:
 *  - A consumer is judged against the producer's current revision and interface. A changed
 *    interface blocks the consumer. A changed implementation with the same interface holds it
 *    until the consumer is re-checked.
 *  - Two tasks collide only when they wrote the same file and neither could have seen the other's
 *    change: neither depends on the other, even indirectly, and they either ran at the same time in
 *    one working tree or one of them ran in its own copy. A task that builds on another's result in
 *    the same tree is ordinary sequential work, not a collision.
 *  - A collision holds the colliding tasks until a check that ran against their current revisions
 *    passes. A check on older revisions is ignored, never reused.
 *  - A failed integration sends back only the tasks it names. Unrelated work keeps its readiness.
 */

import { createHash } from "node:crypto";
import type { VerificationVerdict } from "./verification-lane.js";

export interface TaskFacts {
  id: string;
  /** The revision of this task's work: a receipt hash or a commit. A check must name it to count. */
  revision: string;
  /** Tasks whose outcome this one needs, whatever interface they produce. */
  dependsOn: readonly string[];
  /** Files, or directory prefixes ending in "/", this task wrote. */
  writes: readonly string[];
  /** The verification lane's verdict, or undefined while none exists. */
  verdict?: VerificationVerdict;
  /** When the work ran, epoch ms. Two tasks in one working tree collide only if these overlap. */
  window?: { start: number; end: number };
  /** The work ran in its own copy (a worktree), so it has to be merged back whenever it ran. */
  isolated?: boolean;
}

export interface ProducedInterface {
  taskId: string;
  name: string;
  /** The revision of the producing work that yields this interface. */
  revision: string;
  /** Hash of the interface contract itself: signatures, schema, shape. */
  interfaceHash: string;
}

export interface ConsumedInterface {
  taskId: string;
  name: string;
  /** The producer revision the consumer was last checked against. */
  expectedRevision: string;
  expectedInterfaceHash: string;
}

export interface IntegrationCheck {
  id: string;
  /** Tasks whose collision this check covers. */
  taskIds: readonly string[];
  /** The revision of each covered task that the check ran against. */
  revisions: Readonly<Record<string, string>>;
  result: "passed" | "failed";
}

export interface IntegrationInput {
  tasks: readonly TaskFacts[];
  produced: readonly ProducedInterface[];
  consumed: readonly ConsumedInterface[];
  checks?: readonly IntegrationCheck[];
}

export type Readiness = "ready" | "waiting" | "blocked" | "rework";

export interface TaskReadiness {
  taskId: string;
  readiness: Readiness;
  /** Machine-readable reasons, the first one decisive. Empty when ready. */
  reasons: string[];
  /** For rework: the tasks that must be sent back together. */
  targets: string[];
}

export interface WriteCollision {
  taskIds: string[];
  files: string[];
  /** Pending until a fresh check settles it. */
  state: "pending" | "integrated" | "rework";
  checkId?: string;
}

export interface IntegrationReceipt {
  id: string;
  taskIds: string[];
  revisions: Array<{ taskId: string; revision: string }>;
  files: string[];
  checkIds: string[];
  outcome: WriteCollision["state"];
}

export interface IntegrationDecision {
  readiness: TaskReadiness[];
  collisions: WriteCollision[];
  integrationRequired: boolean;
  receipts: IntegrationReceipt[];
}

const RANK: Record<Readiness, number> = { ready: 0, waiting: 1, blocked: 2, rework: 3 };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort(byText);

/** The concrete path two write entries share, or undefined when they touch different files. */
export function sharedPath(a: string, b: string): string | undefined {
  if (a === b) return a;
  if (a.endsWith("/") && b.startsWith(a)) return b;
  if (b.endsWith("/") && a.startsWith(b)) return a;
  return undefined;
}

/** Whether either task depends on the other, directly or through a chain of dependencies. */
function orderedBy(tasks: Map<string, TaskFacts>): (a: string, b: string) => boolean {
  const reach = new Map<string, Set<string>>();
  const reachable = (from: string): Set<string> => {
    const cached = reach.get(from);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(tasks.get(from)?.dependsOn ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(tasks.get(next)?.dependsOn ?? []));
    }
    reach.set(from, seen);
    return seen;
  };
  return (a, b) => reachable(a).has(b) || reachable(b).has(a);
}

/** Could either task have written over the other without seeing its change? */
function couldOverwrite(a: TaskFacts, b: TaskFacts): boolean {
  if (a.isolated || b.isolated) return true;
  if (!a.window || !b.window) return false;
  return a.window.start < b.window.end && b.window.start < a.window.end;
}

/**
 * Collisions are connected sets of tasks: two tasks that share a file, and could not have seen each
 * other's change, are in one collision, and so is any task linked to them through another shared
 * file. Each set names every file it shares.
 */
function findCollisions(tasks: readonly TaskFacts[], ordered: (a: string, b: string) => boolean): Array<{ taskIds: string[]; files: string[] }> {
  const parent = new Map(tasks.map((task) => [task.id, task.id] as const));
  const root = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current)!;
    parent.set(id, current);
    return current;
  };
  const pairs: Array<{ a: string; b: string; files: string[] }> = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (ordered(a.id, b.id) || !couldOverwrite(a, b)) continue;
      const files = sortedUnique(a.writes.flatMap((left) => b.writes.map((right) => sharedPath(left, right)).filter((file): file is string => file !== undefined)));
      if (files.length === 0) continue;
      pairs.push({ a: a.id, b: b.id, files });
      parent.set(root(a.id), root(b.id));
    }
  }
  const groups = new Map<string, { taskIds: Set<string>; files: Set<string> }>();
  for (const pair of pairs) {
    const key = root(pair.a);
    const group = groups.get(key) ?? { taskIds: new Set<string>(), files: new Set<string>() };
    group.taskIds.add(pair.a);
    group.taskIds.add(pair.b);
    pair.files.forEach((file) => group.files.add(file));
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ taskIds: sortedUnique(group.taskIds), files: sortedUnique(group.files) }))
    .sort((x, y) => byText(x.taskIds.join("\n"), y.taskIds.join("\n")));
}

/** A check counts only when it covers every colliding task at that task's current revision. */
function settlingCheck(taskIds: string[], revisionOf: Map<string, string>, checks: readonly IntegrationCheck[]): IntegrationCheck | undefined {
  const matching = checks
    .filter((check) => taskIds.every((id) => check.taskIds.includes(id) && check.revisions[id] === revisionOf.get(id)))
    .sort((a, b) => byText(a.id, b.id));
  return matching[matching.length - 1];
}

function receiptId(payload: Omit<IntegrationReceipt, "id">): string {
  return `integration_${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function evaluateIntegration(input: IntegrationInput): IntegrationDecision {
  const tasks = new Map<string, TaskFacts>();
  for (const task of input.tasks) {
    if (tasks.has(task.id)) throw new Error(`Duplicate task ${task.id}`);
    tasks.set(task.id, task);
  }
  const requireKnown = (id: string, what: string) => {
    if (!tasks.has(id)) throw new Error(`${what} names unknown task ${id}`);
  };
  input.produced.forEach((item) => requireKnown(item.taskId, "Produced interface"));
  input.consumed.forEach((item) => requireKnown(item.taskId, "Consumed interface"));
  const checks = input.checks ?? [];
  const revisionOf = new Map([...tasks].map(([id, task]) => [id, task.revision] as const));

  const collisions: WriteCollision[] = findCollisions(input.tasks, orderedBy(tasks)).map((found) => {
    const check = settlingCheck(found.taskIds, revisionOf, checks);
    const state: WriteCollision["state"] = !check ? "pending" : check.result === "passed" ? "integrated" : "rework";
    return { ...found, state, ...(check ? { checkId: check.id } : {}) };
  });

  // Which collision holds each task. A failed one outranks a pending one.
  const heldBy = new Map<string, WriteCollision>();
  const sendBack = new Map<string, Set<string>>();
  for (const collision of collisions) {
    if (collision.state === "integrated") continue;
    for (const id of collision.taskIds) {
      if (collision.state === "rework") {
        sendBack.set(id, new Set([...(sendBack.get(id) ?? []), ...collision.taskIds]));
        heldBy.set(id, collision);
      } else if (!heldBy.has(id)) {
        heldBy.set(id, collision);
      }
    }
  }

  // A producer's output is usable only when verified and not held by an unsettled collision.
  const usable = (id: string): boolean => tasks.get(id)?.verdict === "verified" && !heldBy.has(id);

  const readiness: TaskReadiness[] = input.tasks.map((task) => {
    const out: TaskReadiness = { taskId: task.id, readiness: "ready", reasons: [], targets: [] };
    const hold = (level: Readiness, reason: string) => {
      if (RANK[level] > RANK[out.readiness]) out.readiness = level;
      out.reasons.push(reason);
    };

    const collision = heldBy.get(task.id);
    if (collision?.state === "rework") {
      hold("rework", `integration_failed: ${collision.files.slice(0, 8).join(", ")}`);
      out.targets = sortedUnique(sendBack.get(task.id) ?? []);
    } else if (collision) {
      hold("waiting", `integration_pending: ${collision.files.slice(0, 8).join(", ")}`);
    }

    for (const dependency of task.dependsOn) {
      const upstream = tasks.get(dependency);
      if (!upstream) hold("blocked", `unknown_dependency: ${dependency}`);
      else if (upstream.verdict === "blocked") hold("blocked", `dependency_blocked: ${dependency}`);
      else if (!usable(dependency)) hold("waiting", `dependency_not_verified: ${dependency}`);
    }

    for (const consumed of input.consumed.filter((item) => item.taskId === task.id)) {
      const producers = input.produced.filter((item) => item.name === consumed.name);
      if (producers.length === 0) {
        hold("waiting", `no_producer: ${consumed.name}`);
      } else if (producers.length > 1) {
        hold("blocked", `ambiguous_producer: ${consumed.name} from ${sortedUnique(producers.map((item) => item.taskId)).join(", ")}`);
      } else {
        const producer = producers[0]!;
        if (producer.interfaceHash !== consumed.expectedInterfaceHash) {
          // Incompatible APIs never unblock the consumer, whatever the producer claims.
          hold("blocked", `incompatible_interface: ${consumed.name} from ${producer.taskId}`);
        } else if (producer.revision !== consumed.expectedRevision) {
          hold("waiting", `producer_revision_moved: ${consumed.name} from ${producer.taskId}; re-check against ${producer.revision}`);
        } else if (!usable(producer.taskId)) {
          hold("waiting", `producer_not_usable: ${producer.taskId}`);
        }
      }
    }
    return out;
  }).sort((a, b) => byText(a.taskId, b.taskId));

  const receipts: IntegrationReceipt[] = collisions.map((collision) => {
    const payload: Omit<IntegrationReceipt, "id"> = {
      taskIds: collision.taskIds,
      revisions: collision.taskIds.map((taskId) => ({ taskId, revision: revisionOf.get(taskId)! })),
      files: collision.files,
      checkIds: collision.checkId ? [collision.checkId] : [],
      outcome: collision.state,
    };
    return { id: receiptId(payload), ...payload };
  }).sort((a, b) => byText(a.id, b.id));

  return {
    readiness,
    collisions,
    integrationRequired: collisions.some((collision) => collision.state === "pending"),
    receipts,
  };
}
