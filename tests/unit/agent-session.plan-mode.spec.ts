/* Plan mode used to be prompt text: "stay read-only" while every write tool stayed advertised and
   dispatchable. These specs pin the enforced version — mutating tools leave the catalog, anything
   that still reaches dispatch is refused before it runs, and a lane spawned while planning plans
   too. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import { isReadOnlyCommand } from "../../packages/local-runtime/src/security.js";
import { planModeRefusal, planModeWithholds } from "../../src/plan-mode-policy.js";
import { laneRequestMode } from "../../src/chat/subagent-lanes.js";
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

function session(toolCalls: ToolUseBlock[], extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const runtime = { handleMessage: vi.fn(async () => ({ result: { ok: true, stdout: "ok" } })) };
  let served = false;
  const scripted = new ScriptedProviderSession(() => {
    if (served || toolCalls.length === 0) return { text: "plan ready", stopReason: "end_turn", usage };
    served = true;
    return { toolCalls, stopReason: "tool_use", usage };
  });
  const s = new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: runtime as any,
    context: context() as any,
    provider: "anthropic",
    maxIterations: 6,
    checkpointingEnabled: false,
    approvalProvider: vi.fn(async () => "allow" as const),
    editProvider: { applyEdit: vi.fn(async () => ({ ok: true, path: "a", replacements: 1 })), applyBatchEdits: vi.fn(), applyJsonEdit: vi.fn() } as any,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
    ...extra,
  });
  return { session: s, runtime };
}

function advertised(s: AgentSession): string[] {
  return (s as unknown as { _getTools(): Array<{ name: string }> })._getTools().map((t) => t.name);
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function resultFor(events: AgentEvent[], id: string) {
  return events.find((e): e is Extract<AgentEvent, { type: "tool_call_result" }> => e.type === "tool_call_result" && e.toolCallId === id);
}

describe("isReadOnlyCommand", () => {
  it("accepts inspection binaries, version probes and read-only git", () => {
    expect(isReadOnlyCommand("rg", ["TODO", "src"])).toBe(true);
    expect(isReadOnlyCommand("cat", ["package.json"])).toBe(true);
    expect(isReadOnlyCommand("ls", ["-la"])).toBe(true);
    expect(isReadOnlyCommand("node", ["--version"])).toBe(true);
    expect(isReadOnlyCommand("git", ["log", "--oneline", "-5"])).toBe(true);
    expect(isReadOnlyCommand("git", ["diff", "HEAD~1"])).toBe(true);
  });

  it("rejects anything that can write, however it is spelled", () => {
    expect(isReadOnlyCommand("git", ["stash"])).toBe(false);
    expect(isReadOnlyCommand("git", ["branch", "new-branch"])).toBe(false);
    expect(isReadOnlyCommand("git", ["diff", "--output=patch.diff"])).toBe(false);
    expect(isReadOnlyCommand("git", ["-c", "core.fsmonitor=evil", "status"])).toBe(false);
    expect(isReadOnlyCommand("sort", ["-o", "out.txt", "in.txt"])).toBe(false);
    expect(isReadOnlyCommand("npm", ["test"])).toBe(false);
    expect(isReadOnlyCommand("node", ["script.js"])).toBe(false);
    expect(isReadOnlyCommand("./cat", ["x"])).toBe(false);
    expect(isReadOnlyCommand("mkdir", ["x"])).toBe(false);
  });
});

describe("plan-mode policy", () => {
  it("withholds file, repository, loop, sequence, browser-input and service mutations", () => {
    for (const name of ["file_edit", "file_write", "file_delete", "code_rename", "worktree_op", "loop_control", "sequence_execute", "browser_fill_form", "github_create_pr", "skill_write"]) {
      expect(planModeWithholds(name), name).toBe(true);
    }
    for (const name of ["file_read", "file_search", "shell_run", "git_op", "test_run", "plan_create", "plan_doc_write", "ticket_file", "map_note_add", "subagent_spawn", "browser_navigate", "github_get_issue"]) {
      expect(planModeWithholds(name), name).toBe(false);
    }
  });

  it("refuses mutating git operations by argument", () => {
    expect(planModeRefusal("git_op", "workspace.git", { op: "status" })).toBeNull();
    expect(planModeRefusal("git_op", "workspace.git", { op: "commit", message: "x" })).toMatch(/unavailable in plan mode/);
  });

  it("inherits into lanes only as plan mode", () => {
    expect(laneRequestMode("plan")).toEqual({ requestMode: "plan" });
    expect(laneRequestMode("review")).toBeUndefined();
    expect(laneRequestMode(undefined)).toBeUndefined();
  });
});

describe("AgentSession in plan mode", () => {
  it("drops mutating tools from the catalog and restores them outside plan mode", async () => {
    const { session: s } = session([]);
    await drain(s.send("draft a plan", { requestMode: "plan" }));
    const planTools = advertised(s);
    expect(planTools).not.toContain("file_edit");
    expect(planTools).not.toContain("file_write");
    expect(planTools).toContain("file_read");
    expect(planTools).toContain("shell_run");

    await drain(s.send("now implement it", { requestMode: "auto" }));
    expect(advertised(s)).toContain("file_edit");
  });

  it("refuses a write call the model makes anyway, without dispatching it", async () => {
    const call: ToolUseBlock = { type: "tool_use", id: "w1", name: "file_write", input: { path: "a.ts", content: "x" } };
    const { session: s, runtime } = session([call]);
    const events = await drain(s.send("plan it", { requestMode: "plan" }));
    expect(resultFor(events, "w1")?.ok).toBe(false);
    expect(String(resultFor(events, "w1")?.summary)).toMatch(/unavailable in plan mode/);
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it("runs read-only shell commands and refuses the rest", async () => {
    const calls: ToolUseBlock[] = [
      { type: "tool_use", id: "read", name: "shell_run", input: { command: "rg", args: ["TODO"] } },
      { type: "tool_use", id: "install", name: "shell_run", input: { command: "npm", args: ["install"] } },
      { type: "tool_use", id: "script", name: "shell_run", input: { command: "node", args: ["migrate.js"] } },
    ];
    const { session: s, runtime } = session(calls);
    const events = await drain(s.send("plan it", { requestMode: "plan" }));
    expect(resultFor(events, "read")?.ok).toBe(true);
    expect(resultFor(events, "install")?.ok).toBe(false);
    expect(resultFor(events, "script")?.ok).toBe(false);
    const commands = runtime.handleMessage.mock.calls.map((c: unknown[]) => (c[0] as { payload: { command: string } }).payload.command);
    expect(commands).toEqual(["rg"]);
  });

  it("spawns delegated lanes in plan mode", async () => {
    const spawn = vi.fn(async function* () {
      yield { type: "subagent_tool_result", result: { ok: true, subRequestId: "r1", answer: "found it", toolRounds: 1 } };
    });
    const call: ToolUseBlock = { type: "tool_use", id: "lane", name: "subagent_spawn", input: { task: "survey the auth module" } };
    const { session: s } = session([call], { subagentProvider: { spawn } as any });
    await drain(s.send("plan the refactor", { requestMode: "plan" }));
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ requestMode: "plan" }));
  });
});
