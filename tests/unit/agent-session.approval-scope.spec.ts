/* "Allow All" used to flip one session-wide flag that never reset: a click on an edit diff in the
   first turn pre-approved destructive commands, code execution and service mutations for the rest
   of the conversation. These specs pin the replacement contract — a grant covers the category and
   tier it was given for, and only until the turn ends — plus the host-only `confirmed` field,
   which the model could previously set itself to skip every prompt. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import type { ApprovalDecision } from "../../src/approval-gate.js";
import { approvalCategory, approvalGrantKey, commandApprovalScope, TurnApprovalGrants } from "../../src/approval-scope.js";
import { resolveToolDispatch, stripHostOnlyFields, WORKSPACE_TOOLS, GIT_TOOLS, SEQUENCE_TOOLS } from "../../src/tools/definitions.js";
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

/** A runtime that behaves like local-runtime's confirmation protocol: an unconfirmed gated call
 *  answers requiresConfirmation with a tier; a confirmed one runs. */
function confirmingRuntime() {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const tierFor = (payload: Record<string, unknown>): { tier: string; unrecognizedCommand?: boolean } | null => {
    const command = String(payload["command"] ?? "");
    const args = (payload["args"] as string[] | undefined) ?? [];
    if (command === "rm") return { tier: "destructive" };
    if (command === "npm" && args[0] === "install") return { tier: "network" };
    if (command === "npm") return { tier: "write" };
    if (command.startsWith("./")) return { tier: "write", unrecognizedCommand: true };
    return null;
  };
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => {
      calls.push(message);
      if (message.type === "system.delete_path") {
        return message.payload["confirmed"] === true
          ? { result: { ok: true, deleted: message.payload["path"] } }
          : { result: { ok: true, requiresConfirmation: true, tier: "destructive", description: `Delete ${String(message.payload["path"])}` } };
      }
      const gate = tierFor(message.payload);
      if (gate && message.payload["confirmed"] !== true) {
        return { result: { ok: true, requiresConfirmation: true, description: `Run ${String(message.payload["command"])}`, ...gate } };
      }
      return { result: { ok: true, stdout: "ran" } };
    }),
  };
  return { runtime, calls };
}

/** Every send in this file uses one of these prompts; round N answers PROMPTS[N]. */
const PROMPTS = ["first", "second"];

let callSeq = 0;
function shell(command: string, args: string[] = [], extra: Record<string, unknown> = {}): ToolUseBlock {
  callSeq += 1;
  return { type: "tool_use", id: `call-${callSeq}`, name: "shell_run", input: { command, args, ...extra } };
}

function sessionWith(opts: {
  turns: ToolUseBlock[][];
  answers: ApprovalDecision[];
  editProvider?: unknown;
}) {
  const { runtime, calls } = confirmingRuntime();
  const answers = [...opts.answers];
  const approvalProvider = vi.fn(async () => answers.shift() ?? "deny");
  // Round N answers the Nth user prompt, once. Rounds are keyed to the prompt rather than to call
  // order because the harness adds its own continuation rounds (the verification reminder after an
  // edit, for one) inside a turn, and those must not consume the next turn's tool calls.
  const served = new Set<number>();
  const scripted = new ScriptedProviderSession(({ userTexts }) => {
    const prompt = PROMPTS.findIndex((p) => p === [...userTexts].reverse().find((t) => PROMPTS.includes(t)));
    const toolCalls = prompt >= 0 && !served.has(prompt) ? opts.turns[prompt] ?? [] : [];
    if (prompt >= 0) served.add(prompt);
    if (toolCalls.length === 0) return { text: "done", stopReason: "end_turn", usage };
    return { toolCalls, stopReason: "tool_use", usage };
  });
  const session = new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: runtime as any,
    context: context() as any,
    provider: "anthropic",
    maxIterations: 8,
    checkpointingEnabled: false,
    approvalProvider,
    editProvider: opts.editProvider as any,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  return { session, approvalProvider, calls };
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function executed(calls: Array<{ payload: Record<string, unknown> }>, command: string): number {
  return calls.filter((c) => c.payload["command"] === command && c.payload["confirmed"] === true).length;
}

describe("approval scope helpers", () => {
  it("categorizes runtime file operations as edits and everything else by runtime family", () => {
    expect(approvalCategory("file_write", "system.write_file")).toBe("edit");
    expect(approvalCategory("file_delete", "system.delete_path")).toBe("edit");
    expect(approvalCategory("file_edit", "editor.apply_edit")).toBe("edit");
    expect(approvalCategory("code_rename", "lsp.rename")).toBe("edit");
    expect(approvalCategory("shell_run", "system.shell")).toBe("command");
    expect(approvalCategory("git_op", "workspace.git")).toBe("command");
    expect(approvalCategory("github_create_pr", "service.github")).toBe("service");
    expect(approvalCategory("sequence_execute", "sequence.execute")).toBe("sequence");
  });

  it("pins an unrecognized command's grant to its executable", () => {
    const scope = commandApprovalScope("shell_run", "system.shell", "write", { command: "./Build.CMD" }, true);
    expect(approvalGrantKey(scope)).toBe("command:write:unrecognized:./build.cmd");
    expect(approvalGrantKey(commandApprovalScope("shell_run", "system.shell", "write", { command: "npm" }, false)))
      .toBe("command:write");
  });

  it("holds grants until cleared", () => {
    const grants = new TurnApprovalGrants();
    grants.grant({ category: "edit", tier: "write" });
    expect(grants.has({ category: "edit", tier: "write" })).toBe(true);
    expect(grants.has({ category: "command", tier: "write" })).toBe(false);
    grants.clear();
    expect(grants.has({ category: "edit", tier: "write" })).toBe(false);
  });
});

describe("host-only payload fields", () => {
  it("strips a model-supplied confirmed flag at dispatch", () => {
    expect(resolveToolDispatch("shell_run", { command: "rm", args: ["-rf", "x"], confirmed: true }).payload)
      .toEqual({ command: "rm", args: ["-rf", "x"] });
    expect(resolveToolDispatch("file_delete", { path: "a.txt", confirmed: true }).payload).toEqual({ path: "a.txt" });
    expect(stripHostOnlyFields({ a: 1 })).toEqual({ a: 1 });
  });

  it("no longer advertises confirmed on any tool schema", () => {
    for (const tool of [...WORKSPACE_TOOLS, ...GIT_TOOLS, ...SEQUENCE_TOOLS]) {
      expect(Object.keys(tool.input_schema.properties), tool.name).not.toContain("confirmed");
    }
  });

  it("still asks for approval when the model claims the command was confirmed", async () => {
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[shell("rm", ["-rf", "build"], { confirmed: true })]],
      answers: ["deny"],
    });
    const events = await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(executed(calls, "rm")).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "approval_result", granted: false }));
  });

  it("still asks for approval before deleting a file the model marked confirmed", async () => {
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[{ type: "tool_use", id: "del-1", name: "file_delete", input: { path: "src/a.ts", confirmed: true } }]],
      answers: ["deny"],
    });
    await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.type === "system.delete_path" && c.payload["confirmed"] === true)).toBe(false);
  });
});

describe("Allow All is scoped to its category, tier and turn", () => {
  it("covers repeats of the same kind of operation within the turn", async () => {
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[shell("npm", ["install", "a"]), shell("npm", ["install", "b"])]],
      answers: ["allow_all"],
    });
    await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(executed(calls, "npm")).toBe(2);
  });

  it("does not carry into the next turn", async () => {
    const { session, approvalProvider } = sessionWith({
      turns: [[shell("npm", ["install", "a"])], [shell("npm", ["install", "b"])]],
      answers: ["allow_all", "allow"],
    });
    await drain(session.send("first"));
    await drain(session.send("second"));
    expect(approvalProvider).toHaveBeenCalledTimes(2);
  });

  it("does not let a network grant approve a destructive command", async () => {
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[shell("npm", ["install", "a"]), shell("rm", ["-rf", "dist"])]],
      answers: ["allow_all", "deny"],
    });
    await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(2);
    expect(executed(calls, "rm")).toBe(0);
  });

  it("does not let an Allow All on an edit diff approve a command", async () => {
    const applyEdit = vi.fn(async () => ({ ok: true, path: "a.ts", replacements: 1, autoApproveAll: true }));
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[
        { type: "tool_use", id: "edit-1", name: "file_edit", input: { path: "a.ts", oldString: "a", newString: "b" } },
        shell("rm", ["-rf", "dist"]),
      ]],
      answers: ["deny"],
      editProvider: { applyEdit, applyBatchEdits: vi.fn(), applyJsonEdit: vi.fn() },
    });
    await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    expect(executed(calls, "rm")).toBe(0);
  });

  it("carries an edit Allow All to the next edit in the same turn, and not to the next turn", async () => {
    const autoApproveFlags: boolean[] = [];
    const applyEdit = vi.fn(async (_input: unknown, opts: { autoApprove: boolean }) => {
      autoApproveFlags.push(opts.autoApprove);
      return { ok: true, path: "a.ts", replacements: 1, autoApproveAll: autoApproveFlags.length === 1 };
    });
    const edit = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "file_edit", input: { path: "a.ts", oldString: "a", newString: "b" } });
    const { session } = sessionWith({
      turns: [[edit("e1"), edit("e2")], [edit("e3")]],
      answers: [],
      editProvider: { applyEdit, applyBatchEdits: vi.fn(), applyJsonEdit: vi.fn() },
    });
    await drain(session.send("first"));
    await drain(session.send("second"));
    expect(autoApproveFlags).toEqual([false, true, false]);
  });

  it("pins an unrecognized executable's grant to that executable", async () => {
    const { session, approvalProvider, calls } = sessionWith({
      turns: [[shell("./build.sh"), shell("./build.sh"), shell("./other.sh")]],
      answers: ["allow_all", "deny"],
    });
    await drain(session.send("first"));
    expect(approvalProvider).toHaveBeenCalledTimes(2);
    expect(executed(calls, "./build.sh")).toBe(2);
    expect(executed(calls, "./other.sh")).toBe(0);
  });
});
