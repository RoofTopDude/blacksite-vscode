import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type SkillToolProvider } from "../../src/agent-session.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

type SessionOpts = ConstructorParameters<typeof AgentSession>[0];

function fakeContext(): SessionOpts["context"] {
  return {
    workspaceState: {
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
      update: async (): Promise<void> => undefined,
    },
  } as SessionOpts["context"];
}

const noRuntime = () => ({ handleMessage: vi.fn() } as unknown as SessionOpts["runtime"]);

async function consume(run: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _event of run) { /* consume */ }
}

/** A skill provider that hands back a body for `alpha` and nothing for anything else. */
function stubSkillProvider(bodies: Record<string, string>): SkillToolProvider {
  return {
    dispatch: vi.fn(async (op, payload) => {
      if (op !== "read") return { ok: true, skills: [] };
      const name = String(payload["name"] ?? "");
      const markdown = bodies[name];
      if (!markdown) return { ok: false, error: `No skill named '${name}'.` };
      return { ok: true, name, loaded: true, note: "loaded", loadedBody: { name, markdown } };
    }),
  };
}

function readSkill(id: string, name: string) {
  return { type: "tool_use" as const, id, name: "skill_read", input: { name } };
}

function dynamicContextOf(session: AgentSession): string {
  return (session as unknown as { _dynamicContext(): string })._dynamicContext();
}

describe("AgentSession skills", () => {
  /* The body must reach the model through the durable tail block, not the tool result:
     a tool result is exactly what compaction drops, and duplicating it would put two full
     copies of the procedure in context. */
  it("moves a loaded skill's body into the tail context and keeps it out of the tool result", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readSkill("s1", "alpha")], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider: async () => "# Current workspace state\nrevision 1",
      skillProvider: stubSkillProvider({ alpha: "# Alpha procedure\n\nStep one." }),
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("do alpha work"));

    const context = dynamicContextOf(session);
    expect(context).toContain("# Active skills");
    expect(context).toContain("## Skill: alpha");
    expect(context).toContain("Step one.");
    expect(session.loadedSkills).toEqual(["alpha"]);

    const toolResultText = scripted.toolResults.flat().map((result) => result.content).join("\n");
    expect(toolResultText).not.toContain("Step one.");
    expect(toolResultText).toContain("loaded");
  });

  it("orders the skill block after the request profile and before the workspace state", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readSkill("s1", "alpha")], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      workspaceContextProvider: async () => "# Current workspace state\nrevision 1",
      skillProvider: stubSkillProvider({ alpha: "Alpha body." }),
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("plan the alpha work", { requestMode: "plan" }));

    const context = dynamicContextOf(session);
    expect(context.indexOf("# Active request profile")).toBeLessThan(context.indexOf("# Active skills"));
    expect(context.indexOf("# Active skills")).toBeLessThan(context.indexOf("# Current workspace state"));
  });

  it("keeps skills in load order and does not duplicate a re-read", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [readSkill("s1", "beta")], stopReason: "tool_use" };
      if (turnIndex === 1) return { toolCalls: [readSkill("s2", "alpha")], stopReason: "tool_use" };
      if (turnIndex === 2) return { toolCalls: [readSkill("s3", "beta")], stopReason: "tool_use" };
      return { text: "done", stopReason: "end_turn" };
    });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      skillProvider: stubSkillProvider({ alpha: "Alpha body.", beta: "Beta body." }),
      checkpointingEnabled: false,
      maxIterations: 8,
    });

    await consume(session.send("load a few"));

    expect(session.loadedSkills).toEqual(["beta", "alpha"]);
    const context = dynamicContextOf(session);
    expect(context.match(/## Skill: beta/g)).toHaveLength(1);
  });

  it("leaves the context untouched when a load fails", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readSkill("s1", "missing")], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      skillProvider: stubSkillProvider({ alpha: "Alpha body." }),
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("load a skill that isn't there"));

    expect(session.loadedSkills).toEqual([]);
    expect(dynamicContextOf(session)).not.toContain("# Active skills");
  });

  /* Bodies travel with the checkpoint rather than being re-read by name: a resumed run must
     follow the procedure it was actually following, not whatever that file says now. */
  it("carries loaded skill bodies across a checkpoint resume", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readSkill("s1", "alpha")], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      skillProvider: stubSkillProvider({ alpha: "# Alpha procedure\n\nStep one." }),
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("do alpha work"));

    const exported = session.exportState();
    expect(exported.loadedSkills).toEqual([{ name: "alpha", markdown: "# Alpha procedure\n\nStep one." }]);

    const restored = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => new ScriptedProviderSession(() => ({ text: "resumed", stopReason: "end_turn" })),
      // Deliberately no skillProvider: a resumed lane must not need the store to keep
      // following the procedure it already loaded.
      checkpointingEnabled: false,
    });
    restored.restoreState({ messages: session.history, ...exported });

    expect(restored.loadedSkills).toEqual(["alpha"]);
    expect(dynamicContextOf(restored)).toContain("Step one.");
    expect(restored.runtimeState.loadedSkills).toEqual(["alpha"]);
  });

  it("omits loadedSkills from exported state when nothing is loaded", async () => {
    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => new ScriptedProviderSession(() => ({ text: "hi", stopReason: "end_turn" })),
      checkpointingEnabled: false,
    });

    await consume(session.send("nothing to load"));

    expect(session.exportState().loadedSkills).toBeUndefined();
    expect(session.runtimeState.loadedSkills).toBeUndefined();
  });

  it("reports skill tools as unavailable rather than failing opaquely with no provider", async () => {
    const scripted = new ScriptedProviderSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readSkill("s1", "alpha")], stopReason: "tool_use" }
      : { text: "done", stopReason: "end_turn" });

    const session = new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => scripted,
      checkpointingEnabled: false,
      maxIterations: 4,
    });

    await consume(session.send("try to load a skill"));

    expect(scripted.toolResults.flat().map((r) => r.content).join("\n")).toContain("not available");
    expect(session.loadedSkills).toEqual([]);
  });
});

describe("skill tool advertisement", () => {
  const toolNames = (session: AgentSession): string[] =>
    (session as unknown as { _getTools(): Array<{ name: string }> })._getTools().map((tool) => tool.name);

  function build(opts: Partial<SessionOpts>): AgentSession {
    return new AgentSession({
      apiKey: "test",
      model: "test-model",
      systemPrompt: "test prompt",
      workspaceRoot: "C:/workspace",
      runtime: noRuntime(),
      context: fakeContext(),
      providerTurnSessionFactory: () => new ScriptedProviderSession(() => ({ text: "", stopReason: "end_turn" })),
      checkpointingEnabled: false,
      ...opts,
    });
  }

  it("advertises skill tools only when a provider is wired", () => {
    expect(toolNames(build({}))).not.toContain("skill_read");
    expect(toolNames(build({ skillProvider: stubSkillProvider({}) }))).toEqual(
      expect.arrayContaining(["skill_read", "skill_list", "skill_write"]),
    );
  });
});
