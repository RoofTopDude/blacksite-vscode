/*
  One provider turn: open the stream, fold its events into a result, and retry a transient
  failure — before the first byte or mid-stream — without ever splicing two attempts together.
*/
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  HttpError,
  interruptibleSleep,
  isRetryableError,
  outageDelayMs,
  ProviderStreamError,
  type RetryPolicy,
} from "../provider-retry.js";
import type {
  CompactionBlock,
  ContentBlock,
  ModelStopReason,
  ProviderActivityEvent,
  ProviderTurnResult,
  ProviderTurnSink,
  ProviderTurnStreamEvent,
  ReasoningBlock,
  ToolUseBlock,
} from "../types.js";
import { formatDelay, makeAbortError, type ModelRequest } from "./request.js";

export interface ProviderTurnOptions {
  retryPolicy?: RetryPolicy;
  /** How long a run may keep waiting out a provider outage once fast retries are spent. 0 or
   *  absent ends the turn instead. Read when the fast retries run out. */
  outageWaitMs?: () => number;
  signal?: AbortSignal;
  /** Names the provider in activity and retry messages ("anthropic", "bedrock", …). */
  label: string;
  model: string;
}

/**
 * Runs provider turns for one conversation. Stateful only for the outage wait, so a "Retry now"
 * from the user ({@link ProviderTurnRunner.retryNow}) can end it early.
 */
export class ProviderTurnRunner {
  /** Ends the current outage wait early, so a "Retry now" takes effect at once. */
  private outageWake?: () => void;

  /** Wait out part of a provider outage; resolves on the timer, on cancel, or on {@link retryProviderNow}. */
  private outageSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.outageWake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      if (signal?.aborted) { finish(); return; }
      signal?.addEventListener("abort", finish, { once: true });
      this.outageWake = finish;
    });
  }

  /** Try the provider again now instead of at the scheduled time. No effect outside an outage wait. */
  retryNow(): boolean {
    const wake = this.outageWake;
    if (!wake) return false;
    wake();
    return true;
  }


  /**
   * Run one provider turn, retrying a transient failure that struck *after* streaming began.
   *
   * `fetchWithRetry` only covers the pre-stream phase (connect + response status), because a
   * retry there cannot duplicate output — nothing has been emitted yet. But every provider also
   * reports failures *inside* a 200 stream (see {@link ProviderStreamError}), and those were
   * thrown straight to the turn's terminal error handler with no retry at all. On Bedrock that
   * was close to fatal: AWS delivers throttles as in-band exception frames, so the single most
   * common transient failure on that provider bypassed the entire retry layer.
   *
   * Retrying mid-stream is safe here only because the turn is not committed until this method
   * returns: the accumulators below are re-initialised per attempt, and a `turn_reset` tells the
   * UI to drop the partial bubble. The re-issued request is byte-identical (`open` rebuilds it
   * from a history the caller has not touched), so the model simply generates again.
   */
  async run(open: () => AsyncGenerator<ProviderTurnStreamEvent>, sink: ProviderTurnSink, options: ProviderTurnOptions): Promise<ProviderTurnResult> {
    const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    let outageStartedAt: number | undefined;
    let outageRetries = 0;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      if (options.signal?.aborted) throw makeAbortError();
      let activityPhase: ProviderActivityEvent["phase"] | undefined;
      let activityMessage: string | undefined;
      const activity = (phase: ProviderActivityEvent["phase"], message: string): void => {
        if (phase === activityPhase && message === activityMessage) return;
        activityPhase = phase;
        activityMessage = message;
        sink.emit({ type: "provider_activity", phase, message });
      };
      activity("waiting", `Waiting for ${options.label} · ${options.model} (attempt ${attempt + 1}/${policy.maxAttempts})`);
      // Re-initialised per attempt: a retry must not splice its output onto the partial
      // generation that failed.
      const thinkingBlocks: ReasoningBlock[] = [];
      const toolCalls: ToolUseBlock[] = [];
      let text = "";
      // The same turn in arrival order. Used only when it holds provider-executed work, which
      // must replay exactly where it happened; otherwise the canonical order below is kept.
      const ordered: ContentBlock[] = [];
      let pendingText = "";
      let hasNative = false;
      const flushText = (): void => {
        if (pendingText) ordered.push({ type: "text", text: pendingText });
        pendingText = "";
      };
      let stopReason: ModelStopReason | undefined;
      let compactionBlock: CompactionBlock | undefined;
      let usage:
        | {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          serviceTier?: string;
        }
        | undefined;

      const stream = open();

      try {
        for await (const event of stream) {
          if (event.type === "text_delta") activity("responding", `${options.label} is streaming a response`);
          else if (event.type === "thinking_delta" || event.type === "thinking_block" || event.type === "redacted_thinking_block") {
            activity("thinking", `${options.label} is reasoning`);
          } else if (event.type === "notice" && /retry|retrying/i.test(event.message)) activity("retrying", event.message);
          else if (event.type === "provider_activity") {
            activity(event.phase, event.message);
            continue;
          }
          sink.emit(event);
          if (event.type === "text_delta") {
            text += event.text;
            pendingText += event.text;
          } else if (event.type === "thinking_block") {
            const block: ReasoningBlock = {
              type: "thinking",
              thinking: event.text,
              ...(event.signature ? { signature: event.signature } : {}),
              ...(event.encryptedContent ? { encryptedContent: event.encryptedContent } : {}),
              ...(event.reasoningItemId ? { reasoningItemId: event.reasoningItemId } : {}),
            };
            thinkingBlocks.push(block);
            flushText();
            ordered.push(block);
          } else if (event.type === "redacted_thinking_block") {
            thinkingBlocks.push({ type: "redacted_thinking", data: event.data });
            flushText();
            ordered.push({ type: "redacted_thinking", data: event.data });
          } else if (event.type === "tool_use_block") {
            toolCalls.push(event.block);
            flushText();
            ordered.push(event.block);
          } else if (event.type === "provider_native_block") {
            flushText();
            ordered.push(event.block);
            hasNative = true;
          } else if (event.type === "compaction_block") {
            compactionBlock = { type: "compaction", content: event.content };
          } else if (event.type === "stop_reason") {
            stopReason = event.reason;
          } else if (event.type === "usage_update") {
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              serviceTier: event.serviceTier,
            };
          }
        }
        if (stopReason === undefined) {
          throw new ProviderStreamError(`${options.label} stream ended before a completion event`, true);
        }
      } catch (err) {
        if (options.signal?.aborted || !isRetryableError(err)) throw err;
        const isLast = attempt >= policy.maxAttempts - 1;
        // Fast retries are used up. A plan run keeps trying on a slow schedule instead of ending
        // an unattended run over a service that is briefly down.
        let outageWaitMs: number | undefined;
        if (isLast) {
          const budget = options.outageWaitMs?.() ?? 0;
          outageStartedAt ??= Date.now();
          const remaining = budget - (Date.now() - outageStartedAt);
          if (budget <= 0 || remaining <= 0) throw err;
          outageWaitMs = outageDelayMs(outageRetries++, remaining);
        }

        // Release the provider stream before re-issuing — without this the abandoned generator
        // holds its socket open for the whole backoff, and a Bedrock retry storm would leak one
        // connection per attempt.
        await stream.return(undefined).catch(() => { /* generator may already be done */ });

        const reason = err instanceof Error ? err.message : String(err);
        const delayMs = outageWaitMs ?? computeBackoffMs(attempt, policy, err instanceof HttpError ? err.retryAfterSeconds : null);
        sink.emit({ type: "turn_reset", reason });
        if (outageWaitMs !== undefined) {
          sink.emit({
            type: "provider_activity",
            phase: "retrying",
            message: `${options.label} is unavailable (${reason.replace(/\s+/g, " ").slice(0, 120)}) — trying again in ${formatDelay(delayMs)}`,
            outage: true,
            retryAt: Date.now() + delayMs,
          });
          sink.emit({
            type: "notice",
            level: "warn",
            message: `${options.label} is unavailable (${reason}). The plan run is waiting and will try again in ${formatDelay(delayMs)}.`,
          });
          await this.outageSleep(delayMs, options.signal);
          // Stay on the last attempt: the next failure is another slow retry, not a restart of the fast ones.
          attempt = policy.maxAttempts - 2;
          continue;
        }
        activity("retrying", `${options.label}: retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})`);
        sink.emit({
          type: "notice",
          level: "warn",
          message: `${options.label} request failed (${reason}) — discarding any partial response and retrying in ${formatDelay(delayMs)} (attempt ${attempt + 2}/${policy.maxAttempts})…`,
        });
        await interruptibleSleep(delayMs, options.signal);
        continue;
      } finally {
        sink.emit({ type: "provider_activity", phase: "idle", message: "" });
      }

      let normalizedStopReason = stopReason ?? "protocol_violation";
      if (toolCalls.length > 0 && normalizedStopReason !== "tool_use") {
        normalizedStopReason = "protocol_violation";
      } else if (toolCalls.length === 0 && normalizedStopReason === "tool_use") {
        normalizedStopReason = "protocol_violation";
      }
      flushText();
      return {
        text,
        thinkingBlocks,
        toolCalls,
        stopReason: normalizedStopReason,
        usage,
        // Thinking does not count: a reply that reasoned but wrote no text and made no call leaves
        // the user with nothing on screen, which is exactly what the empty-reply recovery is for.
        // Thinking models (the default on current Claude models) produce this shape rather than a
        // truly blank one, so counting their reasoning as content disabled the recovery for them.
        empty: text.trim().length === 0 && toolCalls.length === 0 && !compactionBlock,
        compactionBlock,
        ...(hasNative ? { orderedBlocks: ordered } : {}),
      };
    }

    // Unreachable: the loop either returns a result or throws on the final attempt.
    throw new Error(`${options.label}: provider turn failed after ${policy.maxAttempts} attempts`);
  }
}

/**
 * One finished turn through `transport`, with the same retries as a conversation turn: the
 * simplest way to use a transport when there is no loop around it. Pass `onEvent` to watch it
 * stream.
 */
export function complete(
  transport: { stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ProviderTurnStreamEvent> },
  req: ModelRequest,
  options: Partial<ProviderTurnOptions> & { onEvent?: (event: ProviderTurnStreamEvent) => void } = {},
): Promise<ProviderTurnResult> {
  const { onEvent, ...turn } = options;
  return new ProviderTurnRunner().run(() => transport.stream(req, turn.signal), { emit: onEvent ?? (() => {}) }, {
    label: req.model,
    model: req.model,
    ...turn,
  });
}
