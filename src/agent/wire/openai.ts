/*
  OpenAI / OpenRouter / Responses-API wire format: message and tool-item shaping, the
  explicit prompt-cache breakpoint placement each of the three APIs wants, streamed
  tool-call reassembly, and stop-reason normalization.

  Extracted from agent-session.ts, which re-exports every symbol here so existing call sites
  and specs keep importing them from there. Pure functions and one accumulator class — no
  session state, so each piece is testable without driving a provider turn.
*/
/* OpenRouter proxies Anthropic-family models, which expect Anthropic's own cache_control
   object on the wire — so the marker is built by the Anthropic module, not duplicated here. */
import { cacheControlFor } from "./anthropic.js";
import type { AgentStopReason } from "../../session-state.js";
import type {
  AgentMessage,
  ContentBlock,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../../agent-loop-contract.js";
import type { CacheTtl } from "../../agent-session.js";

export interface OAIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
/** OpenAI's explicit prompt-cache marker (GPT-5.6+). Placed on a content block, it declares
 *  that block — and everything rendered before it — the end of a reusable prefix. */
export interface OAICacheBreakpoint { mode: "explicit" }
export type OAIContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" }; prompt_cache_breakpoint?: OAICacheBreakpoint }
  | { type: "image_url"; image_url: { url: string } };
export interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OAIContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

/**
 * Reassembles streamed OpenAI/OpenRouter tool-call fragments into complete tool_use blocks.
 *
 * The wire protocol keys each fragment by `index` (its slot in the `tool_calls` array): the
 * first fragment for an index carries `id` + `function.name`, later fragments append
 * `function.arguments`. But several OpenAI-compatible backends routed via OpenRouter omit
 * `index` (or send it inconsistently). The previous accumulator did `Number(index ?? 0)`,
 * collapsing every index-less fragment onto slot 0 — which merged two distinct parallel tool
 * calls into one corrupt call and dropped any call that never carried an id. This accumulator:
 *   - keys by `index` when present,
 *   - starts a new call whenever an `id` arrives (an id always marks a call boundary),
 *   - otherwise appends to the call currently in progress (the index-less streaming case),
 * and synthesizes an id at the end when a provider never supplied one, so downstream
 * tool_result pairing still works.
 */
export class OpenAIToolCallAccumulator {
  private readonly calls: Array<{ id: string; name: string; args: string }> = [];
  private readonly indexToPos = new Map<number, number>();
  private activePos = -1;

  push(delta: Record<string, unknown>): void {
    const idx = normalizeToolCallIndex(delta["index"]);
    const id = delta["id"] != null && delta["id"] !== "" ? String(delta["id"]) : undefined;
    const fn = delta["function"] as Record<string, unknown> | undefined;
    const name = fn?.["name"] != null ? String(fn["name"]) : undefined;
    const argFragment = fn?.["arguments"] != null ? String(fn["arguments"]) : "";

    let pos: number;
    if (idx !== undefined && this.indexToPos.has(idx)) {
      pos = this.indexToPos.get(idx)!;
    } else if (id !== undefined) {
      pos = this.calls.length;
      this.calls.push({ id, name: name ?? "", args: "" });
      if (idx !== undefined) this.indexToPos.set(idx, pos);
      this.activePos = pos;
    } else if (idx !== undefined) {
      pos = this.calls.length;
      this.calls.push({ id: "", name: name ?? "", args: "" });
      this.indexToPos.set(idx, pos);
      this.activePos = pos;
    } else if (this.activePos >= 0) {
      pos = this.activePos;
    } else {
      return; // fragment arrived before any call was established and carries no id — nothing to attach to
    }

    const call = this.calls[pos]!;
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    call.args += argFragment;
  }

  finish(): ToolUseBlock[] {
    const blocks: ToolUseBlock[] = [];
    this.calls.forEach((call, i) => {
      if (!call.name) return; // no function name ever arrived — unusable, drop it
      let input: Record<string, unknown> = {};
      try { if (call.args) input = JSON.parse(call.args) as Record<string, unknown>; } catch { /* partial/invalid JSON → empty; handled by the loop's truncation recovery */ }
      blocks.push({ type: "tool_use", id: call.id || `oai_call_${Date.now().toString(36)}_${i}`, name: call.name, input });
    });
    return blocks;
  }
}

function normalizeToolCallIndex(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/**
 * True when an OpenRouter model id routes to a provider that honours explicit
 * `cache_control` breakpoints (Anthropic and Gemini). Deliberately a conservative
 * allowlist: OpenRouter simply strips the field for providers that don't support it, so a
 * false positive is harmless, and a false negative just means today's status quo (no
 * explicit caching). OpenAI models cache automatically server-side either way.
 */
export function openRouterSupportsCacheControl(model: string): boolean {
  return /\b(anthropic|claude|gemini)\b/i.test(model);
}

// ── Strict tool use (Anthropic Messages API + Bedrock Mantle) ─────────────────


export function appendOpenAIWorkspaceContextTail(messages: OAIMessage[], workspaceContext: string): OAIMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  return [...messages, { role: "user", content: workspaceContext }];
}

/**
 * True when a direct-OpenAI model speaks the GPT-5.6-era explicit prompt-cache dialect
 * (`prompt_cache_options` + per-block `prompt_cache_breakpoint`).
 *
 * Threshold-shaped rather than an id list, for the same reason as {@link supportedReasoningEfforts}:
 * a model released after this code was written should get the current generation's caching
 * behaviour instead of silently falling back to the legacy path. A wrong guess is recoverable —
 * `_streamTurnOpenAI` retries once without the cache parameters if the endpoint rejects them.
 */
export function openAISupportsExplicitPromptCache(model: string): boolean {
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(model.trim().toLowerCase());
  if (!gpt) return false; // o-series and anything unrecognised: legacy caching only
  const major = Number(gpt[1]);
  const minor = gpt[2] ? Number(gpt[2]) : 0;
  return major > 5 || (major === 5 && minor >= 6);
}

/**
 * Request-level prompt-cache configuration for the direct OpenAI provider. Mutates `body` in
 * place; shared by the Chat Completions and Responses paths, which take identical fields here.
 *
 * Two dialects, split at GPT-5.6:
 *  - 5.6+ takes `prompt_cache_options.mode: "explicit"`, which suppresses the automatic
 *    breakpoint OpenAI would otherwise place on the newest message. That default is actively
 *    wrong for this harness — the newest message is the volatile workspace tail, so the implicit
 *    breakpoint re-writes it into the cache at the 1.25x premium every single turn and none of
 *    those tokens can ever come back as a read. Explicit mode makes the stable breakpoints from
 *    {@link withOpenAICacheBreakpoints} the only ones that write, which is what moves those
 *    tokens out of `cache_write_tokens` and into `cached_tokens` on the following turn.
 *    `ttl` is left unset: "30m" is currently both the default and the only accepted value, so
 *    naming it would only add a field to break on when that changes.
 *  - Older models take `prompt_cache_retention: "24h"`, which is deprecated for 5.6+ and would
 *    be rejected there. Without it, a ZDR-enabled organisation silently gets the `in_memory`
 *    policy — 5–10 minutes of idle tolerance — and an agent run pauses for a code review or a
 *    long tool call comes back to a cold cache.
 *
 * `breakpointsPlaced` guards the one way this could backfire: explicit mode with no breakpoints
 * in the payload disables caching outright. A caller that could not anchor one stays on implicit
 * mode, which is merely wasteful rather than useless.
 */
export function applyOpenAICacheParams(body: Record<string, unknown>, model: string, breakpointsPlaced: boolean): void {
  if (!openAISupportsExplicitPromptCache(model)) { body["prompt_cache_retention"] = "24h"; return; }
  if (breakpointsPlaced) body["prompt_cache_options"] = { mode: "explicit" };
}

/** Strip everything {@link applyOpenAICacheParams}, {@link withOpenAICacheBreakpoints} and
 *  {@link withResponsesCacheBreakpoints} put on a request, for the one-shot retry after an
 *  endpoint rejects them. Returns true if anything was actually removed, so the caller only
 *  retries when there is a change to retry with. Both payload shapes are swept: `messages` for
 *  Chat Completions and `input` for Responses. Sweeping only `messages` — as this did while the
 *  Responses path carried no breakpoints — would now retry a rejected Responses request with the
 *  very breakpoints that were rejected still on it, turning the one-shot recovery into a
 *  guaranteed second failure. */
export function stripOpenAICacheParams(body: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["prompt_cache_options", "prompt_cache_retention"]) {
    if (key in body) { delete body[key]; changed = true; }
  }
  const messages = body["messages"];
  if (Array.isArray(messages)) {
    body["messages"] = (messages as OAIMessage[]).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      if (!msg.content.some((part) => part.type === "text" && part.prompt_cache_breakpoint)) return msg;
      changed = true;
      return {
        ...msg,
        content: msg.content.map((part) =>
          part.type === "text" && part.prompt_cache_breakpoint
            ? { type: "text" as const, text: part.text, ...(part.cache_control ? { cache_control: part.cache_control } : {}) }
            : part),
      };
    });
  }
  const input = body["input"];
  if (Array.isArray(input)) {
    body["input"] = (input as Array<Record<string, unknown>>).map((item) => {
      const content = item["content"];
      if (!Array.isArray(content)) return item;
      const parts = content as Array<Record<string, unknown>>;
      if (!parts.some((part) => part["prompt_cache_breakpoint"])) return item;
      changed = true;
      return {
        ...item,
        content: parts.map((part) => {
          if (!part["prompt_cache_breakpoint"]) return part;
          const { prompt_cache_breakpoint: _dropped, ...rest } = part;
          return rest;
        }),
      };
    });
  }
  return changed;
}

/** True for a 400 plausibly caused by a prompt-cache parameter this build sent — the trigger for
 *  the one-shot retry without them. OpenAI names the offending parameter in the error body, so
 *  this stays narrow: an unrelated 400 still surfaces as a real error. */
export function looksLikePromptCacheRejection(status: number, text: string): boolean {
  return status === 400 && /prompt_cache_(?:options|retention|breakpoint)/i.test(text);
}

/**
 * Mark the reusable prompt prefix for OpenAI's explicit prompt caching (GPT-5.6+).
 *
 * GPT-5.6 changed the economics enough that the previous "send `prompt_cache_key` and let
 * implicit caching sort it out" approach actively worked against this harness. Implicit mode
 * auto-places a breakpoint on the *latest* message, and the latest message here is the volatile
 * per-turn workspace-context tail — so every request wrote the entire prompt into a cache entry
 * keyed on content that never recurs, at the 1.25x write premium 5.6 introduced, while the
 * stable conversation prefix never got a breakpoint of its own to be re-read from. The result
 * was the observed near-zero hit rate on Sol/Terra/Luna alongside a write charge on every turn.
 *
 * Two breakpoints, mirroring the direct Anthropic path's economics exactly (see
 * {@link withOpenRouterCacheControl}, which does the same job in OpenRouter's dialect):
 *  - the system message — the large static system+tools prefix, stable for the whole session, and
 *  - the last message of the real conversation (rolling) — so everything up to this turn is a
 *    cache read on the next one.
 *
 * MUST be called before {@link appendOpenAIWorkspaceContextTail}: a breakpoint on the volatile
 * tail is precisely the failure this exists to avoid. OpenAI allows up to four new cache writes
 * per request, so two leaves headroom. Never mutates the input array or its messages.
 */
export function withOpenAICacheBreakpoints(messages: OAIMessage[]): OAIMessage[] {
  const markLastTextPart = (msg: OAIMessage): OAIMessage => {
    const breakpoint: OAICacheBreakpoint = { mode: "explicit" };
    if (typeof msg.content === "string") {
      // A bare string has no block to hang the marker on; promote it to the one-part form.
      // Empty strings are left alone — an empty text block is not a valid cache anchor.
      return msg.content
        ? { ...msg, content: [{ type: "text", text: msg.content, prompt_cache_breakpoint: breakpoint }] }
        : msg;
    }
    if (!Array.isArray(msg.content)) return msg;
    const parts = msg.content.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]!;
      if (part.type === "text") {
        parts[i] = { ...part, prompt_cache_breakpoint: breakpoint };
        return { ...msg, content: parts };
      }
    }
    return msg;
  };

  const out = messages.slice();
  const systemIdx = out.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) out[systemIdx] = markLastTextPart(out[systemIdx]!);
  // Rolling breakpoint on the final message of the conversation proper. Deliberately not
  // restricted to user messages (unlike the OpenRouter twin, where the provider only documents
  // breakpoints on system/user): an agent turn usually ends on a tool result, and anchoring
  // further back would leave the whole tool round-trip re-billed as fresh input every iteration.
  for (let i = out.length - 1; i >= 0; i--) {
    if (i === systemIdx) break; // system-only prompt — one breakpoint is already enough
    const marked = markLastTextPart(out[i]!);
    if (marked !== out[i]) { out[i] = marked; break; }
  }
  return out;
}

/** Whether any message carries an explicit prompt-cache breakpoint. Gates `mode: "explicit"`,
 *  which disables caching entirely if the payload turns out to have nothing anchored. */
export function hasOpenAICacheBreakpoint(messages: OAIMessage[]): boolean {
  return messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some((part) => part.type === "text" && part.prompt_cache_breakpoint));
}

/**
 * Responses-API twin of {@link withOpenAICacheBreakpoints}: anchor the reusable prefix of the
 * `input` array so it comes back as a cache *read* instead of being rewritten every turn.
 *
 * This path was left on implicit caching, and measurement says that was expensive. Across a real
 * 635-iteration session: 68.7% of all input tokens were `cache_write_tokens` against 24% reads —
 * a 2.87:1 write:read ratio, on a model family where a write bills at 1.25x fresh input. The
 * cause is exactly the one {@link applyOpenAICacheParams} already documents for Chat Completions:
 * implicit mode auto-anchors the *newest* item, the newest item here is the per-turn workspace
 * tail from {@link appendResponsesWorkspaceContextTail}, and a breakpoint keyed on content that
 * never recurs can only ever be written. The reads that did land were the one cold prefix cached
 * before any tail existed, which is why cacheR sat flat near 30k while cacheW climbed all session.
 *
 * Anchors go on `message` items with `role: "user"` only. Tool results ride in
 * `function_call_output` items, whose `output` is a bare string with no content part to hang a
 * marker on, and the API documents breakpoints on `input_text`/`input_image`/`input_file`. Being
 * conservative here costs the trailing tool round-trips of the current turn — real, but small
 * against a prefix that is the whole conversation — and mirrors {@link withOpenRouterCacheControl},
 * which is narrow for the same "only anchor what the provider documents" reason.
 *
 * MUST be called before {@link appendResponsesWorkspaceContextTail}, for the same reason its Chat
 * Completions twin must: anchoring the volatile tail is the failure being fixed, not the fix.
 * Never mutates the input array or its items.
 */
export function withResponsesCacheBreakpoints(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const anchored = (item: Record<string, unknown>): Record<string, unknown> | null => {
    if (item["type"] !== "message" || item["role"] !== "user") return null;
    const breakpoint = { mode: "explicit" };
    const content = item["content"];
    if (typeof content === "string") {
      // An empty string is not a valid anchor — same rule as the Chat Completions twin.
      return content ? { ...item, content: [{ type: "input_text", text: content, prompt_cache_breakpoint: breakpoint }] } : null;
    }
    if (!Array.isArray(content)) return null;
    const parts = (content as Array<Record<string, unknown>>).slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]?.["type"] === "input_text") {
        parts[i] = { ...parts[i], prompt_cache_breakpoint: breakpoint };
        return { ...item, content: parts };
      }
    }
    return null;
  };

  const out = items.slice();
  // First anchorable item: caches the static prefix ahead of it — `instructions` and the tool
  // schemas, which on this harness is the single largest stable block in the request.
  // Last anchorable item: rolling, so everything through the newest user turn reads back next time.
  let first = -1;
  for (let i = 0; i < out.length; i++) {
    const marked = anchored(out[i]!);
    if (marked) { out[i] = marked; first = i; break; }
  }
  if (first === -1) return items;
  for (let i = out.length - 1; i > first; i--) {
    const marked = anchored(out[i]!);
    if (marked) { out[i] = marked; break; }
  }
  return out;
}

/** Responses twin of {@link hasOpenAICacheBreakpoint} — gates `mode: "explicit"`, which caches
 *  nothing at all if the payload turned out to have no anchor. */
export function hasResponsesCacheBreakpoint(items: Array<Record<string, unknown>>): boolean {
  return items.some((item) =>
    Array.isArray(item["content"])
    && (item["content"] as Array<Record<string, unknown>>).some((part) => part["prompt_cache_breakpoint"]));
}

/**
 * Add Anthropic-style prompt-cache breakpoints to an OpenAI-format message array for
 * OpenRouter, which forwards `cache_control` on multipart text content to providers that
 * support it. Without this, a Claude/Gemini model driven through OpenRouter re-bills the
 * entire prompt every turn — the direct Anthropic/Bedrock paths have had these breakpoints
 * all along, and OpenRouter runs were paying full freight for the same tokens.
 *
 * Two breakpoints, mirroring the direct path's economics:
 *  - the system message (Anthropic orders tools before system, so this one breakpoint
 *    caches the entire static tools+system prefix), and
 *  - the last user message (rolling; everything before it — most of a long conversation —
 *    is re-read from cache on the next turn).
 * Tool-role messages are left untouched: OpenRouter only documents breakpoints on
 * system/user multipart text content. Never mutates the input array or its messages.
 */
export function withOpenRouterCacheControl(messages: OAIMessage[], cacheTtl?: CacheTtl): OAIMessage[] {
  const markLastTextPart = (msg: OAIMessage): OAIMessage => {
    if (typeof msg.content === "string") {
      return { ...msg, content: [{ type: "text", text: msg.content, cache_control: cacheControlFor(cacheTtl) }] };
    }
    if (!Array.isArray(msg.content)) return msg;
    const parts = msg.content.slice();
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]!;
      if (part.type === "text") {
        parts[i] = { ...part, cache_control: cacheControlFor(cacheTtl) };
        return { ...msg, content: parts };
      }
    }
    return msg;
  };

  const out = messages.slice();
  const systemIdx = out.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) out[systemIdx] = markLastTextPart(out[systemIdx]!);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === "user") {
      out[i] = markLastTextPart(out[i]!);
      break;
    }
  }
  return out;
}

export function toOpenAIMessages(messages: AgentMessage[], systemPrompt: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: systemPrompt }];
  // OpenAI/OpenRouter reject a tool message ("function call output") whose tool_call_id has
  // no matching assistant tool_call — a fatal 400 that ends the whole run (observed in the
  // execution log as a protocol_violation). Track which call ids the assistant has actually
  // emitted, and which we've already answered, so a stray or duplicated tool_result can never
  // reach the provider. sanitizeToolMessages runs before this; these guards are defense-in-depth.
  const emittedCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else {
        // May be a mix of tool_result + text + image blocks
        const toolResults = (msg.content as ContentBlock[]).filter((b): b is ToolResultBlock => b.type === "tool_result");
        const textBlocks  = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        const imageBlocks = (msg.content as ContentBlock[]).filter((b): b is ImageBlock => b.type === "image");
        for (const tr of toolResults) {
          if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
          answeredCallIds.add(tr.tool_use_id);
          result.push({ role: "tool", content: tr.content, tool_call_id: tr.tool_use_id });
        }
        // Images can never live inside a tool-role message (OpenAI requires tool content
        // to be a plain string) — send them as a sibling user-role message instead.
        if (imageBlocks.length) {
          const parts: OAIContentPart[] = imageBlocks.map((ib) => ({
            type: "image_url",
            image_url: { url: `data:${ib.source.media_type};base64,${ib.source.data}` },
          }));
          if (textBlocks.length) parts.push({ type: "text", text: textBlocks.map((t) => t.text).join("\n") });
          result.push({ role: "user", content: parts });
        } else if (textBlocks.length) {
          result.push({ role: "user", content: textBlocks.map((t) => t.text).join("\n") });
        }
      }
    } else {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else {
        const textBlocks = (msg.content as ContentBlock[]).filter((b): b is TextBlock => b.type === "text");
        const toolBlocks = (msg.content as ContentBlock[]).filter((b): b is ToolUseBlock => b.type === "tool_use");
        const content = textBlocks.map((t) => t.text).join("\n") || null;
        const tool_calls = toolBlocks.length > 0 ? toolBlocks.map((tb) => {
          emittedCallIds.add(tb.id);
          return {
            id:       tb.id,
            type:     "function" as const,
            function: { name: tb.name, arguments: JSON.stringify(tb.input) },
          };
        }) : undefined;
        // A bare {role:assistant, content:null} with no tool calls contributes nothing and can
        // desync tool pairing on some providers — skip it entirely.
        if (content === null && !tool_calls) continue;
        result.push({ role: "assistant", content, tool_calls });
      }
    }
  }

  return result;
}

// ── OpenAI Responses API conversion ─────────────────────────────────────────
//
// The Responses API's `input`/`output` are flat arrays of heterogeneous items (message |
// function_call | function_call_output | reasoning | ...) rather than Chat Completions' nested
// per-turn message objects — a tool call and its result are each their own top-level item,
// matched by `call_id` (this harness's `tool_use.id` / `tool_result.tool_use_id`).

/** Flat function-tool shape: `{type, name, description, parameters}`, not Chat Completions'
 *  `{type:"function", function:{name,...}}` nesting. No `strict` — OpenAI's strict-mode schema
 *  rules differ from Anthropic's (see toStrictToolSchema) and are out of scope here. */
export function toResponsesTools(
  tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return tools.map(({ name, description, input_schema }) => ({
    type: "function",
    name,
    description,
    parameters: input_schema,
  }));
}

/**
 * Convert session history into the Responses API's flat `input` item array.
 *
 * Reasoning items only round-trip when they carry a `reasoningItemId` — the discriminator for
 * "this came from the Responses API itself" versus an Anthropic-origin thinking block (which
 * carries `signature` instead and means nothing to this API). Compaction blocks are similarly
 * Anthropic-only and are silently skipped. This mirrors toOpenAIMessages' existing "OpenAI-
 * compatible paths do not round-trip foreign thinking" behavior, narrowed to recognize this
 * path's own reasoning items as the one exception worth replaying.
 */
export function toResponsesInputItems(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  // Same defense-in-depth as toOpenAIMessages: never emit a function_call_output whose call_id
  // wasn't actually emitted by a function_call item in this same converted array, and never
  // answer the same call_id twice.
  const emittedCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content) items.push({ type: "message", role: "user", content: msg.content });
        continue;
      }
      const blocks = msg.content as ContentBlock[];
      const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
      const textBlocks  = blocks.filter((b): b is TextBlock => b.type === "text");
      const imageBlocks = blocks.filter((b): b is ImageBlock => b.type === "image");
      for (const tr of toolResults) {
        if (!emittedCallIds.has(tr.tool_use_id) || answeredCallIds.has(tr.tool_use_id)) continue;
        answeredCallIds.add(tr.tool_use_id);
        items.push({ type: "function_call_output", call_id: tr.tool_use_id, output: tr.content });
      }
      if (imageBlocks.length) {
        const content: Array<Record<string, unknown>> = imageBlocks.map((ib) => ({
          type: "input_image",
          image_url: `data:${ib.source.media_type};base64,${ib.source.data}`,
          detail: "auto",
        }));
        if (textBlocks.length) content.push({ type: "input_text", text: textBlocks.map((t) => t.text).join("\n") });
        items.push({ type: "message", role: "user", content });
      } else if (textBlocks.length) {
        items.push({ type: "message", role: "user", content: textBlocks.map((t) => t.text).join("\n") });
      }
    } else {
      if (typeof msg.content === "string") {
        if (msg.content) items.push({ type: "message", role: "assistant", content: msg.content });
        continue;
      }
      const blocks = msg.content as ContentBlock[];
      // Reasoning leads the turn it belongs to, matching how _appendAssistantTurn already
      // orders history (reasoning, then text, then tool calls) — so iterating in the blocks'
      // stored order already replays reasoning ahead of the tool calls it informed.
      for (const block of blocks) {
        if (block.type !== "thinking" || !block.reasoningItemId) continue;
        const summary = block.thinking ? [{ type: "summary_text", text: block.thinking }] : [];
        items.push({
          type: "reasoning",
          id: block.reasoningItemId,
          summary,
          ...(block.encryptedContent ? { encrypted_content: block.encryptedContent } : {}),
        });
      }
      const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");
      if (textBlocks.length) items.push({ type: "message", role: "assistant", content: textBlocks.map((t) => t.text).join("\n") });
      const toolBlocks = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      for (const tb of toolBlocks) {
        emittedCallIds.add(tb.id);
        items.push({ type: "function_call", call_id: tb.id, name: tb.name, arguments: JSON.stringify(tb.input) });
      }
    }
  }

  return items;
}

/** Responses-API twin of appendOpenAIWorkspaceContextTail: append the live workspace block as
 *  a trailing user input item, after history conversion. */
export function appendResponsesWorkspaceContextTail(items: Array<Record<string, unknown>>, workspaceContext: string): Array<Record<string, unknown>> {
  if (!workspaceContext.trim() || items.length === 0) return items;
  return [...items, { type: "message", role: "user", content: workspaceContext }];
}

/**
 * Map a terminal Responses API `response` object to a harness stop reason. Priority mirrors
 * the Chat Completions/Anthropic paths: any function_call output means "tool_use" regardless
 * of what else is present, a refusal (either a `content_filter` incomplete reason or a
 * `refusal`-typed message content part) is terminal-but-declined, `max_output_tokens` maps to
 * the truncation-recovery path, and anything else unrecognized fails open into
 * protocol_violation rather than silently reporting success.
 */
export function normalizeResponsesStopReason(resp: Record<string, unknown>): AgentStopReason {
  const status = String(resp["status"] ?? "");
  const output = Array.isArray(resp["output"]) ? (resp["output"] as Array<Record<string, unknown>>) : [];
  const hasFunctionCall = output.some((item) => item["type"] === "function_call");
  const hasRefusal = output.some((item) =>
    item["type"] === "message"
    && Array.isArray(item["content"])
    && (item["content"] as Array<Record<string, unknown>>).some((part) => part["type"] === "refusal"));

  if (hasFunctionCall) return "tool_use";
  if (hasRefusal) return "refusal";
  if (status === "incomplete") {
    const reason = (resp["incomplete_details"] as Record<string, unknown> | undefined)?.["reason"];
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "refusal";
    return "protocol_violation";
  }
  if (status === "completed") return "end_turn";
  if (status === "cancelled") return "cancelled";
  return "protocol_violation";
}

