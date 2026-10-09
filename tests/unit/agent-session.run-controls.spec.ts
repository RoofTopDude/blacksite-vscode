/* What a long unattended run needs from the loop itself:
   - a turn the harness starts to carry the same request on keeps the user's "Allow all" answers,
     where a turn the user types does not;
   - a turn can be asked to stop at the next tool-round boundary, and does, cleanly;
   - a provider outage can be waited out on a slow schedule instead of ending the run, and the
     wait can be cut short. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, continuesRequest, type AgentEvent } from "../../src/agent-session.js";
import type { ToolUseBlock } from "../../src/agent-loop-contract.js";
import type { ApprovalDecision } from "../../src/approval-gate.js";
import { outageDelayMs, OUTAGE_RETRY_SCHEDULE_MS } from "../../src/provider-retry.js";
import { successStream } from "./helpers/bedrock-frames.js";
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

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("turn origins", () => {
  it("treats only harness-started continuations as the same request", () => {
    expect(continuesRequest(undefined)).toBe(false);
    expect(continuesRequest("user")).toBe(false);
    expect(continuesRequest("run")).toBe(false);
    expect(continuesRequest("steer")).toBe(false);
    expect(continuesRequest("conductor")).toBe(true);
    expect(continuesRequest("resume")).toBe(true);
    expect(continuesRequest("stop_hook")).toBe(true);
  });
});

/** A runtime whose shell commands are gated until the host confirms them. */
function gatedRuntime() {
  return {
    handleMessage: vi.fn(async (message: { type: string; payload: Record<string, unknown> }) => {
      if (message.payload["confirmed"] !== true) {
        return { result: { ok: true, requiresConfirmation: true, tier: "network", description: `Run ${String(message.payload["command"])}` } };
      }
      return { result: { ok: true, stdout: "ran" } };
    }),
  };
}

function install(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "shell_run", input: { command: "npm", args: ["install", id] } };
}

describe("Allow all across a run", () => {
  function make(answers: ApprovalDecision[]) {
    const queue = [...answers];
    const approvalProvider = vi.fn(async () => queue.shift() ?? "deny");
    // Every turn asks for one gated install, once, then finishes.
    const seen = new Set<string>();
    const scripted = new ScriptedProviderSession(({ userTexts }) => {
      const last = userTexts.at(-1) ?? "";
      if (!last.startsWith("go") && !last.startsWith("[")) return { text: "done", stopReason: "end_turn", usage };
      if (seen.has(last)) return { text: "done", stopReason: "end_turn", usage };
      seen.add(last);
      return { toolCalls: [install(`call-${seen.size}`)], stopReason: "tool_use", usage };
    });
    const session = new AgentSession({
      apiKey: "key",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      workspaceRoot: "C:/workspace",
      runtime: gatedRuntime() as never,
      context: context() as never,
      provider: "anthropic",
      maxIterations: 6,
      checkpointingEnabled: false,
      approvalProvider,
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    } as never);
    return { session, approvalProvider };
  }

  it("is kept by turns the harness starts to carry the request on", async () => {
    const { session, approvalProvider } = make(["allow_all"]);
    await drain(session.send("go one"));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
    await drain(session.send("[Automatic plan continuation]\nkeep going", { origin: "conductor", preserveRequestMode: true }));
    await drain(session.send("[Resumed from checkpoint]", { origin: "resume", preserveRequestMode: true }));
    expect(approvalProvider).toHaveBeenCalledTimes(1);
  });

  it("is dropped when the user types a new request", async () => {
    const { session, approvalProvider } = make(["allow_all", "allow"]);
    await drain(session.send("go one"));
    await drain(session.send("go two", { userText: "go two" }));
    expect(approvalProvider).toHaveBeenCalledTimes(2);
  });

  it("is dropped when the run says so", async () => {
    const { session, approvalProvider } = make(["allow_all", "allow"]);
    await drain(session.send("go one"));
    session.clearApprovalGrants();
    await drain(session.send("[Automatic plan continuation]\nkeep going", { origin: "conductor", preserveRequestMode: true }));
    expect(approvalProvider).toHaveBeenCalledTimes(2);
  });
});

describe("pausing at a boundary", () => {
  it("finishes the tool round it is in, then stops as paused instead of starting another", async () => {
    const holder: { session?: AgentSession } = {};
    let rounds = 0;
    const scripted = new ScriptedProviderSession(() => {
      rounds += 1;
      return { toolCalls: [{ type: "tool_use", id: `read-${rounds}`, name: "file_read", input: { path: "a.txt" } }], stopReason: "tool_use", usage };
    });
    const runtime = {
      handleMessage: vi.fn(async () => {
        // The pause is asked for while a tool is running.
        holder.session!.requestPause();
        return { result: { ok: true, content: "text" } };
      }),
    };
    const session = new AgentSession({
      apiKey: "key",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      workspaceRoot: "C:/workspace",
      runtime: runtime as never,
      context: context() as never,
      provider: "anthropic",
      maxIterations: 20,
      checkpointingEnabled: false,
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    } as never);
    holder.session = session;

    const events = await drain(session.send("work"));
    const complete = events.find((event) => event.type === "turn_complete");
    expect(complete).toMatchObject({ stopReason: "paused" });
    // One model call, one tool round: nothing was cut off and nothing new was started.
    expect(rounds).toBe(1);
    expect(events.filter((event) => event.type === "tool_call_result")).toHaveLength(1);
    expect(session.runtimeState.lastStopReason).toBe("paused");
  });

  it("does not carry a stale pause into the next turn", async () => {
    const scripted = new ScriptedProviderSession(() => ({ text: "ok", stopReason: "end_turn", usage }));
    const session = new AgentSession({
      apiKey: "key",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
      context: context() as never,
      provider: "anthropic",
      maxIterations: 4,
      checkpointingEnabled: false,
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    } as never);
    session.requestPause();
    const events = await drain(session.send("hello"));
    expect(events.find((event) => event.type === "turn_complete")).toMatchObject({ stopReason: "end_turn" });
  });

  it("shows the model a note about where it stopped, for one turn only", async () => {
    let tail = "";
    const scripted = new ScriptedProviderSession(() => ({ text: "ok", stopReason: "end_turn", usage }));
    const session = new AgentSession({
      apiKey: "key",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      workspaceRoot: "C:/workspace",
      runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
      context: context() as never,
      provider: "anthropic",
      maxIterations: 4,
      checkpointingEnabled: false,
      memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
      providerTurnSessionFactory: () => scripted,
    } as never);
    const dynamic = () => (session as unknown as { _dynamicContext(): string })._dynamicContext();
    session.setRunNotice("Stopped: Paused at the end of a step.");
    // Armed for the next turn, not shown until it begins.
    expect(dynamic()).not.toContain("Paused at the end of a step.");
    const stream = session.send("continue");
    await stream.next();
    tail = dynamic();
    await drain(stream);
    expect(tail).toContain("Stopped: Paused at the end of a step.");
    expect(dynamic()).not.toContain("Paused at the end of a step.");
  });
});

describe("outage schedule", () => {
  it("backs off from half a minute to five and never waits longer than what is left", () => {
    expect(OUTAGE_RETRY_SCHEDULE_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(outageDelayMs(0, 1_000_000)).toBe(30_000);
    expect(outageDelayMs(2, 1_000_000)).toBe(120_000);
    expect(outageDelayMs(9, 1_000_000)).toBe(300_000);
    expect(outageDelayMs(0, 12_000)).toBe(12_000);
    expect(outageDelayMs(0, -5)).toBe(0);
  });
});

function bedrockSession(outageMs: () => number) {
  return new AgentSession({
    apiKey: "unused-on-bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    systemPrompt: "test",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: context() as never,
    provider: "bedrock",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    maxIterations: 5,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    providerOutageWaitMs: outageMs,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

/** Let the fake clock run in small steps until the promise settles, so the test never depends on
 *  guessing the exact total wait. */
async function runClockUntil<T>(promise: Promise<T>, stepMs = 5_000, maxSteps = 120): Promise<T> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < maxSteps && !settled; i++) await vi.advanceTimersByTimeAsync(stepMs);
  return promise;
}

function unavailable(): Response {
  return new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503, headers: { "retry-after": "0" } });
}

describe("waiting out a provider outage", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("keeps trying on a slow schedule and finishes the turn when the provider comes back", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => unavailable())
      .mockImplementationOnce(async () => unavailable())
      .mockImplementationOnce(async () => unavailable())
      .mockImplementationOnce(async () => unavailable())
      .mockImplementation(async () => ({ ok: true, body: successStream("Back again") }));
    vi.stubGlobal("fetch", fetchMock);
    const session = bedrockSession(() => 10 * 60_000);
    const startedAt = Date.now();
    const events = await runClockUntil(drain(session.send("hello")));

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    const outage = events.find((event) => event.type === "provider_activity" && (event as { outage?: boolean }).outage);
    expect(outage).toBeDefined();
    // The first slow wait is half a minute away.
    const retryAt = (outage as { retryAt?: number }).retryAt ?? 0;
    expect(retryAt).toBeGreaterThanOrEqual(startedAt + 29_000);
    expect(retryAt).toBeLessThanOrEqual(startedAt + 31_000);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("gives up once the allowed wait is spent, so a long outage cannot hold a run forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    const session = bedrockSession(() => 20_000);
    const events = await runClockUntil(drain(session.send("hello")));
    expect(events.some((event) => event.type === "provider_activity" && (event as { outage?: boolean }).outage)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "error" });
  });

  it("does not wait at all unless a run asked it to", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    const session = bedrockSession(() => 0);
    const events = await runClockUntil(drain(session.send("hello")));
    expect(events.some((event) => event.type === "provider_activity" && (event as { outage?: boolean }).outage)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "error" });
  });

  it("tries again at once when told to, instead of finishing the wait", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => unavailable())
      .mockImplementationOnce(async () => unavailable())
      .mockImplementation(async () => ({ ok: true, body: successStream("Back again") }));
    vi.stubGlobal("fetch", fetchMock);
    const session = bedrockSession(() => 10 * 60_000);
    const startedAt = Date.now();
    const collected = drain(session.send("hello"));
    // Let the failures happen and the wait begin, without letting anything like 30 seconds pass.
    let woke = false;
    for (let i = 0; i < 200 && !woke; i++) {
      await vi.advanceTimersByTimeAsync(1);
      woke = session.retryProviderNow();
    }
    const events = await runClockUntil(collected, 50, 40);
    expect(woke).toBe(true);
    // Far less than the 30 seconds the wait was scheduled for.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
    expect(session.retryProviderNow()).toBe(false);
  });
});
