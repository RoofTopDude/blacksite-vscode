/*
  Phases 3 and 4 of the context-economy plan through a real AgentSession: aging (observe and on),
  the history budget, honest stubs on the emergency path, the agent-facing status line, the context
  tool, and the carry-forward note compaction keeps. The transport is scripted at the
  ModelTransport seam and reports usage close to the ledger's own estimate, so calibration is ~1.
*/
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelTransport, ProviderTurnStreamEvent, ToolUseBlock } from "@blacksite-agent/llm";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import { BASELINE_CONTEXT_FLAGS, type ContextFlags } from "../../src/context/flags.js";

const FILE_CHARS = 20_000;

function requestChars(req: ModelRequest): number {
  return req.system.length + req.systemSummary.length + (req.contextStable?.length ?? 0) + req.contextTail.length
    + JSON.stringify(req.messages).length + JSON.stringify(req.tools.wire).length;
}

/** One file read per round from `calls`, then a final answer. */
function transport(calls: Array<ToolUseBlock | ToolUseBlock[]>) {
  const requests: ModelRequest[] = [];
  const t: ModelTransport & { requests: ModelRequest[] } = {
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
      requests.push({ ...req, messages: [...req.messages] });
      const step = calls[requests.length - 1];
      if (step) {
        for (const block of [step].flat()) yield { type: "tool_use_block", block };
        yield { type: "stop_reason", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "Done." };
        yield { type: "stop_reason", reason: "end_turn" };
      }
      yield { type: "usage_update", inputTokens: Math.ceil(requestChars(req) / 3.6), outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return t;
}

const read = (id: string, path: string): ToolUseBlock => ({ type: "tool_use", id, name: "file_read", input: { path } });

function session(t: ModelTransport, flags: Partial<ContextFlags>, extra: Record<string, unknown> = {}) {
  return new AgentSession({
    apiKey: "synthetic",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "Synthetic aging fixture",
    workspaceRoot: "C:/workspace",
    checkpointingEnabled: false,
    maxIterations: 40,
    compressionKeepRecent: 4,
    modelTransport: t,
    contextFlags: () => ({ ...BASELINE_CONTEXT_FLAGS, ...flags }),
    runtime: {
      handleMessage: vi.fn(async (message: { payload?: { path?: string } }) => ({
        result: { ok: true, path: message.payload?.path, content: `${message.payload?.path}\n${"z".repeat(FILE_CHARS)}` },
      })),
    } as never,
    context: { workspaceState: { get: () => undefined, update: async () => {} } } as never,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" } as never,
    ...extra,
  });
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function resultContents(s: AgentSession): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of s.history) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) if (block.type === "tool_result") out.set(block.tool_use_id, block.content);
  }
  return out;
}

const eightReads = (): ToolUseBlock[] => [
  read("r1", "src/a.ts"), read("r2", "src/b.ts"), read("r3", "src/a.ts"), read("r4", "src/c.ts"),
  read("r5", "src/d.ts"), read("r6", "src/e.ts"), read("r7", "src/f.ts"), read("r8", "src/g.ts"),
];

describe("aging", () => {
  it("off: history keeps every result in full", async () => {
    const s = session(transport(eightReads()), { historyBudgetTokens: 20_000 });
    await drain(s.send("Read them."));
    for (const content of resultContents(s).values()) expect(content).not.toContain("_setAside");
  });

  it("observe: reports what it would set aside and changes nothing", async () => {
    const s = session(transport(eightReads()), { historyBudgetTokens: 20_000, aging: "observe", report: true });
    const events = await drain(s.send("Read them."));
    const notes = events.filter((e) => e.type === "execution_diagnostic" && e.message.startsWith("Aging (observe)"));
    expect(notes.length).toBeGreaterThan(0);
    for (const content of resultContents(s).values()) expect(content).not.toContain("_setAside");
    const report = events.find((e): e is Extract<AgentEvent, { type: "context_report" }> => e.type === "context_report")!.report;
    expect(report.aging.wouldSetAside.count).toBeGreaterThan(0);
    expect(report.aging.setAside.count).toBe(0);
  });

  it("on: over the budget, sets older results aside behind records, superseded first, never the recent window", async () => {
    const t = transport(eightReads());
    const s = session(t, { historyBudgetTokens: 20_000, aging: "on", report: true });
    const events = await drain(s.send("Read them."));
    const contents = resultContents(s);
    const setAside = [...contents.entries()].filter(([, content]) => content.includes("_setAside")).map(([id]) => id);
    expect(setAside.length).toBeGreaterThan(0);
    expect(setAside).toContain("r1"); // superseded by r3
    expect(JSON.parse(contents.get("r1")!)._setAside.why).toContain("r3");
    // The last two rounds (four messages) are the recent window.
    expect(setAside).not.toContain("r8");
    expect(setAside).not.toContain("r7");
    // Requests stay bounded. The floor is the frame (system prompt and ~14k of tool definitions)
    // plus the protected recent window; without aging, every read stays in full.
    const off = transport(eightReads());
    await drain(session(off, { historyBudgetTokens: 20_000 }).send("Read them."));
    const withAging = requestTokens(t.requests.at(-1)!);
    const without = requestTokens(off.requests.at(-1)!);
    expect(withAging).toBeLessThan(without * 0.6);
    // What the model was shown says how to get it back, and it works.
    const record = JSON.parse(contents.get("r2")!)._setAside;
    expect(record.recover).toContain('toolCallId "r2"');
    const page = (s as unknown as { _toolOutput: { page(p: Record<string, unknown>): { content: string } } })._toolOutput.page({ toolCallId: "r2" });
    expect(page.content).toContain("src/b.ts");
    // The full history keeps the originals.
    const full = s.fullHistory.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
    expect(full.some((b) => b.type === "tool_result" && b.tool_use_id === "r2" && !b.content.includes("_setAside"))).toBe(true);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.startsWith("Set aside"))).toBe(true);
    const report = events.find((e): e is Extract<AgentEvent, { type: "context_report" }> => e.type === "context_report")!.report;
    expect(report.aging.setAside.count).toBe(setAside.length);
  });

  it("never sets aside a question card answer", async () => {
    const calls: Array<ToolUseBlock | ToolUseBlock[]> = [read("r1", "src/a.ts"), read("r2", "src/b.ts"), read("r3", "src/c.ts"), read("r4", "src/d.ts"), read("r5", "src/e.ts"), read("r6", "src/f.ts")];
    const s = session(transport(calls), { historyBudgetTokens: 15_000, aging: "on" });
    // Seed an answered question card at the start of history, large enough to qualify.
    (s as unknown as { messages: unknown[] }).messages.push(
      { role: "user", content: "Start." },
      { role: "assistant", content: [{ type: "tool_use", id: "q1", name: "question_card", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: JSON.stringify({ answer: "y".repeat(FILE_CHARS) }) }] },
    );
    await drain(s.send("Read them."));
    expect(resultContents(s).get("q1")).not.toContain("_setAside");
  });
});

function requestTokens(req: ModelRequest): number {
  return Math.ceil(requestChars(req) / 3.6);
}

describe("history budget", () => {
  it("brings the compaction line forward, and only forward", () => {
    const window = 200_000;
    const make = (budget: number) => session(transport([]), { historyBudgetTokens: budget }, { contextLength: window }) as unknown as {
      _compactionThresholdTokens(): number; _compactionFillPct(): number; _contextFillLabel(pct: number): string; _lastInputTokens: number;
    };
    const none = make(0);
    expect(none._compactionThresholdTokens()).toBe(120_000);
    const budgeted = make(50_000);
    expect(budgeted._compactionThresholdTokens()).toBe(50_000);
    budgeted._lastInputTokens = 50_000;
    // 25% of the window, but at the budget: reads as the 60% trigger.
    expect(budgeted._compactionFillPct()).toBe(60);
    expect(budgeted._contextFillLabel(60)).toContain("50k history budget");
    expect(make(500_000)._compactionThresholdTokens()).toBe(120_000);
  });
});

describe("emergency stubs", () => {
  it("say how to read the result back instead of asking for a re-run", async () => {
    const s = session(transport([read("r1", "src/a.ts"), read("r2", "src/b.ts"), read("r3", "src/c.ts"), read("r4", "src/d.ts")]), {});
    await drain(s.send("Read them."));
    const freed = (s as unknown as { _emergencyTruncateOldestToolResults(target: number): number })._emergencyTruncateOldestToolResults(10_000_000);
    expect(freed).toBeGreaterThan(0);
    const stub = JSON.parse(resultContents(s).get("r1")!);
    expect(stub._setAside.why).toContain("compaction could not free enough");
    expect(stub._setAside.recover).toContain("tool_output_page");
    expect(JSON.stringify(stub)).not.toContain("re-run the tool");
  });
});

describe("awareness", () => {
  it("status: the live block carries facts about the context from the second request on", async () => {
    const t = transport([read("r1", "src/a.ts"), read("r2", "src/b.ts")]);
    await drain(session(t, { awareness: "status" }).send("Read them."));
    expect(t.requests[0]!.contextTail).not.toContain("# Context");
    const tail = t.requests[1]!.contextTail;
    expect(tail).toContain("# Context");
    expect(tail).toMatch(/Last request: ~[\d,k]+ tokens, \d+% of the [\d,k]+ at which older history is summarised/);
    expect(tail).toContain("tool_output_page reads any result back by toolCallId");
    expect(tail).not.toContain("context tool");
  });

  it("off: no status line", async () => {
    const t = transport([read("r1", "src/a.ts"), read("r2", "src/b.ts")]);
    await drain(session(t, {}).send("Read them."));
    for (const request of t.requests) expect(request.contextTail).not.toContain("# Context");
  });

  it("the context tool reviews, sets aside with a note, and stores a carry-forward note", async () => {
    const context = (id: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name: "context", input });
    const t = transport([
      read("r1", "src/a.ts"),
      read("r2", "src/b.ts"),
      context("c1", { action: "review" }),
      context("c2", { action: "set_aside", ids: ["r1", "c1", "nope"], note: "a.ts exports run()" }),
      context("c3", { action: "carry_forward", note: "Goal: rename run() to start() in a.ts and b.ts." }),
    ]);
    const s = session(t, { awareness: "status+tool", report: true });
    const events = await drain(s.send("Work on it."));
    const results = new Map(events.filter((e): e is Extract<AgentEvent, { type: "tool_call_result" }> => e.type === "tool_call_result").map((e) => [e.toolCallId, e.result as Record<string, any>]));

    const review = results.get("c1")!;
    expect(review.ok).toBe(true);
    expect(review.toolResults.map((r: { toolCallId: string }) => r.toolCallId)).toEqual(expect.arrayContaining(["r1", "r2"]));
    expect(review.compactionAtTokens).toBeGreaterThan(0);

    const setAside = results.get("c2")!;
    expect(setAside.setAside).toContain("r1");
    expect(setAside.skipped).toEqual(expect.arrayContaining([{ toolCallId: "nope", reason: "not in the current context" }]));
    expect(setAside.freedTokensPerRequest).toBeGreaterThan(1_000);
    expect(setAside.recachedOnceTokens).toBeGreaterThan(0);
    const record = JSON.parse(resultContents(s).get("r1")!)._setAside;
    expect(record).toMatchObject({ note: "a.ts exports run()", why: "you set it aside" });

    expect(results.get("c3")).toMatchObject({ ok: true, replacedEarlierNote: false });
    const exported = s.exportState();
    expect(exported.carryForwardNote).toBe("Goal: rename run() to start() in a.ts and b.ts.");
    const tail = t.requests.at(-1)!.contextTail;
    expect(tail).toContain("A carry-forward note");
    expect(tail).toContain("The context tool");

    const report = events.find((e): e is Extract<AgentEvent, { type: "context_report" }> => e.type === "context_report")!.report;
    expect(report.aging.byAgent.count).toBeGreaterThan(0);
  });

  it("refuses the context tool when awareness is not at status+tool", () => {
    const s = session(transport([]), { awareness: "status" }) as unknown as { _handleContextTool(p: Record<string, unknown>): { ok: boolean } };
    expect(s._handleContextTool({ action: "review" }).ok).toBe(false);
  });
});

describe("carry-forward note through compaction", () => {
  it("is kept verbatim ahead of the summary, once", async () => {
    const compress = vi.fn(async () => "SUMMARY OF OLD WORK");
    const s = session(transport(eightReads()), { awareness: "status+tool" }, { compressionProvider: { compress } });
    await drain(s.send("Read them."));
    const internals = s as unknown as {
      _carryForwardNote: string; _compressedSummary: string;
      _compressHistory(provider: unknown, trigger: string): Promise<string>;
    };
    internals._carryForwardNote = "Decided: keep the old API until v2.";
    expect(await internals._compressHistory({ compress }, "manual")).toBe("compressed");
    expect(internals._compressedSummary).toContain("[Carried forward by the agent before this compaction, verbatim]\nDecided: keep the old API until v2.");
    expect(internals._compressedSummary.indexOf("Decided")).toBeLessThan(internals._compressedSummary.indexOf("SUMMARY OF OLD WORK"));
    expect(internals._carryForwardNote).toBe("");
  });
});
