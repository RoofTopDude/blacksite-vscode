/* On-demand tool loading: a small core loads up front and the rest through tool_search. These
   specs pin both mechanisms — client-side (tools join the list once loaded) and native Anthropic
   (every tool sent, non-core deferred, loads expanded from tool_reference blocks) — plus the
   persistence and PAU accounting that make the saving real and measurable. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import type { ToolDefinition } from "../../src/tools/definitions.js";
import { ALL_TOOLS, PLANNING_TOOLS } from "../../src/tools/definitions.js";
import {
  buildToolRoster, CORE_TOOL_NAMES, expandToolReferences, firstSentence, searchTools, supportsNativeToolSearch,
} from "../../src/agent/tool-loading.js";
import { capturePauReceipt } from "../../src/pau-metrics.js";
import { ScriptedProviderSession } from "./helpers/scripted-provider-session.js";

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
type Opts = ConstructorParameters<typeof AgentSession>[0];

function context() {
  const values = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); },
    },
  };
}

function createSession(overrides: Partial<Opts> = {}) {
  return new AgentSession({
    apiKey: "key",
    model: "claude-sonnet-4-6",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as any,
    context: context() as any,
    provider: "anthropic",
    maxIterations: 6,
    checkpointingEnabled: false,
    planningProvider: {} as any,
    ticketProvider: {} as any,
    graphProvider: {} as any,
    skillProvider: {} as any,
    editProvider: {} as any,
    memoryProvider: { append: () => undefined, readMemory: () => "memory text", readContext: () => "" },
    toolLoading: () => "on_demand",
    ...overrides,
  });
}

type Internals = {
  _toolPlan(): { wire: ToolDefinition[]; deferred: ReadonlySet<string>; inContext: ToolDefinition[]; outOfContext: ToolDefinition[] };
  _buildAnthropicWireTools(): Array<Record<string, unknown>>;
  _anthropicWireMessages(sent: ReadonlySet<string>): Array<{ role: string; content: unknown }>;
  _pauToolSchemas(format: "anthropic" | "openai"): { inContext: unknown; deferred: unknown };
  _toolReferenceResults: Map<string, string[]>;
};
const internals = (session: AgentSession) => session as unknown as Internals;
const names = (tools: ToolDefinition[]) => tools.map((tool) => tool.name);

function scriptedSession(toolCalls: ToolUseBlock[], overrides: Partial<Opts> = {}) {
  let served = false;
  const scripted = new ScriptedProviderSession(() => {
    if (served) return { text: "done", stopReason: "end_turn", usage };
    served = true;
    return { toolCalls, stopReason: "tool_use", usage };
  });
  return createSession({ providerTurnSessionFactory: () => scripted, ...overrides });
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function resultOf(events: AgentEvent[], id: string): Record<string, unknown> {
  const event = events.find((e): e is Extract<AgentEvent, { type: "tool_call_result" }> => e.type === "tool_call_result" && e.toolCallId === id);
  return (event?.result ?? {}) as Record<string, unknown>;
}

describe("tool-loading helpers", () => {
  it("recognizes the models that support native tool search", () => {
    for (const model of ["claude-sonnet-4-6", "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929", "claude-fable-5-1", "claude-mythos-5"]) {
      expect(supportsNativeToolSearch(model), model).toBe(true);
    }
    for (const model of ["claude-sonnet-4-20250514", "claude-opus-4-1-20250805", "claude-3-7-sonnet-20250219", "gpt-5.6", "anthropic/claude-sonnet"]) {
      expect(supportsNativeToolSearch(model), model).toBe(false);
    }
  });

  it("names every deferred tool in the roster, grouped by family", () => {
    const deferred = [...PLANNING_TOOLS, { name: "mystery_tool", description: "x", runtimeType: "x", input_schema: { type: "object", properties: {} } } as ToolDefinition];
    const roster = buildToolRoster(deferred);
    expect(roster).toContain("- Plans, todo runs and plan documents: plan_create, plan_update");
    expect(roster).toContain("- Other: mystery_tool");
  });

  it("finds tools by what they do, name hits first", () => {
    const candidates = ALL_TOOLS.filter((tool) => !CORE_TOOL_NAMES.has(tool.name));
    expect(searchTools("rename a symbol", candidates)[0]?.name).toBe("code_rename");
    expect(names(searchTools("update plan step", candidates))).toContain("plan_update");
    expect(searchTools("", candidates)).toEqual([]);
  });

  it("expands only references this request can send", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "ts1", name: "tool_search", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ts1", content: "{\"ok\":true}", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "other", content: "untouched" }] },
    ];
    const refs = new Map([["ts1", ["plan_update", "gone_tool"]]]);
    const out = expandToolReferences(messages, refs, new Set(["plan_update"]));
    expect((out[1]!.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "tool_result",
      tool_use_id: "ts1",
      content: [{ type: "tool_reference", tool_name: "plan_update" }],
      cache_control: { type: "ephemeral" },
    });
    expect(out[2]).toBe(messages[2]);
    // Nothing sendable: the text result stays.
    const none = expandToolReferences(messages, new Map([["ts1", ["gone_tool"]]]), new Set(["plan_update"]));
    expect((none[1]!.content as Array<Record<string, unknown>>)[0]!["content"]).toBe("{\"ok\":true}");
  });

  it("summarizes a description by its first sentence", () => {
    expect(firstSentence("Load tools. Then more.")).toBe("Load tools.");
    expect(firstSentence("No terminator here")).toBe("No terminator here");
  });
});

describe("client-side on-demand loading", () => {
  // OpenAI has no deferral, so this exercises the client-side mechanism.
  const clientOverrides: Partial<Opts> = { provider: "openai", model: "gpt-5.6" };

  it("sends the core plus the loader, and lists the rest in the loader's roster", () => {
    const plan = internals(createSession(clientOverrides))._toolPlan();
    const wire = names(plan.wire);
    expect(wire).toContain("file_read");
    expect(wire).toContain("tool_search");
    expect(wire).not.toContain("plan_update");
    expect(plan.deferred.size).toBe(0);
    const loader = plan.wire.find((tool) => tool.name === "tool_search")!;
    expect(loader.description).toContain("plan_update");
    expect(loader.description).toContain("ticket_file");
    expect(loader.description).not.toContain("file_read,");
  });

  it("adds a loaded tool from the next request on, and remembers it across a restore", async () => {
    const session = scriptedSession([{ type: "tool_use", id: "load", name: "tool_search", input: { names: ["plan_update", "plan_updat"] } }], clientOverrides);
    const events = await drain(session.send("update the plan"));
    const result = resultOf(events, "load");
    expect(result["ok"]).toBe(true);
    expect(result["loaded"]).toEqual([expect.objectContaining({ name: "plan_update" })]);
    expect(result["notFound"]).toEqual([{ name: "plan_updat", didYouMean: "plan_update" }]);

    const plan = internals(session)._toolPlan();
    expect(names(plan.wire)).toContain("plan_update");
    expect(plan.wire.find((tool) => tool.name === "tool_search")!.description).not.toContain("plan_update");

    const state = session.exportState(true);
    expect(state.loadedTools).toEqual(["plan_update"]);
    const restored = createSession(clientOverrides);
    restored.restoreState({ ...state, messages: [] });
    expect(names(internals(restored)._toolPlan().wire)).toContain("plan_update");
  });

  it("loads by query", async () => {
    const session = scriptedSession([{ type: "tool_use", id: "q", name: "tool_search", input: { query: "file a ticket for follow-up work" } }], clientOverrides);
    const result = resultOf(await drain(session.send("go")), "q");
    expect(result["ok"]).toBe(true);
    expect((result["loaded"] as Array<{ name: string }>).map((t) => t.name)).toContain("ticket_file");
  });

  it("counts a deferred tool the model calls directly as loaded", async () => {
    const session = scriptedSession([{ type: "tool_use", id: "m", name: "memory_read", input: {} }], clientOverrides);
    await drain(session.send("recall"));
    expect(names(internals(session)._toolPlan().wire)).toContain("memory_read");
  });

  it("sends the whole catalog when on-demand loading is off", () => {
    const plan = internals(createSession({ ...clientOverrides, toolLoading: () => "all" }))._toolPlan();
    expect(names(plan.wire)).toContain("plan_update");
    expect(names(plan.wire)).not.toContain("tool_search");
  });
});

describe("native (Anthropic) deferral", () => {
  it("sends every tool, defers the non-core ones, and caches on the last loaded tool", () => {
    const tools = internals(createSession())._buildAnthropicWireTools();
    const deferred = tools.filter((tool) => tool["defer_loading"] === true).map((tool) => String(tool["name"]));
    const loaded = tools.filter((tool) => tool["defer_loading"] !== true).map((tool) => String(tool["name"]));
    expect(deferred).toContain("plan_update");
    expect(loaded).toContain("file_read");
    expect(loaded).toContain("tool_search");
    expect(loaded.every((name) => CORE_TOOL_NAMES.has(name))).toBe(true);
    // Loaded tools first, so the breakpoint lands on the last of them; never on a deferred tool.
    const firstDeferred = tools.findIndex((tool) => tool["defer_loading"] === true);
    expect(tools.slice(firstDeferred).every((tool) => tool["defer_loading"] === true)).toBe(true);
    expect(tools[firstDeferred - 1]!["cache_control"]).toBeDefined();
    expect(tools.filter((tool) => tool["cache_control"]).length).toBe(1);
  });

  it("keeps the roster fixed after a load so the cached prefix never changes", async () => {
    const session = scriptedSession([{ type: "tool_use", id: "load", name: "tool_search", input: { names: ["plan_update"] } }]);
    const before = JSON.stringify(internals(session)._buildAnthropicWireTools());
    await drain(session.send("update the plan"));
    expect(JSON.stringify(internals(session)._buildAnthropicWireTools())).toBe(before);
    expect(internals(session)._toolReferenceResults.get("load")).toEqual(["plan_update"]);
  });

  it("serializes a tool_search result as tool_reference blocks", () => {
    const session = createSession();
    session.restoreState({
      messages: [
        { role: "user", content: "update the plan" },
        { role: "assistant", content: [{ type: "tool_use", id: "load", name: "tool_search", input: { names: ["plan_update"] } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "load", content: "{\"ok\":true}" }] },
      ],
      toolReferenceResults: [{ toolUseId: "load", names: ["plan_update"] }],
    } as any);
    const wire = internals(session)._anthropicWireMessages(new Set(names(internals(session)._toolPlan().wire)));
    const result = (wire[2]!.content as Array<Record<string, unknown>>).find((block) => block["type"] === "tool_result");
    expect(result!["content"]).toEqual([{ type: "tool_reference", tool_name: "plan_update" }]);
  });

  it("uses client-side loading on Bedrock Mantle and for models without tool search", () => {
    expect(internals(createSession({ model: "claude-3-7-sonnet-20250219" }))._toolPlan().deferred.size).toBe(0);
    expect(internals(createSession({ provider: "bedrock", bedrockApi: "mantle" }))._toolPlan().deferred.size).toBe(0);
  });
});

describe("PAU measures what on-demand loading saves", () => {
  it("measures only in-context tools and reports the deferred remainder", () => {
    const { inContext, deferred } = internals(createSession({ provider: "openai", model: "gpt-5.6" }))._pauToolSchemas("openai");
    expect(JSON.stringify(inContext).length).toBeLessThan(JSON.stringify(deferred).length);
  });

  it("puts a token estimate for the deferred catalog on the receipt", () => {
    const toolSchemas = [{ name: "file_read", description: "Read a file.".repeat(20), input_schema: { type: "object", properties: {} } }];
    const deferredToolSchemas = Array.from({ length: 6 }, (_, i) => ({ ...toolSchemas[0], name: `tool_${i}` }));
    const traceInput = { system: "s", messages: [{ role: "user", content: "hello there" }] };
    const receipt = capturePauReceipt({ traceInput, format: "anthropic", runId: "r", model: "m", provider: "anthropic", toolSchemas, deferredToolSchemas });
    expect(receipt.skipped).toBe(false);
    if (receipt.skipped) return;
    expect(receipt.toolSchemaTokens).toBeGreaterThan(0);
    expect(receipt.deferredToolSchemaTokens).toBeGreaterThan(receipt.toolSchemaTokens! * 4);
    const plain = capturePauReceipt({ traceInput, format: "anthropic", runId: "r", model: "m", provider: "anthropic", toolSchemas });
    expect(plain.skipped === false && plain.deferredToolSchemaTokens).toBeFalsy();
  });
});
