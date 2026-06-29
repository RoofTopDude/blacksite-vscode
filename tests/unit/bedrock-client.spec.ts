import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signBedrockRequest, streamBedrockConverse, mantleMessage } from "../../src/bedrock-client.js";
import type { BedrockConverseStreamEvent } from "../../src/bedrock-types.js";

const CREDS = {
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret123",
};

describe("signBedrockRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-02T03:04:05.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces a SigV4 Authorization header with the right scope and signed headers", () => {
    const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/some.model/converse-stream";
    const headers = signBedrockRequest(CREDS, "POST", url, { "content-type": "application/json" }, "{}");

    expect(headers["x-amz-date"]).toBe("20250102T030405Z");
    expect(headers["Authorization"]).toContain("AWS4-HMAC-SHA256 ");
    expect(headers["Authorization"]).toContain("Credential=AKIAEXAMPLE/20250102/us-east-1/bedrock/aws4_request");
    expect(headers["Authorization"]).toContain("SignedHeaders=content-type;host;x-amz-date");
    expect(headers["Authorization"]).toMatch(/Signature=[0-9a-f]{64}$/);
    // x-amz-security-token must not appear without a session token.
    expect(headers["x-amz-security-token"]).toBeUndefined();
  });

  it("is deterministic for identical inputs at a fixed time", () => {
    const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse";
    const a = signBedrockRequest(CREDS, "POST", url, { "content-type": "application/json" }, "{}");
    const b = signBedrockRequest(CREDS, "POST", url, { "content-type": "application/json" }, "{}");
    expect(a["Authorization"]).toBe(b["Authorization"]);
  });

  it("includes the session token in the signed headers and result", () => {
    const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse";
    const headers = signBedrockRequest({ ...CREDS, sessionToken: "tok" }, "POST", url, { "content-type": "application/json" }, "{}");
    expect(headers["x-amz-security-token"]).toBe("tok");
    expect(headers["Authorization"]).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
  });

  it("uses bedrock-mantle service name and signs the mantle host when service param is bedrock-mantle", () => {
    const url = "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages";
    const headers = signBedrockRequest(CREDS, "POST", url, { "content-type": "application/json", "anthropic-version": "2023-06-01" }, "{}", "bedrock-mantle");

    expect(headers["Authorization"]).toContain("Credential=AKIAEXAMPLE/20250102/us-east-1/bedrock-mantle/aws4_request");
    // host signed must be the mantle host, not bedrock-runtime
    expect(headers["Authorization"]).toContain("SignedHeaders=");
    expect(headers["Authorization"]).toMatch(/Signature=[0-9a-f]{64}$/);
  });
});

// ── Event-stream frame encoding (mirror of the AWS binary protocol) ────────────

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

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(creds = CREDS): Promise<BedrockConverseStreamEvent[]> {
  const events: BedrockConverseStreamEvent[] = [];
  for await (const ev of streamBedrockConverse({ credentials: creds, modelId: "m", messages: [] })) {
    events.push(ev);
  }
  return events;
}

describe("streamBedrockConverse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses decoded frames into tagged events", async () => {
    const frames = [
      encodeFrame("contentBlockDelta", { delta: { text: "hi" } }),
      encodeFrame("messageStop", { stopReason: "end_turn" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: streamFromChunks(frames) } as unknown as Response));

    const events = await collect();
    expect(events).toEqual([
      { eventType: "contentBlockDelta", data: { delta: { text: "hi" } } },
      { eventType: "messageStop", data: { stopReason: "end_turn" } },
    ]);
  });

  it("reassembles a frame split across read chunks", async () => {
    const frame = encodeFrame("contentBlockDelta", { delta: { text: "split" } });
    const mid = Math.floor(frame.length / 2);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: streamFromChunks([frame.slice(0, mid), frame.slice(mid)]),
    } as unknown as Response));

    const events = await collect();
    expect(events).toEqual([{ eventType: "contentBlockDelta", data: { delta: { text: "split" } } }]);
  });

  it("throws a parsed error message on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ message: "not authorized" })),
    } as unknown as Response));

    await expect(collect()).rejects.toThrow("Bedrock 403: not authorized");
  });
});

describe("mantleMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-02T03:04:05.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts to the mantle endpoint with bedrock-mantle SigV4 scope and returns parsed response", async () => {
    const mockResponse = {
      content: [{ type: "text", text: "Hello from Mantle" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await mantleMessage({
      credentials: CREDS,
      model: "anthropic.claude-opus-4-8",
      system: "You are a helpful assistant.",
      maxTokens: 100,
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result).toEqual(mockResponse);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
    expect(init.method).toBe("POST");

    const auth = (init.headers as Record<string, string>)["Authorization"];
    expect(auth).toContain("Credential=AKIAEXAMPLE/20250102/us-east-1/bedrock-mantle/aws4_request");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("anthropic.claude-opus-4-8");
    expect(body["system"]).toBe("You are a helpful assistant.");
    expect(body["max_tokens"]).toBe(100);
  });

  it("throws a parsed error on a non-OK mantle response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ message: "budget_tokens not supported" })),
    } as unknown as Response));

    await expect(mantleMessage({
      credentials: CREDS,
      model: "anthropic.claude-opus-4-8",
      messages: [{ role: "user", content: "Hi" }],
    })).rejects.toThrow("Bedrock 400: budget_tokens not supported");
  });
});
