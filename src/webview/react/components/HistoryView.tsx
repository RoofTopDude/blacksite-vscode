import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { formatRelativeTime, shortText } from "@/lib/format";
import { actions, useStore } from "@/lib/store";
import { historyTitle } from "@/lib/history";
import { PanelHeader } from "./PanelHeader";
import { cn } from "@/lib/utils";

/** Search only appears once the list is long enough for scanning to fail. */
const SEARCH_THRESHOLD = 7;

export function HistoryView() {
  const store = useStore();
  const [query, setQuery] = useState("");
  // Two-step delete: the first click arms this row's confirm state, the second
  // click (on the now-explicit "Delete?" button) actually deletes. Any other
  // interaction disarms, so a stray hover-click can never destroy a session.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmingId) return;
    const timer = setTimeout(() => setConfirmingId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmingId]);

  const q = query.trim().toLowerCase();
  const sessions = q
    ? store.history.filter((s) =>
      historyTitle(s).toLowerCase().includes(q) || (s.model ?? "").toLowerCase().includes(q))
    : store.history;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-2.5 py-2">
        <PanelHeader title="Conversation History" sub="Click to resume a past session" />
        {store.history.length >= SEARCH_THRESHOLD && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or model…"
            aria-label="Search conversation history"
            className="mt-2 w-full rounded-md border border-border bg-white/[0.03] px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/40"
          />
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="px-5 py-8 text-center text-base leading-relaxed text-muted-foreground">
            {q ? "No conversations match your search." : "No previous conversations."}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => {
              const confirming = confirmingId === s.sessionId;
              return (
                <div key={s.sessionId} className="chat-interactive group relative flex items-center rounded-md border border-transparent hover:border-border hover:bg-white/5">
                  <button
                    type="button"
                    onClick={() => { setConfirmingId(null); actions.loadSession(s.sessionId); }}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                  >
                    <div className="truncate text-base text-foreground">{shortText(historyTitle(s), 80)}</div>
                    <div className="mt-0.5 text-sm text-muted-foreground">
                      {[s.model, formatRelativeTime(s.updatedAt || s.createdAt)].filter(Boolean).join(" · ")}
                    </div>
                  </button>
                  {confirming ? (
                    <button
                      type="button"
                      onClick={() => { setConfirmingId(null); actions.deleteSession(s.sessionId); }}
                      onBlur={() => setConfirmingId(null)}
                      className="mr-2 shrink-0 rounded-md border border-[color:var(--s-err)]/45 bg-[color:var(--s-err)]/15 px-2 py-1 text-xs font-semibold text-[color:var(--s-err)]"
                    >
                      Delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      title={`Delete "${shortText(historyTitle(s), 40)}"`}
                      onClick={() => setConfirmingId(s.sessionId)}
                      className={cn(
                        "mr-1 shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-[color:var(--s-err)] focus-visible:opacity-100 group-hover:opacity-100",
                        "opacity-0",
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
