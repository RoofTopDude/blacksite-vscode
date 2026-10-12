/*
  The OpenAI Chat Completions route, shared by OpenAI and OpenRouter.
*/
import { openRouterCitations, openRouterServerToolCall, openRouterWebSearchTool } from "../hosted-search.js";
import { normalizeForProvider } from "../history.js";
import { isOpenAIReasoningModel, resolveReasoningEffort, toOpenRouterReasoningEffort } from "../model-limits.js";
import { FLEX_STREAM_IDLE_TIMEOUT_MS, ProviderStreamError, STREAM_IDLE_TIMEOUT_MS } from "../provider-retry.js";
import { buildSamplingBody } from "../sampling-parameters.js";
import { normalizeOpenAIStopReason, openAIStreamError } from "../stop-reasons.js";
import { acceptsSamplingParams, DEFAULT_CLAUDE_EFFORT, resolveThinkingMode } from "../thinking-modes.js";
import type { ProviderTurnStreamEvent } from "../types.js";
import {
  OpenAIToolCallAccumulator,
  appendOpenAIWorkspaceContextTail,
  applyOpenAICacheParams,
  hasOpenAICacheBreakpoint,
  hasOpenRouterToolTailAnchor,
  looksLikePromptCacheRejection,
  openAISupportsExplicitPromptCache,
  openRouterAnchorsToolResults,
  openRouterSupportsCacheControl,
  stripOpenAICacheParams,
  toOpenAIMessages,
  withOpenAICacheBreakpoints,
  withOpenRouterCacheControl,
} from "../wire/openai.js";
import { fetchWithRetry } from "../transport/fetch-retry.js";
import { PROVIDER_BASE_URLS, type ModelRequest, type TransportContext } from "../transport/request.js";
import { readResponseLines } from "../transport/sse.js";

/**
 * The system string the OpenAI/OpenRouter wire body carries: the system prompt, plus the
 * compressed summary of older history when there is one. Also what PAU measures, so the two
 * cannot disagree about what the provider saw.
 */
export function openAIEffectiveSystem(system: string, summary: string): string {
  return summary
    ? `${system}\n\n---\n[COMPRESSED CONVERSATION HISTORY]\n${summary}\n---`
    : system;
}

export async function* streamOpenAIChat(ctx: TransportContext, req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
  const provider = ctx.config.provider;
  const url  = ctx.config.baseUrl ?? PROVIDER_BASE_URLS[provider as "openrouter" | "openai"];
  const effectiveSystem = openAIEffectiveSystem(req.system, req.systemSummary);
  // Cache breakpoints must be placed BEFORE the volatile workspace-context tail is
  // appended, exactly like the direct Anthropic path (withRollingCacheBreakpoint before
  // appendWorkspaceContextTail): a breakpoint on per-turn content re-writes the whole
  // conversation at the cache-write premium every request and never gets a read hit.
  // So: convert history → mark stable breakpoints → append the volatile tail last.
  let msgs = toOpenAIMessages(normalizeForProvider(req.messages), effectiveSystem);
  // Without the tool-result anchor, for the one-shot retry if OpenRouter rejects that anchor.
  let msgsWithoutToolAnchor: ReturnType<typeof toOpenAIMessages> | undefined;
  // Claude/Gemini models behind OpenRouter honour explicit cache breakpoints — mark the
  // static system prefix and the rolling tail so those runs get the same prompt-cache
  // economics as the direct Anthropic path.
  if (provider === "openrouter" && openRouterSupportsCacheControl(req.model)) {
    const anchorToolTail = !ctx.latches.openRouterToolCacheRejected && openRouterAnchorsToolResults(req.model);
    const marked = withOpenRouterCacheControl(msgs, ctx.config.cacheTtl, { anchorToolTail });
    if (hasOpenRouterToolTailAnchor(marked)) {
      msgsWithoutToolAnchor = appendOpenAIWorkspaceContextTail(withOpenRouterCacheControl(msgs, ctx.config.cacheTtl), req.contextTail);
    }
    msgs = marked;
  }
  // GPT-5.6+ takes the same treatment in OpenAI's own dialect. Earlier OpenAI models have
  // no breakpoint concept at all and rely purely on implicit prefix caching.
  const explicitCache = provider === "openai" && openAISupportsExplicitPromptCache(req.model);
  if (explicitCache) msgs = withOpenAICacheBreakpoints(msgs);
  msgs = appendOpenAIWorkspaceContextTail(msgs, req.contextTail);
  const tools: Array<Record<string, unknown>> = req.tools.wire.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  // OpenRouter's server tool: the model decides when to search, OpenRouter runs it inside this
  // request, and the sources come back as url_citation annotations.
  const hosted = provider === "openrouter" ? req.hostedSearch : undefined;
  const hostedHere = hosted?.provider === "openrouter";
  if (hosted && hostedHere) tools.push(openRouterWebSearchTool(hosted));

  const extraHeaders: Record<string, string> = {};
  if (provider === "openrouter") {
    extraHeaders["HTTP-Referer"] = ctx.config.httpReferer ?? "https://blacksite.dev";
    extraHeaders["X-Title"] = ctx.config.xTitle ?? "Blacksite";
  }

  // OpenAI reasoning models (o1/o3/o4, gpt-5 family) reject `max_tokens` and any
  // `temperature` other than the default — they require `max_completion_tokens`
  // and accept `reasoning_effort`. OpenRouter normalizes these, so only special-case
  // the direct OpenAI provider.
  const reasoning = provider === "openai" && isOpenAIReasoningModel(req.model);
  // OpenRouter forwards its unified `reasoning` parameter to whatever the routed model natively
  // supports. For a Claude model that means Anthropic's own thinking config — so the same
  // per-model dialect rules apply here as on the direct path, and the plan below is what decides
  // between a token budget and an effort rung.
  const plan = req.thinking;
  const maxTok = plan.maxTokens;

  const oaiBody: Record<string, unknown> = {
    model: req.model,
    messages: msgs,
    tools,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  };
  // OpenAI's prompt caching routes by prefix hash; a stable per-session key steers every
  // request of this conversation to the same cache shard, materially raising hit rates for
  // long agent runs (without it, load-balanced requests miss). OpenAI documents this as
  // *required* for reliable matching from GPT-5.6 onward, not merely advisory.
  if (provider === "openai") {
    oaiBody["prompt_cache_key"] = req.conversationId;
    applyOpenAICacheParams(oaiBody, req.model, explicitCache && hasOpenAICacheBreakpoint(msgs));
  }
  // Explicit processing tier (direct OpenAI only). "auto"/unset sends nothing, leaving
  // the account default in charge; "flex" buys reduced rates on flagship models at the
  // cost of queued latency — the fallback below handles the capacity-miss case.
  const serviceTier = provider === "openai" && ctx.config.serviceTier && ctx.config.serviceTier !== "auto"
    ? ctx.config.serviceTier
    : undefined;
  if (serviceTier) oaiBody["service_tier"] = serviceTier;
  if (reasoning) {
    oaiBody["max_completion_tokens"] = maxTok;
    // Clamp to the model family's supported rungs so a persisted deep setting (e.g.
    // "xhigh") survives a switch to a model without it instead of 400ing every turn.
    const effort = resolveReasoningEffort(req.model, ctx.config.reasoningEffort);
    if (effort) oaiBody["reasoning_effort"] = effort;
  } else {
    oaiBody["max_tokens"] = maxTok;
    // plan.temperature, not opts.temperature: OpenRouter forwards this to the routed model, so a
    // Claude 4.7+/Sonnet 5 behind OpenRouter rejects it exactly as it would on the direct path.
    // (The plan leaves non-Claude models' temperature untouched, including OpenAI's 0–2 range.)
    if (plan.temperature !== undefined) oaiBody["temperature"] = plan.temperature;
    // Sampling controls beyond temperature (top_p, top_k, penalties, seed …). Filtered to
    // what the routed model's catalog entry says it accepts, so a control that only some
    // models expose is never sent to one that would 400 on it. Skipped entirely on the
    // reasoning branch above, which rejects sampling parameters the same way it rejects
    // temperature.
    //
    // acceptsSamplingParams is checked for the same reason plan.temperature is stripped
    // above: a modern Claude behind OpenRouter 400s on top_p/top_k outright. The settings
    // panel already hides these controls for those models, but the values persist per
    // provider — so switching to one of them would otherwise keep sending whatever was
    // configured for the previous model and fail every turn.
    if (acceptsSamplingParams(req.model)) {
      Object.assign(oaiBody, buildSamplingBody(ctx.config.sampling, ctx.config.modelSupportedParameters));
    }
  }
  // OpenRouter's unified `reasoning` parameter maps the user's thinking setting onto whatever the
  // routed model natively supports, and is ignored by models without reasoning — so the same
  // toggle that drives Anthropic/Bedrock extended thinking works here too. Which sub-field to
  // send is decided by the routed model, not by us: a token budget on an adaptive-era Claude
  // becomes `thinking.budget_tokens` downstream and 400s, so those models get an effort rung
  // instead. OpenRouter's effort vocabulary is low/medium/high, so the deeper Anthropic rungs
  // (xhigh, max) collapse to "high".
  if (provider === "openrouter") {
    if (plan.thinking.kind === "budget") {
      oaiBody["reasoning"] = { max_tokens: plan.thinking.budgetTokens };
    } else if (plan.thinking.kind === "adaptive") {
      const effort = plan.effort ?? DEFAULT_CLAUDE_EFFORT;
      oaiBody["reasoning"] = { effort: effort === "low" || effort === "medium" ? effort : "high" };
    } else if (resolveThinkingMode(req.model) === "none" && ctx.config.reasoningEffort) {
      // Non-Claude routed models (Gemini thinking, DeepSeek R1, GPT-5 via OR, …): the Claude
      // thinking plan above can never produce a reasoning param for these, so the user's
      // reasoning-effort setting drives the unified param directly. (This used to be sent as
      // a top-level `reasoning_effort` no UI could set for this provider — dead code — while
      // these models silently ran with reasoning at the routed model's default.) "none" maps
      // to sending nothing at all, since the unified param *enables* reasoning when present.
      const effort = toOpenRouterReasoningEffort(ctx.config.reasoningEffort);
      if (effort) oaiBody["reasoning"] = { effort };
    }
    // Thinking off on a Claude model: send no `reasoning` at all. OpenRouter's unified param
    // *enables* reasoning on the routed model, so emitting an effort here would switch back on
    // what the user turned off. (Effort-without-thinking is expressible on the Anthropic-native
    // paths, not through this one.)

    // Model fallback list — OpenRouter tries these in order if the primary model is
    // rate-limited or unavailable, without the caller having to detect and retry itself.
    if (ctx.config.openrouterFallbackModels?.length) {
      oaiBody["models"] = ctx.config.openrouterFallbackModels;
    }
    // Provider-routing preferences — forwarded verbatim as OpenRouter's `provider` object.
    // Only include fields actually set, so an all-default preferences object sends nothing
    // rather than an empty `{}` that could be read as "restrict to zero providers".
    const routing = ctx.config.openrouterProvider;
    if (routing) {
      const providerField: Record<string, unknown> = {};
      if (routing.order?.length) providerField["order"] = routing.order;
      if (routing.allowFallbacks !== undefined) providerField["allow_fallbacks"] = routing.allowFallbacks;
      if (routing.dataCollection) providerField["data_collection"] = routing.dataCollection;
      if (routing.sort) providerField["sort"] = routing.sort;
      if (Object.keys(providerField).length > 0) oaiBody["provider"] = providerField;
    }
  }

  // Serialized at call time so the flex fallback below can mutate oaiBody and re-fetch.
  const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ctx.config.apiKey}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(oaiBody),
    signal,
  });

  let response = yield* fetchWithRetry(ctx, provider, doFetch);
  if (!response.ok && response.status === 400) {
    // Read the body once and dispatch on what it names — a 400 can be a rejected processing
    // tier, a rejected prompt-cache parameter, or a genuine problem with the request.
    const text = await response.text().catch(() => "");
    if (serviceTier && /\bservice[_ ]tier\b/i.test(text)) {
      // Flex/Fast availability is model-limited and changes over time (OpenAI's own guidance
      // calls it "limited model availability"), so rather than hard-failing the run over a
      // stale assumption about which models support it, detect the specific "this model
      // doesn't support that tier" rejection and retry once at the account default. OpenAI
      // names the rejected param in the error body, so this narrowly targets that case — an
      // unrelated 400 (bad tool schema, oversized request, …) still surfaces as a real error.
      yield { type: "notice", level: "warn", message: `This model doesn't support the "${serviceTier}" processing tier — running this turn at the standard tier instead.` };
      delete oaiBody["service_tier"];
      response = yield* fetchWithRetry(ctx, provider, doFetch);
    } else if (looksLikePromptCacheRejection(response.status, text) && stripOpenAICacheParams(oaiBody)) {
      // The caching dialect is picked from the model id (see openAISupportsExplicitPromptCache),
      // which is a threshold guess for anything newer than this build. Getting it wrong must
      // cost a round trip, not the run: retry once with no cache parameters at all, which is
      // always valid and merely forfeits the caching gains for this turn.
      yield { type: "notice", level: "warn", message: "This endpoint rejected the prompt-cache parameters — retrying this turn without them." };
      response = yield* fetchWithRetry(ctx, provider, doFetch);
    } else if (msgsWithoutToolAnchor) {
      // The tool-result cache anchor needs array-form tool content, which is outside what
      // OpenRouter documents. Retry with the documented anchors only; the anchor is blamed —
      // and dropped for the session — only if that retry succeeds, so an unrelated 400 still
      // surfaces as its own error and costs nothing beyond this one round trip.
      oaiBody["messages"] = msgsWithoutToolAnchor;
      response = yield* fetchWithRetry(ctx, provider, doFetch);
      if (response.ok) {
        ctx.latches.openRouterToolCacheRejected = true;
        yield { type: "notice", level: "info", message: "OpenRouter rejected a prompt-cache marker on tool results — continuing without it." };
      }
    } else {
      throw new Error(`${provider} ${response.status}: ${text.slice(0, 400)}`);
    }
  } else if (!response.ok && response.status === 429 && serviceTier) {
    // The requested tier was unavailable even after the standard retry/backoff cycle
    // (flex: no spare capacity; fast: a transient limit). Fall back to the account
    // default for THIS turn only — capacity misses are transient, so the next turn
    // tries the requested tier again — rather than failing the run over a cost/latency
    // preference. OpenAI does not bill a flex request that 429s on capacity.
    await response.body?.cancel().catch(() => { /* releasing the socket is best-effort */ });
    yield { type: "notice", level: "warn", message: `The "${serviceTier}" tier is unavailable right now — running this turn at the standard tier instead.` };
    delete oaiBody["service_tier"];
    response = yield* fetchWithRetry(ctx, provider, doFetch);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${provider} ${response.status}: ${text.slice(0, 400)}`);
  }
  if (!response.body) throw new Error(`No response body from ${provider}`);

  // Reassemble streamed tool-call fragments. Robust to providers that omit `index`
  // (which the old index-keyed map collapsed into one corrupt call) — see the accumulator.
  const toolCalls = new OpenAIToolCallAccumulator();
  let stopReason: string | undefined;
  // Sources OpenRouter attached to the reply, and the search calls it reported itself.
  let citations: unknown[] = [];
  const reportedSearches = new Set<string>();
  let oaiInputTokens = 0;
  let oaiOutputTokens = 0;
  let oaiCachedTokens = 0;
  let oaiCacheWriteTokens = 0;
  // Seeded from the body rather than the `serviceTier` const — the tier fallback above may
  // have dropped this request back to the account default, and costing it as flex would then
  // halve a bill that was charged in full. A backend that doesn't echo the field at all
  // (OpenRouter, a proxy) keeps this seed instead of silently costing at standard rates.
  let oaiServedTier = typeof oaiBody["service_tier"] === "string" ? oaiBody["service_tier"] : undefined;

  // Checked against the body, not the serviceTier const — the flex fallback above may
  // have dropped this request back to the standard tier (and its standard idle bound).
  const idleMs = oaiBody["service_tier"] === "flex" ? FLEX_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
  for await (const line of readResponseLines(response.body, { idleMs })) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    if (json === "[DONE]") break;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

    // OpenRouter (and some OpenAI-compatible backends) can send a mid-stream error chunk
    // — `{"error":{"message":...,"code":...}}`, with no `choices` — after the HTTP response
    // already came back 200 and started streaming (the failure happens routing to the
    // underlying model). Previously this chunk had no `choices`, so `if (!choices?.length)
    // continue` silently skipped it, the stream then ended, and the turn completed as if
    // finished cleanly with whatever partial text had streamed (sometimes nothing). Throw
    // so it surfaces through the turn-level retry (429/5xx from the routed model) or, if
    // fatal, the turn error handling — instead of vanishing.
    const streamError = openAIStreamError(ev);
    if (streamError) throw streamError;

    // Every chunk echoes the tier that actually served this request, which OpenAI is explicit
    // can differ from the one asked for — a flex request runs at the standard tier when flex
    // capacity is out, and "auto" resolves to whatever the account defaults to. Billing
    // follows what served it, so this (not `serviceTier`) is what the cost estimate needs.
    const echoedTier = ev["service_tier"];
    if (typeof echoedTier === "string" && echoedTier) oaiServedTier = echoedTier;

    // OpenAI sends usage in a final chunk (with stream_options.include_usage)
    const topUsage = ev["usage"] as Record<string, unknown> | undefined;
    if (topUsage) {
      oaiInputTokens  = Number(topUsage["prompt_tokens"] ?? 0);
      oaiOutputTokens = Number(topUsage["completion_tokens"] ?? 0);
      // OpenAI/OpenRouter cache the prompt prefix server-side and report the hit under
      // prompt_tokens_details.cached_tokens — surface it so cache rate is visible in metrics.
      const details = topUsage["prompt_tokens_details"] as Record<string, unknown> | undefined;
      oaiCachedTokens = Number(details?.["cached_tokens"] ?? topUsage["cached_tokens"] ?? 0);
      // Tokens newly written into the cache. Free (and unreported) before GPT-5.6; from 5.6
      // on they bill at 1.25x uncached input, so leaving this hardcoded to 0 — as it was —
      // hid a real and, on a long agent run, substantial charge from the cost estimate.
      oaiCacheWriteTokens = Number(details?.["cache_write_tokens"] ?? topUsage["cache_write_tokens"] ?? 0);
    }

    const choices = ev["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) continue;
    const choice = choices[0] as Record<string, unknown> | undefined;
    if (!choice) continue;
    const delta = choice["delta"] as Record<string, unknown> | undefined;
    const finishReason = choice["finish_reason"];
    if (finishReason) stopReason = String(finishReason);

    if (!delta) continue;

    // OpenRouter streams reasoning tokens under delta.reasoning when the unified
    // `reasoning` param is active. Display-only (thinking_delta): unlike Anthropic
    // thinking blocks, these are never replayed into the message history, so they
    // must not become thinking_block entries.
    const reasoningDelta = delta["reasoning"];
    if (typeof reasoningDelta === "string" && reasoningDelta) yield { type: "thinking_delta", text: reasoningDelta };

    const content = delta["content"];
    if (typeof content === "string" && content) yield { type: "text_delta", text: content };

    if (hostedHere) {
      const annotations = delta["annotations"];
      if (Array.isArray(annotations)) citations = citations.concat(annotations);
      const details = delta["reasoning_details"];
      for (const detail of Array.isArray(details) ? details : []) {
        const call = openRouterServerToolCall(detail);
        if (!call || reportedSearches.has(call.id)) continue;
        reportedSearches.add(call.id);
        yield { type: "hosted_search", id: call.id, query: call.query, results: call.results.length ? call.results : openRouterCitations(citations) };
      }
    }

    const toolCallDeltas = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (toolCallDeltas) {
      yield { type: "provider_activity", phase: "tool_input", message: `${provider} is preparing tool calls` };
      for (const tcd of toolCallDeltas) toolCalls.push(tcd);
    }
  }

  if (stopReason === undefined) throw new ProviderStreamError(`${provider} stream ended before a finish reason`, true);

  // Emit reassembled tool calls. With OpenRouter's search on, a web_search call is the server
  // tool, already run — never ours to execute (our own web_search is off the list then).
  const finished = toolCalls.finish();
  let serverSearches = 0;
  for (const block of finished) {
    if (hostedHere && block.name === "web_search") {
      serverSearches++;
      if (!reportedSearches.has(block.id)) {
        reportedSearches.add(block.id);
        yield { type: "hosted_search", id: block.id, query: String(block.input["query"] ?? ""), results: openRouterCitations(citations) };
      }
      continue;
    }
    yield { type: "tool_use_block", block };
  }
  if (serverSearches > 0 && serverSearches === finished.length && stopReason === "tool_calls") stopReason = "stop";
  // No call was reported, but the reply cites what it found: one row for the search's sources.
  if (hostedHere && reportedSearches.size === 0) {
    const sources = openRouterCitations(citations);
    if (sources.length) yield { type: "hosted_search", id: `openrouter-search-${req.conversationId}-${req.turnIndex}`, query: "", results: sources };
  }

  yield { type: "stop_reason", reason: normalizeOpenAIStopReason(stopReason) };
  if (oaiInputTokens > 0 || oaiOutputTokens > 0) {
    // prompt_tokens is the total and already includes both cached and newly-written tokens;
    // split them out so the accounting stays consistent with the Anthropic path
    // (input + cacheRead + cacheWrite = total) and each lands on its own price.
    const cacheRead = Math.min(oaiCachedTokens, oaiInputTokens);
    const cacheWrite = Math.min(oaiCacheWriteTokens, oaiInputTokens - cacheRead);
    yield {
      type: "usage_update",
      inputTokens: Math.max(0, oaiInputTokens - cacheRead - cacheWrite),
      outputTokens: oaiOutputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      serviceTier: oaiServedTier,
    };
  }
}
