import { type ReactNode } from "react";
import { formatDuration, joinParts, stopReasonLabel, toolStateText, type ToolState } from "@/lib/format";
import { latestAssistantTurn, toolStateClass, type ToolCall, type Turn } from "@/lib/chat-model";
import { useStore } from "@/lib/store";

const SIGNAL: Record<ToolState, string> = {
  running: "var(--s-info)", ok: "var(--s-ok)", fail: "var(--s-err)", pending: "var(--s-warn)",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-white/[0.02] px-2 py-1 text-center">
      <div className="text-[8.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[12px] font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</div>
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
    <div className="flex flex-col gap-3 border-b border-border bg-black/15 px-2.5 py-2">
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
            <div className="text-[9.5px] text-muted-foreground">
              {joinParts([
                stopReasonLabel(live.stopReason) || (live.status === "streaming" ? "in progress" : "complete"),
                !live.historical && live.startedAt != null ? formatDuration((live.endedAt ?? Date.now()) - live.startedAt) : "",
                live.index ? `Assistant ${live.index}` : "",
              ]) || "Live turn details"}
            </div>
          </>
        ) : <div className="text-[10px] text-muted-foreground">No active assistant turn yet.</div>}
      </Section>

      <Section title="Recent Activity">
        {recent.length ? recent.map(({ turn, call }) => {
          const state = toolStateClass(call);
          return (
            <div key={call.id} className="flex items-center gap-2 rounded-md border border-border bg-white/[0.02] px-2 py-1">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10.5px] font-medium text-foreground">{call.label || call.displayName}</div>
                <div className="truncate text-[9px] text-muted-foreground">{joinParts([`Assistant ${turn.index}`, call.preview || "", call.elapsedMs != null ? formatDuration(call.elapsedMs) : ""])}</div>
              </div>
              <span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-[8.5px] font-semibold" style={{ color: SIGNAL[state], borderColor: `color-mix(in srgb, ${SIGNAL[state]} 28%, transparent)`, background: `color-mix(in srgb, ${SIGNAL[state]} 14%, transparent)` }}>{toolStateText(state)}</span>
            </div>
          );
        }) : <div className="text-[10px] text-muted-foreground">Tool calls and approvals will appear here.</div>}
      </Section>

      <Section title="Selection Context">
        {store.pendingCtx ? (
          <div className="truncate rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] text-primary">{store.pendingCtx.label || "Queued context"}</div>
        ) : <div className="text-[10px] text-muted-foreground">No queued editor context.</div>}
      </Section>
    </div>
  );
}
