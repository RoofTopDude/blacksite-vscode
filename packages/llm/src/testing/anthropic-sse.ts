/**
 * Builders for Anthropic's plain-text SSE wire format (`data: {...}\n\n` lines), the
 * counterpart to bedrock-frames.ts's binary event-stream builders. Anthropic's protocol needs
 * no framing — this is just newline-delimited JSON — so these helpers are correspondingly
 * thinner: encode one event per chunk and let the harness's line reader do the rest.
 */

function sseChunk(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function anthropicSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(sseChunk(ev));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** A successful turn whose response leads with a server-side compaction block ahead of the
 *  normal text reply — the shape the API sends once compaction has triggered. */
export function anthropicCompactionTurn(opts: {
  compactionText: string;
  replyText: string;
  inputTokens?: number;
  outputTokens?: number;
  iterations?: Array<{ type: string; input_tokens: number; output_tokens: number }>;
}): ReadableStream<Uint8Array> {
  const usage: Record<string, unknown> = { input_tokens: opts.inputTokens ?? 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (opts.iterations) usage["iterations"] = opts.iterations;
  const deltaUsage: Record<string, unknown> = { output_tokens: opts.outputTokens ?? 20 };
  if (opts.iterations) deltaUsage["iterations"] = opts.iterations;
  return anthropicSseStream([
    { type: "message_start", message: { usage } },
    { type: "content_block_start", index: 0, content_block: { type: "compaction" } },
    { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: opts.compactionText } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: opts.replyText } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: deltaUsage },
  ]);
}

/** A plain successful text-only turn, no compaction. */
export function anthropicTextTurn(text: string, opts?: { inputTokens?: number; outputTokens?: number }): ReadableStream<Uint8Array> {
  return anthropicSseStream([
    { type: "message_start", message: { usage: { input_tokens: opts?.inputTokens ?? 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: opts?.outputTokens ?? 5 } },
  ]);
}
