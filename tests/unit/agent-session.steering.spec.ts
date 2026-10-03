/**
 * Next-step steering: a message the user sends while a run is going reaches the model before the
 * next provider call, without cancelling the run. Driven through a real Bedrock Converse session
 * over a mocked wire, because Converse rejects two user messages in a row — the strictest check
 * that a steer appended after tool results still produces a valid request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, STEER_PREFIX, type AgentEvent } from "../../src/agent-session.js";
import { eventFrame, streamFromChunks, successStream } from "./helpers/bedrock-frames.js";

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

function createBedrockSession(): AgentSession {
  return new AgentSession({
    apiKey: "unused-on-bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true, content: "file body" } })) } as never,
    context: createFakeContext() as never,
    provider: "bedrock",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    maxIterations: 10,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
  } as never);
}

const usageFrame = eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } });

function readRound(id: string, path: string) {
  return streamFromChunks([
    eventFrame("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: id, name: "file_read" } } }),
    eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify({ path }) } } }),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("messageStop", { stopReason: "tool_use" }),
    usageFrame,
  ]);
}

type WireBlock = { text?: string; toolResult?: unknown };
type WireMessage = { role: string; content: WireBlock[] };

function requestMessages(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): WireMessage[] {
  return (JSON.parse(String((fetchMock.mock.calls[callIndex]![1] as RequestInit).body)) as { messages: WireMessage[] }).messages;
}

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("next-step steering", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("delivers a message sent during a tool round with that round's results, in one valid user turn", async () => {
    const session = createBedrockSession();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        // The user types while the model is choosing its tool.
        session.enqueueSteer({ id: "s1", text: "Also check b.ts", userText: "Also check b.ts" });
        return { ok: true, body: readRound("r1", "a.ts") };
      })
      .mockImplementation(async () => ({ ok: true, body: successStream("a.ts and b.ts both export one helper.") }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(session.send("read a.ts", { userText: "read a.ts" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "steer_delivered", ids: ["s1"] });
    const messages = requestMessages(fetchMock, 1);
    // Strict alternation: the steer rides in the tool-result turn, not a second user message.
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const last = messages[2]!.content;
    expect(last.some((block) => block.toolResult)).toBe(true);
    const steer = last.find((block) => block.text?.startsWith(STEER_PREFIX));
    expect(steer?.text).toContain("Also check b.ts");
    expect(session.userPrompts).toEqual(["read a.ts", "Also check b.ts"]);
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("answers a message that arrived while the model was finishing, in the same run", async () => {
    const session = createBedrockSession();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        session.enqueueSteer({ id: "s2", text: "Use British spelling" });
        return { ok: true, body: successStream("Here is the summary, in American spelling.") };
      })
      .mockImplementation(async () => ({ ok: true, body: successStream("Here is the summary, in British spelling.") }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(session.send("summarise the readme"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "steer_delivered", ids: ["s2"] });
    const messages = requestMessages(fetchMock, 1);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2]!.content.map((block) => block.text ?? "").join("\n")).toContain("Use British spelling");
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
  });

  it("leaves a message that arrived after the run ended for the caller to send as the next turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: successStream("Done.") })));
    const session = createBedrockSession();

    await drain(session.send("say done"));
    session.enqueueSteer({ id: "late", text: "and then stop" });

    expect(session.takePendingSteers().map((steer) => steer.id)).toEqual(["late"]);
    expect(session.takePendingSteers()).toEqual([]);
  });

  it("keeps a steer queued through a cancelled run, so the caller can hand it back", async () => {
    const controller = new AbortController();
    const session = createBedrockSession();
    vi.stubGlobal("fetch", vi.fn(async () => {
      session.enqueueSteer({ id: "s3", text: "never mind" });
      controller.abort();
      return { ok: true, body: readRound("r2", "a.ts") };
    }));
    session.attachSignal(controller.signal);

    const events = await drain(session.send("read a.ts", { userText: "read a.ts" }));

    expect(events.some((event) => event.type === "steer_delivered")).toBe(false);
    expect(session.takePendingSteers().map((steer) => steer.id)).toEqual(["s3"]);
  });
});
