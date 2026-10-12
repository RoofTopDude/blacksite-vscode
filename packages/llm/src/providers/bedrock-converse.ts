/*
  The Bedrock Converse route: AWS's own message format over its binary event stream.
*/
import { streamBedrockConverse, type ConverseOptions } from "../bedrock-client.js";
import type { BedrockConverseStreamEvent } from "../bedrock-types.js";
import { normalizeForProvider } from "../history.js";
import { bedrockSupportsCacheTtl1h } from "../model-limits.js";
import { ProviderStreamError } from "../provider-retry.js";
import { parseClaudeVersion } from "../thinking-modes.js";
import { toBedrockThinking } from "../thinking-plan.js";
import type { ModelStopReason, ProviderTurnStreamEvent } from "../types.js";
import {
  appendBedrockWorkspaceContextTail,
  bedrockStreamFrameError,
  isBedrockCacheValidationError,
  normalizeBedrockStopReason,
  toBedrockMessages,
  toBedrockTools,
  withBedrockRollingCacheBreakpoint,
  withBedrockToolsCacheBreakpoint,
} from "../wire/bedrock.js";
import { makeAbortError, resolveCredential, type ModelRequest, type TransportContext } from "../transport/request.js";

export async function* streamBedrockConverseTurn(ctx: TransportContext, req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
  const credentials = await resolveCredential(ctx.config.bedrock);
  if (!credentials) throw new Error("Bedrock provider selected but AWS credentials are not configured.");

  const plan = req.thinking;
  const thinking = toBedrockThinking(plan.thinking);

  // Inject the live workspace block at the message tail, kept out of the systemPrompt field
  // so the Bedrock system/tools cache breakpoints stay stable. Critically, the block is
  // appended AFTER the rolling cache breakpoint (see appendBedrockWorkspaceContextTail).
  const baseBedrockMessages = toBedrockMessages(normalizeForProvider(req.messages));
  const anchorPreviousTurn = parseClaudeVersion(req.model) !== null;
  // The session's cache TTL used to stop at the Anthropic and Mantle paths: Converse sent bare
  // cache points, so a "1h" session (the default) quietly ran on 5-minute entries and paid to
  // rewrite the cache after any pause. Sent only where AWS lists support, and withdrawn for the
  // session on its own if Bedrock still rejects it, before caching as a whole is given up.
  const cacheTtl = ctx.config.cacheTtl === "1h" && !ctx.latches.bedrockCacheTtlUnsupported && bedrockSupportsCacheTtl1h(req.model)
    ? "1h" as const
    : undefined;
  const buildConverseOpts = (useCache: boolean, withTtl = true): ConverseOptions => {
    const ttl = useCache && withTtl ? cacheTtl : undefined;
    return {
      cacheEnabled: useCache,
      cacheTtl: ttl,
      credentials,
      modelId: req.model,
      messages: appendBedrockWorkspaceContextTail(
        useCache ? withBedrockRollingCacheBreakpoint(baseBedrockMessages, { anchorPreviousTurn, ttl }) : baseBedrockMessages,
        req.contextTail,
      ),
      systemPrompt: req.system,
      compressedSummary: req.systemSummary || undefined,
      maxTokens: plan.maxTokens,
      temperature: plan.temperature,
      tools: useCache
        ? withBedrockToolsCacheBreakpoint(toBedrockTools(req.tools.wire), ttl)
        : toBedrockTools(req.tools.wire),
      thinking,
      effort: plan.effort,
    };
  };

  // Transient failures — including the in-band throttle/overload frames that are unique to
  // Converse — are now retried uniformly by ProviderTurnRunner.run, which re-runs this whole
  // generator from scratch. So the only thing left to handle here is the one case that layer
  // cannot: the cache-breakpoint capability probe.
  //
  // Some model/region/quota combinations reject requests containing cachePoint blocks, and
  // unlike the ARN context-length gap that can't be determined from the model id — so detect
  // the rejection live. Issuing the first frame forces the request, and because nothing has
  // been yielded to the caller yet, retrying without breakpoints is invisible. The result is
  // remembered for the rest of the session so we don't pay a failed round-trip every turn.
  if (ctx.signal?.aborted) throw makeAbortError();
  let iterator: AsyncIterator<BedrockConverseStreamEvent>;
  let firstResult: IteratorResult<BedrockConverseStreamEvent>;
  try {
    iterator = streamBedrockConverse(buildConverseOpts(!ctx.latches.bedrockCacheUnsupported), ctx.signal)[Symbol.asyncIterator]();
    firstResult = await iterator.next();
  } catch (err) {
    if (ctx.latches.bedrockCacheUnsupported || !isBedrockCacheValidationError(err)) throw err;
    let recovered = false;
    if (cacheTtl) {
      // Try the 5-minute cache before no cache: the TTL is the newer, narrower feature, and a
      // model that takes cache points at all is far better off keeping them.
      ctx.latches.bedrockCacheTtlUnsupported = true;
      yield { type: "notice", level: "info", message: "This Bedrock model rejected the 1-hour cache duration. Retrying with the 5-minute cache." };
      try {
        iterator = streamBedrockConverse(buildConverseOpts(true, false), ctx.signal)[Symbol.asyncIterator]();
        firstResult = await iterator.next();
        recovered = true;
      } catch (retryErr) {
        if (!isBedrockCacheValidationError(retryErr)) throw retryErr;
      }
    }
    if (!recovered) {
      ctx.latches.bedrockCacheUnsupported = true;
      yield { type: "notice", level: "info", message: "This Bedrock model rejected prompt caching. Retrying without cache markers." };
      iterator = streamBedrockConverse(buildConverseOpts(false), ctx.signal)[Symbol.asyncIterator]();
      firstResult = await iterator.next();
    }
  }

  async function* replay(): AsyncGenerator<BedrockConverseStreamEvent> {
    try {
      if (firstResult.done) return;
      yield firstResult.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }
  const stream = replay();

  // State keyed by Bedrock's contentBlockIndex. A reasoning block has no
  // contentBlockStart event (AWS documents starts as tool-use-only), so inferring it from
  // the start event loses its text/signature when the matching stop arrives. Keep the
  // per-index accumulators just like the Anthropic SSE parser above.
  const thinkingAcc = new Map<number, { text: string; signature?: string; redacted?: string }>();
  const toolUseAcc = new Map<number, { id: string; name: string; input: string }>();
  let stopReason: ModelStopReason | undefined;
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null = null;

  for await (const { eventType, data } of stream) {
    switch (eventType) {
      case "contentBlockStart": {
        const event = data["contentBlockStart"] as { start?: Record<string, unknown>; contentBlockIndex?: unknown } | undefined;
        const start = event?.start
          ?? (data["start"] as Record<string, unknown> | undefined);
        const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
        if (start?.["toolUse"]) {
          const tu = start["toolUse"] as { toolUseId?: string; name?: string };
          toolUseAcc.set(index, { id: tu.toolUseId ?? "", name: tu.name ?? "", input: "" });
          yield { type: "provider_activity", phase: "tool_input", message: `${ctx.config.provider} is preparing ${tu.name || "a tool call"}` };
        }
        break;
      }
      case "contentBlockDelta": {
        const event = data["contentBlockDelta"] as { delta?: Record<string, unknown>; contentBlockIndex?: unknown } | undefined;
        const delta = event?.delta
          ?? (data["delta"] as Record<string, unknown> | undefined);
        const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
        if (delta?.["reasoningContent"]) {
          yield { type: "provider_activity", phase: "thinking", message: `${ctx.config.provider} is reasoning` };
          // Converse splits reasoning across three delta shapes on the same index: `text`,
          // `signature`, and `redactedContent` (the safety-encrypted variant). All three must be
          // accumulated — a block whose payload arrives only as redactedContent still has to be
          // replayed, or the next turn leads with toolUse and Bedrock rejects it.
          const rc = delta["reasoningContent"] as Record<string, unknown>;
          const text = String(rc["text"] ?? "");
          const previous = thinkingAcc.get(index) ?? { text: "" };
          const redactedDelta = typeof rc["redactedContent"] === "string" ? rc["redactedContent"] : undefined;
          thinkingAcc.set(index, {
            text: previous.text + text,
            signature: typeof rc["signature"] === "string" ? rc["signature"] : previous.signature,
            redacted: redactedDelta !== undefined ? (previous.redacted ?? "") + redactedDelta : previous.redacted,
          });
          if (text) yield { type: "thinking_delta", text };
        } else if (delta?.["toolUse"]) {
          const toolUse = toolUseAcc.get(index);
          if (toolUse) toolUse.input += String((delta["toolUse"] as { input?: string }).input ?? "");
        } else if (typeof delta?.["text"] === "string") {
          yield { type: "text_delta", text: delta["text"] as string };
        }
        break;
      }
      case "contentBlockStop": {
        const event = data["contentBlockStop"] as { contentBlockIndex?: unknown } | undefined;
        const index = Number(event?.contentBlockIndex ?? data["contentBlockIndex"] ?? 0);
        const thinking = thinkingAcc.get(index);
        if (thinking) {
          if (thinking.redacted) {
            yield { type: "redacted_thinking_block", data: thinking.redacted };
          } else if (thinking.text || thinking.signature) {
            // Signature-without-text is emitted too: on Claude 4.7+ the default display is
            // "omitted", so reasoning arrives with an empty text field but still occupies a
            // structural slot the next request has to replay.
            yield { type: "thinking_block", text: thinking.text, signature: thinking.signature };
          }
          thinkingAcc.delete(index);
        } else {
          const toolUse = toolUseAcc.get(index);
          if (!toolUse) break;
          let input: Record<string, unknown> = {};
          try { if (toolUse.input) input = JSON.parse(toolUse.input) as Record<string, unknown>; } catch { /* ignore */ }
          yield { type: "tool_use_block", block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input } };
          toolUseAcc.delete(index);
        }
        break;
      }
      case "messageStop": {
        const raw = (data["messageStop"] as { stopReason?: string } | undefined)?.stopReason
          ?? (data["stopReason"] as string | undefined);
        stopReason = normalizeBedrockStopReason(String(raw ?? "end_turn"), { extendedStopReasons: ctx.config.bedrockExtendedStopReasons?.() });
        break;
      }
      case "metadata": {
        type BedrockStreamUsage = {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheWriteInputTokens?: number;
        };
        const u = (data["metadata"] as { usage?: BedrockStreamUsage } | undefined)?.usage
          ?? (data["usage"] as BedrockStreamUsage | undefined);
        if (u) {
          usage = {
            inputTokens: Number(u.inputTokens ?? 0),
            outputTokens: Number(u.outputTokens ?? 0),
            cacheReadTokens: Number(u.cacheReadInputTokens ?? 0),
            cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0),
          };
        }
        break;
      }
      default:
        // Bedrock surfaces a mid-stream failure as a regular protocol frame tagged via the
        // `:exception-type` header (readEventFrame folds it into `eventType` — see
        // bedrock-client.ts), not as an HTTP error. Previously this had no case: the frame
        // was silently dropped, the stream ended right after with no messageStop, and the
        // turn completed as an apparently-successful but silently EMPTY end_turn — the
        // agent looked like it just said nothing, with no error surfaced anywhere. Throwing
        // here routes it through the turn-level retry (throttling/overload → backoff and
        // replay) or, if fatal, the turn error handling — instead of presenting a failure
        // as a normal empty response.
        {
          const frameError = bedrockStreamFrameError(eventType, data);
          if (frameError) throw frameError;
        }
        break;
    }
  }

  if (stopReason === undefined || toolUseAcc.size > 0 || thinkingAcc.size > 0) {
    throw new ProviderStreamError("Bedrock stream ended before the response was complete", true);
  }
  yield { type: "stop_reason", reason: stopReason };
  if (usage) {
    yield { type: "usage_update", ...usage };
  }
}
