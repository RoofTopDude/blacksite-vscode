import { Trash2 } from "lucide-react";
import { formatClock, shortText } from "@/lib/format";
import { actions, useStore } from "@/lib/store";
import { historyTitle } from "@/lib/history";

export function HistoryView() {
  const store = useStore();
  const sessions = store.history;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-3.5 py-2.5">
        <div className="text-[13px] font-semibold text-foreground">Conversation History</div>
        <div className="text-[11px] text-muted-foreground">Click to resume a past session</div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">No previous conversations.</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => (
              <div
                key={s.sessionId}
                onClick={() => actions.loadSession(s.sessionId)}
                className="group flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-3 py-2 hover:border-border hover:bg-white/5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-foreground">{shortText(historyTitle(s), 80)}</div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {[s.model, formatClock(s.updatedAt || s.createdAt)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <button
                  type="button"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); actions.deleteSession(s.sessionId); }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-[color:var(--s-err)] group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
