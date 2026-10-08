/*
  Transcript hygiene: the provider-neutral passes that make a message history safe to put
  on the wire — orphaned tool_result repair, adjacent user-turn merging, oversized tool-input
  and image stripping for persistence, empty-content filling, and unsigned-thinking removal.

  Extracted from agent-session.ts, which re-exports every symbol here so existing call sites
  and tests keep importing them from there. Every function is pure and must stay that way:
  each takes a message array and returns a new one, never mutating its input. Several run on
  the hot path once per provider turn, so they return the original array unchanged when there
  is nothing to fix rather than always allocating a copy.
*/
import { browserTool, redactBrowserPayload } from "../browser/privacy.js";
import type { PendingGateState } from "../session-state.js";
import type {
  AgentMessage,
  ContentBlock,
  ThinkingBlock,
  ToolUseBlock,
} from "../agent-loop-contract.js";


/**
 * Envelope for everything the harness attaches to a request (request profile, loaded skills,
 * workspace state, closing checklist). That text rides in the user's own turn, or right behind it,
 * so without a label the model cannot tell where the user's words stop: it read the block as a
 * message that had been cut off, or as the user pasting their context again on every tool round
 * (the block moves to the newest turn each request, and is never kept in history). The static
 * system prompt names this tag, so keep the two in step.
 */
export const ATTACHED_CONTEXT_TAG = "blacksite-context";

export function wrapAttachedContext(body: string): string {
  if (!body.trim()) return "";
  return [
    `<${ATTACHED_CONTEXT_TAG}>`,
    "Attached automatically by Blacksite on every request. The user did not write this and it is not part of their message: their message is everything before this block, and it is complete. Each request carries a fresh copy, so a copy you remember from an earlier turn has been replaced, not sent again. It holds project state and repository guidance, not a request from the user.",
    "",
    body,
    `</${ATTACHED_CONTEXT_TAG}>`,
  ].join("\n");
}

/**
 * Appends the live workspace-context block as a trailing text block on the last (user)
 * message, without persisting it into session history. Apply this AFTER
 * withRollingCacheBreakpoint so the block lands *past* the cache breakpoint: the static
 * system + tools + conversation prefix stays a cache hit, and only this small block —
 * which changes every turn — is re-read uncached. The input array is never mutated.
 */
export function appendWorkspaceContextTail(messages: AgentMessage[], workspaceContext: string): AgentMessage[] {
  if (!workspaceContext.trim() || messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  const ctxBlock: ContentBlock = { type: "text", text: workspaceContext };
  if (last.role === "user") {
    const blocks: ContentBlock[] = typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : (last.content as ContentBlock[]).slice();
    blocks.push(ctxBlock);
    out[out.length - 1] = { ...last, content: blocks };
  } else {
    // Defensive: the pre-call message is always a user turn in the send() loop, but if it
    // ever isn't, keep roles alternating rather than corrupting the assistant turn.
    out.push({ role: "user", content: [ctxBlock] });
  }
  return out;
}

/** True when a message is a user turn whose content carries a tool_result block. */
function messageCarriesToolResult(msg: AgentMessage | undefined): boolean {
  if (!msg || msg.role !== "user" || typeof msg.content === "string") return false;
  return (msg.content as ContentBlock[]).some((b) => b.type === "tool_result");
}

/**
 * Choose the index at which the "recent" (uncompressed) window begins so the compression
 * boundary never falls between an assistant tool_use and the user tool_result that answers it.
 * If `recent` began on a tool_result-bearing user message, that result's tool_use would be
 * swept into the compressed summary, orphaning it — which serialises to a fatal provider 400.
 * Walk the boundary earlier (keep slightly more recent history) until it starts cleanly.
 */
export function safeRecentStart(messages: AgentMessage[], keepRecent: number): number {
  let start = Math.max(0, messages.length - keepRecent);
  while (start > 0 && messageCarriesToolResult(messages[start])) start--;
  return start;
}

export function sanitizeToolMessages(messages: AgentMessage[]): AgentMessage[] {
  // tool_use ids that already have a result anywhere in the transcript.
  const satisfied = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_result") satisfied.add(block.tool_use_id);
      }
    }
  }

  const seenToolUse = new Set<string>();
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push(msg);
      continue;
    }
    const blocks = msg.content as ContentBlock[];

    if (msg.role === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") seenToolUse.add(block.id);
      }
      out.push(msg);

      // Answer any tool_use in this message that never got a result, so the assistant's
      // tool_calls are always satisfied on the next request.
      const unanswered = blocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use" && !satisfied.has(b.id),
      );
      if (unanswered.length > 0) {
        out.push({
          role: "user",
          content: unanswered.map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: JSON.stringify({ ok: false, error: "Tool result unavailable (run interrupted before completion)." }),
          })),
        });
        for (const b of unanswered) satisfied.add(b.id);
      }
      continue;
    }

    // user message: drop tool_result blocks that reference an unknown tool_use.
    const kept = blocks.filter(
      (b) => b.type !== "tool_result" || seenToolUse.has(b.tool_use_id),
    );
    if (kept.length === 0 && blocks.length > 0) continue; // was only orphan results
    out.push(kept.length === blocks.length ? msg : { ...msg, content: kept });
  }

  return out;
}

/**
 * Bedrock and Anthropic require the conversation to begin with a user message.
 * Compression can leave the recent window opening on an assistant tool_use turn,
 * which the provider rejects with a fatal 400 ("Expected toolResult blocks at
 * messages.0.content …" in the execution logs) that then recurs on every retry and
 * bricks the session. Prepend a minimal user turn so any boundary is valid. Applied
 * at the provider-send boundary, on top of {@link sanitizeToolMessages}.
 */
/**
 * Persisted copies of the transcript replace inline image data with a small text stub.
 * A single screenshot-heavy turn can otherwise re-serialize tens of MB of base64 into the
 * workspaceState memento on EVERY checkpoint save (the hot path runs once per iteration).
 * The pixels are dead weight once persisted anyway: compression and the memory index both
 * drop image blocks, so a restored session would never show them to the model again.
 */
const MAX_REPLAYED_TOOL_INPUT_CHARS = 256 * 1024;
const MAX_PERSISTED_PREVIEW_CODE_CHARS = 512 * 1024;

/** Estimate JSON size with an early exit, avoiding a second 39 MB allocation while recovering a
 *  session already poisoned by an oversized preview bundle. Tool inputs are JSON-shaped. */
function exceedsJsonBudget(value: unknown, budget: number): boolean {
  let remaining = budget;
  const visit = (item: unknown): boolean => {
    if (remaining < 0) return true;
    if (typeof item === "string") { remaining -= item.length + 2; return remaining < 0; }
    if (item == null) { remaining -= 4; return remaining < 0; }
    if (typeof item === "number" || typeof item === "bigint") { remaining -= 24; return remaining < 0; }
    if (typeof item === "boolean") { remaining -= 5; return remaining < 0; }
    if (Array.isArray(item)) {
      remaining -= 2;
      for (const entry of item) if (visit(entry)) return true;
      return false;
    }
    if (typeof item === "object") {
      remaining -= 2;
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        remaining -= key.length + 3;
        if (visit(entry)) return true;
      }
    }
    return remaining < 0;
  };
  return visit(value);
}

/**
 * Replace historical function-call inputs that cannot safely be replayed. OpenAI rejects an
 * individual Responses `arguments` string above 1 MiB; using a much lower history ceiling also
 * prevents giant calls from dominating context and being multiplied through checkpoints/UI state.
 * The executed tool result remains intact, so only reproducible invocation detail is omitted.
 */
export function sanitizeOversizedToolInputs(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
    let changed = false;
    const content = msg.content.map((block): ContentBlock => {
      if (block.type !== "tool_use" || !exceedsJsonBudget(block.input, MAX_REPLAYED_TOOL_INPUT_CHARS)) return block;
      changed = true;
      return {
        ...block,
        input: {
          _history_input_omitted: `Historical tool arguments exceeded ${MAX_REPLAYED_TOOL_INPUT_CHARS} characters and were omitted after execution.`,
          _original_keys: Object.keys(block.input).slice(0, 32),
        },
      };
    });
    return changed ? { ...msg, content } : msg;
  });
}

/** Runtime state and checkpoints do not need to duplicate a large compiled preview: the live
 * question event owns the full visual payload. Labels/descriptions remain recoverable after reload. */
export function sanitizePendingGateForPersistence(gate: PendingGateState | undefined): PendingGateState | undefined {
  if (!gate || gate.kind !== "question") return gate;
  let changed = false;
  const questions = gate.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => {
      const code = option.preview?.code ?? "";
      const mountCss = option.preview?.mountCss ?? "";
      if (code.length + mountCss.length <= MAX_PERSISTED_PREVIEW_CODE_CHARS) return option;
      changed = true;
      return { ...option, preview: undefined };
    }),
  }));
  return changed ? { ...gate, questions } : gate;
}

/** The text block {@link stripImagesForPersistence} leaves where an image block was. */
export const PERSISTED_IMAGE_STUB = "[image omitted from persisted transcript]";

export function stripImagesForPersistence(messages: AgentMessage[]): AgentMessage[] {
  const browserIds = new Set<string>();
  for (const message of messages) {
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.type === "tool_use" && browserTool(block.name)) browserIds.add(block.id);
    }
  }
  return sanitizeOversizedToolInputs(messages).map((msg) => {
    if (typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((b): ContentBlock => {
        if (b.type === "image") return { type: "text", text: PERSISTED_IMAGE_STUB };
        if (b.type === "tool_use" && browserTool(b.name)) return { ...b, input: redactBrowserPayload(b.input) as Record<string, unknown> };
        if (b.type === "tool_result" && browserIds.has(b.tool_use_id)) return { ...b, content: "[Browser/research result omitted from persisted transcript. Inspect current state and request fresh approval before entry.]" };
        return b;
      }),
    };
  });
}

function isImageStub(block: ContentBlock): boolean {
  return block.type === "text" && block.text === PERSISTED_IMAGE_STUB;
}

/**
 * Put back the images {@link stripImagesForPersistence} removed, taking them from the live
 * transcript the persisted copy was made from.
 *
 * Most settings changes rebuild the session, and the rebuilt one restores from the session store.
 * The store keeps no pixels, so every screenshot and attachment already in the conversation turned
 * into a stub the moment the user changed, say, the reasoning effort — and the model could no
 * longer see what it had been shown a minute earlier.
 *
 * Deliberately narrow: a message is touched only when its persisted form is exactly what stripping
 * `live` produces at the same position, and within it only the stubs change. Everything else keeps
 * its persisted form, including browser results the store redacts. Stripping maps blocks one to
 * one, which is what makes the positional swap safe. Returns `stored` itself when nothing changes.
 */
export function restorePersistedImages(stored: AgentMessage[], live: AgentMessage[]): AgentMessage[] {
  if (stored.length === 0 || live.length === 0) return stored;
  const strippedLive = stripImagesForPersistence(live);
  let changed = false;
  const out = stored.map((msg, index) => {
    const liveMsg = live[index];
    if (typeof msg.content === "string" || !liveMsg || typeof liveMsg.content === "string") return msg;
    if (!msg.content.some(isImageStub)) return msg;
    if (JSON.stringify(msg) !== JSON.stringify(strippedLive[index])) return msg;
    const liveBlocks = liveMsg.content;
    changed = true;
    return {
      ...msg,
      content: msg.content.map((block, blockIndex) => {
        const liveBlock = liveBlocks[blockIndex];
        return isImageStub(block) && liveBlock?.type === "image" ? liveBlock : block;
      }),
    };
  });
  return changed ? out : stored;
}

export function ensureLeadingUserMessage(messages: AgentMessage[]): AgentMessage[] {
  if (messages[0]?.role === "assistant") {
    return [{ role: "user", content: "[Conversation continues from summarized history above.]" }, ...messages];
  }
  return messages;
}

/** Stand-in for a message that carries no wire-valid content. Anthropic and Bedrock both reject
 *  an empty content array *and* a blank text block, so the placeholder must be non-empty. */
export const EMPTY_TURN_PLACEHOLDER = "(no response)";

/** True for a block that survives serialization to every provider — i.e. anything except a
 *  text block that is empty/whitespace and an unsigned thinking block (which the Anthropic and
 *  Bedrock adapters both drop, since replaying one earns a 400). */
function isWireMeaningfulBlock(block: ContentBlock): boolean {
  if (block.type === "text") return block.text.trim().length > 0;
  // A thinking block only counts as meaningful once it carries something that must be
  // replayed verbatim — Anthropic's signature or the Responses API's encrypted reasoning
  // payload. A bare summary with neither is display-only and safe to drop.
  if (block.type === "thinking") {
    const t = block as ThinkingBlock;
    return !!t.signature || !!t.encryptedContent;
  }
  return true;
}

/** The assistant-turn twin of {@link fillEmptyMessageContent}, applied at record time so the
 *  transcript never contains a contentless turn in the first place. */
export function nonEmptyAssistantContent(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.some(isWireMeaningfulBlock)
    ? blocks
    : [{ type: "text", text: EMPTY_TURN_PLACEHOLDER }];
}

/** Substitute a placeholder for any message whose content would serialize to nothing.
 *
 *  A turn where the model returned no text, no thinking and no tool calls is recorded with an
 *  empty content array — and the empty-response recovery then *continues the run*, so that
 *  message is replayed on every subsequent request for the rest of the session. Anthropic
 *  rejects `content: []`; Bedrock's own guard turned it into a blank text block, which Converse
 *  rejects too. Either way one empty response permanently bricked the session, and neither error
 *  is retryable. (toOpenAIMessages already sidesteps this by skipping the message — it can,
 *  because OpenAI does not require strict role alternation. Bedrock does, so here we substitute
 *  rather than drop.) `_appendAssistantTurn` now prevents this at the source; this pass repairs
 *  transcripts that were persisted before that fix, or arrive from a checkpoint. */
export function fillEmptyMessageContent(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0 ? msg : { ...msg, content: EMPTY_TURN_PLACEHOLDER };
    }
    const blocks = msg.content as ContentBlock[];
    if (blocks.some(isWireMeaningfulBlock)) return msg;
    return { ...msg, content: [{ type: "text", text: EMPTY_TURN_PLACEHOLDER }] as ContentBlock[] };
  });
}

function userContentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content !== "string") return content;
  return content.trim() ? [{ type: "text", text: content }] : [];
}

/**
 * Fold every run of consecutive user messages into one user turn.
 *
 * The loop legitimately produces such runs: a harness continuation appended after a tool-result
 * turn (the duplicate-round progress check), a retry prompt appended after reverting a truncated
 * assistant turn, a message sent after a run that stopped with results as its last turn (iteration
 * limit, cancel, provider error, checkpoint resume), and the tool_result turn
 * {@link sanitizeToolMessages} synthesizes for a call that never completed. Anthropic merges
 * consecutive same-role turns server-side, so those requests happened to work there — but Bedrock
 * Converse enforces strict alternation and rejects them outright, and because the history itself
 * keeps the shape, every later request in the session failed the same way.
 *
 * Merging here, at the one normalization every provider path shares, covers all of those sources
 * at once. tool_result blocks lead the merged turn, since Anthropic requires them first in a user
 * turn. Assistant runs are never merged: their thinking signatures cover the turn they came from.
 */
export function mergeAdjacentUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let merged = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    const previous = out[out.length - 1];
    if (previous?.role !== "user" || msg.role !== "user") {
      out.push(msg);
      continue;
    }
    const blocks = [...userContentBlocks(previous.content), ...userContentBlocks(msg.content)];
    out[out.length - 1] = {
      role: "user",
      content: [
        ...blocks.filter((block) => block.type === "tool_result"),
        ...blocks.filter((block) => block.type !== "tool_result"),
      ],
    };
    merged = true;
  }
  return merged ? out : messages;
}

/** Sanitize tool pairing, repair contentless turns, and guarantee a user-first, strictly alternating
 *  array — the full pre-send normalization. Shared by all four provider paths so a fix here lands
 *  everywhere. Merging runs after tool pairing because the repair can itself create a user run. */
export function normalizeForProvider(messages: AgentMessage[]): AgentMessage[] {
  return ensureLeadingUserMessage(fillEmptyMessageContent(
    mergeAdjacentUserMessages(sanitizeToolMessages(sanitizeOversizedToolInputs(messages))),
  ));
}

/**
 * Drop thinking blocks that carry no signature before sending to Anthropic (direct or
 * Mantle). A signed thinking block is replayed verbatim — required for interleaved
 * thinking across tool-use turns — while an unsigned one (e.g. a session persisted before
 * signatures were captured, or any block that lost its signature) would be rejected by
 * Anthropic's signature validation with a 400. Blocks other than thinking are untouched;
 * if stripping would leave an assistant turn with no content at all, a minimal text block
 * is substituted so the turn stays wire-valid.
 */
export function stripUnsignedThinking(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    const blocks = msg.content as ContentBlock[];
    const hasUnsigned = blocks.some((b) => b.type === "thinking" && !(b as ThinkingBlock).signature);
    if (!hasUnsigned) return msg;
    const kept = blocks.filter((b) => b.type !== "thinking" || !!(b as ThinkingBlock).signature);
    if (kept.length === 0) return { ...msg, content: [{ type: "text", text: "(reasoning omitted)" }] as ContentBlock[] };
    return { ...msg, content: kept };
  });
}

/**
 * Resolve provider-executed blocks for an Anthropic-format request (direct or Mantle).
 *
 * With `expand`, Anthropic's own search blocks are unwrapped back into the exact content blocks
 * the API sent, in place, which is the only form it accepts them in. Without it — a request that
 * does not carry the web search tool, or one bound for Mantle, which has none — every
 * provider-native block is dropped, because a `server_tool_use` the API cannot account for is a
 * 400. Codex blocks (a conversation that switched providers) are always dropped. A turn left
 * with nothing gets the empty-turn placeholder so alternation survives.
 */
export function resolveAnthropicNativeBlocks(messages: AgentMessage[], expand: boolean): AgentMessage[] {
  if (!messages.some((m) => Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === "provider_native"))) return messages;
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg;
    const blocks = msg.content as ContentBlock[];
    if (!blocks.some((b) => b.type === "provider_native")) return msg;
    const out: ContentBlock[] = [];
    for (const block of blocks) {
      if (block.type !== "provider_native") out.push(block);
      else if (expand && block.provider === "anthropic") out.push(structuredClone(block.block) as unknown as ContentBlock);
    }
    return { ...msg, content: out.length ? out : [{ type: "text", text: EMPTY_TURN_PLACEHOLDER }] };
  });
}
