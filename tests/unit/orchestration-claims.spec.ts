/* #19 mutation-time concurrency claims: the registry, a lane's and the main session's view of it,
   the editor wrapper, what reaches a receipt, and two real lanes writing one file. See
   docs/orchestration-p1-implementation-plan.md §4. Path tests pin case folding explicitly, so
   they mean the same on Windows and on the Linux CI runner. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolUseBlock } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { createClaimEditProvider } from "../../src/orchestration/claims/edit-claims.js";
import { ClaimRegistry, type ClaimHolder } from "../../src/orchestration/claims/registry.js";
import { LaneClaims, MainSessionClaims, type WorkingTreeState } from "../../src/orchestration/claims/session-claims.js";
import { parsePorcelainZ } from "../../src/orchestration/claims/working-tree.js";
import type { SignalDraft } from "../../src/orchestration/signals/model.js";
import { buildReceipt } from "../../src/orchestration/work-receipt.js";
import type { EditProvider } from "../../src/diff-edit-service.js";
import type { EditApprovalRequest } from "../../src/workspace-edit-applier.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

let clock = 0;
const now = () => clock;
const holder = (id: string, ticketId?: string): ClaimHolder => ({ id, laneId: id, label: `Lane ${id}`, ...(ticketId ? { ticketId } : {}) });
const relative = (file: string) => file.replace(/\\/g, "/");

function lane(registry: ClaimRegistry, id: string, mode: "observe" | "enforce" = "enforce", workingTree?: () => Promise<WorkingTreeState | undefined>) {
  const signals: SignalDraft[] = [];
  const claims = new LaneClaims({
    registry, holder: holder(id, `BLK-${id}`), mode: () => mode, sink: { emit: (signal) => signals.push(signal) },
    toRelative: relative, ...(workingTree ? { workingTree } : {}),
  });
  return { claims, signals };
}

describe("claim registry", () => {
  it("claims every path or none, and names who holds what", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    expect(registry.acquire(holder("a"), ["src/x.ts", "src/y.ts"]).ok).toBe(true);
    const refused = registry.acquire(holder("b"), ["src/z.ts", "src/y.ts"]);
    expect(refused).toEqual({ ok: false, conflicts: [{ path: "src/y.ts", holder: holder("a") }] });
    // Nothing of the refused call was taken.
    expect(registry.holderOf("src/z.ts")).toBeUndefined();
    expect(registry.acquire(holder("a"), ["src/y.ts"]).ok).toBe(true);
  });

  it("treats a directory claim as covering everything under it, both ways round", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    registry.acquire(holder("a"), ["src/lib"], { prefix: true });
    expect(registry.acquire(holder("b"), ["src/lib/deep/file.ts"]).ok).toBe(false);
    expect(registry.acquire(holder("b"), ["src/library.ts"]).ok).toBe(true);
    const other = new ClaimRegistry({ now, caseInsensitive: false });
    other.acquire(holder("a"), ["src/lib/one.ts"]);
    expect(other.acquire(holder("b"), ["src/lib"], { prefix: true }).ok).toBe(false);
  });

  it("folds case only where the platform does", () => {
    const folding = new ClaimRegistry({ now, caseInsensitive: true });
    folding.acquire(holder("a"), ["src/App.ts"]);
    expect(folding.acquire(holder("b"), ["src/app.ts"]).ok).toBe(false);
    const exact = new ClaimRegistry({ now, caseInsensitive: false });
    exact.acquire(holder("a"), ["src/App.ts"]);
    expect(exact.acquire(holder("b"), ["src/app.ts"]).ok).toBe(true);
    expect(folding.key(".\\src\\App.ts\\")).toBe("src/app.ts");
  });

  it("lets a claim lapse when its holder goes quiet, and caps how long any claim lives (AC 4)", () => {
    clock = 0;
    const registry = new ClaimRegistry({ now, caseInsensitive: false, leaseMs: 1000, maxLeaseMs: 5000 });
    registry.acquire(holder("a"), ["f"]);
    clock = 900;
    registry.renew("a");
    clock = 1800;
    expect(registry.acquire(holder("b"), ["f"]).ok).toBe(false);
    clock = 3000;
    expect(registry.acquire(holder("b"), ["f"]).ok).toBe(true);
    clock = 3500;
    for (let t = 3500; t <= 9000; t += 500) { clock = t; registry.renew("b"); }
    expect(registry.acquire(holder("c"), ["f"]).ok).toBe(true);
  });

  it("releases everything a holder had", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    registry.acquire(holder("a"), ["f", "g"]);
    registry.release("a");
    expect(registry.held().size).toBe(0);
  });

  it("marks shell commands that ran alongside another lane's as ambiguous", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    registry.beginShell("a");
    expect(registry.endShell("a")).toBe(false);
    registry.beginShell("a");
    registry.beginShell("b");
    expect(registry.endShell("b")).toBe(true);
    expect(registry.endShell("a")).toBe(true);
  });

  it("holds its invariants over random interleavings of four lanes and twenty files (stress)", () => {
    let seed = 7;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    const violations: string[] = [];
    for (let run = 0; run < 500; run += 1) {
      clock = 0;
      const registry = new ClaimRegistry({ now, caseInsensitive: false, leaseMs: 50 });
      const holders = ["a", "b", "c", "d"].map((id) => holder(id));
      const owned = new Map<string, Set<string>>(holders.map((entry) => [entry.id, new Set()]));
      for (let step = 0; step < 40; step += 1) {
        clock += Math.floor(random() * 10);
        const who = holders[Math.floor(random() * holders.length)]!;
        const roll = random();
        if (roll < 0.1) {
          registry.release(who.id);
          owned.get(who.id)!.clear();
          continue;
        }
        const paths = Array.from({ length: 1 + Math.floor(random() * 3) }, () => `f${Math.floor(random() * 20)}`);
        const result = registry.acquire(who, paths);
        if (result.ok) for (const file of paths) owned.get(who.id)!.add(file);
        // Invariants: no path has two live holders, and whatever a holder holds, it acquired.
        // Checked as plain conditions so the run stays fast under coverage; reported once below.
        const seen = new Set<string>();
        for (const claim of holders.flatMap((entry) => registry.claimsOf(entry.id))) {
          if (seen.has(claim.key)) violations.push(`run ${run} step ${step}: ${claim.key} held twice`);
          seen.add(claim.key);
          if (!owned.get(claim.holder.id)!.has(claim.key)) violations.push(`run ${run} step ${step}: ${claim.holder.id} holds ${claim.key} unacquired`);
        }
      }
      for (const entry of holders) registry.release(entry.id);
      if (registry.held().size !== 0) violations.push(`run ${run}: claims left after release`);
    }
    expect(violations).toEqual([]);
  }, 30_000);
});

describe("a lane's claims", () => {
  it("refuses a write into a file another lane holds, naming it, and signals the collision (AC 1)", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    const a = lane(registry, "1");
    const b = lane(registry, "2");
    expect(a.claims.beforeWrite("file_edit", ["src/x.ts"])).toEqual({ ok: true });
    const refused = b.claims.beforeWrite("file_edit", ["src/x.ts"]);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("BLK-1's lane");
    expect(b.signals).toEqual([expect.objectContaining({ kind: "contract_conflict", taskId: "ticket:BLK-2", provenance: { source: "host", observer: "claims" } })]);
    expect([...b.claims.conflicts]).toEqual(["src/x.ts"]);
  });

  it("records but allows the same collision when only observing", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    lane(registry, "1", "observe").claims.beforeWrite("file_edit", ["src/x.ts"]);
    const b = lane(registry, "2", "observe");
    expect(b.claims.beforeWrite("file_edit", ["src/x.ts"])).toEqual({ ok: true });
    expect(b.signals[0]?.data).toMatchObject({ refused: false });
  });

  it("refuses to overwrite a file another lane changed after this one read it, but leaves anchored edits alone", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    const a = lane(registry, "1");
    const b = lane(registry, "2");
    a.claims.noteRead(["src/x.ts"]);
    b.claims.beforeWrite("file_edit", ["src/x.ts"]);
    b.claims.afterWrite(["src/x.ts"]);
    b.claims.release();
    const overwrite = a.claims.beforeWrite("file_write", ["src/x.ts"]);
    expect(overwrite.ok).toBe(false);
    expect(!overwrite.ok && overwrite.error).toContain("Read it again");
    // An anchored edit verifies its own anchor text against the file; it fails safely by itself.
    expect(a.claims.beforeWrite("file_edit", ["src/x.ts"]).ok).toBe(true);
    // Once re-read, the overwrite is fine.
    a.claims.noteRead(["src/x.ts"]);
    expect(a.claims.beforeWrite("file_write", ["src/x.ts"]).ok).toBe(true);
  });

  it("never stands in the way of reading (AC 3)", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    lane(registry, "1").claims.beforeWrite("file_edit", ["src/x.ts"]);
    const reader = lane(registry, "2");
    reader.claims.noteRead(["src/x.ts"]);
    reader.claims.touch();
    expect(reader.signals).toEqual([]);
    expect(registry.claimsOf("2")).toEqual([]);
  });

  it("attributes what its own shell command changed, and flags a file another lane holds", async () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    lane(registry, "1").claims.beforeWrite("file_edit", ["src/held.ts"]);
    const trees: WorkingTreeState[] = [new Map([["src/old.ts", "M|1:1"]]), new Map([["src/old.ts", "M|1:1"], ["src/held.ts", "M|2:2"], ["gen/out.js", "??|3:3"]])];
    const b = lane(registry, "2", "enforce", async () => trees.shift());
    await b.claims.beforeShell();
    await b.claims.afterShell();
    expect([...b.claims.shellChanged].sort()).toEqual(["gen/out.js", "src/held.ts"]);
    expect([...b.claims.conflicts]).toEqual(["src/held.ts"]);
    expect(b.signals[0]).toMatchObject({ kind: "contract_conflict", provenance: { observer: "shell_delta" } });
    expect(b.claims.shellCovered).toBe(true);
    expect(registry.lastWriter("gen/out.js")).toBe("2");
  });

  it("does not guess when two lanes' commands ran at once", async () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    const trees: WorkingTreeState[] = [new Map(), new Map([["src/a.ts", "M|1:1"]])];
    const a = lane(registry, "1", "enforce", async () => trees.shift());
    await a.claims.beforeShell();
    registry.beginShell("2");
    await a.claims.afterShell();
    expect([...a.claims.unattributed]).toEqual(["src/a.ts"]);
    expect([...a.claims.shellChanged]).toEqual([]);
  });

  it("says shell writes were not covered when the tree could not be read", async () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    const a = lane(registry, "1", "enforce", async () => undefined);
    await a.claims.beforeShell();
    await a.claims.afterShell();
    expect(a.claims.shellCovered).toBe(false);
  });
});

describe("the main session's claims (D8)", () => {
  it("warns when it writes where a lane is working, never refuses, and makes the lane's copy stale", () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    const worker = lane(registry, "1");
    worker.claims.noteRead(["src/x.ts"]);
    worker.claims.beforeWrite("file_edit", ["src/x.ts"]);
    worker.claims.afterWrite(["src/x.ts"]);
    const main = new MainSessionClaims(registry, () => "enforce", relative);
    const checked = main.beforeWrite("file_write", ["src/x.ts"]);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.warning).toContain("BLK-1's lane");
    main.afterWrite(["src/x.ts"]);
    const stale = worker.claims.beforeWrite("file_write", ["src/x.ts"]);
    expect(!stale.ok && stale.error).toContain("your chat agent");
  });
});

describe("claims at the editor boundary", () => {
  function edit(claims: LaneClaims, autoApprove: boolean, inner?: (request: EditApprovalRequest) => Promise<"apply" | "all" | "reject" | null>) {
    let decision: unknown;
    const delegate: EditProvider = {
      applyEdit: async (_input, options) => {
        decision = await options.approvalProvider!({ summary: "s", fileCount: 1, paths: ["src/renamed.ts"] });
        return { ok: true } as never;
      },
      applyBatchEdits: async () => ({ ok: true }) as never,
      applyJsonEdit: async () => ({ ok: true }) as never,
    };
    const wrapped = createClaimEditProvider(delegate, claims);
    return async () => {
      await wrapped.applyEdit({} as never, { autoApprove, ...(inner ? { approvalProvider: inner } : {}) } as never);
      return decision;
    };
  }

  it("rejects an edit landing in a held file, and otherwise keeps the caller's own decision", async () => {
    const registry = new ClaimRegistry({ now, caseInsensitive: false });
    lane(registry, "1").claims.beforeWrite("code_rename", ["src/renamed.ts"]);
    expect(await edit(lane(registry, "2").claims, true)()).toBe("reject");
    const free = new ClaimRegistry({ now, caseInsensitive: false });
    expect(await edit(lane(free, "2").claims, true)()).toBe("apply");
    const inner = vi.fn(async () => "all" as const);
    const asking = new ClaimRegistry({ now, caseInsensitive: false });
    expect(await edit(lane(asking, "3").claims, false, inner)()).toBe("all");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("claims on a receipt", () => {
  const base = (enforcement: "observe" | "enforce", extra: Record<string, unknown> = {}) => buildReceipt({
    id: "r", contract: { id: "wc", schema: 1, enforcement }, subject: {}, createdAt: "t",
    usage: { spendPartial: false, toolRounds: 1, elapsedMs: 1 },
    facts: {
      ended: "ok", filesChanged: [{ path: "src/a.ts", change: "M" }], coverage: "tool_edits+shell_delta", outOfScope: [],
      checks: [], uncovered: [], failedFiles: [], missingOutputs: [], verificationRequired: false, ...extra,
    },
  });

  it("sends work that collided with another lane back rather than to review, under enforcement only", () => {
    const enforced = base("enforce", { conflicts: ["src/a.ts"] });
    expect(enforced.status).toBe("partial");
    expect(enforced.basis).toEqual(["concurrent_write"]);
    expect(enforced.observed.conflicts).toEqual(["src/a.ts"]);
    expect(base("observe", { conflicts: ["src/a.ts"] }).status).toBe("succeeded_unverified");
    expect(base("enforce").observed.coverage).toBe("tool_edits+shell_delta");
  });

  it("records unattributed changes without blaming the lane", () => {
    const receipt = base("enforce", { unattributed: ["src/b.ts"] });
    expect(receipt.status).toBe("succeeded_unverified");
    expect(receipt.observed.unattributed).toEqual(["src/b.ts"]);
  });
});

describe("git status parsing", () => {
  it("reads porcelain v1 -z, renames included", () => {
    const parsed = parsePorcelainZ(" M src/a.ts\0?? new file.txt\0R  src/new.ts\0src/old.ts\0");
    expect([...parsed]).toEqual([["src/a.ts", " M"], ["new file.txt", "??"], ["src/new.ts", "R "]]);
  });
});

// ── Two real lanes ─────────────────────────────────────────────────────────

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function laneSession(root: string, claims: LaneClaims, calls: ToolUseBlock[]) {
  const writes: string[] = [];
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => {
      if (message.type === "system.write_file") {
        const file = String(message.payload.path);
        writes.push(file);
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), String(message.payload.content ?? ""));
        return { result: { ok: true, path: file, relativePath: file, created: false, sizeBytes: 1 } };
      }
      return { result: { ok: true } };
    }),
  };
  const values = new Map<string, unknown>();
  const scripted = new ScriptedProviderSession(({ turnIndex }) => (
    turnIndex === 0 ? { toolCalls: calls, stopReason: "tool_use", usage } : { text: "Done.", stopReason: "end_turn", usage }
  ));
  const session = new AgentSession({
    apiKey: "key", model: "claude-sonnet-4-6", systemPrompt: "test", workspaceRoot: root, runtime: runtime as never,
    context: { workspaceState: { get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback), update: async (key: string, value: unknown) => { values.set(key, value); } } } as never,
    provider: "anthropic", maxIterations: 4, checkpointingEnabled: false,
    approvalProvider: async () => "allow", delegatedLane: true, claims,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  return { session, writes };
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("two lanes writing one file", () => {
  it("lands exactly one write under enforcement, and tells the other lane who holds the file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claims-lanes-"));
    tempDirs.push(root);
    const registry = new ClaimRegistry({ caseInsensitive: false });
    const first = lane(registry, "1");
    const second = lane(registry, "2");
    const write = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "file_write", input: { path: "src/shared.ts", content: id } });
    const a = laneSession(root, first.claims, [write("a1")]);
    const b = laneSession(root, second.claims, [write("b1")]);
    await drain(a.session.send("go"));
    const events = await drain(b.session.send("go"));
    expect(a.writes).toEqual(["src/shared.ts"]);
    expect(b.writes).toEqual([]);
    const refused = events.find((event): event is Extract<AgentEvent, { type: "tool_call_result" }> => event.type === "tool_call_result" && event.toolName === "file_write");
    expect(refused?.ok).toBe(false);
    expect(refused?.summary).toContain("BLK-1's lane");
    // The first lane ends: its claim goes with it, and the second may now write.
    first.claims.release();
    const retry = laneSession(root, second.claims, [write("b2")]);
    await drain(retry.session.send("again"));
    expect(retry.writes).toEqual(["src/shared.ts"]);
  });
});
