/*
  The Anthropic Messages API route (direct), and the SSE parser Bedrock Mantle shares with it.
*/
import { anthropicSearchResults, anthropicWebSearchTool } from "../hosted-search.js";
import {
  appendWorkspaceContextTail,
  normalizeForProvider,
  resolveAnthropicNativeBlocks,
  stripUnsignedThinking,
} from "../history.js";
import { STREAM_IDLE_TIMEOUT_MS } from "../provider-retry.js";
import { anthropicStreamError, normalizeAnthropicStopReason } from "../stop-reasons.js";
import { applyAnthropicThinking, resolveAnthropicBetaExtras } from "../thinking-plan.js";
import type { AgentMessage, HostedSearchPolicy, ProviderTurnStreamEvent } from "../types.js";
import {
  buildAnthropicSystemBlocks,
  cacheControlFor,
  withAnthropicStrictTools,
  withRollingCacheBreakpoint,
} from "../wire/anthropic.js";
import { expandToolReferences } from "../wire/tool-search.js";
import { fetchWithRetry } from "../transport/fetch-retry.js";
import { PROVIDER_BASE_URLS, resolveCredential, type ModelRequest, type ModelToolPlan, type TransportContext } from "../transport/request.js";
import { readResponseLines } from "../transport/sse.js";

/** How many times one turn follows a `pause_turn` (a long server-side search) before giving up. */
const MAX_PAUSE_TURN_RESUMES = 5;

export interface AnthropicParseResult {
  /** The raw stop reason, before normalization (`pause_turn` must be seen as itself). */
  rawStopReason: string;
  /** Every completed block in wire form: what a paused turn must send back unchanged. */
  wireBlocks: Array<Record<string, unknown>>;
}

/** Anthropic-format history for the wire, with tool_search results expanded natively. */
export function anthropicWireMessages(ctx: TransportContext, req: ModelRequest, sentToolNames: ReadonlySet<string>, expandNative = false): unknown[] {
  const messages = appendWorkspaceContextTail(
    withRollingCacheBreakpoint(stripUnsignedThinking(resolveAnthropicNativeBlocks(normalizeForProvider(req.messages), expandNative)), ctx.config.cacheTtl),
    req.contextTail,
  );
  return req.nativeToolSearch && req.tools.references
    ? expandToolReferences(messages as Array<{ role: string; content: unknown }>, req.tools.references, sentToolNames)
    : messages;
}

/** Build the Anthropic wire tool list — strict-marked where the schema qualifies, unless the
 *  session already learned strict isn't accepted — with the trailing cache breakpoint. */
export function buildAnthropicWireTools(ctx: TransportContext, plan: ModelToolPlan, hosted?: HostedSearchPolicy): Array<Record<string, unknown>> {
  const tools = ctx.latches.strictToolsUnsupported
    ? plan.wire.map(({ name, description, input_schema }) =>
        ({ name, description, input_schema }) as Record<string, unknown>)
    : withAnthropicStrictTools(plan.wire);
  // Deferred tools stay out of the prompt prefix until a tool_reference expands them. The plan
  // lists every non-deferred tool first, so the tool breakpoint below lands on the last one —
  // a deferred tool may not carry cache_control at all.
  for (const tool of tools) if (plan.deferred.has(String(tool["name"]))) tool["defer_loading"] = true;
  // Cache the (large, stable) tool-schema block by marking the last loaded tool. Tools come first
  // in Anthropic's prefix order (tools → system → messages), so this entry holds the tool schemas
  // alone — which is what lets delegated lanes, whose system prompts differ from the parent's,
  // still share it. The system block carries its own breakpoint for tools+system. One of the
  // four breakpoints a request may carry; see withRollingCacheBreakpoint for the other two.
  const lastLoaded = tools.map((tool) => tool["defer_loading"] !== true).lastIndexOf(true);
  if (lastLoaded >= 0) tools[lastLoaded]!["cache_control"] = cacheControlFor(ctx.config.cacheTtl);
  // After the breakpoint: the search tool comes and goes with consent, and keeping it out of the
  // cached prefix means switching it on does not rewrite every tool schema at the write premium.
  if (hosted) tools.push(anthropicWebSearchTool(hosted));
  return tools;
}

/** True for a 400 plausibly caused by `strict`/schema validation — the trigger for the
 *  one-shot retry without strict marking. A false positive costs one harmless extra
 *  round-trip whose real error still surfaces. */
export function looksLikeStrictRejection(status: number, text: string): boolean {
  return status === 400 && /\bstrict\b|input_schema/i.test(text);
}

export async function* streamAnthropic(ctx: TransportContext, req: ModelRequest): AsyncGenerator<ProviderTurnStreamEvent> {
  const url = ctx.config.baseUrl ?? PROVIDER_BASE_URLS.anthropic;

  const plan = req.thinking;
  const extras = resolveAnthropicBetaExtras(req.model, req.anthropicBeta ?? {}, false);

  const makeBody = (): Record<string, unknown> => {
    const toolPlan = req.tools;
    const hosted = req.hostedSearch;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: plan.maxTokens,
      system: buildAnthropicSystemBlocks(req.system, req.systemSummary, ctx.config.cacheTtl),
      messages: anthropicWireMessages(ctx, req, new Set(toolPlan.wire.map((tool) => tool.name)), hosted?.provider === "anthropic"),
      tools: buildAnthropicWireTools(ctx, toolPlan, hosted?.provider === "anthropic" ? hosted : undefined),
      stream: true,
    };
    if (plan.temperature !== undefined) body["temperature"] = plan.temperature;
    applyAnthropicThinking(body, plan);
    Object.assign(body, extras.bodyExtras);
    if (extras.taskBudgetTokens) {
      const existingOutputConfig = body["output_config"] as Record<string, unknown> | undefined;
      body["output_config"] = { ...existingOutputConfig, task_budget: { type: "tokens", total: extras.taskBudgetTokens } };
    }
    return body;
  };
  let body = makeBody();

  const anthropicHeaders: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "x-api-key": (await resolveCredential(ctx.config.apiKey)) ?? "",
    "content-type": "application/json",
  };
  // claude-3-7 is the one model that still needs the interleaved-thinking beta header. Claude 4+
  // has it built in, and adaptive thinking enables interleaving on its own — so this only ever
  // applies to the budget dialect.
  const betas = extras.betas.slice();
  if (plan.thinking.kind === "budget" && /claude-3[-.]7/i.test(req.model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }
  if (betas.length > 0) anthropicHeaders["anthropic-beta"] = betas.join(",");
  const doFetch = (signal: AbortSignal | undefined): Promise<Response> => fetch(url, {
    method: "POST",
    headers: anthropicHeaders,
    body: JSON.stringify(body),
    signal,
  });
  let response = yield* fetchWithRetry(ctx, "Anthropic", doFetch);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Strict tool marking is an optimization, never worth failing a run over: an endpoint
    // (or gateway) that rejects it gets one retry with the plain schemas, remembered for
    // the rest of the session — the same live-probe pattern as the Bedrock cachePoint check.
    if (!ctx.latches.strictToolsUnsupported && looksLikeStrictRejection(response.status, text)) {
      ctx.latches.strictToolsUnsupported = true;
      yield { type: "notice", level: "warn", message: "Strict tool schemas were rejected by the endpoint — retrying this turn without them." };
      body = makeBody();
      response = yield* fetchWithRetry(ctx, "Anthropic", doFetch);
      if (!response.ok) {
        const retryText = await response.text().catch(() => "");
        throw new Error(`Anthropic ${response.status}: ${retryText.slice(0, 400)}`);
      }
    } else {
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
    }
  }
  if (!response.body) throw new Error("No response body from Anthropic");

  let parsed = yield* parseAnthropicSSE(response.body, ctx.config.provider, req.messages);
  // A long server-side search can pause the turn. The API continues it when the paused content
  // comes back as the final assistant message, unchanged; what streams next is the rest of the
  // same reply, so it lands in the same turn here too.
  const paused: Array<Record<string, unknown>> = [];
  for (let resumes = 0; parsed.rawStopReason === "pause_turn" && resumes < MAX_PAUSE_TURN_RESUMES; resumes++) {
    paused.push(...parsed.wireBlocks);
    const resumed = makeBody();
    body = { ...resumed, messages: [...(resumed["messages"] as unknown[]), { role: "assistant", content: [...paused] }] };
    response = yield* fetchWithRetry(ctx, "Anthropic", doFetch);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error("No response body from Anthropic");
    parsed = yield* parseAnthropicSSE(response.body, ctx.config.provider, req.messages);
  }
}

/**
 * When server-side compaction fires, `usage.iterations` carries a per-iteration breakdown
 * (a `"compaction"` entry plus the normal `"message"` entry) and the plain top-level
 * `input_tokens`/`output_tokens` reflect only the message iteration — silently undercounting
 * real spend by whatever the compaction pass itself billed. Sum the array when present;
 * return null when absent so the caller falls back to the plain fields unchanged (the
 * exact placement of `iterations` in the streaming variant isn't documented, so this must
 * degrade to today's behavior rather than assume a location that turns out to be wrong).
 */
function sumUsageIterations(usage: Record<string, unknown>): { input: number; output: number } | null {
  const iterations = usage["iterations"];
  if (!Array.isArray(iterations) || iterations.length === 0) return null;
  let input = 0;
  let output = 0;
  for (const entry of iterations) {
    if (!entry || typeof entry !== "object") continue;
    input += Number((entry as Record<string, unknown>)["input_tokens"] ?? 0);
    output += Number((entry as Record<string, unknown>)["output_tokens"] ?? 0);
  }
  return { input, output };
}

export async function* parseAnthropicSSE(body: ReadableStream<Uint8Array>, label: string, history: readonly AgentMessage[]): AsyncGenerator<ProviderTurnStreamEvent, AnthropicParseResult> {
  const reader = readResponseLines(body, { idleMs: STREAM_IDLE_TIMEOUT_MS });
  const textAcc     = new Map<number, string>();
  const thinkingAcc = new Map<number, string>();
  const signatureAcc = new Map<number, string>();
  const redactedAcc = new Map<number, string>();
  const jsonAcc     = new Map<number, string>();
  const blockMeta   = new Map<number, { type: string; id: string; name: string }>();
  // Provider-executed blocks (server_tool_use, web_search_tool_result) exactly as sent, the query
  // behind each server call, and every completed block in wire form: what a paused turn must
  // send back unchanged to be continued.
  const nativeAcc   = new Map<number, Record<string, unknown>>();
  const citationAcc = new Map<number, unknown[]>();
  const searchQueries = new Map<string, string>();
  const wireBlocks: Array<Record<string, unknown>> = [];
  let rawStop = "";
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;

  for await (const line of reader) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(json) as Record<string, unknown>; } catch { continue; }

    const evType = String(ev["type"] ?? "");

    if (evType === "message_start") {
      const msg = ev["message"] as Record<string, unknown> | undefined;
      const usage = msg?.["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const iterations = sumUsageIterations(usage);
        inputTokens = iterations?.input ?? Number(usage["input_tokens"] ?? 0);
        cacheReadTokens = Number(usage["cache_read_input_tokens"] ?? 0);
        cacheWriteTokens = Number(usage["cache_creation_input_tokens"] ?? 0);
      }
    } else if (evType === "content_block_start") {
      const idx = Number(ev["index"]);
      const cb = ev["content_block"] as Record<string, unknown>;
      const cbType = String(cb["type"] ?? "");
      blockMeta.set(idx, { type: cbType, id: String(cb["id"] ?? ""), name: String(cb["name"] ?? "") });
      if (cbType === "text") textAcc.set(idx, "");
      if (cbType === "thinking") thinkingAcc.set(idx, "");
      if (cbType === "tool_use") {
        jsonAcc.set(idx, "");
        yield { type: "provider_activity", phase: "tool_input", message: `${label} is preparing ${String(cb["name"] || "a tool call")}` };
      } else if (cbType === "thinking" || cbType === "redacted_thinking") {
        yield { type: "provider_activity", phase: "thinking", message: `${label} is reasoning` };
      }
      // A redacted thinking block arrives complete in content_block_start — its encrypted payload
      // is in `data`, and no deltas follow. The parser previously had no case for this block type
      // at all, so it was dropped, and the assistant turn it belonged to replayed leading with
      // tool_use instead of its reasoning — a 400 on the next request.
      if (cbType === "redacted_thinking") redactedAcc.set(idx, String(cb["data"] ?? ""));
      // The provider's own search. The call's input streams in like a tool_use's; its result
      // block arrives complete, encrypted content and all, and is kept byte for byte.
      if (cbType === "server_tool_use") {
        jsonAcc.set(idx, "");
        nativeAcc.set(idx, { ...cb });
        yield { type: "provider_activity", phase: "tool_input", message: `${label} is searching the web` };
      } else if (cbType !== "tool_result" && cbType.endsWith("_tool_result")) {
        nativeAcc.set(idx, { ...cb });
      }
      // A refusal-fallback switch point (only appears when the session opted into
      // server-side fallbacks — see resolveAnthropicBetaExtras). Purely informational: the
      // block itself is an "ignored audit marker" per Anthropic's docs, so it needs no
      // accumulator entry — just surface which model took over.
      if (cbType === "fallback") {
        const from = (cb["from"] as Record<string, unknown> | undefined)?.["model"];
        const to = (cb["to"] as Record<string, unknown> | undefined)?.["model"];
        if (from || to) {
          yield { type: "notice", level: "warn", message: `${from ?? "The primary model"} declined this turn — continuing on ${to ?? "the fallback model"}.` };
        }
      }
    } else if (evType === "content_block_delta") {
      const idx = Number(ev["index"]);
      const delta = ev["delta"] as Record<string, unknown>;
      const dType = String(delta["type"] ?? "");
      if (dType === "text_delta") {
        const text = String(delta["text"] ?? "");
        textAcc.set(idx, (textAcc.get(idx) ?? "") + text);
        yield { type: "text_delta", text };
      } else if (dType === "thinking_delta") {
        const text = String(delta["thinking"] ?? "");
        thinkingAcc.set(idx, (thinkingAcc.get(idx) ?? "") + text);
        if (text) yield { type: "thinking_delta", text };
      } else if (dType === "signature_delta") {
        // The cryptographic signature for a thinking block arrives in its own delta.
        // Capture it so the block can be replayed to Anthropic verbatim — an unsigned
        // thinking block is rejected with a 400 once extended thinking is enabled.
        signatureAcc.set(idx, (signatureAcc.get(idx) ?? "") + String(delta["signature"] ?? ""));
      } else if (dType === "input_json_delta") {
        jsonAcc.set(idx, (jsonAcc.get(idx) ?? "") + String(delta["partial_json"] ?? ""));
      } else if (dType === "citations_delta") {
        // Kept only for continuing a paused turn, which must resend the text as it came.
        if (delta["citation"]) citationAcc.set(idx, [...(citationAcc.get(idx) ?? []), delta["citation"]]);
      } else if (dType === "compaction_delta") {
        // Server-side compaction (beta compact-2026-01-12) is documented as non-incremental —
        // the full summary arrives in exactly one delta event, unlike text/thinking which
        // stream char-by-char. Yielding directly here (rather than accumulating into a map
        // and reading it at content_block_stop, as every other block type does) is safe only
        // because of that one-shot guarantee; if that ever changes, a second delta for the
        // same index would silently overwrite rather than append.
        const content = String(delta["content"] ?? "");
        if (content) yield { type: "compaction_block", content };
      }
    } else if (evType === "content_block_stop") {
      const idx = Number(ev["index"]);
      const meta = blockMeta.get(idx);
      if (meta?.type === "tool_use") {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(jsonAcc.get(idx) ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }
        yield { type: "tool_use_block", block: { type: "tool_use", id: meta.id, name: meta.name, input } };
        wireBlocks.push({ type: "tool_use", id: meta.id, name: meta.name, input });
      } else if (meta?.type === "thinking") {
        const thinkingText = thinkingAcc.get(idx) ?? "";
        const signature = signatureAcc.get(idx) || undefined;
        // Emit on a signature even with no text. `display: "omitted"` (the default on Claude 4.7+)
        // streams thinking blocks whose text is empty — but the block is still a structural part
        // of the turn, and an assistant turn that made tool calls must lead with its reasoning on
        // replay. Requiring text here silently dropped it and earned a 400 on the next request.
        if (thinkingText || signature) {
          yield { type: "thinking_block", text: thinkingText, signature };
          wireBlocks.push({ type: "thinking", thinking: thinkingText, ...(signature ? { signature } : {}) });
        }
      } else if (meta?.type === "redacted_thinking") {
        const data = redactedAcc.get(idx) ?? "";
        if (data) {
          yield { type: "redacted_thinking_block", data };
          wireBlocks.push({ type: "redacted_thinking", data });
        }
      } else if (meta?.type === "text") {
        // The API rejects an empty text block, so one that never received a delta is left out.
        const citations = citationAcc.get(idx);
        const blockText = textAcc.get(idx) ?? "";
        if (blockText) wireBlocks.push({ type: "text", text: blockText, ...(citations?.length ? { citations } : {}) });
      } else if (meta?.type === "server_tool_use") {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(jsonAcc.get(idx) || "{}") as Record<string, unknown>; } catch { /* keep {} */ }
        const block: Record<string, unknown> = { ...nativeAcc.get(idx), input };
        if (typeof input["query"] === "string") searchQueries.set(String(block["id"] ?? ""), input["query"]);
        wireBlocks.push(block);
        yield { type: "provider_native_block", block: { type: "provider_native", provider: "anthropic", block } };
      } else if (meta && nativeAcc.has(idx)) {
        const block = nativeAcc.get(idx)!;
        wireBlocks.push(block);
        yield { type: "provider_native_block", block: { type: "provider_native", provider: "anthropic", block } };
        if (meta.type === "web_search_tool_result") {
          const id = String(block["tool_use_id"] ?? "");
          const { results, error } = anthropicSearchResults(block["content"]);
          yield { type: "hosted_search", id, query: searchQueries.get(id) ?? priorSearchQuery(history, id), results, ...(error ? { error } : {}) };
        }
      }
    } else if (evType === "message_delta") {
      const delta = ev["delta"] as Record<string, unknown>;
      const rawStopReason = String(delta["stop_reason"] ?? "end_turn");
      rawStop = rawStopReason;
      // stop_details is populated only on a refusal, and rides the same delta object as
      // stop_reason/stop_sequence. Surface it as a preceding notice so the generic "declined
      // to complete this response" diagnostic gets a specific category/explanation in front
      // of it, instead of leaving the operator to guess why.
      if (rawStopReason === "refusal") {
        const details = delta["stop_details"] as Record<string, unknown> | undefined;
        const category = details?.["category"];
        const explanation = details?.["explanation"];
        const parts = [
          typeof category === "string" && category ? `category: ${category}` : null,
          typeof explanation === "string" && explanation ? explanation : null,
        ].filter((p): p is string => p !== null);
        if (parts.length > 0) {
          yield { type: "notice", level: "warn", message: `Refusal details — ${parts.join("; ")}` };
        }
      }
      yield { type: "stop_reason", reason: normalizeAnthropicStopReason(rawStopReason) };
      const usage = ev["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        const iterations = sumUsageIterations(usage);
        outputTokens = iterations?.output ?? Number(usage["output_tokens"] ?? 0);
        // The compaction pass's own input tokens are real spend that message_start's
        // pre-compaction snapshot couldn't have known about yet — only override upward
        // (never let a message_delta lacking iterations erase what message_start already
        // established from its own, possibly-present iterations breakdown).
        if (iterations) inputTokens = Math.max(inputTokens, iterations.input);
      }
    } else if (evType === "error") {
      // Anthropic (and Bedrock Mantle, which shares this parser) can send a mid-stream
      // `{"type":"error","error":{...}}` event — e.g. overloaded_error, api_error — after
      // already streaming partial content. Previously this matched none of the branches
      // above, so it was silently dropped: the connection closes right after with no
      // message_delta/stop_reason, and the turn completed as if it had ended cleanly with
      // whatever partial text/thinking had streamed so far (sometimes nothing at all).
      // Throwing a classified ProviderStreamError surfaces it through the turn-level retry
      // (overloaded_error → retried with backoff) or, if fatal, the turn error handling.
      throw anthropicStreamError(ev);
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: "usage_update", inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  }
  return { rawStopReason: rawStop, wireBlocks };
}

/**
 * The query of a search the model asked for in an earlier response. A server call made in the
 * same parallel group as a client tool runs only on the next request, so its result arrives in
 * a later response than the call that named the query.
 */
function priorSearchQuery(history: readonly AgentMessage[], id: string): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i]!.content;
    if (typeof content === "string") continue;
    for (const block of content) {
      if (block.type === "provider_native" && block.block["type"] === "server_tool_use" && block.block["id"] === id) {
        const input = block.block["input"] as Record<string, unknown> | undefined;
        return typeof input?.["query"] === "string" ? input["query"] : "";
      }
    }
  }
  return "";
}
