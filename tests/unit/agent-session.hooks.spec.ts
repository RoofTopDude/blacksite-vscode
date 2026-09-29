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
    expect(order).not.toContain("Notification");
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
  it("gives the model what a post-tool hook found, on the result it belongs to", async () => {
    const { session, provider } = setup({ hookProvider: async (input) => input.event === "PostToolUse" ? { context: ["lint: 2 errors in test.txt"] } : {} });
    await drain(session.send("go"));
    const result = provider.toolResults[0]![0]!;
    expect(JSON.parse(result.content as string)).toMatchObject({ ok: true, hook_feedback: "lint: 2 errors in test.txt" });
  });
  it("sends context a prompt hook added with the prompt, leaving what was typed alone", async () => {
    const seen: string[] = [];
    const { session, provider } = setup({ hookProvider: async (input) => {
      if (input.event === "UserPromptSubmit") { seen.push(input.prompt!); return { context: ["branch: main"] }; }
      return {};
    } });
    await drain(session.send("hello", { userText: "hello" }));
    expect(seen).toEqual(["hello"]);
    expect(provider.userTexts[0]).toMatch(/^hello\n\n\[Context from a UserPromptSubmit hook\]\nbranch: main/);
  });

  describe("a Stop hook that asks the agent to keep going", () => {
    function resumable(extra: Partial<AgentSessionOptions>) {
      const provider = new ScriptedProviderSession(({ turnIndex }) => ({ text: `answer ${turnIndex}`, stopReason: "end_turn" }));
      const session = new AgentSession({ apiKey: "test", model: "test", systemPrompt: "test", workspaceRoot: process.cwd(),
        context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
        runtime: { handleMessage: vi.fn() } as any, checkpointingEnabled: false, maxIterations: 4,
        providerTurnSessionFactory: () => provider, ...extra });
      return { session, provider };
    }
    it("runs the agent again with the hook's words, and shows the turn as one run", async () => {
      const stops: HookInput[] = [];
      const { session, provider } = resumable({ hookProvider: async (input) => {
        if (input.event !== "Stop") return {};
        stops.push(input);
        return stops.length === 1 ? { resume: "Run the tests before finishing." } : {};
      } });
      const events = await drain(session.send("build it"));
      expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
      expect(provider.userTexts[1]).toContain("A Stop hook asked you to keep working before you finish:\nRun the tests before finishing.");
      expect(provider.userTexts[1]).toMatch(/^\[Internal continuation\]/);
      expect(stops.map((stop) => stop.stopHookActive)).toEqual([undefined, true]);
      expect(events).toContainEqual(expect.objectContaining({ type: "execution_diagnostic", level: "info", message: expect.stringContaining("Run the tests before finishing.") }));
    });
    it("stops asking after two resumes, so a hook that is never satisfied cannot loop forever", async () => {
      let stops = 0;
      const { session, provider } = resumable({ hookProvider: async (input) => {
        if (input.event === "Stop") { stops++; return { resume: "again" }; }
        return {};
      } });
      const events = await drain(session.send("build it"));
      expect(stops).toBe(3);
      expect(provider.userTexts).toHaveLength(3);
      expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    });
    it("does not resume a run that was cancelled", async () => {
      const abort = new AbortController();
      let stops = 0;
      const { session, provider } = resumable({ hookProvider: async (input) => {
        if (input.event === "Stop") { stops++; return { resume: "again" }; }
        return {};
      } });
      session.attachSignal(abort.signal);
      abort.abort();
      await drain(session.send("build it"));
      expect(stops).toBe(1);
      expect(provider.userTexts).toEqual(["build it"]);
    });
  });

  it("tells a Notification hook when the agent is waiting on an approval, without holding the card up", async () => {
    const notifications: HookInput[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const provider = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [{ type: "tool_use", id: "t1", name: "file_list", input: { path: "." } }], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });
    const session = new AgentSession({ apiKey: "test", model: "test", systemPrompt: "test", workspaceRoot: process.cwd(),
      context: { workspaceState: { get: () => undefined, update: async () => undefined } } as any,
      runtime: { handleMessage: vi.fn(async ({ payload }: { payload: { confirmed?: boolean } }) => payload.confirmed
        ? { result: { ok: true } } : { result: { requiresConfirmation: true, tier: "network", description: "List a network share" } }) } as any,
      checkpointingEnabled: false, maxIterations: 3, providerTurnSessionFactory: () => provider,
      approvalProvider: async () => "allow",
      // Still running when the approval resolves: had the session awaited it, this would hang.
      hookProvider: async (input) => { if (input.event === "Notification") { notifications.push(input); await held; } return {}; } });
    const events = await drain(session.send("go"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_result", ok: true }));
    expect(notifications).toEqual([expect.objectContaining({ event: "Notification", notificationType: "approval", message: "List a network share" })]);
    release();
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
