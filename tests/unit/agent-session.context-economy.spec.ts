/*
  Context economy through a real AgentSession: the per-turn context report (Phase 0), the ledger
  fed from real tool calls (Phase 1), and stable caching's split of the attached context (Phase 2).
  The transport is faked at the ModelTransport seam, so every request the session builds is seen
  exactly as a route would receive it.
*/
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelTransport, ProviderTurnStreamEvent } from "@blacksite-agent/llm";
import { toSubscriptionRequest } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ContextFlags } from "../../src/context/flags.js";
import { createStructuredEventEntry } from "../../src/execution-log-format.js";

function readTransport(rounds: number) {
  const requests: ModelRequest[] = [];
  const transport: ModelTransport & { requests: ModelRequest[] } = {
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
      requests.push({ ...req, messages: [...req.messages] });
      const n = requests.length;
      if (n <= rounds) {
        // Reads the same file twice, so the second read supersedes the first.
        yield { type: "tool_use_block", block: { type: "tool_use", id: `read_${n}`, name: "file_read", input: { path: "src/app.ts" } } };
        yield { type: "stop_reason", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "Done." };
        yield { type: "stop_reason", reason: "end_turn" };
      }
      yield { type: "usage_update", inputTokens: 200, outputTokens: 20, cacheReadTokens: 800 * (n - 1), cacheWriteTokens: n === 1 ? 900 : 50 };
    },
  };
  return transport;
}

function session(transport: ModelTransport, flags: Partial<ContextFlags>) {
  let refresh = 0;
  return new AgentSession({
    apiKey: "synthetic",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "Synthetic context-economy fixture",
    workspaceRoot: "C:/workspace",
    checkpointingEnabled: false,
    modelTransport: transport,
    contextFlags: () => ({ report: false, stableCaching: false, ...flags }),
    workspaceContextProvider: async () => {
      refresh += 1;
      return {
        combined: `# Current workspace state\nInstructions: use tabs.\nGit: ${refresh} changed`,
        stable: "# Workspace: repository and project state\nInstructions: use tabs.",
        live: `# Current workspace state: live\nGit: ${refresh} changed`,
      };
    },
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, content: "export const app = 1;\n".repeat(40) } })) } as never,
    context: { workspaceState: { get: () => undefined, update: async () => {} } } as never,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" } as never,
  });
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("context report", () => {
  it("is emitted once per turn, before turn_complete, with what every request carried", async () => {
    const transport = readTransport(2);
    const events = await drain(session(transport, { report: true }).send("Read app.ts twice."));
    const reports = events.filter((event): event is Extract<AgentEvent, { type: "context_report" }> => event.type === "context_report");
    expect(reports).toHaveLength(1);
    const index = events.findIndex((event) => event.type === "context_report");
    expect(events.findIndex((event) => event.type === "turn_complete")).toBeGreaterThan(index);

    const report = reports[0]!.report;
    expect(report.turn.requests).toBe(transport.requests.length);
    expect(report.turn.requests).toBe(3);
    expect(report.turn).toMatchObject({ input: 600, cacheRead: 2400, cacheWrite: 1000, output: 60 });
    expect(report.latest!.byClassTokens["tool-result"]).toBeGreaterThan(0);
    expect(report.latest!.byClassTokens.system).toBeGreaterThan(0);
    expect(report.toolResults).toMatchObject({ count: 2, superseded: { count: 1 } });
    expect(report.toolResults!.repeatedReads).toEqual([{ path: "src/app.ts", reads: 2 }]);
    expect(report.calibrationRatio).not.toBeNull();
  });

  it("reaches the execution log with every figure intact", async () => {
    const events = await drain(session(readTransport(2), { report: true }).send("Read app.ts twice."));
    const event = events.find((e) => e.type === "context_report")!;
    const entry = createStructuredEventEntry({ ts: "t", workspaceRoot: "C:/workspace", turnCount: 1 } as never, event);
    const logged = (entry.data as { report: Record<string, any> }).report;
    // The generic key filter blanks anything named like a token or a session.
    expect(JSON.stringify(logged)).not.toContain("[redacted]");
    expect(JSON.stringify(logged)).not.toContain("[depth-limit]");
    expect(logged).toEqual(JSON.parse(JSON.stringify((event as Extract<AgentEvent, { type: "context_report" }>).report)));
  });

  it("is not emitted with reports off", async () => {
    const events = await drain(session(readTransport(1), {}).send("Read app.ts."));
    expect(events.some((event) => event.type === "context_report")).toBe(false);
  });

  it("keeps the session totals across turns and restarts the turn's", async () => {
    const transport = readTransport(0);
    const s = session(transport, { report: true });
    await drain(s.send("one"));
    const events = await drain(s.send("two"));
    const report = events.find((event): event is Extract<AgentEvent, { type: "context_report" }> => event.type === "context_report")!.report;
    expect(report.turn.requests).toBe(1);
    expect(report.session.requests).toBe(2);
  });
});

describe("archive through the session", () => {
  it("lets the agent page back into a result that fit inline", async () => {
    const transport = readTransport(1);
    const s = session(transport, {});
    await drain(s.send("Read app.ts."));
    const page = (s as unknown as { _toolOutput: { page(p: Record<string, unknown>): unknown } })._toolOutput.page({ toolCallId: "read_1" });
    expect(page).toMatchObject({ ok: true, hasMore: false });
    expect(JSON.stringify(page)).toContain("export const app = 1;");
  });
});

describe("stable caching", () => {
  it("off: no stable block, and the tail carries the combined workspace block as before", async () => {
    const transport = readTransport(1);
    await drain(session(transport, {}).send("Read app.ts."));
    for (const request of transport.requests) {
      expect(request.contextStable).toBeUndefined();
      expect(request.contextTail).toContain("Instructions: use tabs.");
      expect(request.contextTail).toContain("# Current workspace state\n");
    }
  });

  it("on: the stable block is byte-identical across tool rounds while the live tail changes", async () => {
    const transport = readTransport(3);
    await drain(session(transport, { stableCaching: true }).send("Read app.ts three times."));
    const [first, ...rest] = transport.requests;
    expect(first!.contextStable).toContain("Instructions: use tabs.");
    expect(first!.contextStable).toContain("<blacksite-session-context>");
    for (const request of rest) expect(request.contextStable).toBe(first!.contextStable);
    for (const request of transport.requests) expect(request.contextTail).not.toContain("Instructions: use tabs.");
    expect(new Set(transport.requests.map((request) => request.contextTail)).size).toBe(transport.requests.length);
  });

  it("on the ChatGPT route, rides ahead of the tail: the same text the route carried before", () => {
    const base = {
      model: "gpt-5.5", system: "S", systemSummary: "", messages: [], conversationId: "c", turnIndex: 0,
      tools: { wire: [], deferred: new Set<string>() },
      thinking: { maxTokens: 1000 } as never,
    };
    expect(toSubscriptionRequest({ ...base, contextTail: "LIVE", contextStable: "STABLE" }, {}).contextTail).toBe("STABLE\n\nLIVE");
    expect(toSubscriptionRequest({ ...base, contextTail: "LIVE" }, {}).contextTail).toBe("LIVE");
    expect(toSubscriptionRequest({ ...base, contextTail: "" }, {}).contextTail).toBeUndefined();
  });
});
