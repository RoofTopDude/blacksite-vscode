/**
 * End-to-end coverage for the two defects that made Bedrock runs crash mid-run and on the final
 * answer. Both live in the shared loop; Bedrock is simply the provider that reaches them.
 *
 *  1. A transient failure reported *inside* a 200 stream (Bedrock's in-band `throttlingException`
 *     and friends) bypassed the entire retry layer — `_fetchWithRetry` only covers the pre-stream
 *     phase — and was thrown straight to the turn's terminal handler. One throttle ended the run.
 *
 *  2. That throw then rejected `turnPromise`, which nothing ever awaited on the error path (the
 *     queue's rejection reaches the caller first), so Node saw an unhandled rejection and the
 *     extension host faulted instead of reporting a turn error.
 *
 * These drive a real AgentSession over a mocked Bedrock wire, so they pin the actual behaviour
 * rather than a classifier in isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { ContentBlock } from "../../src/agent-loop-contract.js";
import { successStream, failingStream } from "./helpers/bedrock-frames.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

function createBedrockSession() {
  return new AgentSession({
    apiKey: "unused-on-bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as never,
    context: createFakeContext() as never,
    provider: "bedrock",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    maxIterations: 5,
    checkpointingEnabled: false,
    // Keep backoff effectively instant; the retry *decision* is what is under test, not the wait.
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function assistantText(session: AgentSession): string {
  const assistant = [...session.history].reverse().find((m) => m.role === "assistant");
  if (!assistant) return "";
  if (typeof assistant.content === "string") return assistant.content;
  return (assistant.content as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Fails the test if the run leaves an unhandled promise rejection behind — the crash itself. */
function watchUnhandledRejections(): { readonly seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { seen.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => { process.off("unhandledRejection", onUnhandled); },
  };
}

/** Give Node a chance to report an unhandled rejection (it fires on a later macrotask). */
async function flushRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("mid-stream provider failures", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("retries a Bedrock throttle that struck mid-response and keeps only the retry's output", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: failingStream("Here is the par", "throttlingException", "Too many requests") })
      .mockResolvedValueOnce({ ok: true, body: successStream("Here is the complete answer.") });
    vi.stubGlobal("fetch", fetchMock);

    const session = createBedrockSession();
    const events = await collect(session, "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The turn completed normally instead of dying on the throttle.
    const complete = events.filter((e) => e.type === "turn_complete").at(-1);
    expect(complete).toMatchObject({ stopReason: "end_turn" });
    expect(events.some((e) => e.type === "error")).toBe(false);

    // The partial answer was explicitly discarded, not spliced onto the retry.
    expect(events.some((e) => e.type === "turn_reset")).toBe(true);
    expect(assistantText(session)).toBe("Here is the complete answer.");
    expect(assistantText(session)).not.toContain("Here is the par");
  });

  it("tells the user why the answer restarted", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, body: failingStream("part", "serviceUnavailableException", "Service unavailable") })
      .mockResolvedValueOnce({ ok: true, body: successStream("done") }));

    const events = await collect(createBedrockSession(), "hello");
    const diagnostics = events
      .filter((e): e is Extract<AgentEvent, { type: "execution_diagnostic" }> => e.type === "execution_diagnostic")
      .map((e) => e.message);
    expect(diagnostics.some((m) => /retrying/i.test(m) && /serviceUnavailableException/.test(m))).toBe(true);
  });

  it("does not retry a validation failure — replaying a broken request cannot fix it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, body: failingStream("x", "validationException", "bad input") });
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createBedrockSession(), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const complete = events.filter((e) => e.type === "turn_complete").at(-1);
    expect(complete).toMatchObject({ stopReason: "error" });
  });

  it("gives up after the retry budget and reports a clean error rather than hanging", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, body: failingStream("x", "throttlingException", "still throttled") });
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(createBedrockSession(), "hello");

    expect(fetchMock).toHaveBeenCalledTimes(3); // maxAttempts
    const complete = events.filter((e) => e.type === "turn_complete").at(-1);
    expect(complete).toMatchObject({ stopReason: "error" });
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  /**
   * The crash. Before the fix, `turnPromise` was rejected by its own `.catch(err => { …; throw err })`
   * while the error surfaced to the caller through the event queue instead — so the rejection was
   * never observed, and the extension host had no `unhandledRejection` handler to absorb it.
   */
  it("leaves no unhandled promise rejection when a turn fails terminally", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: failingStream("x", "validationException", "bad input") }));

    const watcher = watchUnhandledRejections();
    try {
      const events = await collect(createBedrockSession(), "hello");
      await flushRejections();

      // The failure is reported as a normal turn error…
      expect(events.filter((e) => e.type === "turn_complete").at(-1)).toMatchObject({ stopReason: "error" });
      // …and nothing escaped as an unhandled rejection.
      expect(watcher.seen).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  it("leaves no unhandled rejection when the request itself fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("Bedrock 403: invalid security token"), { name: "Error" })));

    const watcher = watchUnhandledRejections();
    try {
      await collect(createBedrockSession(), "hello");
      await flushRejections();
      expect(watcher.seen).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});
