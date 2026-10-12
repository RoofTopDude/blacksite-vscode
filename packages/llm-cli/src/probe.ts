/* `blacksite-llm probe`: a handful of live checks against one provider route, the same things the
   extension depends on — a plain answer, a tool call and its result coming back, reasoning that
   survives the round trip, usage reporting. `--fixture` runs them against a scripted Anthropic
   endpoint instead, so the route code is exercised with no key and no network. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderTurnStreamEvent } from "@blacksite-agent/llm";
import { anthropicSseStream } from "@blacksite-agent/llm/testing";
import { Conversation } from "./conversation.js";
import { demoTools } from "./tools.js";
import type { CliTransport } from "./transport.js";

export interface ProbeCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const CODE_WORD = "maple-42";

export interface ProbeOptions {
  label: string;
  model: string;
  thinking: boolean;
  maxTokens: number;
  /** The route keeps reasoning in the provider's own conversation (ChatGPT's live Codex thread),
   *  so there is nothing for the client to send back. */
  reasoningInThread?: boolean;
}

export async function runProbe(open: () => Promise<CliTransport>, options: ProbeOptions): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const events: ProviderTurnStreamEvent[] = [];
  const record = (event: ProviderTurnStreamEvent): void => { events.push(event); };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blacksite-llm-probe-"));
  await fs.writeFile(path.join(dir, "probe.txt"), `The code word is ${CODE_WORD}.\n`);
  const cli = await open();
  try {
    const base = { transport: cli.transport, provider: cli.provider, label: options.label, model: options.model, maxTokens: options.maxTokens };

    // 1. A plain answer.
    try {
      const plain = new Conversation({ ...base, system: "You are a terse test endpoint.", tools: [], thinking: false });
      const { rounds } = await plain.send("Reply with exactly the word: pong", record);
      const last = rounds.at(-1)!;
      checks.push(last.text.trim() && last.stopReason === "end_turn"
        ? { name: "answers a plain prompt", status: "pass", detail: `"${last.text.trim().slice(0, 40)}"` }
        : { name: "answers a plain prompt", status: "fail", detail: `stop ${last.stopReason}, text "${last.text.slice(0, 40)}"` });
    } catch (error) {
      checks.push({ name: "answers a plain prompt", status: "fail", detail: message(error) });
    }

    // 2–4. A tool round trip, with reasoning when asked for.
    try {
      const tooling = new Conversation({ ...base, system: "You can read files with read_file. Use it when asked about a file.", tools: demoTools(dir), thinking: options.thinking });
      const { rounds, toolCalls } = await tooling.send("Read probe.txt with read_file and tell me the code word in it.", record);
      const called = toolCalls.find((call) => call.name === "read_file");
      checks.push(called
        ? { name: "calls a tool", status: called.error ? "fail" : "pass", detail: `read_file ${JSON.stringify(called.input)}` }
        : { name: "calls a tool", status: "fail", detail: "no read_file call" });
      const answer = rounds.at(-1)!.text;
      checks.push(answer.includes(CODE_WORD)
        ? { name: "uses the tool result", status: "pass", detail: `answer names ${CODE_WORD}` }
        : { name: "uses the tool result", status: "fail", detail: `answer "${answer.slice(0, 60)}"` });
      if (options.reasoningInThread) {
        checks.push({ name: "replays reasoning", status: "skip", detail: "this route keeps reasoning in its own thread" });
      } else if (!options.thinking) {
        checks.push({ name: "replays reasoning", status: "skip", detail: "run with --thinking" });
      } else {
        const reasoned = rounds[0]?.thinkingBlocks.length ?? 0;
        checks.push(reasoned > 0 && rounds.length > 1
          ? { name: "replays reasoning", status: "pass", detail: `${reasoned} reasoning block(s) sent back on the next request` }
          : { name: "replays reasoning", status: "fail", detail: reasoned ? "no follow-up request" : "no reasoning returned with the tool call" });
      }
    } catch (error) {
      for (const name of ["calls a tool", "uses the tool result", "replays reasoning"]) checks.push({ name, status: "fail", detail: message(error) });
    }

    // 5. Usage.
    const usage = events.filter((event) => event.type === "usage_update");
    checks.push(usage.length
      ? { name: "reports token usage", status: "pass", detail: `${usage.length} usage report(s)` }
      : { name: "reports token usage", status: "fail", detail: "no usage_update event" });
  } finally {
    cli.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
  return checks;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);
}

/**
 * A scripted Anthropic endpoint for `probe --fixture`: answers "pong", calls read_file (with a
 * signed thinking block first), then answers from whatever the tool result in the request says.
 */
export function installFixtureEndpoint(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
    const messages = body.messages ?? [];
    const toolResult = messages.flatMap((m) => (Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []))
      .find((block) => block["type"] === "tool_result");
    const asksForFile = JSON.stringify(messages).includes("probe.txt");
    const usage = { type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    const text = (t: string) => [
      usage,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
    ];
    const events = toolResult
      ? text(`It says: ${String(toolResult["content"]).trim()}`)
      : asksForFile
        ? [
            usage,
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should read the file." } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_fixture", name: "read_file", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"probe.txt\"}" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
          ]
        : text("pong");
    return { ok: true, status: 200, body: anthropicSseStream(events) } as unknown as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}
