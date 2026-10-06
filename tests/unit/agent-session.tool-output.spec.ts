/* While a shell command runs, the session forwards its output on the onToolOutput side
   channel — the run loop itself is suspended awaiting the command and cannot yield it — tagged
   with the tool call it belongs to. Other runtime tools get no listener. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type ToolOutputEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
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

type Hooks = { onOutput?: (stream: "stdout" | "stderr", text: string) => void };

function run(toolCalls: ToolUseBlock[]) {
  const hooksSeen: Array<{ type: string; hooks: Hooks | undefined }> = [];
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }, _signal?: AbortSignal, hooks?: Hooks) => {
      hooksSeen.push({ type: message.type, hooks });
      if (message.type === "system.shell") {
        /* An unrecognized command asks first; the approved re-run must stream too. */
        if (message.payload["command"] === "./build" && message.payload["confirmed"] !== true) {
          return { result: { ok: true, requiresConfirmation: true, tier: "write", description: "Run ./build", unrecognizedCommand: true } };
        }
        hooks?.onOutput?.("stdout", "compiling\n");
        hooks?.onOutput?.("stderr", "warn\n");
        return { result: { ok: true, exitCode: 0, stdout: "compiling\n", stderr: "warn\n", timedOut: false } };
      }
      return { result: { ok: true, entries: [] } };
    }),
  };
  let served = false;
  const scripted = new ScriptedProviderSession(() => {
    if (served) return { text: "done", stopReason: "end_turn", usage };
    served = true;
    return { toolCalls, stopReason: "tool_use", usage };
  });
  const output: ToolOutputEvent[] = [];
  const session = new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: runtime as never,
    onToolOutput: (event) => output.push(event),
    context: context() as never,
    provider: "anthropic",
    maxIterations: 4,
    checkpointingEnabled: false,
    approvalProvider: async () => "allow",
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
  });
  return { session, output, hooksSeen };
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("AgentSession tool output side channel", () => {
  it("forwards a shell command's output tagged with its call, before the call's result", async () => {
    const { session, output } = run([{ type: "tool_use", id: "sh-1", name: "shell_run", input: { command: "npm", args: ["run", "build"] } }]);
    const events = await drain(session.send("build it"));
    expect(output).toEqual([
      { toolCallId: "sh-1", toolName: "shell_run", stream: "stdout", text: "compiling\n" },
      { toolCallId: "sh-1", toolName: "shell_run", stream: "stderr", text: "warn\n" },
    ]);
    expect(events.some((event) => event.type === "tool_call_result" && event.toolCallId === "sh-1")).toBe(true);
  });

  it("streams the approved run of a command that had to ask first", async () => {
    const { session, output, hooksSeen } = run([{ type: "tool_use", id: "sh-2", name: "shell_run", input: { command: "./build" } }]);
    await drain(session.send("build it"));
    const shellCalls = hooksSeen.filter((call) => call.type === "system.shell");
    expect(shellCalls).toHaveLength(2);
    expect(shellCalls.every((call) => typeof call.hooks?.onOutput === "function")).toBe(true);
    expect(output.map((event) => event.toolCallId)).toEqual(["sh-2", "sh-2"]);
  });

  it("passes no output listener to non-shell runtime tools", async () => {
    const { session, output, hooksSeen } = run([{ type: "tool_use", id: "ls-1", name: "file_list", input: { path: "." } }]);
    await drain(session.send("list"));
    expect(hooksSeen.find((call) => call.type === "system.list_directory")?.hooks).toBeUndefined();
    expect(output).toEqual([]);
  });
});
