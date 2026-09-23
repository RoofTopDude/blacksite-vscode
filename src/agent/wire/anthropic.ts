/*
  Anthropic-direct wire format: system-block construction, rolling cache breakpoints, and
  strict tool definitions.

  Extracted from agent-session.ts, which re-exports every symbol here so existing call sites
  and specs keep importing them from there. Pure functions.

  `cacheControlFor` lives here rather than in a neutral module because the shape it produces
  is Anthropic's; OpenRouter imports it for the Anthropic-family models it proxies, which
  expect that exact `cache_control` object on the wire.
*/
import { toStrictToolSchema } from "./strict-schema.js";
import type { AgentMessage, ContentBlock } from "../../agent-loop-contract.js";
import type { CacheTtl } from "../../agent-session.js";

export type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

/**
 * Build a cache_control object honoring the session's chosen TTL. The default (5-minute) case
 * emits the bare `{type:"ephemeral"}` shape — byte-identical to the behavior before the TTL
 * option existed, so every existing cache-marking call site is a no-op change unless the
 * session opted into "1h".
 */
export function cacheControlFor(ttl: CacheTtl | undefined): AnthropicCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * Build the Anthropic `system` field as cache-eligible content blocks. The system prompt is
 * captured once per session (the workspace snapshot is frozen at session creation), so it is
 * byte-identical across every iteration of a run — marking it with a cache breakpoint lets the
 * whole prompt be re-read from cache instead of re-billed each turn. A growing compressed-history
 * summary rides in a separate, *uncached* block so that when it changes it invalidates only
 * itself, never the cached prompt — the core of keeping a clean, stable prompt head.
 */
export function buildAnthropicSystemBlocks(
  systemPrompt: string,
  compressedSummary: string,
  cacheTtl?: CacheTtl,
): Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> {
  const blocks: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }> = [
    { type: "text", text: systemPrompt, cache_control: cacheControlFor(cacheTtl) },
  ];
  if (compressedSummary) {
    blocks.push({
      type: "text",
      text: `---\n[COMPRESSED CONVERSATION HISTORY — earlier messages summarised for context efficiency]\n${compressedSummary}\n---`,
    });
  }
  return blocks;
}

/**
 * Rolling cache breakpoints over the message history, so the conversation prefix is re-read from
 * cache on the next request. During a turn the agent makes many provider calls seconds apart (one
 * per tool round), each appending results to the tail — well inside the cache TTL — so this is
 * where a long-horizon (e.g. 1000-iteration) run recovers most of its input-token cost.
 *
 * Two anchors, not one:
 *  - the final message, which is where the next request will find this one's prefix; and
 *  - the nearest earlier user turn, which is exactly where the *previous* request put its final
 *    anchor (every request here ends on a user turn).
 *
 * The second exists because a breakpoint only looks back about 20 content blocks for an earlier
 * cache entry. One iteration with ~10 parallel tool calls — thinking, text, ten tool_use blocks,
 * ten tool_result blocks — puts the previous entry out of reach, and the whole conversation was
 * then rewritten at the cache-write premium (2x on the 1h TTL) instead of read back at 0.1x.
 * Naming the previous position makes that read exact however wide the round was.
 *
 * Budget: with the system block and the last tool definition this is four breakpoints, Anthropic's
 * maximum — nothing else may add one. Only the marked messages are cloned; nothing is mutated.
 */
export function withRollingCacheBreakpoint(messages: AgentMessage[], cacheTtl?: CacheTtl): AgentMessage[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = markLastBlock(messages[lastIndex]!, cacheTtl);
  if (!last) return messages;
  const out = messages.slice();
  out[lastIndex] = last;
  for (let i = lastIndex - 1; i >= 0; i--) {
    if (out[i]!.role !== "user") continue;
    const previous = markLastBlock(out[i]!, cacheTtl);
    if (previous) out[i] = previous;
    break;
  }
  return out;
}

/** The message with `cache_control` on its final block, or null when there is nothing that can
 *  carry one (no blocks, or an empty text block, which the API rejects as a cache anchor). */
function markLastBlock(message: AgentMessage, cacheTtl?: CacheTtl): AgentMessage | null {
  const blocks: ContentBlock[] = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : (message.content as ContentBlock[]).slice();
  const final = blocks[blocks.length - 1];
  if (!final || (final.type === "text" && !final.text)) return null;
  blocks[blocks.length - 1] = Object.assign({}, final, { cache_control: cacheControlFor(cacheTtl) }) as ContentBlock;
  return { ...message, content: blocks };
}


/**
 * Map the session tool list to Anthropic wire definitions, marking every tool whose schema
 * qualifies with `strict: true`. Non-qualifying tools are sent byte-identical to before —
 * mixed strict/non-strict lists are valid.
 */
export function withAnthropicStrictTools(
  tools: ReadonlyArray<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  return tools.map(({ name, description, input_schema }) => {
    const strictSchema = toStrictToolSchema(input_schema);
    return strictSchema
      ? { name, description, input_schema: strictSchema, strict: true }
      : { name, description, input_schema };
  });
}
