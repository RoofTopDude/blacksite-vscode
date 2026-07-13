import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEventHeaders, readEventFrame, streamBedrockConverse } from "../../src/bedrock-client.js";

// A provider stream decoder runs on the extension host's event loop with no `await` between
// decode steps. If a step ever fails to consume bytes, the loop spins, the host stops
// responding, and VS Code kills and restarts the extension — the failure mode that produced
// the repeated crashes in the captured execution log.
//
// A watchdog cannot catch that: a synchronous spin starves the event loop, so a timer-based
// timeout never fires and the test process hangs instead of failing. So the decoder exposes
// its per-step decision as a pure function, and these tests assert the progress invariant
// directly: every successful step consumes at least one byte.

const CREDS = { region: "us-east-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret123" };

/** Deterministic PRNG so a fuzz failure reproduces from the seed printed in the assertion. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

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

function encodeFrame(eventType: string, payload: unknown): Uint8Array {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headers.length);
  view.setUint32(8, 0); // prelude CRC (unchecked)
  frame.set(headers, 12);
  frame.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, 0); // message CRC (unchecked)
  return frame;
}

function randomBytes(random: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/**
 * Drain a buffer the way parseEventStream does, but with a hard step cap so a regressed
 * decoder fails the assertion instead of hanging the suite. Returns the steps taken, or
 * throws whatever the decoder throws.
 */
function drain(buffer: Uint8Array, stepCap = 10_000): { steps: number; drained: boolean } {
  let remaining = buffer;
  let steps = 0;

  while (steps < stepCap) {
    const step = readEventFrame(remaining);
    if (step.status === "need_more") return { steps, drained: false };

    // The invariant the whole decode loop rests on.
    expect(step.consumed).toBeGreaterThan(0);

    remaining = remaining.slice(step.consumed);
    steps += 1;
    if (remaining.length === 0) return { steps, drained: true };
  }
  throw new Error(`decoder did not settle within ${stepCap} steps — it would spin the extension host`);
}

/** Byte patterns that a desynced or hostile stream can realistically put at the read head. */
const ADVERSARIAL: Array<{ name: string; bytes: Uint8Array }> = [
  { name: "all zeros (the crash: totalLength decodes as 0)", bytes: new Uint8Array(64) },
  { name: "all 0xff (totalLength decodes as 4294967295)", bytes: new Uint8Array(64).fill(0xff) },
  { name: "empty buffer", bytes: new Uint8Array(0) },
  { name: "single byte", bytes: new Uint8Array([1]) },
  { name: "exactly the 12-byte prelude, all zeros", bytes: new Uint8Array(12) },
  { name: "11 bytes (one short of a prelude)", bytes: new Uint8Array(11) },
];

describe("bedrock event-stream decoder — progress invariant", () => {
  it.each(ADVERSARIAL)("never stalls on $name", ({ bytes }) => {
    // Either it decodes, or it needs more data, or it throws a desync — but it never spins.
    try {
      drain(bytes);
    } catch (err) {
      expect((err as Error).message).toMatch(/desynced/);
    }
  });

  it("consumes bytes on every decoded frame across 500 random buffers", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = makeRandom(seed);
      const bytes = randomBytes(random, Math.floor(random() * 512));
      try {
        drain(bytes);
      } catch (err) {
        // A desync error is a valid outcome; a stall is not.
        expect((err as Error).message, `seed ${seed}`).toMatch(/desynced/);
      }
    }
  });

  it("settles when a valid frame is followed by corrupt trailing bytes", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed);
      const good = encodeFrame("contentBlockDelta", { delta: { text: "x" } });
      const buffer = concat([good, randomBytes(random, Math.floor(random() * 64))]);
      try {
        drain(buffer);
      } catch (err) {
        expect((err as Error).message, `seed ${seed}`).toMatch(/desynced/);
      }
    }
  });

  it("settles when a valid frame's length field is corrupted to any 32-bit value", () => {
    const interesting = [0, 1, 11, 12, 15, 16, 17, 0xffff, 0x7fffffff, 0xffffffff];
    for (const totalLength of interesting) {
      const frame = encodeFrame("contentBlockDelta", { delta: { text: "x" } });
      new DataView(frame.buffer).setUint32(0, totalLength);
      try {
        drain(frame);
      } catch (err) {
        expect((err as Error).message, `totalLength ${totalLength}`).toMatch(/desynced/);
      }
    }
  });

  it("settles when the headers-length field is corrupted to any 32-bit value", () => {
    const interesting = [0, 1, 0xffff, 0x7fffffff, 0xffffffff];
    for (const headersLength of interesting) {
      const frame = encodeFrame("contentBlockDelta", { delta: { text: "x" } });
      new DataView(frame.buffer).setUint32(4, headersLength);
      try {
        drain(frame);
      } catch (err) {
        expect((err as Error).message, `headersLength ${headersLength}`).toMatch(/desynced/);
      }
    }
  });

  it("still drains a long run of well-formed frames", () => {
    const frames = Array.from({ length: 50 }, (_, i) => encodeFrame("contentBlockDelta", { delta: { text: `t${i}` } }));
    const result = drain(concat(frames));
    expect(result).toEqual({ steps: 50, drained: true });
  });
});

describe("bedrock event-stream header parser — termination", () => {
  it("terminates and returns an object for 500 random header blobs", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const random = makeRandom(seed);
      const headers = parseEventHeaders(randomBytes(random, Math.floor(random() * 128)));
      expect(typeof headers, `seed ${seed}`).toBe("object");
    }
  });

  it("terminates on a truncated string header that claims more bytes than remain", () => {
    // name_length=4 "abcd", type=7 (string), value_length=0xffff, but no value bytes follow.
    const bytes = new Uint8Array([4, 97, 98, 99, 100, 7, 0xff, 0xff]);
    expect(typeof parseEventHeaders(bytes)).toBe("object");
  });
});

// These drive the real async generator. Every input here must be one that CANNOT spin even if
// the desync guard is deleted — otherwise a regression hangs the vitest worker and CI stalls
// instead of reporting a failure. A frame claiming a huge length is safe (an unguarded decoder
// just waits for more data); a frame claiming length 0 is not, so it lives in the pure suite
// above, where the step cap turns the same regression into a fast, readable assertion failure.
describe("streamBedrockConverse — end to end", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubBody(chunks: Uint8Array[]): void {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    } as unknown as Response));
  }

  async function collect(chunks: Uint8Array[]): Promise<unknown[]> {
    stubBody(chunks);
    const events: unknown[] = [];
    for await (const event of streamBedrockConverse({ credentials: CREDS, modelId: "m", messages: [] })) {
      events.push(event);
    }
    return events;
  }

  it("surfaces a desync as a turn error instead of stalling the host", async () => {
    await expect(collect([new Uint8Array(64).fill(0xff)])).rejects.toThrow(/desynced/);
  });

  it("recovers the event from a valid frame split at every byte boundary", async () => {
    const frame = encodeFrame("contentBlockDelta", { delta: { text: "hi" } });
    for (let cut = 1; cut < frame.length; cut += 1) {
      const events = await collect([frame.slice(0, cut), frame.slice(cut)]);
      expect(events, `cut at ${cut}`).toEqual([{ eventType: "contentBlockDelta", data: { delta: { text: "hi" } } }]);
    }
  });

  it("delivers every event when a long run of frames arrives one byte per chunk", async () => {
    const frames = Array.from({ length: 10 }, (_, i) => encodeFrame("contentBlockDelta", { delta: { text: `t${i}` } }));
    const bytes = concat(frames);
    const events = await collect([...bytes].map((byte) => new Uint8Array([byte])));
    expect(events).toHaveLength(10);
  });

  it("ends cleanly on an empty body", async () => {
    expect(await collect([])).toEqual([]);
  });
});
