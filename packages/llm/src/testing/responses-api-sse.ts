/** Builders for the OpenAI Responses API's SSE event stream — see
 *  tests/unit/helpers/anthropic-sse.ts for the sibling Anthropic builder and the rationale for
 *  testing at this level rather than only the pure converters. */

function sseChunk(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function responsesSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(sseChunk(ev));
      controller.close();
    },
  });
}

/** A turn that reasons, then makes one tool call — the scenario the whole feature exists for:
 *  the reasoning item must round-trip with its encrypted_content intact. */
export function responsesReasoningToolCallTurn(opts: {
  reasoningId: string;
  summaryText: string;
  encryptedContent: string;
  callId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}): ReadableStream<Uint8Array> {
  const reasoningItem = {
    type: "reasoning",
    id: opts.reasoningId,
    summary: [{ type: "summary_text", text: opts.summaryText }],
    encrypted_content: opts.encryptedContent,
  };
  const functionCallItem = {
    type: "function_call",
    id: `fc_${opts.callId}`,
    call_id: opts.callId,
    name: opts.toolName,
    arguments: JSON.stringify(opts.toolArgs),
  };
  return responsesSseStream([
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: opts.reasoningId, summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: opts.reasoningId, delta: opts.summaryText },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: `fc_${opts.callId}`, call_id: opts.callId, name: opts.toolName, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: `fc_${opts.callId}`, delta: JSON.stringify(opts.toolArgs) },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: `fc_${opts.callId}`, name: opts.toolName, arguments: JSON.stringify(opts.toolArgs) },
    { type: "response.output_item.done", output_index: 1, item: functionCallItem },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [reasoningItem, functionCallItem],
        usage: {
          input_tokens: opts.inputTokens ?? 1000,
          output_tokens: opts.outputTokens ?? 50,
          input_tokens_details: { cached_tokens: opts.cachedTokens ?? 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 20 },
        },
      },
    },
  ]);
}

/** A turn that streams partial output and then dies on a mid-stream `error` event — the flex-tier
 *  backend failure that used to end a run outright. `code` is symbolic, exactly as this endpoint
 *  sends it; the numeric-status assumption is what the classifier regressed on. */
export function responsesMidStreamErrorTurn(opts: { code?: string; message?: string; partialText?: string } = {}): ReadableStream<Uint8Array> {
  return responsesSseStream([
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    ...(opts.partialText
      ? [{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: opts.partialText }]
      : []),
    {
      type: "error",
      code: opts.code ?? "server_error",
      message: opts.message ?? "The server had an error while processing your request.",
      param: null,
      sequence_number: 3,
    },
  ]);
}

/** A plain successful text-only turn — no reasoning, no tool calls. */
export function responsesTextTurn(text: string): ReadableStream<Uint8Array> {
  const messageItem = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return responsesSseStream([
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: messageItem },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [messageItem],
        usage: { input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      },
    },
  ]);
}
