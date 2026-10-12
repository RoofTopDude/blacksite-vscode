import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  interruptibleSleep,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
} from "../provider-retry.js";
import type { ProviderTurnStreamEvent } from "../types.js";
import { formatDelay, makeAbortError, type TransportContext } from "./request.js";

/**
 * POST to a provider with transient-failure retries, yielding a live "retrying…" notice
 * between attempts and returning the successful Response. Only the pre-stream phase
 * (connection + response status) is retried — that is where 429/529/5xx/throttle and
 * connect failures surface, before any body has been read — so a retry can never
 * duplicate already-streamed output. A non-retryable or exhausted non-OK response is
 * returned as-is for the caller to turn into its provider-specific error. Honours a
 * server `Retry-After` header.
 */
export async function* fetchWithRetry(
  ctx: TransportContext,
  label: string,
  doFetch: (signal: AbortSignal | undefined) => Promise<Response>,
): AsyncGenerator<ProviderTurnStreamEvent, Response> {
  const policy = ctx.config.retryPolicy ?? DEFAULT_RETRY_POLICY;
  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (ctx.signal?.aborted) throw makeAbortError();
    const isLast = attempt >= policy.maxAttempts - 1;
    try {
      const response = await doFetch(ctx.signal);
      if (response.ok) return response;
      if (isLast || !isRetryableStatus(response.status)) return response;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const delayMs = computeBackoffMs(attempt, policy, retryAfter);
      await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
      yield {
        type: "notice",
        level: "warn",
        message: `${label} ${response.status} — retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
      };
      await interruptibleSleep(delayMs, ctx.signal);
    } catch (err) {
      lastErr = err;
      if (ctx.signal?.aborted || isLast || !isRetryableError(err)) throw err;
      const delayMs = computeBackoffMs(attempt, policy, null);
      yield {
        type: "notice",
        level: "warn",
        message: `${label} connection error (${err instanceof Error ? err.message : String(err)}) — retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
      };
      await interruptibleSleep(delayMs, ctx.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: request failed after ${policy.maxAttempts} attempts`);
}
