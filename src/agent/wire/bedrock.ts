/*
  Bedrock/Converse wire format: AgentMessage -> BedrockMessage, tool schemas, cache
  breakpoints, and the stop-reason/stream-frame classifiers.

  Extracted from agent-session.ts, which re-exports every symbol here so existing
  call sites and tests keep importing them from there. Pure functions only — nothing
  in this file touches session state, which is what makes it testable in isolation.
*/
import { EMPTY_TURN_PLACEHOLDER } from "../transcript-hygiene.js";
import { ProviderStreamError } from "../../provider-retry.js";
import type { ToolDefinition } from "../../tools/definitions.js";
import type { AgentStopReason } from "../../session-state.js";
import type { AgentMessage, ContentBlock } from "../../agent-loop-contract.js";
import type {
  BedrockCachePoint,
  BedrockContentBlock,
  BedrockImageFormat,
  BedrockMessage,
  BedrockToolDef,
} from "../../bedrock-types.js";

function nonEmptyBedrockContent(blocks: BedrockContentBlock[]): BedrockContentBlock[] {
  const filtered = blocks.filter((b) => !("text" in b) || b.text.trim().length > 0);
  return filtered.length > 0 ? filtered : [{ text: EMPTY_TURN_PLACEHOLDER }];
}

function bedrockImageFormat(mediaType: string): BedrockImageFormat {
  const sub = mediaType.split("/")[1]?.toLowerCase();
  return sub === "jpeg" || sub === "jpg" ? "jpeg" : sub === "gif" ? "gif" : sub === "webp" ? "webp" : "png";
}

export function toBedrockMessages(messages: AgentMessage[]): BedrockMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: nonEmptyBedrockContent([{ text: msg.content }]) };
    }

    const blocks: BedrockContentBlock[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "text") {
        blocks.push({ text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ toolUse: { toolUseId: block.id, name: block.name, input: block.input } });
      } else if (block.type === "tool_result") {
        blocks.push({ toolResult: { toolUseId: block.tool_use_id, content: [{ text: block.content }] } });
      } else if (block.type === "image") {
        blocks.push({ image: { format: bedrockImageFormat(block.source.media_type), source: { bytes: block.source.data } } });
      } else if (block.type === "thinking") {
        // Converse requires the generated reasoning text *and* its signature to be replayed
        // verbatim on subsequent turns. Omitting it discards the model's interleaved-thought
        // context; replaying an old unsigned block earns a 400, so legacy blocks are skipped.
        if (block.signature) {
          blocks.push({ reasoningContent: { reasoningText: { text: block.thinking, signature: block.signature } } });
        }
      } else if (block.type === "redacted_thinking") {
        blocks.push({ reasoningContent: { redactedContent: block.data } });
      }
    }
    return { role: msg.role, content: nonEmptyBedrockContent(blocks) };
  });
}

/**
 * Add a rolling cache breakpoint to the final Bedrock message, mirroring
 * withRollingCacheBreakpoint for the Anthropic-direct/Mantle paths. Without this the
 * native Converse path only ever cached the static system-prompt block (buildRequestBody's
 * one hardcoded cachePoint) — the message history, which holds most of a long agent
 * conversation's tokens, was resent uncached on every turn.
 */
export function withBedrockRollingCacheBreakpoint(messages: BedrockMessage[]): BedrockMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (last.content.length === 0) return messages;
  out[out.length - 1] = { ...last, content: [...last.content, { cachePoint: { type: "default" } }] };
  return out;
}

/**
 * Bedrock/Converse twin of appendWorkspaceContextTail: appends the live workspace block as a
 * trailing text block on the final (user) message. Apply this AFTER withBedrockRollingCacheBreakpoint
 * so the block lands *past* the cachePoint — the stable message-history prefix stays a cache hit and
 * only this per-turn block is re-read uncached, exactly like the compressed-summary-after-cachePoint
 * pattern in bedrock-client. Converse requires strict user/assistant alternation, so the block can
 * only ride on the trailing message's content, never a fresh user turn — if the last message somehow
 * isn't a user turn, it is left untouched rather than corrupting an assistant turn. Never mutates input.
 */
export function appendBedrockWorkspaceContextTail(messages: BedrockMessage[], workspaceContext: string): BedrockMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (last.role !== "user") return messages;
  out[out.length - 1] = { ...last, content: [...last.content, { text: workspaceContext }] };
  return out;
}

export function toBedrockTools(tools: ToolDefinition[]): BedrockToolDef[] {
  return tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } },
  }));
}

/** Append a cachePoint entry after the tool list so the (large, stable) tool schema
 *  block is cache-eligible too, mirroring the Anthropic/Mantle paths' last-tool marker. */
export function withBedrockToolsCacheBreakpoint(
  tools: BedrockToolDef[],
): Array<BedrockToolDef | BedrockCachePoint> {
  if (tools.length === 0) return tools;
  return [...tools, { cachePoint: { type: "default" } }];
}

/**
 * True when a Bedrock error looks like it was caused by the request's cache
 * breakpoints being rejected (a 400 or 422 validation error mentioning "cache"), as
 * opposed to an unrelated failure (auth, throttling, network) that a cache-less retry
 * wouldn't fix. Deliberately narrow so unrelated errors surface immediately instead
 * of being masked by a pointless retry.
 */
export function isBedrockCacheValidationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Bedrock (?:400|422)\b/.test(message) && /cache/i.test(message);
}

/**
 * Bedrock ConverseStream failure frame types (AWS's documented Smithy exception shapes for
 * this operation). Each arrives via the `:exception-type` header rather than an HTTP error,
 * so a mid-stream throttle/overload/validation failure looks exactly like a normal frame
 * unless the eventType is checked against this set — see the `default` case in
 * `_streamTurnBedrock`'s switch.
 */
const BEDROCK_STREAM_EXCEPTION_TYPES = new Set([
  "internalServerException",
  "modelStreamErrorException",
  "validationException",
  "throttlingException",
  "serviceUnavailableException",
  "modelTimeoutException",
  "modelNotReadyException",
  "resourceNotFoundException",
  "accessDeniedException",
]);

/**
 * The subset of the above that is transient. This is the crux of why Bedrock ran so much less
 * reliably than the other providers: AWS delivers throttles and capacity failures *in-band*, as
 * frames inside an already-200 stream, where the other providers deliver them as a pre-stream
 * 429/5xx that `_fetchWithRetry` absorbs. Classified as retryable, they now re-enter the same
 * backoff cycle as every other transient provider failure instead of ending the run.
 *
 * Deliberately excludes validation/resourceNotFound/accessDenied: those mean the *request* is
 * wrong, and replaying it unchanged can only reproduce the failure.
 */
const BEDROCK_RETRYABLE_STREAM_EXCEPTIONS = new Set([
  "internalServerException",
  "modelStreamErrorException",
  "throttlingException",
  "serviceUnavailableException",
  "modelTimeoutException",
  "modelNotReadyException",
]);

/**
 * Classify a decoded Bedrock ConverseStream frame: returns a {@link ProviderStreamError} when
 * `eventType` is one of `BEDROCK_STREAM_EXCEPTION_TYPES`, `null` for a normal content frame.
 * Exported pure function, same pattern as `isBedrockCacheValidationError` — testable directly
 * without driving the private `_streamTurnBedrock` streaming method.
 */
export function bedrockStreamFrameError(eventType: string, data: Record<string, unknown>): ProviderStreamError | null {
  if (!BEDROCK_STREAM_EXCEPTION_TYPES.has(eventType)) return null;
  const message = typeof data["message"] === "string" ? data["message"] : eventType;
  return new ProviderStreamError(
    `Bedrock stream error (${eventType}): ${message}`,
    BEDROCK_RETRYABLE_STREAM_EXCEPTIONS.has(eventType),
  );
}

export function normalizeBedrockStopReason(reason: string): AgentStopReason {
  switch (reason) {
    case "tool_use":      return "tool_use";
    case "max_tokens":    return "max_tokens";
    case "end_turn":
    case "stop_sequence": return "end_turn";
    // Documented Converse stop reasons for a response the service declined to complete on
    // content grounds. Previously these fell into `default` → protocol_violation, which the
    // truncation-recovery path reads as a cut-off response and retries with a doubled output
    // budget — re-provoking the same guardrail every time. See AgentStopReason."refusal".
    case "guardrail_intervened":
    case "content_filtered": return "refusal";
    default:                 return "protocol_violation";
  }
}

