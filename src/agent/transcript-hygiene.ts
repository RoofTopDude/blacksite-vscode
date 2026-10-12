/*
  The Blacksite side of transcript hygiene: the envelope the harness wraps attached context in,
  and the passes that shrink a transcript before it is persisted (image stubs, browser-payload
  redaction, oversized preview payloads). The provider-neutral passes live in
  @blacksite-agent/llm and are re-exported here for existing imports.
*/
import { sanitizeOversizedToolInputs, type AgentMessage, type ContentBlock } from "@blacksite-agent/llm";
import { browserTool, redactBrowserPayload } from "../browser/privacy.js";
import type { PendingGateState } from "../session-state.js";


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

const MAX_PERSISTED_PREVIEW_CODE_CHARS = 512 * 1024;

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

/**
 * Persisted copies of the transcript replace inline image data with a small text stub.
 * A single screenshot-heavy turn can otherwise re-serialize tens of MB of base64 into the
 * workspaceState memento on EVERY checkpoint save (the hot path runs once per iteration).
 * The pixels are dead weight once persisted anyway: compression and the memory index both
 * drop image blocks, so a restored session would never show them to the model again.
 */
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
