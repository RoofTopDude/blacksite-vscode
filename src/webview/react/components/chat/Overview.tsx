import { type CSSProperties } from "react";
import { countLabel, formatClock, formatTokenCount, joinParts, shortText } from "@/lib/format";
import { conversationStats } from "@/lib/chat-model";
import { actions, contextMeter, useStore, type Store } from "@/lib/store";

const PILL_COLOR: Record<string, string> = {
  idle: "var(--muted-foreground)",
  live: "var(--s-info)",
  wait: "var(--s-warn)",
  error: "var(--s-err)",
  done: "var(--s-ok)",
};

function pillStyle(cls: string): CSSProperties {
  const c = PILL_COLOR[cls] || "var(--muted-foreground)";
  return { color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, borderColor: `color-mix(in srgb, ${c} 28%, transparent)` };
}

interface OverviewState { title: string; sub: string; pillClass: string; pillText: string; }

function computeOverview(store: Store): OverviewState {
  const chat = store.chat;
  const stats = conversationStats(chat);
  const runtime = chat.sessionRuntime;
  const live = chat.currentLiveTurnId ? chat.byId.get(chat.currentLiveTurnId) : null;

  let title = "Ready for the next task";
  let sub = "Tool activity and approvals will appear here.";
  let pillClass = "idle";
  let pillText = "Idle";

  if (chat.running && !live) {
    title = runtime?.isCompacting ? "Compacting conversation history" : "Starting assistant turn";
    sub = runtime?.isCompacting ? "Older history is being compacted to reclaim context." : "Waiting for the first streamed update.";
    pillClass = "live"; pillText = "Live";
  } else if (live) {
    const pq = live.toolCallList.filter((c) => c.approvalState === "pending" && c.toolName === "question_card").length;
    const pa = live.toolCallList.filter((c) => c.approvalState === "pending" && c.toolName !== "question_card").length;
    if (pq > 0) { title = "Waiting for your response"; sub = pq === 1 ? "The agent has a question for you." : `The agent has ${pq} questions for you.`; pillClass = "wait"; pillText = "Wait"; }
    else if (pa > 0) { title = "Awaiting approval"; sub = pa === 1 ? "1 tool is waiting on approval." : `${pa} tools are waiting on approval.`; pillClass = "wait"; pillText = "Wait"; }
    else if (runtime?.isCompacting) { title = "Agent is compacting history"; sub = "Older history is being compressed so the live context stays focused."; pillClass = "live"; pillText = "Live"; }
    else { title = "Agent is working"; sub = live.toolCallList.length ? `${countLabel(live.toolCallList.length, "tool call")} in the live turn.` : "Drafting the assistant response."; pillClass = "live"; pillText = "Live"; }
  } else if (chat.lastConversationError) {
    title = "Last turn hit an error"; sub = shortText(chat.lastConversationError, 110); pillClass = "error"; pillText = "Error";
  } else if (stats.assistantTurns > 0) {
    title = "Conversation ready";
    sub = joinParts([countLabel(stats.assistantTurns, "assistant turn"), stats.toolCalls ? countLabel(stats.toolCalls, "tool call") : "", stats.failures ? `${stats.failures} failures` : "no failures"]);
    pillClass = "done"; pillText = "Ready";
  }
  return { title, sub, pillClass, pillText };
}

interface CompactionState { badgeClass: string; badgeText: string; title: string; detail: string; canCompact: boolean; btnLabel: string; }

function computeCompaction(store: Store): CompactionState {
  const runtime = store.chat.sessionRuntime;
  const running = store.chat.running;
  const autoEnabled = runtime ? !!runtime.compressionEnabled : !!store.settings.compression?.enabled;

  let badgeClass = "idle";
  let badgeText = autoEnabled ? "Auto" : "Manual";
  let title = autoEnabled ? "Automatic compaction is armed." : "Automatic compaction is off.";
  let detail = autoEnabled ? "Older history will compact when the active context gets tight." : "Manual compaction unlocks once enough history accumulates.";

  if (runtime?.isCompacting) {
    badgeClass = "live"; badgeText = "Live"; title = "Compacting older history now.";
    detail = (runtime.compressibleMessageCount ?? 0) > 0 ? `Compressing ${countLabel(runtime.compressibleMessageCount!, "older message")} to reclaim context.` : "Compacting earlier history to reclaim context.";
  } else if (runtime?.lastCompressionError) {
    badgeClass = "error"; badgeText = "Issue"; title = "The last compaction attempt failed."; detail = shortText(runtime.lastCompressionError, 140);
  } else if ((runtime?.compressionCount ?? 0) > 0) {
    badgeClass = "done"; badgeText = "Done"; title = `${countLabel(runtime!.compressionCount!, "compaction pass")} applied.`;
    detail = joinParts([
      runtime!.lastCompressedMessageCount ? `Last pass: ${countLabel(runtime!.lastCompressedMessageCount, "message")}` : "",
      runtime!.lastCompressionTrigger ? `${runtime!.lastCompressionTrigger} trigger` : "",
      runtime!.lastCompressedAt ? formatClock(runtime!.lastCompressedAt) : "",
    ]) || "Compressed history is available to the agent.";
  } else if ((runtime?.compressibleMessageCount ?? 0) > 0) {
    badgeClass = autoEnabled ? "wait" : "idle"; badgeText = autoEnabled ? "Ready" : "Manual";
    title = `${countLabel(runtime!.compressibleMessageCount!, "message")} can be compacted now.`;
    detail = autoEnabled ? "Compact early now or let the agent do it automatically at the threshold." : "Auto compaction is off, but you can compact manually now.";
  }

  const canCompact = !!runtime && !runtime.isCompacting && !running && (runtime.compressibleMessageCount ?? 0) > 0;
  return { badgeClass, badgeText, title, detail, canCompact, btnLabel: runtime?.isCompacting ? "Compacting…" : "Compact now" };
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[14px] font-semibold tabular-nums text-foreground">{value}</span>
      <span className="text-[8.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

export function Overview() {
  const store = useStore();
  const stats = conversationStats(store.chat);
  const ov = computeOverview(store);
  const comp = computeCompaction(store);
  const meter = contextMeter();

  return (
    <div className="flex flex-col gap-2 border-b border-border px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Conversation</div>
          <div className="truncate text-[12px] font-semibold text-foreground">{ov.title}</div>
          <div className="line-clamp-2 text-[10px] text-muted-foreground">{ov.sub}</div>
        </div>
        <span className="shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold" style={pillStyle(ov.pillClass)}>{ov.pillText}</span>
      </div>

      <div className="flex items-center justify-between gap-1 rounded-md border border-border bg-white/[0.02] px-2 py-1.5">
        <Metric value={stats.assistantTurns} label="Turns" />
        <Metric value={stats.toolCalls} label="Tools" />
        <Metric value={stats.approvals} label="Approvals" />
        <Metric value={stats.failures} label="Failures" />
        {meter.show && (
          <div className="flex min-w-[54px] flex-col items-center gap-0.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${meter.pct}%`, background: meter.tone === "danger" ? "var(--s-err)" : meter.tone === "warn" ? "var(--s-warn)" : "var(--primary)" }}
              />
            </div>
            <span className="text-[8.5px] uppercase tracking-wide text-muted-foreground">{meter.pct}% ctx</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-white/[0.02] px-2 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="rounded-full border px-1.5 py-px text-[8.5px] font-semibold" style={pillStyle(comp.badgeClass)}>{comp.badgeText}</span>
            <span className="truncate text-[10.5px] font-medium text-foreground">{comp.title}</span>
          </div>
          <div className="line-clamp-1 text-[9.5px] text-muted-foreground" title={meter.show ? `${formatTokenCount(store.chat.lastInputTokens)} tokens` : undefined}>{comp.detail}</div>
        </div>
        <button
          type="button"
          disabled={!comp.canCompact}
          onClick={() => actions.compact()}
          className="shrink-0 rounded-md border border-border bg-white/5 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:opacity-40"
        >
          {comp.btnLabel}
        </button>
      </div>
    </div>
  );
}
