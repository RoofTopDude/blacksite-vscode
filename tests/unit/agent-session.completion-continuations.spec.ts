/**
 * End-of-turn continuations, driven through a real Bedrock Converse session over a mocked wire so
 * the assertions see the request bodies that actually leave — the per-turn context tail and the
 * harness messages — rather than a scripted provider's view of them.
 *
 *  - A reply that only reasoned (thinking, no text, no tool call) leaves nothing on screen, and must
 *    get the same recovery as a blank one; thinking models produce that shape, not a blank reply.
 *  - Outstanding map-note and verification debt is listed in the tail before the model writes its
 *    final answer, and when the end-of-turn reminder still fires, both debts go out as ONE message
 *    that asks for the complete answer again — the transcript renders only the text after the last
 *    tool call as the reply, so a reminder that is merely obeyed buries the real summary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent } from "../../src/agent-session.js";
import type { EditProvider, EditResult } from "../../src/diff-edit-service.js";
import type { GraphAnnotationProvider } from "../../src/graph-annotation-store.js";
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

const editProvider = {
  applyEdit: async (input: { path: string }): Promise<EditResult> => ({ ok: true, path: input.path, replacements: 1 }),
} as EditProvider;

const graphProvider: GraphAnnotationProvider = {
  async dispatch(op, payload) {
    if (op === "add") return { ok: true, note: { id: "note-1", from: String(payload.from ?? ""), note: String(payload.note ?? "") } };
    if (op === "list") return { ok: true, notes: [] };
    return { ok: false, error: `Unknown map operation: ${op}` };
  },
};

function createBedrockSession() {
  return new AgentSession({
    apiKey: "unused-on-bedrock",
    model: "anthropic.claude-sonnet-4-6-v1:0",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: {
      handleMessage: vi.fn(async (message: { type: string }) => ({
        result: message.type === "test.run" ? { ok: true, passed: 3, failed: 0, skipped: 0 } : { ok: true, content: "file body" },
      })),
    } as never,
    context: createFakeContext() as never,
    provider: "bedrock",
    bedrock: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
    maxIterations: 10,
    checkpointingEnabled: false,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    editProvider,
    graphProvider,
  } as never);
}

const usageFrame = eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } });

function toolRoundStream(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
  return streamFromChunks([
    ...calls.flatMap((call, index) => [
      eventFrame("contentBlockStart", { contentBlockIndex: index, start: { toolUse: { toolUseId: call.id, name: call.name } } }),
      eventFrame("contentBlockDelta", { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(call.input) } } }),
      eventFrame("contentBlockStop", { contentBlockIndex: index }),
    ]),
    eventFrame("messageStop", { stopReason: "tool_use" }),
    usageFrame,
  ]);
}

function thinkingOnlyStream() {
  return streamFromChunks([
    eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "The result answers it; nothing left to do." } } }),
    eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-abc" } } }),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("messageStop", { stopReason: "end_turn" }),
    usageFrame,
  ]);
}

type WireMessage = { role: string; content: Array<{ text?: string }> };

function requestMessages(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): WireMessage[] {
  return (JSON.parse(String((fetchMock.mock.calls[callIndex]![1] as RequestInit).body)) as { messages: WireMessage[] }).messages;
}

/** All text carried by the final (user) message of a request — harness messages plus the context tail. */
function lastMessageText(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string {
  const messages = requestMessages(fetchMock, callIndex);
  return messages[messages.length - 1]!.content.map((block) => block.text ?? "").join("\n");
}

async function drain(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

describe("end-of-turn continuations on the real Bedrock Converse wire", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("recovers a post-tool reply that only reasoned, and offers the finished case a way out", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, body: toolRoundStream([{ id: "r1", name: "file_read", input: { path: "a.ts" } }]) }))
      .mockImplementationOnce(async () => ({ ok: true, body: thinkingOnlyStream() }))
      .mockImplementation(async () => ({ ok: true, body: successStream("a.ts exports one helper.") }));
    vi.stubGlobal("fetch", fetchMock);

    const events = await drain(createBedrockSession().send("read a.ts and tell me what it does"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.some((e) => e.type === "execution_diagnostic" && e.message.includes("no visible text"))).toBe(true);
    const continuation = lastMessageText(fetchMock, 2);
    expect(continuation).toContain("Your last response had no visible text.");
    expect(continuation).toContain("If the task is complete, write your final answer now.");
    expect(events.at(-1)).toMatchObject({ type: "turn_complete", stopReason: "end_turn" });
  });

  it("lists outstanding debt before the answer, then sends one combined reminder that asks for the answer again", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        body: toolRoundStream([{ id: "e1", name: "file_edit", input: { path: "src/a.ts", oldString: "a", newString: "b" } }]),
      }))
      // Summarizes straight away, before noting or verifying — the case the reminder exists for.
      .mockImplementationOnce(async () => ({ ok: true, body: successStream("Changed a to b in src/a.ts.") }))
      .mockImplementationOnce(async () => ({
        ok: true,
        body: toolRoundStream([
          { id: "n1", name: "map_note_add", input: { from: "src/a.ts", note: "Swapped a for b so the helper matches the spec." } },
          { id: "v1", name: "test_run", input: { filter: "a" } },
        ]),
      }))
      .mockImplementation(async () => ({ ok: true, body: successStream("Changed a to b in src/a.ts; its tests pass.") }));
    vi.stubGlobal("fetch", fetchMock);

    const session = createBedrockSession();
    const events = await drain(session.send("change a to b in src/a.ts"));

    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Right after the edit, the tail already names what is owed.
    const afterEdit = lastMessageText(fetchMock, 1);
    expect(afterEdit).toContain("# Before your final answer");
    expect(afterEdit).toContain("map_note_add");
    expect(afterEdit).toContain("A verification check after your last edit");
    expect(afterEdit).toContain("src/a.ts");

    // The model summarized anyway: exactly one reminder covering both debts.
    const reminder = lastMessageText(fetchMock, 2);
    expect(reminder).toContain("Before you finish:");
    expect(reminder).toContain("without leaving a Codebase Map note: src/a.ts");
    expect(reminder).toContain("The edit set is not verified yet: src/a.ts");
    expect(reminder).toContain("Then write your complete final answer again");
    const harnessMessages = requestMessages(fetchMock, 2)
      .flatMap((message) => message.content)
      .filter((block) => block.text?.startsWith("[Internal continuation]"));
    expect(harnessMessages).toHaveLength(1);

    // Both debts cleared: the checklist is gone and the run ends on the restated answer.
    expect(lastMessageText(fetchMock, 3)).not.toContain("# Before your final answer");
    expect(session.runtimeState.verification).toMatchObject({ status: "passed" });
    expect(session.exportState().dirtyMapFiles).toBeUndefined();
    expect(events.filter((e) => e.type === "turn_complete")).toEqual([
      expect.objectContaining({ stopReason: "end_turn" }),
    ]);
    // Neither gate failed open: the debts were met, not abandoned.
    expect(events.some((e) => e.type === "execution_diagnostic"
      && (e.message.includes("Finishing without a Codebase Map note") || e.message.includes("unverified edits")))).toBe(false);
  });

  it("omits the checklist entirely when nothing is owed", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, body: toolRoundStream([{ id: "r1", name: "file_read", input: { path: "a.ts" } }]) }))
      .mockImplementation(async () => ({ ok: true, body: successStream("It exports one helper.") }));
    vi.stubGlobal("fetch", fetchMock);

    await drain(createBedrockSession().send("what does a.ts do?"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastMessageText(fetchMock, 1)).not.toContain("Before your final answer");
  });
});
