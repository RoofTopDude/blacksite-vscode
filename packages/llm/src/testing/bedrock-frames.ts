/**
 * Builders for AWS event-stream frames — the binary wire format Bedrock ConverseStream speaks.
 *
 * Exception frames are the reason this helper exists: Bedrock reports a throttle or an overload
 * as a *frame* tagged with an `:exception-type` header inside an already-200 stream, not as an
 * HTTP status. Reproducing that shape byte-for-byte is the only way to test the harness's
 * response to the failure mode that dominates real Bedrock runs.
 */

function encodeHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let o = 0;
  buf[o++] = nameBytes.length;
  buf.set(nameBytes, o); o += nameBytes.length;
  buf[o++] = 7; // value type: string
  buf[o++] = (valueBytes.length >> 8) & 0xff;
  buf[o++] = valueBytes.length & 0xff;
  buf.set(valueBytes, o);
  return buf;
}

function frame(headerName: string, headerValue: string, payload: unknown): Uint8Array {
  const headers = encodeHeader(headerName, headerValue);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const buf = new Uint8Array(totalLength);
  const view = new DataView(buf.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headers.length);
  view.setUint32(8, 0); // prelude CRC (the decoder does not verify it)
  buf.set(headers, 12);
  buf.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, 0); // message CRC (likewise unverified)
  return buf;
}

/** A normal content/protocol frame (`:event-type`). */
export function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return frame(":event-type", eventType, payload);
}

/** A failure frame (`:exception-type`) — e.g. `throttlingException`, `validationException`. */
export function exceptionFrame(exceptionType: string, message: string): Uint8Array {
  return frame(":exception-type", exceptionType, { message });
}

export function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A complete, successful Converse stream that answers with `text`. */
export function successStream(text: string): ReadableStream<Uint8Array> {
  return streamFromChunks([
    eventFrame("contentBlockDelta", { delta: { text }, contentBlockIndex: 0 }),
    eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
    eventFrame("messageStop", { stopReason: "end_turn" }),
    eventFrame("metadata", { usage: { inputTokens: 10, outputTokens: 5 } }),
  ]);
}

/** A stream that emits `text`, then dies with an in-band exception frame — the Bedrock failure
 *  that used to end the run outright. */
export function failingStream(text: string, exceptionType: string, message = "boom"): ReadableStream<Uint8Array> {
  return streamFromChunks([
    eventFrame("contentBlockDelta", { delta: { text }, contentBlockIndex: 0 }),
    exceptionFrame(exceptionType, message),
  ]);
}
