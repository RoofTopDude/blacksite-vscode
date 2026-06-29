/**
 * AWS Bedrock Converse API client with SigV4 request signing.
 *
 * Ported from the chrome extension (src/background/bedrock-client.ts). Two
 * differences for the VS Code extension host:
 *  - Signing uses Node's `crypto` (createHmac/createHash) instead of Web Crypto.
 *  - Streaming is exposed as an async generator of decoded frames instead of a
 *    callback interface; the contentBlock state machine lives in agent-session.
 */

import { createHash, createHmac } from "node:crypto";
import type {
  BedrockCredentials,
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockConverseStreamEvent,
  BedrockMessage,
  BedrockToolDef,
} from "./bedrock-types.js";

const ALGORITHM = "AWS4-HMAC-SHA256";

// ── AWS SigV4 signing ───────────────────────────────────────────────────────

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function getAmzDate(): { amzDate: string; dateStamp: string } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizePathname(pathname: string): string {
  if (!pathname) return "/";
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/") || "/";
}

function canonicalizeQuery(searchParams: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  searchParams.forEach((value, key) => entries.push([key, value]));
  return entries
    .sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) return aValue.localeCompare(bValue);
      return aKey.localeCompare(bKey);
    })
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

/** Sign a Bedrock request with AWS Signature Version 4. Returns the headers to send.
 *  Pass `service = "bedrock-mantle"` for the Mantle Messages endpoint. */
export function signBedrockRequest(
  creds: BedrockCredentials,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  service = "bedrock",
): Record<string, string> {
  const { amzDate, dateStamp } = getAmzDate();
  const parsed = new URL(url);

  const signedHeadersList = ["content-type", "host", "x-amz-date"];
  if (creds.sessionToken) signedHeadersList.push("x-amz-security-token");
  signedHeadersList.sort();

  const allHeaders: Record<string, string> = {
    ...headers, host: parsed.host, "x-amz-date": amzDate,
  };
  if (creds.sessionToken) allHeaders["x-amz-security-token"] = creds.sessionToken;

  const canonicalHeaders = signedHeadersList.map((h) => `${h}:${allHeaders[h]?.trim() ?? ""}`).join("\n") + "\n";
  const signedHeaders = signedHeadersList.join(";");
  const payloadHash = sha256Hex(body);
  const canonicalUri = canonicalizePathname(parsed.pathname);
  const canonicalQuery = canonicalizeQuery(parsed.searchParams);

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${creds.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSigningKey(creds.secretAccessKey, dateStamp, creds.region, service);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const result: Record<string, string> = {
    ...headers, "x-amz-date": amzDate,
    Authorization: `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (creds.sessionToken) result["x-amz-security-token"] = creds.sessionToken;
  return result;
}

// ── Converse request building ───────────────────────────────────────────────

export interface ConverseOptions {
  credentials: BedrockCredentials;
  modelId: string;
  messages: BedrockMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: BedrockToolDef[];
  thinking?: { enabled: boolean; budgetTokens?: number };
}

function buildRequestBody(opts: ConverseOptions): BedrockConverseRequest {
  const body: BedrockConverseRequest = {
    modelId: opts.modelId,
    messages: opts.messages,
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 4096,
    },
  };

  // When thinking is enabled, temperature must be 1 and cannot be set explicitly.
  if (!opts.thinking?.enabled) {
    body.inferenceConfig!.temperature = opts.temperature ?? 0.7;
  }

  if (opts.systemPrompt) {
    body.system = [{ text: opts.systemPrompt }];
  }

  if (opts.tools?.length) {
    body.toolConfig = { tools: opts.tools };
  }

  if (opts.thinking?.enabled) {
    body.performanceConfig = {
      thinking: {
        type: "enabled",
        budgetTokens: opts.thinking.budgetTokens ?? 10000,
      },
    };
  }

  return body;
}

function bedrockEndpoint(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export function mantleEndpoint(region: string): string {
  return `https://bedrock-mantle.${region}.api.aws`;
}

export interface MantleMessageOptions {
  credentials: BedrockCredentials;
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>;
  maxTokens?: number;
}

export interface MantleMessageResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** One-shot non-streaming POST to the Bedrock Mantle (Messages) API. Throws on non-OK. */
export async function mantleMessage(opts: MantleMessageOptions, signal?: AbortSignal): Promise<MantleMessageResponse> {
  const url = `${mantleEndpoint(opts.credentials.region)}/anthropic/v1/messages`;
  const reqBody: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: opts.messages,
  };
  if (opts.system) reqBody["system"] = opts.system;

  const body = JSON.stringify(reqBody);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body, "bedrock-mantle");

  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  return (await response.json()) as MantleMessageResponse;
}

async function readBedrockError(response: Response): Promise<string> {
  const errorText = await response.text().catch(() => "");
  try {
    const ej = JSON.parse(errorText) as { message?: string; Message?: string };
    return `Bedrock ${response.status}: ${ej.message ?? ej.Message ?? errorText}`;
  } catch {
    return `Bedrock ${response.status}: ${errorText}`;
  }
}

// ── Streaming Converse ────────────────────────────────────────────────────────

/**
 * Stream a Bedrock Converse call, yielding one decoded frame per event. Bedrock
 * returns AWS's binary event protocol (vnd.amazon.eventstream); we parse the
 * frames and surface each JSON payload tagged with its event type. Non-OK
 * responses throw so the caller can surface the error like any other provider.
 */
export async function* streamBedrockConverse(
  opts: ConverseOptions,
  signal?: AbortSignal,
): AsyncGenerator<BedrockConverseStreamEvent> {
  const url = `${bedrockEndpoint(opts.credentials.region)}/model/${encodeURIComponent(opts.modelId)}/converse-stream`;
  const body = JSON.stringify(buildRequestBody(opts));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/vnd.amazon.eventstream",
  };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body);

  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  if (!response.body) throw new Error("No response body from Bedrock");

  yield* parseEventStream(response.body);
}

/**
 * Parse the AWS event stream binary protocol.
 *
 * Each frame: [total_length:4][headers_length:4][prelude_crc:4]
 *             [headers:headers_length][payload:...][message_crc:4]
 */
async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<BedrockConverseStreamEvent> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;

      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        if (buffer.length < totalLength) break; // need more data

        const headersLength = view.getUint32(4);
        // Skip prelude CRC (4 bytes at offset 8).
        const headerBytes = buffer.slice(12, 12 + headersLength);
        const payloadStart = 12 + headersLength;
        const payloadEnd = totalLength - 4; // exclude message CRC
        const payloadBytes = buffer.slice(payloadStart, payloadEnd);

        const eventHeaders = parseEventHeaders(headerBytes);
        const eventType = eventHeaders[":event-type"] ?? eventHeaders[":exception-type"];

        if (eventType && payloadBytes.length > 0) {
          const payloadText = decoder.decode(payloadBytes);
          try {
            const data = JSON.parse(payloadText) as Record<string, unknown>;
            yield { eventType, data };
          } catch {
            // Ignore frames whose payload isn't valid JSON.
          }
        }

        buffer = buffer.slice(totalLength);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse AWS event stream headers (binary key-value pairs). */
function parseEventHeaders(bytes: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {};
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset < bytes.length) {
    // Header name: [name_length:1][name:name_length]
    const nameLength = bytes[offset]!;
    offset += 1;
    const name = decoder.decode(bytes.slice(offset, offset + nameLength));
    offset += nameLength;

    // Header value type: [type:1]
    const valueType = bytes[offset]!;
    offset += 1;

    if (valueType === 7) {
      // Type 7 = string: [value_length:2][value:value_length]
      const valueLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
      offset += 2;
      headers[name] = decoder.decode(bytes.slice(offset, offset + valueLength));
      offset += valueLength;
    } else {
      // Unknown value type — shouldn't happen for event stream headers.
      break;
    }
  }

  return headers;
}

// ── Non-streaming Converse (used by compression) ───────────────────────────────

/** One-shot Converse call. Throws on a non-OK response. */
export async function converseBedrock(opts: ConverseOptions, signal?: AbortSignal): Promise<BedrockConverseResponse> {
  const url = `${bedrockEndpoint(opts.credentials.region)}/model/${encodeURIComponent(opts.modelId)}/converse`;
  const body = JSON.stringify(buildRequestBody(opts));
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const signedHeaders = signBedrockRequest(opts.credentials, "POST", url, headers, body);

  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw new Error(await readBedrockError(response));
  return (await response.json()) as BedrockConverseResponse;
}
