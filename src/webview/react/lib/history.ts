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

export type HistoryBucket = "Today" | "Yesterday" | "Previous 7 days" | "Earlier";

const DAY_MS = 86_400_000;

/** Calendar-day bucket for a session's last activity, in the viewer's local time. */
export function historyBucket(ts: number | undefined, now = Date.now()): HistoryBucket {
  if (!ts) return "Earlier";
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  if (ts >= today) return "Today";
  if (ts >= today - DAY_MS) return "Yesterday";
  if (ts >= today - 6 * DAY_MS) return "Previous 7 days";
  return "Earlier";
}

/** Sessions grouped by bucket, keeping the feed's own order within and across groups. */
export function groupHistory(sessions: HistorySession[], now = Date.now()): Array<{ bucket: HistoryBucket; sessions: HistorySession[] }> {
  const groups = new Map<HistoryBucket, HistorySession[]>();
  for (const session of sessions) {
    const bucket = historyBucket(session.updatedAt || session.createdAt, now);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(session);
  }
  return [...groups].map(([bucket, items]) => ({ bucket, sessions: items }));
}
