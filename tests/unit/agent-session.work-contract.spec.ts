/* A delegated lane under a work contract: writes its tools name outside the contract's territory
   are put to the lane's approver before they run (tier "scope"), can be granted like any other
   gate, and are remembered once granted. Observe mode records and never asks. The session also
   keeps the facts its receipt is built from — what changed, what was checked — without reading
   anything the model says about its own work. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolUseBlock } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ApprovalDecision } from "../../src/approval-gate.js";
import { activateContract } from "../../src/orchestration/active-contract.js";
import { contractFromTicket } from "../../src/orchestration/contract-mapping.js";
import type { Ticket } from "../../src/ticket-store.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function context() {
  const values = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
  };
}

function contract(enforcement: "observe" | "enforce") {
  return activateContract(contractFromTicket({
    id: "BLK-1", title: "Parser", status: "backlog", statusSource: "manual", priority: "normal", labels: [],
    acceptanceCriteria: [], territory: { files: ["src/a.ts"], areas: [] }, references: [], runIds: [], blockedBy: [],
    blocks: [], relatedTo: [], children: [], assignee: "agent", origin: "user", events: [], createdAt: "", updatedAt: "",
  } as Ticket, {
    id: "wc_test", createdAt: "2026-10-16T00:00:00.000Z", enforcement,
    budget: { maxToolRounds: 10, maxRuntimeSeconds: 600, idleTimeoutSeconds: 120 },
  }));
}

let seq = 0;
function write(file: string): ToolUseBlock {
  seq += 1;
  return { type: "tool_use", id: `w${seq}`, name: "file_write", input: { path: file, content: "x" } };
}

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function harness(rounds: ToolUseBlock[][], answers: ApprovalDecision[], active: ReturnType<typeof contract>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-lane-"));
  tempDirs.push(root);
  const writes: string[] = [];
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => {
      if (message.type === "system.write_file") {
        const file = String(message.payload.path);
        writes.push(file);
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "x");
        return { result: { ok: true, path: file, relativePath: file, created: true, sizeBytes: 1 } };
      }
      return { result: { ok: true } };
    }),
  };
  const queue = [...answers];
  const approvalProvider = vi.fn(async (_id: string, _tool: string, _description: string, _tier: string) => queue.shift() ?? "deny" as ApprovalDecision);
  const scripted = new ScriptedProviderSession(({ turnIndex }) => (
    turnIndex < rounds.length
      ? { toolCalls: rounds[turnIndex], stopReason: "tool_use", usage }
      : { text: "All done, every test passes.", stopReason: "end_turn", usage }
  ));
  const session = new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: root,
    runtime: runtime as never,
    context: context() as never,
    provider: "anthropic",
    maxIterations: 8,
    checkpointingEnabled: false,
    approvalProvider,
    delegatedLane: true,
    workContract: active,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  return { session, approvalProvider, writes };
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function results(events: AgentEvent[]) {
  return events.filter((event): event is Extract<AgentEvent, { type: "tool_call_result" }> => event.type === "tool_call_result");
}

describe("work contract enforcement in a lane", () => {
  it("writes inside the territory without asking", async () => {
    const active = contract("enforce");
    const { session, approvalProvider, writes } = harness([[write("src/a.ts")]], [], active);
    await drain(session.send("go"));
    expect(writes).toEqual(["src/a.ts"]);
    expect(approvalProvider.mock.calls.filter((call) => call[3] === "scope")).toHaveLength(0);
  });

  it("asks before a write outside it, and a refusal stops only that call", async () => {
    const active = contract("enforce");
    const { session, approvalProvider, writes } = harness([[write("docs/notes.md")]], ["deny"], active);
    const events = await drain(session.send("go"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(approvalProvider.mock.calls[0]?.[3]).toBe("scope");
    expect(approvalProvider.mock.calls[0]?.[2]).toContain("docs/notes.md");
    expect(writes).toEqual([]);
    const result = results(events).find((event) => event.toolName === "file_write");
    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain("outside this lane's work contract");
    expect(active.refused).toHaveLength(1);
    expect(session.contractObservation().refused).toHaveLength(1);
  });

  it("can be granted, and remembers the grant for the rest of the lane", async () => {
    const active = contract("enforce");
    const { session, approvalProvider, writes } = harness([[write("docs/notes.md")], [write("docs/notes.md")]], ["allow"], active);
    await drain(session.send("go"));
    expect(writes).toEqual(["docs/notes.md", "docs/notes.md"]);
    expect(approvalProvider.mock.calls.filter((call) => call[3] === "scope")).toHaveLength(1);
    expect([...active.granted]).toEqual(["docs/notes.md"]);
    expect(session.contractObservation().granted).toEqual(["docs/notes.md"]);
  });

  it("lets 'Allow all' cover further scope widening this turn", async () => {
    const active = contract("enforce");
    const { session, approvalProvider, writes } = harness([[write("docs/one.md")], [write("docs/two.md")]], ["allow_all"], active);
    await drain(session.send("go"));
    expect(writes).toEqual(["docs/one.md", "docs/two.md"]);
    expect(approvalProvider).toHaveBeenCalledTimes(1);
  });

  it("only records in observe mode", async () => {
    const active = contract("observe");
    const { session, approvalProvider, writes } = harness([[write("docs/notes.md")]], [], active);
    await drain(session.send("go"));
    expect(approvalProvider).not.toHaveBeenCalled();
    expect(writes).toEqual(["docs/notes.md"]);
    expect([...active.observedOutOfScope]).toEqual(["docs/notes.md"]);
  });

  it("observes what changed and that nothing checked it, whatever the lane says", async () => {
    const active = contract("enforce");
    const { session } = harness([[write("src/a.ts")]], [], active);
    await drain(session.send("go"));
    const observation = session.contractObservation();
    expect(observation.filesChanged).toEqual([{ path: "src/a.ts", change: "A" }]);
    expect(observation.checks).toEqual([]);
    expect(observation.owesVerification).toBe(true);
    expect(observation.uncovered).toContain("src/a.ts");
  });

  it("does nothing at all without a contract", async () => {
    const writes: string[] = [];
    const session = new AgentSession({
      apiKey: "key", model: "claude-sonnet-4-6", systemPrompt: "test", workspaceRoot: "/workspace",
      runtime: { handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => {
        if (message.type === "system.write_file") writes.push(String(message.payload.path));
        return { result: { ok: true, path: message.payload.path, relativePath: message.payload.path } };
      }) } as never,
      context: context() as never, provider: "anthropic", maxIterations: 4, checkpointingEnabled: false,
      approvalProvider: vi.fn(async () => "deny" as ApprovalDecision),
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => new ScriptedProviderSession(({ turnIndex }) => (
        turnIndex === 0 ? { toolCalls: [write("docs/notes.md")], stopReason: "tool_use", usage } : { text: "ok", stopReason: "end_turn", usage }
      )),
    });
    await drain(session.send("go"));
    expect(writes).toEqual(["docs/notes.md"]);
    expect(session.contractObservation().filesChanged).toEqual([]);
  });
});
