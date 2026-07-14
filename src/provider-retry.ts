/**
 * Transient-failure handling for provider calls — the piece the agent loop was missing.
 *
 * Every model turn is a network round-trip to a provider that can, and routinely does,
 * answer with a rate-limit (429), an "overloaded" (Anthropic 529), a throttle
 * (Bedrock), a transient 5xx, or a dropped/half-open socket. Before this module those
 * all threw straight out of the streaming methods and the loop converted them into a
 * terminal `error` stop — a single blip ended the whole run. For a long-horizon
 * (e.g. 1000-iteration) session that is fatal: the probability of *zero* transient
 * failures across hundreds of calls is negligible.
 *
 * The logic here is deliberately split into small pure functions (classification,
 * backoff, Retry-After parsing) so the retry decisions are unit-testable without real
 * timers or sockets. The actual await-loop lives in {@link retryAsync} for
 * non-streaming callers (compressor, Bedrock Converse first-frame); the streaming
 * provider paths run an equivalent loop inline so they can *yield* a live "retrying…"
 * notice to the UI between attempts (see AgentSession._fetchWithRetry).
 */

export interface RetryPolicy {
  /** Total attempts including the first, so `1` disables retrying. */
  maxAttempts: number;
  /** Base for the exponential backoff, in ms. */
  baseDelayMs: number;
  /** Ceiling for any single backoff wait, in ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 600,
  maxDelayMs: 20_000,
};

/**
 * Maximum gap between streamed bytes before the stream is considered stalled. A model
 * turn that is actively producing tokens resets this on every chunk; a silently
 * half-open socket trips it and turns an otherwise-infinite hang into a normal error.
 * (undici's own `headersTimeout`/`bodyTimeout` — 300s each by default — are the coarse
 * backstop for the connect phase; this is the tighter, agent-appropriate stream bound.)
 */
// Models with extended thinking can spend several minutes between streamed
// chunks, especially while producing their final answer. Keep the connection
// alive for five minutes before treating it as stalled.
export const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Idle bound for OpenAI flex-tier streams. Flex requests queue server-side until capacity
 * frees up, so gaps before/between early chunks can legitimately run minutes long —
 * OpenAI's own guidance is a ~15-minute client timeout for flex. The standard 60s bound
 * would misread that queueing as a stalled socket and abort a request that was about to
 * be served at reduced rates. (undici's 300s headersTimeout still caps the pre-header
 * wait; a queue longer than that surfaces as a retryable connection error and re-enters
 * the normal backoff cycle.)
 */
export const FLEX_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Carries an HTTP status (and optional Retry-After) through a thrown rejection so
 *  {@link retryAsync} can classify it and honour the server's backoff hint. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Signals a stalled stream (no bytes within the idle window). Retryable like a network error. */
export class StreamIdleTimeoutError extends Error {
  constructor(message = "Stream idle timeout") {
    super(message);
    this.name = "StreamIdleTimeoutError";
  }
}

/**
 * A failure the provider reported *inside* an already-successful (HTTP 200) stream.
 *
 * Every provider has one of these, and none of them are HTTP statuses:
 *   - Bedrock Converse: an event frame tagged `:exception-type` (throttlingException,
 *     internalServerException, …) — a documented, first-class part of the AWS event protocol.
 *   - Anthropic / Bedrock Mantle: an SSE `{"type":"error","error":{...}}` event (overloaded_error…).
 *   - OpenAI / OpenRouter: a chunk carrying `{"error":{...}}` and no `choices`.
 *
 * These are the *same* transient failures the HTTP paths surface as 429/5xx — they just arrive
 * after the response headers, which is why {@link HttpError} can't carry them. Without a type
 * of their own they degraded into bare `Error`s that {@link isRetryableError} classified as
 * fatal, so a routine throttle ended the whole run. `retryable` is decided by the provider
 * adapter that recognises the wire shape; the retry loop only reads the flag.
 */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderStreamError";
  }
}

/**
 * Statuses worth retrying: rate limits, the Anthropic-specific 529 "overloaded", request
 * timeouts, and the transient 5xx family. Deliberately excludes 4xx that signal a broken
 * request (400/401/403/404/422) — retrying those just burns the same error and delays the
 * real failure the model needs to see.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 529
    || status === 500 || status === 502 || status === 503 || status === 504;
}

/** True for an AbortController/AbortSignal cancellation — never retried (the user cancelled). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  return name === "AbortError" || code === "ABORT_ERR" || code === 20;
}

const RETRYABLE_NETWORK_RE =
  /fetch failed|network|socket hang up|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|other side closed|premature close/i;

/**
 * Whether a thrown error (as opposed to an HTTP status) is a transient transport failure
 * worth retrying. A user cancel is explicitly not retryable. `HttpError` is delegated to
 * {@link isRetryableStatus}. Undici/fetch surface connection drops either as a `TypeError`
 * ("fetch failed") or with an errno-bearing `cause`, so we look at both.
 */
export function isRetryableError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof HttpError) return isRetryableStatus(err.status);
  if (err instanceof ProviderStreamError) return err.retryable;
  if (err instanceof StreamIdleTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const causeMsg = (() => {
    const cause = (err as { cause?: unknown } | null)?.cause;
    if (!cause) return "";
    const code = (cause as { code?: unknown }).code;
    return `${code ?? ""} ${cause instanceof Error ? cause.message : String(cause)}`;
  })();
  if (RETRYABLE_NETWORK_RE.test(msg) || RETRYABLE_NETWORK_RE.test(causeMsg)) return true;
  // A bare TypeError from fetch is almost always a connection failure.
  return err instanceof TypeError;
}

/**
 * Parse a `Retry-After` header — either delta-seconds ("30") or an HTTP-date — into
 * seconds from now. Returns null when absent or unparseable so the caller falls back to
 * exponential backoff.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.max(0, (asDate - nowMs) / 1000);
  return null;
}

/**
 * Backoff for a given zero-based attempt index. Honours a server Retry-After hint when
 * present (capped to maxDelayMs); otherwise full-jitter exponential
 * (`random() * min(base * 2^attempt, max)`). Full jitter — rather than fixed
 * exponential — is what keeps many concurrent lanes from re-colliding in lockstep after a
 * shared 429. `rand` is injectable for deterministic tests.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterSeconds?: number | null,
  rand: () => number = Math.random,
): number {
  if (retryAfterSeconds != null && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const ceiling = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.floor(rand() * ceiling);
}

/** Sleep that resolves early (rather than rejecting) if the signal aborts, so the caller
 *  can re-check `signal.aborted` and unwind cleanly. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export interface RetryInfo {
  /** 1-based number of the attempt that is about to be retried (i.e. the one that failed). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface RetryAsyncOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (info: RetryInfo) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
}

/**
 * Run `fn`, retrying transient failures with backoff. For non-streaming callers
 * (compressor, Bedrock Converse first-frame acquisition). Streaming provider paths use an
 * inline equivalent so they can yield UI notices between attempts.
 */
export async function retryAsync<T>(fn: (attempt: number) => Promise<T>, opts: RetryAsyncOptions = {}): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? interruptibleSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= policy.maxAttempts - 1;
      if (opts.signal?.aborted || isLast || !isRetryable(err)) throw err;
      const retryAfter = err instanceof HttpError ? err.retryAfterSeconds : null;
      const delayMs = computeBackoffMs(attempt, policy, retryAfter, opts.rand);
      opts.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: policy.maxAttempts,
        delayMs,
        reason: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "retryAsync: no attempts"));
}

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}
