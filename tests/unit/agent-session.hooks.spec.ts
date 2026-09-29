import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import type { HookInput } from "../../src/hooks.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

function setup(extra: Partial<AgentSessionOptions> = {}, parallel = false) {
  const provider = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0 ? {
    toolCalls: [{ type: "tool_use", id: "t1", name: parallel ? "subagent_spawn" : "file_write",
      input: parallel ? { task: "test", parallel: true } : { path: "test.txt", content: "hello" } }], stopReason: "tool_use",
  } : { text: "done", stopReason: "end_turn" });
  const runtime = { handleMessage: vi.fn(async () => ({ result: { ok: true, path: "test.txt" } })) };
  const hooks: HookInput[] = [];
  const session = new AgentSession({ apiKey: "test", model: "test", systemPrompt: "test", workspaceRoot: process.cwd(),
    context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
    runtime: runtime as any, checkpointingEnabled: false, maxIterations: 3,
    providerTurnSessionFactory: () => provider, approvalProvider: async () => "allow_all",
    hookProvider: async (input) => { hooks.push(input); return {}; }, ...extra });
  return { session, runtime, hooks, provider };
}
async function drain(stream: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("agent lifecycle hooks", () => {
  it("orders prompt, pre-tool, post-tool and stop; captures formatter changes before the after-snapshot", async () => {
    const order: string[] = [];
    const { session, runtime } = setup({
      hookProvider: async (input) => { order.push(input.event); return {}; },
      editDiffJournal: { captureBefore: async () => { order.push("before"); }, captureAfter: async () => { order.push("after"); return []; } } as any,
    });
    await drain(session.send("hello", { userText: "hello" }));
    expect(runtime.handleMessage).toHaveBeenCalled();
    expect(order).toEqual(["UserPromptSubmit", "PreToolUse", "before", "PostToolUse", "after", "Stop"]);
  });
  it("blocks a submitted prompt before contacting the model or appending history", async () => {
    const calls: string[] = [];
    const { session, provider, runtime } = setup({ hookProvider: async (input) => {
      calls.push(input.event); return input.event === "UserPromptSubmit" ? { blocked: "no secrets" } : {};
    } });
    const events = await drain(session.send("secret", { userText: "secret" }));
    expect(provider.userTexts).toEqual([]);
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "error", message: "no secrets" });
    expect(calls).toEqual(["UserPromptSubmit", "Stop"]);
  });
  it("blocks tools, including parallel delegation, before dispatch", async () => {
    for (const parallel of [false, true]) {
      const spawn = vi.fn();
      const { session, runtime } = setup({
        hookProvider: async (input) => input.event === "PreToolUse" ? { blocked: "protected" } : {},
        subagentProvider: { spawn } as any,
      }, parallel);
      const events = await drain(session.send("go"));
      expect(runtime.handleMessage).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", ok: false, summary: "protected" }));
    }
  });
  it("fails closed on a thrown pre-hook and warns without reversing completed tools", async () => {
    const blocked = setup({ hookProvider: async () => { throw new Error("broken config"); } });
    expect(await drain(blocked.session.send("go"))).toContainEqual(expect.objectContaining({ type: "tool_call_result", ok: false, summary: expect.stringContaining("broken config") }));
    expect(blocked.runtime.handleMessage).not.toHaveBeenCalled();
    const warned = setup({ hookProvider: async (input) => { if (input.event === "PostToolUse") throw new Error("formatter failed"); return {}; } });
    const events = await drain(warned.session.send("go"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", ok: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "execution_diagnostic", message: expect.stringContaining("formatter failed") }));
  });
  it("does not submit harness prompts, and runs Stop after cancellation", async () => {
    const { session, hooks } = setup();
    const abort = new AbortController();
    abort.abort();
    session.attachSignal(abort.signal);
    await drain(session.send("continue", { preserveRequestMode: true }));
    expect(hooks.map((h) => h.event)).toEqual(["Stop"]);
    expect(hooks[0].stopReason).toBe("cancelled");
  });
  it("runs Stop once when the consumer closes the stream", async () => {
    const { session, hooks } = setup();
    const stream = session.send("go");
    await stream.next();
    await stream.return(undefined);
    expect(hooks.map((h) => h.event)).toEqual(["Stop"]);
  });
  it("does not repeat Stop when a consumer closes on its warning after a blocked prompt", async () => {
    const seen: string[] = [];
    const { session } = setup({ hookProvider: async (input) => {
      seen.push(input.event);
      return input.event === "UserPromptSubmit" ? { blocked: "blocked" } : { warnings: ["stop failed"] };
    } });
    const stream = session.send("go", { userText: "go" });
    await stream.next();
    expect((await stream.next()).value).toMatchObject({ type: "execution_diagnostic", message: "stop failed" });
    await stream.return(undefined);
    expect(seen).toEqual(["UserPromptSubmit", "Stop"]);
  });
});
