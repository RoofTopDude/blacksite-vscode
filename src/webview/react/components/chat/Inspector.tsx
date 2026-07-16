import { type ReactNode } from "react";
import { formatDuration, joinParts, stopReasonLabel, toolStateText } from "@/lib/format";
import { latestAssistantTurn, toolStateClass, type ToolCall, type Turn } from "@/lib/chat-model";
import { useStore } from "@/lib/store";
import { StatusPill, toolStateTone } from "./signal";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="chat-surface px-2 py-1 text-center">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="eyebrow">{title}</div>
      {children}
    </section>
  );
}

export function Inspector() {
  const store = useStore();
  const chat = store.chat;
  const live = (chat.currentLiveTurnId ? chat.byId.get(chat.currentLiveTurnId) : null) || latestAssistantTurn(chat);

  const recent: Array<{ turn: Turn; call: ToolCall }> = [];
  for (let i = chat.turns.length - 1; i >= 0 && recent.length < 4; i--) {
    const turn = chat.turns[i]!;
    if (turn.role !== "assistant") continue;
    for (let c = turn.toolCallList.length - 1; c >= 0 && recent.length < 4; c--) {
      recent.push({ turn, call: turn.toolCallList[c]! });
    }
  }

  return (
    <div className="reveal-in flex flex-col gap-3 border-b border-border bg-black/15 px-2.5 py-2">
      <Section title="Live Turn">
        {live ? (
          <>
            <div className="grid grid-cols-5 gap-1">
              <Stat label="Status" value={live.status === "streaming" ? "Live" : live.status === "error" ? "Error" : "Done"} />
              <Stat label="Tools" value={String(live.toolCallList.length)} />
              <Stat label="Appr." value={String(live.approvalCount)} />
              <Stat label="Fails" value={String(live.failureCount)} />
              <Stat label="Iter." value={live.iterations ? String(live.iterations) : "1"} />
            </div>
            <div className="text-xs text-muted-foreground">
              {joinParts([
                stopReasonLabel(live.stopReason) || (live.status === "streaming" ? "in progress" : "complete"),
                !live.historical && live.startedAt != null ? formatDuration((live.endedAt ?? Date.now()) - live.startedAt) : "",
                live.index ? `Assistant ${live.index}` : "",
              ]) || "Live turn details"}
            </div>
          </>
        ) : <div className="text-xs text-muted-foreground">No active assistant turn yet.</div>}
      </Section>

      <Section title="Recent Activity">
        {recent.length ? recent.map(({ turn, call }) => {
          const state = toolStateClass(call);
          return (
            <div key={call.id} className="chat-surface flex items-center gap-2 px-2 py-1">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{call.label || call.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{joinParts([`Assistant ${turn.index}`, call.preview || "", call.elapsedMs != null ? formatDuration(call.elapsedMs) : ""])}</div>
              </div>
              <StatusPill tone={toolStateTone(state)} className="font-mono text-xs">{toolStateText(state)}</StatusPill>
            </div>
          );
        }) : <div className="text-xs text-muted-foreground">Tool calls and approvals will appear here.</div>}
      </Section>

      <Section title="Selection Context">
        {store.pendingCtx ? (
          <div className="truncate rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary">{store.pendingCtx.label || "Queued context"}</div>
        ) : <div className="text-xs text-muted-foreground">No queued editor context.</div>}
      </Section>
    </div>
  );
}
