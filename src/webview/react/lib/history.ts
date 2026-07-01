/* Pure helpers for the conversation-history list. Kept dependency-free so the
   title-derivation logic is unit-testable without the webview runtime. */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ChatMessage, HistorySession } from "./protocol";

/** First user-authored text in a message list, or "" when none is present. */
export function firstUserText(messages?: ChatMessage[]): string {
  for (const m of messages || []) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.find((b: any) => b?.type === "text");
      if (text?.text) return String(text.text);
    }
  }
  return "";
}

/**
 * Title for a history row. The history feed sends `firstMessage` summaries (the full
 * `messages` array is intentionally omitted from list payloads), so prefer that;
 * fall back to deriving from any inline messages, then to a generic label.
 */
export function historyTitle(session: HistorySession): string {
  return session.firstMessage?.trim() || firstUserText(session.messages) || "Conversation";
}
