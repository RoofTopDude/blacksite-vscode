import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentEvent, type AgentSessionOptions } from "../../src/agent-session.js";
import type { ImageBlock, ToolUseBlock } from "../../src/agent-loop-contract.js";
import { ScriptedProviderSession, type ScriptedTurnFactory } from "./helpers/scripted-provider-session.js";

/* Images reach the model from attachments and from tools (file_read, screenshots, previews). When
   the model was judged unable to see them they were dropped with only a note to the model, so the
   user saw an agent that "could not see" and nothing saying why. */

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
// A real 1×1 PNG, so it passes vision preparation untouched.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const readImage = (id: string): ToolUseBlock => ({ type: "tool_use", id, name: "file_read", input: { path: "shot.png" } });

function context() {
  const values = new Map<string, unknown>();
  return { workspaceState: { get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback, update: async (key: string, value: unknown) => { values.set(key, value); } } };
}

function makeSession(factory: ScriptedTurnFactory, options: Partial<AgentSessionOptions> = {}) {
  const scripted = new ScriptedProviderSession(factory);
  const runtime = {
    handleMessage: vi.fn(async (message: { type: string }) => ({
      result: message.type === "system.read_file"
        ? { ok: true, path: "shot.png", relativePath: "shot.png", mediaDataUrl: `data:image/png;base64,${PNG}`, mediaType: "image/png", sizeBytes: 70 }
        : { ok: true },
    })),
  };
  const session = new AgentSession({
    apiKey: "key", model: "text-only-model", systemPrompt: "test", workspaceRoot: "C:/workspace",
    runtime: runtime as never, context: context() as never, provider: "openrouter", maxIterations: 8,
    checkpointingEnabled: false, contextLength: 200_000,
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    providerTurnSessionFactory: () => scripted,
    ...options,
  });
  return { session, scripted };
}

async function collect(session: AgentSession, ...args: Parameters<AgentSession["send"]>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(...args)) events.push(event);
  return events;
}

const warnings = (events: AgentEvent[]) => events
  .filter((event): event is Extract<AgentEvent, { type: "execution_diagnostic" }> => event.type === "execution_diagnostic" && event.level === "warn")
  .map((event) => event.message);

describe("vision support is read live", () => {
  it("follows a capability that changes after the session was built", () => {
    let vision = false;
    const { session } = makeSession(() => ({ text: "ok", stopReason: "end_turn", usage }), { supportsVision: () => vision });
    expect(session.supportsVision).toBe(false);
    vision = true;
    expect(session.supportsVision).toBe(true);
  });

  it("puts a tool's image in front of a vision model, with no warning", async () => {
    const { session, scripted } = makeSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readImage("r1")], stopReason: "tool_use", usage }
      : { text: "a red dot", stopReason: "end_turn", usage }, { supportsVision: () => true });
    const events = await collect(session, "what is in shot.png?");
    expect(scripted.images.map((image: ImageBlock) => image.source.data)).toEqual([PNG]);
    expect(warnings(events)).toEqual([]);
  });
});

describe("images kept from the model are reported", () => {
  it("says once per turn that tool images were not shown, however many there were", async () => {
    const { session, scripted } = makeSession(({ turnIndex }) => {
      if (turnIndex === 0) return { toolCalls: [readImage("r1")], stopReason: "tool_use", usage };
      if (turnIndex === 1) return { toolCalls: [readImage("r2")], stopReason: "tool_use", usage };
      return { text: "I cannot see it", stopReason: "end_turn", usage };
    });
    const events = await collect(session, "what is in shot.png?");
    const notices = warnings(events).filter((message) => message.includes("not shown to the model"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("1 image from file_read was not shown to the model: text-only-model is not recognised as a vision model");
    expect(notices[0]).toContain("Image fallback");
    expect(scripted.images).toEqual([]);
  });

  it("says when the vision fallback described the images instead", async () => {
    const describeImage = vi.fn(async () => "a red dot");
    const { session } = makeSession(({ turnIndex }) => turnIndex === 0
      ? { toolCalls: [readImage("r1")], stopReason: "tool_use", usage }
      : { text: "a red dot", stopReason: "end_turn", usage }, { visionFallbackProvider: { describeImage } });
    const events = await collect(session, "what is in shot.png?");
    expect(describeImage).toHaveBeenCalledOnce();
    expect(warnings(events).join("\n")).toContain("configured vision fallback described the content in text instead");
  });

  it("reports attachments the host left out", async () => {
    const { session } = makeSession(() => ({ text: "ok", stopReason: "end_turn", usage }));
    const events = await collect(session, "look at these", { withheldImages: 2 });
    expect(warnings(events)).toContain(
      "2 attached images were not shown to the model: text-only-model is not recognised as a vision model. "
      + "Pick a vision-capable model, or set an Image fallback model in Settings > Media & system so images are at least described.",
    );
  });
});
