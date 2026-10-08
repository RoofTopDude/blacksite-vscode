import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

function fakeContext(): ConstructorParameters<typeof AgentSession>[0]["context"] {
  return {
    workspaceState: {
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
      update: async (): Promise<void> => undefined,
    },
  } as ConstructorParameters<typeof AgentSession>[0]["context"];
}

async function consume(run: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _event of run) { /* consume */ }
}

describe("AgentSession live workspace environment", () => {
  it("refreshes context before every provider turn, including post-tool continuations", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
          toolCalls: [{ type: "tool_use", id: "read-1", name: "file_list", input: { path: "." } }],
          stopReason: "tool_use",
        }
      : { text: "done", stopReason: "end_turn" });
    const workspaceContextProvider = vi.fn(async () => `# Current workspace state\nrevision ${workspaceContextProvider.mock.calls.length}`);
    const runtime = { handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })) };
    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: runtime as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider,
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("inspect then finish"));

    expect(workspaceContextProvider).toHaveBeenCalledTimes(2);
    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps running when a later context refresh fails", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? {
          toolCalls: [{ type: "tool_use", id: "read-1", name: "file_list", input: { path: "." } }],
          stopReason: "tool_use",
        }
      : { text: "done", stopReason: "end_turn" });
    const workspaceContextProvider = vi.fn()
      .mockResolvedValueOnce("# Current workspace state\nhealthy")
      .mockRejectedValueOnce(new Error("temporary index failure"));
    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, entries: [] } })) } as unknown as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider,
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await expect(consume(session.send("inspect then finish"))).resolves.toBeUndefined();
    expect(workspaceContextProvider).toHaveBeenCalledTimes(2);
  });

  it("labels everything it attaches as one envelope the user did not write", async () => {
    const scripted = new ScriptedProviderSession(() => ({ text: "planned", stopReason: "end_turn" }));
    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn() } as unknown as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider: async () => "# Current workspace state\nrevision 3",
      checkpointingEnabled: false,
    });
    const dynamicContext = () => (session as unknown as { _dynamicContext(): string })._dynamicContext();

    // Nothing to attach, nothing to label: a bare envelope would itself be noise in the user's turn.
    expect(dynamicContext()).toBe("");

    await consume(session.send("Create a detailed plan", { requestMode: "plan" }));

    const attached = dynamicContext();
    expect(attached.startsWith("<blacksite-context>\n")).toBe(true);
    expect(attached.endsWith("\n</blacksite-context>")).toBe(true);
    expect(attached.match(/<blacksite-context>/g)).toHaveLength(1);
    // The explanation comes first, ahead of the request profile and the workspace state.
    expect(attached.indexOf("not part of their message")).toBeGreaterThan(0);
    expect(attached.indexOf("not part of their message")).toBeLessThan(attached.indexOf("# Active request profile: plan"));
    expect(attached.indexOf("# Active request profile: plan")).toBeLessThan(attached.indexOf("# Current workspace state\nrevision 3"));
  });

  it("layers and persists the active request profile with live workspace context", async () => {
    const scripted = new ScriptedProviderSession(() => ({ text: "planned", stopReason: "end_turn" }));
    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn() } as unknown as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider: async () => "# Current workspace state\nrevision 7",
      checkpointingEnabled: false,
    });

    await consume(session.send("Create a detailed plan", { requestMode: "plan" }));

    const dynamicContext = (session as unknown as { _dynamicContext(): string })._dynamicContext();
    expect(dynamicContext).toContain("# Active request profile: plan");
    expect(dynamicContext).toContain("# Current workspace state\nrevision 7");
    expect(session.runtimeState.requestMode).toBe("plan");
    expect(session.runtimeState.activeRequestMode).toBe("plan");
    expect(session.exportState().requestMode).toBe("plan");

    const restored = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn() } as unknown as ConstructorParameters<typeof AgentSession>[0]["runtime"],
      context: fakeContext(),
      providerTurnSessionFactory: () => new ScriptedProviderSession(() => ({ text: "resumed", stopReason: "end_turn" })),
      workspaceContextProvider: async () => "# Current workspace state\nrevision 8",
      checkpointingEnabled: false,
    });
    restored.restoreState({ messages: session.history, ...session.exportState() });
    await consume(restored.send("[Resumed from checkpoint]", { preserveRequestMode: true }));
    expect(restored.runtimeState.requestMode).toBe("plan");
    expect(restored.runtimeState.activeRequestMode).toBe("plan");
  });
});
