/*
  Stop-reason normalization and mid-stream error classification for each wire format. A
  provider's own vocabulary goes in; the shared ModelStopReason, or a ProviderStreamError that
  carries the retry decision, comes out.
*/
import { isRetryableStatus, ProviderStreamError } from "./provider-retry.js";
import type { ModelStopReason } from "./types.js";

/** Stop reasons the harness owns rather than the provider — passed through untouched by every
 *  normalizer so a value the loop itself assigned can round-trip. */
function isHarnessStopReason(reason: string): reason is ModelStopReason {
  return reason === "max_iterations" || reason === "approval_pending" || reason === "question_pending"
    || reason === "cancelled" || reason === "paused" || reason === "error" || reason === "refusal"
    || reason === "context_window_exceeded" || reason === "protocol_violation";
}

export function normalizeOpenAIStopReason(reason: string): ModelStopReason {
  if (!reason || reason === "stop") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  // A filtered completion is a real terminal outcome, not a malformed turn. Mapping it to
  // protocol_violation (as before) sent it into the truncation-recovery path, which reverts
  // the turn and retries with a doubled output budget against a model that will filter again.
  if (reason === "content_filter") return "refusal";
  if (reason === "end_turn" || isHarnessStopReason(reason)) return reason as ModelStopReason;
  return "protocol_violation";
}


/**
 * Classify an OpenAI-compatible mid-stream error chunk (`{"error":{...}}`, sent by OpenRouter
 * and some gateways after the HTTP response already streamed 200 + partial content), or `null`
 * if `ev` isn't one. Exported pure function for the same reason as `anthropicStreamError` —
 * directly testable without driving the private `_streamTurnOpenAI` streaming method.
 *
 * Retryability comes from the chunk's own `code`, which these gateways populate with the HTTP
 * status of the upstream failure (429 on a rate limit, 502/503 when the routed model is
 * unreachable). Absent a recognisable status the error is treated as fatal: an unknown
 * mid-stream failure is more likely a broken request than a blip, and retrying it would just
 * burn the same error four more times before failing anyway.
 */
export function openAIStreamError(ev: Record<string, unknown>): ProviderStreamError | null {
  const streamError = ev["error"] as Record<string, unknown> | string | undefined;
  if (!streamError) return null;
  if (typeof streamError === "string") return new ProviderStreamError(streamError, false);
  const message = String(streamError["message"] ?? JSON.stringify(streamError));
  const rawCode = streamError["code"] ?? streamError["status"];
  const code = typeof rawCode === "number" ? rawCode : Number.parseInt(String(rawCode ?? ""), 10);
  return new ProviderStreamError(message, Number.isFinite(code) && isRetryableStatus(code));
}

export function normalizeAnthropicStopReason(reason: string): ModelStopReason {
  if (!reason || reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  // An input-side overflow, not an output cut-off — recovered by compacting, never by escalating
  // the output budget (which would make the very request that overflowed even bigger).
  if (reason === "model_context_window_exceeded") return "context_window_exceeded";
  // See normalizeOpenAIStopReason: a refusal is terminal, not a truncated turn.
  if (reason === "refusal") return "refusal";
  // `pause_turn` ends a long-running turn that the model expects to continue. The harness has
  // no server-side tools that produce it, and treating it as a clean stop lets the normal
  // end_turn/tool_use handling decide what happens next — unlike protocol_violation, which
  // would revert the (perfectly valid) turn and escalate the output budget.
  if (reason === "pause_turn" || reason === "stop_sequence") return "end_turn";
  if (isHarnessStopReason(reason)) return reason;
  return "protocol_violation";
}

/** Anthropic SSE error types that are transient (the request itself was fine). `overloaded_error`
 *  is Anthropic's 529 and by far the most common; the rest mirror the retryable HTTP statuses. */
const ANTHROPIC_RETRYABLE_STREAM_ERRORS = new Set([
  "overloaded_error",
  "api_error",
  "rate_limit_error",
  "timeout_error",
]);

/**
 * Classify an Anthropic-shaped SSE `{"type":"error","error":{...}}` event (also sent by Bedrock
 * Mantle, which shares the parser). Exported as a pure function (same pattern as
 * `isBedrockCacheValidationError` below) so the classification is directly unit-testable without
 * driving the private streaming methods that call it.
 */
export function anthropicStreamError(ev: Record<string, unknown>): ProviderStreamError {
  const err = ev["error"] as Record<string, unknown> | undefined;
  const errType = String(err?.["type"] ?? "unknown_error");
  const errMsg = String(err?.["message"] ?? "Anthropic reported a stream error.");
  return new ProviderStreamError(
    `Anthropic stream error (${errType}): ${errMsg}`,
    ANTHROPIC_RETRYABLE_STREAM_ERRORS.has(errType),
  );
}

/** Responses-API stream error codes that are transient — the request was fine, the backend
 *  wasn't. `server_error` is what a flex-tier turn gets when capacity evaporates mid-stream and
 *  is by far the most common member here. */
const RESPONSES_RETRYABLE_STREAM_CODES = new Set([
  "server_error",
  "internal_error",
  "rate_limit_exceeded",
  "slow_down",
  "service_unavailable",
  "temporarily_unavailable",
  "overloaded",
  "timeout",
  "gateway_timeout",
  "upstream_error",
]);

/** The opposite pole: a broken *request*, which will fail identically on every retry. Matched as
 *  a pattern rather than an exhaustive set because this family is open-ended
 *  (`unsupported_parameter`, `unsupported_value`, `invalid_value`, `unknown_parameter`, …) and a
 *  missed member here costs a wasted retry cycle rather than a wrong terminal failure. */
const RESPONSES_FATAL_STREAM_CODE_RE =
  /invalid|unsupported|unknown_parameter|missing_|not_found|permission|unauthorized|quota|billing|policy|context_length|decommissioned/i;

/**
 * Classify the Responses API's SSE `error` event. Exported as a pure function for the same reason
 * as `anthropicStreamError`/`openAIStreamError` — the classification is what regressed, and it is
 * testable directly without driving the private streaming method.
 *
 * Two things about this endpoint make it different from the sibling classifiers, and getting
 * either wrong is what turned routine backend blips into terminal run-ending failures:
 *
 *  - **`code` is a symbolic string, not an HTTP status** (`"server_error"`, not `429`). The
 *    previous inline classifier ran `Number(ev["code"])` through `isRetryableStatus`, so every
 *    real error event scored `NaN` and was declared fatal — the mid-stream retry layer that
 *    exists precisely for these was unreachable from this provider path.
 *  - **The payload appears in both a flat and a nested shape.** The documented event is flat
 *    (`{type:"error",code,message}`); proxies and some failure paths emit the Anthropic-style
 *    `{type:"error",error:{...}}` instead. Reading only the flat one dropped the message on the
 *    floor and reported a bare "OpenAI Responses stream error" with no diagnostic content.
 *
 * The unknown-code default also inverts relative to `openAIStreamError`, deliberately. That
 * function classifies chunks from gateways that forward an upstream HTTP status, so an
 * unrecognised code there really does suggest a malformed request. Here the request has already
 * cleared validation — a bad one is rejected with a pre-stream 400 by the code path above this
 * parser — so an error arriving *after* a 200 is far more likely to be backend-side. Unknown
 * codes are therefore retried unless they name the invalid-request family.
 */
export function responsesStreamError(ev: Record<string, unknown>): ProviderStreamError {
  const nested = ev["error"];
  const src = nested && typeof nested === "object" ? nested as Record<string, unknown> : ev;
  const message = typeof src["message"] === "string" && src["message"]
    ? src["message"]
    : typeof nested === "string" && nested
    ? nested
    : "OpenAI reported a stream error.";
  // `type` is only an error classifier on the nested shape; on the flat one it is the SSE event
  // discriminator (`"error"`) and says nothing about the failure.
  const codes = [src["code"], src["status"], src !== ev ? src["type"] : undefined]
    .filter((c) => c != null && c !== "")
    .map((c) => String(c));

  const numeric = codes.map((c) => Number(c)).filter((n) => Number.isFinite(n));
  const retryable = numeric.length > 0
    ? numeric.some(isRetryableStatus)
    : codes.some((c) => RESPONSES_RETRYABLE_STREAM_CODES.has(c.toLowerCase()))
      || !codes.some((c) => RESPONSES_FATAL_STREAM_CODE_RE.test(c));

  const label = codes[0] ?? "unknown_error";
  return new ProviderStreamError(`OpenAI Responses stream error (${label}): ${message}`, retryable);
}
