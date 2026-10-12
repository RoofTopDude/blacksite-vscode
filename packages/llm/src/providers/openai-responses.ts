/*
  The OpenAI Responses API route, for reasoning models: it replays encrypted reasoning items so a
  model keeps its reasoning across a tool-call round trip.
*/
import { normalizeForProvider } from "../history.js";
import { resolveReasoningEffort } from "../model-limits.js";
import { FLEX_STREAM_IDLE_TIMEOUT_MS, ProviderStreamError, STREAM_IDLE_TIMEOUT_MS } from "../provider-retry.js";
import { responsesStreamError } from "../stop-reasons.js";
import type { ProviderTurnStreamEvent } from "../types.js";
import {
  appendResponsesWorkspaceContextTail,
  applyOpenAICacheParams,
  hasResponsesCacheBreakpoint,
  looksLikePromptCacheRejection,
  normalizeResponsesStopReason,
  stripOpenAICacheParams,
  toResponsesInputItems,
  toResponsesTools,
  withResponsesCacheBreakpoints,
} from "../wire/openai.js";
import { fetchWithRetry } from "../transport/fetch-retry.js";
import { PROVIDER_BASE_URLS, type ModelRequest, type TransportContext } from "../transport/request.js";
import { readResponseLines } from "../transport/sse.js";

/**
 * Opt-in alternative to `streamOpenAIChat` for OpenAI reasoning models. The Chat Completions
 * API (used by `streamOpenAIChat`) has no way to replay a reasoning model's internal
 * reasoning state across a tool-call round trip — each call starts the model reasoning from
 * scratch about work it already reasoned through last turn. The Responses API's `reasoning`
 * output items carry an opaque `encrypted_content` payload that, replayed verbatim in the
 * next request's `input` array, preserves that continuity. Everything else about this method
 * mirrors `streamOpenAIChat` as closely as the two APIs' shapes allow (retry, flex-tier
 * fallback, idle timeout, prompt caching, service tier) — see that method's comments for the
 * reasoning behind each of those pieces; only what genuinely differs is re-explained here.
 *
 * Scope: first-party OpenAI only (the Responses API is not an OpenRouter/Bedrock/Anthropic
 * surface), custom function tools only (no built-in web_search/computer_use/file_search —
 * this harness doesn't use OpenAI's hosted tools), text + image input (no PDF/file input).
 */

export async function* streamOpenAIResponses(ctx: TransportContext, req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
  // `opts.baseUrl` is documented and UI-labeled as the Chat Completions endpoint override
  // (used verbatim by `streamOpenAIChat`) — the Responses API lives at a sibling path, not
  // the same URL. Swap the well-known suffix so a proxy/Azure/local-server override still
  // resolves to the right endpoint; a baseUrl that doesn't end in it is respected as-is.
  const url = ctx.config.baseUrl
    ? ctx.config.baseUrl.replace(/\/chat\/completions\/?$/, "/responses")
    : PROVIDER_BASE_URLS.openaiResponses;
  const effectiveInstructions = req.systemSummary
    ? `${req.system}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${req.systemSummary}\n---`
    : req.system;

  const plan = req.thinking;
  const maxTok = plan.maxTokens;
  const reasoningEffort = resolveReasoningEffort(req.model, ctx.config.reasoningEffort);
  const tools = toResponsesTools(req.tools.wire);
  const serviceTier = ctx.config.serviceTier && ctx.config.serviceTier !== "auto" ? ctx.config.serviceTier : undefined;

  const makeBody = (): Record<string, unknown> => {
    // Breakpoints go on before the volatile tail is appended — see withResponsesCacheBreakpoints.
    const anchored = withResponsesCacheBreakpoints(toResponsesInputItems(normalizeForProvider(req.messages)));
    const body: Record<string, unknown> = {
      model: req.model,
      input: appendResponsesWorkspaceContextTail(anchored, req.contextTail),
      instructions: effectiveInstructions,
      tools,
      tool_choice: "auto",
      stream: true,
      // We manage history client-side and replay reasoning items ourselves — server-side
      // storage/previous_response_id chaining is a different (stateful) integration model
      // this harness doesn't use. `include` is required to get encrypted_content back at
      // all when store is false.
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: maxTok,
      // Same rationale as the Chat Completions path: steers every request of this
      // conversation to the same cache shard for a materially higher hit rate.
      prompt_cache_key: req.conversationId,
    };
    // Explicit mode is what stops implicit caching from anchoring the volatile workspace tail
    // and re-writing the entire prompt every turn at the 1.25x premium. Gated on an anchor
    // actually being placed: explicit with nothing anchored caches nothing at all, which is
    // worse than the implicit behaviour this replaces.
    applyOpenAICacheParams(body, req.model, hasResponsesCacheBreakpoint(anchored));
    if (reasoningEffort) body["reasoning"] = { effort: reasoningEffort, summary: "auto" };
    if (serviceTier) body["service_tier"] = serviceTier;
    return body;
  };
  const body = makeBody();

  const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ctx.config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  let response = yield* fetchWithRetry(ctx, "OpenAI Responses", doFetch);
  // Mirrors streamOpenAIChat's tier and prompt-cache fallbacks exactly — see that method.
  if (!response.ok && response.status === 400) {
    const text = await response.text().catch(() => "");
    if (serviceTier && /\bservice[_ ]tier\b/i.test(text)) {
      yield { type: "notice", level: "warn", message: `This model doesn't support the "${serviceTier}" processing tier — running this turn at the standard tier instead.` };
      delete (body as Record<string, unknown>)["service_tier"];
      response = yield* fetchWithRetry(ctx, "OpenAI Responses", doFetch);
    } else if (looksLikePromptCacheRejection(response.status, text) && stripOpenAICacheParams(body)) {
      yield { type: "notice", level: "warn", message: "This endpoint rejected the prompt-cache parameters — retrying this turn without them." };
      response = yield* fetchWithRetry(ctx, "OpenAI Responses", doFetch);
    } else {
      throw new Error(`OpenAI Responses ${response.status}: ${text.slice(0, 400)}`);
    }
  } else if (!response.ok && response.status === 429 && serviceTier) {
    await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
    yield { type: "notice", level: "warn", message: `The "${serviceTier}" tier is unavailable right now — running this turn at the standard tier instead.` };
    delete (body as Record<string, unknown>)["service_tier"];
    response = yield* fetchWithRetry(ctx, "OpenAI Responses", doFetch);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Responses ${response.status}: ${text.slice(0, 400)}`);
  }
  if (!response.body) throw new Error("No response body from OpenAI Responses");

  const idleMs = body["service_tier"] === "flex" ? FLEX_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
  yield* parseResponsesSSE(readResponseLines(response.body, { idleMs }));
}

/**
 * Parse the Responses API's SSE event stream. Unlike Anthropic's protocol (which requires
 * accumulating every block from incremental deltas), the Responses API hands back each
 * output item complete and final in its own `response.output_item.done` event — deltas here
 * are consumed only for live UI streaming (`text_delta`/`thinking_delta`), never as the
 * source of truth for the block a caller will persist. This is a deliberately more robust
 * design than manual accumulation: a delta shape this parser doesn't recognize can only cost
 * a moment of missing incremental UI feedback, never a corrupted final block.
 *
 * Terminal detection is driven by the `status` field inside whichever `response.*` event
 * carries a `response` object, rather than by matching an exact set of event-type strings —
 * `response.created`/`response.in_progress` naturally fall through (status "in_progress" or
 * "queued"), and `response.completed`/`response.incomplete`/`response.cancelled` all resolve
 * the same way once a real terminal status arrives. This degrades gracefully if a specific
 * discriminant string this comment doesn't name turns out to differ from what's implemented.
 */
export async function* parseResponsesSSE(lines: AsyncIterable<string>): AsyncGenerator<ProviderTurnStreamEvent> {
  let finished = false;
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

    const evType = String(ev["type"] ?? "");

    if (evType === "response.output_text.delta") {
      const text = String(ev["delta"] ?? "");
      if (text) yield { type: "text_delta", text };
    } else if (evType === "response.reasoning_summary_text.delta") {
      const text = String(ev["delta"] ?? "");
      if (text) yield { type: "thinking_delta", text };
    } else if (evType === "response.output_item.added") {
      const item = ev["item"] as Record<string, unknown> | undefined;
      if (item?.["type"] === "function_call") {
        yield { type: "provider_activity", phase: "tool_input", message: `openai is preparing ${String(item["name"] || "a tool call")}` };
      } else if (item?.["type"] === "reasoning") {
        yield { type: "provider_activity", phase: "thinking", message: "openai is reasoning" };
      }
    } else if (evType === "response.output_item.done") {
      const item = ev["item"] as Record<string, unknown> | undefined;
      if (!item) continue;
      const itemType = String(item["type"] ?? "");
      if (itemType === "reasoning") {
        const summaryParts = item["summary"] as Array<Record<string, unknown>> | undefined;
        const summaryText = (summaryParts ?? [])
          .map((p) => String(p["text"] ?? ""))
          .join("\n")
          .trim();
        const encryptedContent = typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
        const reasoningItemId = typeof item["id"] === "string" ? item["id"] : undefined;
        // Emitted even with an empty summary as long as there's an id/encrypted payload to
        // replay — an assistant turn that made tool calls must lead with its reasoning on
        // replay, the same rule the Anthropic-family thinking_block handling follows.
        if ((summaryText || encryptedContent) && reasoningItemId) {
          yield { type: "thinking_block", text: summaryText, encryptedContent, reasoningItemId };
        }
      } else if (itemType === "function_call") {
        const callId = String(item["call_id"] ?? item["id"] ?? "");
        const name = String(item["name"] ?? "");
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(String(item["arguments"] ?? "{}")) as Record<string, unknown>; } catch { /* partial/invalid JSON → empty; handled by truncation recovery */ }
        if (callId && name) yield { type: "tool_use_block", block: { type: "tool_use", id: callId, name, input } };
      }
      // "message" items: text already streamed via response.output_text.delta and is
      // accumulated by the caller from those events — nothing further needed here.
    } else if (evType === "error") {
      // A top-level stream error (not scoped to a specific response) — OpenAI's own
      // equivalent of Anthropic's mid-stream `{"type":"error",...}` event. Classified by
      // `responsesStreamError`, which knows this endpoint's symbolic (non-numeric) codes;
      // a retryable verdict is what lets ProviderTurnRunner.run re-issue the turn.
      throw responsesStreamError(ev);
    } else if (evType.startsWith("response.")) {
      const resp = ev["response"];
      if (!resp || typeof resp !== "object") continue;
      const respObj = resp as Record<string, unknown>;
      const status = String(respObj["status"] ?? "");
      if (!status || status === "in_progress" || status === "queued") continue; // response.created etc. — not terminal
      if (status === "failed") {
        // `response.failed` carries the same error object as the top-level `error` event and
        // fails for the same reasons (a backend that gave up after the 200). It used to throw a
        // bare Error, which isRetryableError can only classify as fatal — so the transient case
        // ended the run here even once the `error` branch above learned to retry it.
        throw responsesStreamError(respObj);
      }
      finished = true;
      yield { type: "stop_reason", reason: normalizeResponsesStopReason(respObj) };
      const usage = respObj["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const inputDetails = usage["input_tokens_details"] as Record<string, unknown> | undefined;
        const inputTotal = Number(usage["input_tokens"] ?? 0);
        // input_tokens is the total and already contains both details; cache writes were
        // being read but not subtracted, so on GPT-5.6+ (the first family to report them)
        // those tokens were counted twice — once as fresh input, once as a cache write.
        const cacheRead = Math.min(Number(inputDetails?.["cached_tokens"] ?? 0), inputTotal);
        const cacheWrite = Math.min(Number(inputDetails?.["cache_write_tokens"] ?? 0), inputTotal - cacheRead);
        yield {
          type: "usage_update",
          inputTokens: Math.max(0, inputTotal - cacheRead - cacheWrite),
          outputTokens: Number(usage["output_tokens"] ?? 0),
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          // The tier that actually served the request, which OpenAI may downgrade from the
          // one asked for. Drives cost estimation — see the ProviderTurnStreamEvent docs.
          serviceTier: typeof respObj["service_tier"] === "string" ? respObj["service_tier"] : undefined,
        };
      }
    }
  }
  // A stream that closes without ever reaching a terminal response.* event (connection
  // dropped, [DONE] arrived early) must not present as a normal end_turn — the retry layer
  // needs to see this as a real failure to re-attempt, not silently succeed with an empty turn.
  if (!finished) throw new ProviderStreamError("OpenAI Responses stream ended without a terminal response event", true);
}
