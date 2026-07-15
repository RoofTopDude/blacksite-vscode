import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  countLabel, formatClock, formatCostUsd, formatDuration, formatTokenCount, iterationProgressLabel,
  joinParts, liveElapsedMs, shortText,
} from "@/lib/format";
import { conversationStats, lastUserPrompt } from "@/lib/chat-model";
import { actions, contextMeter, useStore, type Store } from "@/lib/store";
import { cacheHitRatePct, usagePromptTotal, usageTotal } from "@/lib/tokens";
import { useLiveClock } from "@/lib/use-live-clock";
import { StatusPill, overviewTone } from "./signal";

interface OverviewState { title: string; sub: string; pillClass: string; pillText: string; }

function computeOverview(store: Store, now: number): OverviewState {
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
    const elapsedMs = liveElapsedMs(live.startedAt, live.endedAt, now);
    const elapsedLabel = elapsedMs != null ? `${formatDuration(elapsedMs)} elapsed` : "";
    if (pq > 0) { title = "Waiting for your response"; sub = pq === 1 ? "The agent has a question for you." : `The agent has ${pq} questions for you.`; pillClass = "wait"; pillText = "Wait"; }
    else if (pa > 0) { title = "Awaiting approval"; sub = pa === 1 ? "1 tool is waiting on approval." : `${pa} tools are waiting on approval.`; pillClass = "wait"; pillText = "Wait"; }
    else if (runtime?.isCompacting) { title = "Agent is compacting history"; sub = "Older history is being compressed so the live context stays focused."; pillClass = "live"; pillText = "Live"; }
    else {
      title = "Agent is working";
      sub = joinParts([
        live.toolCallList.length ? countLabel(live.toolCallList.length, "tool call") : "Drafting the assistant response",
        iterationProgressLabel(live.iterations, store.settings.maxIterations),
        elapsedLabel,
      ]);
      pillClass = "live"; pillText = "Live";
    }
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

function Metric({ value, label, tone }: { value: number | string; label: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-[14px] font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

export function Overview() {
  const store = useStore();
  const now = useLiveClock(store.chat.running);
  const stats = conversationStats(store.chat);
  const ov = computeOverview(store, now);
  const comp = computeCompaction(store);
  const meter = contextMeter();
  const canRetry = !store.chat.running && !!store.chat.lastConversationError && !!lastUserPrompt(store.chat);
  const usage = store.sessionUsage;
  const usageGrand = usageTotal(usage);
  const cachePct = cacheHitRatePct(usage);
  const cost = store.sessionCost;

  return (
    <div className="flex flex-col gap-2 border-b border-border px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Conversation</div>
          <div className="truncate text-[12px] font-semibold text-foreground">{ov.title}</div>
          <div className="line-clamp-2 text-[10px] text-muted-foreground">{ov.sub}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canRetry && (
            <button
              type="button"
              onClick={() => actions.retryLast()}
              title="Resend your last message"
              className="chat-interactive inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[9px] font-semibold text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              <RotateCw className="size-2.5" /> Retry
            </button>
          )}
          <StatusPill tone={overviewTone(ov.pillClass)} className={cn("text-[9px]", ov.pillClass === "live" && "live-breathe")}>{ov.pillText}</StatusPill>
        </div>
      </div>

      <div className="chat-surface flex items-center justify-between gap-1 px-2 py-1.5">
        <Metric value={stats.assistantTurns} label="Turns" />
        <Metric value={stats.toolCalls} label="Tools" />
        <Metric value={stats.approvals} label="Approvals" tone={stats.approvals ? "var(--s-warn)" : undefined} />
        <Metric value={stats.failures} label="Failures" tone={stats.failures ? "var(--s-err)" : undefined} />
        {meter.show && (
          <div className="flex min-w-[54px] flex-col items-center gap-0.5">
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${meter.pct}%`, background: meter.tone === "danger" ? "var(--s-err)" : meter.tone === "warn" ? "var(--s-warn)" : "var(--primary)" }}
              />
            </div>
            <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground">{meter.pct}% ctx</span>
          </div>
        )}
      </div>

      {usageGrand > 0 && (
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="eyebrow">Session tokens</span>
          <span className="flex items-center gap-2 font-mono text-[9.5px] tabular-nums text-muted-foreground">
            {cost.usd > 0 ? (
              <span
                className="font-semibold text-foreground"
                title={cost.partial
                  ? "Estimated spend this session — some usage had no known per-token price and isn't included, so this is a lower bound"
                  : "Estimated spend this session, based on live provider pricing"}
              >
                {cost.partial ? "~" : ""}{formatCostUsd(cost.usd)}
              </span>
            ) : cost.partial ? (
              <span className="text-muted-foreground/70" title="This session's usage has no known per-token pricing (e.g. Bedrock), so spend can't be estimated">
                cost n/a
              </span>
            ) : null}
            <span className="font-semibold text-foreground" title="Total billed tokens this session">{formatTokenCount(usageGrand)}</span>
            <span title="Prompt tokens (fresh input + cache)">↑ {formatTokenCount(usagePromptTotal(usage))}</span>
            <span title="Generated output tokens">↓ {formatTokenCount(usage.output)}</span>
            {cachePct !== null && (
              <span className="text-[color:var(--s-ok)]" title="Tokens served from prompt cache (share of all prompt tokens)">
                ⚡ {formatTokenCount(usage.cacheRead)}<span className="opacity-75"> · {cachePct}%</span>
              </span>
            )}
          </span>
        </div>
      )}

      <div className="chat-surface flex items-center justify-between gap-2 px-2 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusPill tone={overviewTone(comp.badgeClass)} className="text-[9.5px]">{comp.badgeText}</StatusPill>
            <span className="truncate text-[10.5px] font-medium text-foreground">{comp.title}</span>
          </div>
          <div className="line-clamp-1 text-[9.5px] text-muted-foreground" title={meter.show ? `${formatTokenCount(store.chat.lastInputTokens)} tokens` : undefined}>{comp.detail}</div>
        </div>
        <button
          type="button"
          disabled={!comp.canCompact}
          onClick={() => actions.compact()}
          className="chat-interactive shrink-0 rounded-md border border-border bg-white/5 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-40 disabled:active:scale-100"
        >
          {comp.btnLabel}
        </button>
      </div>
    </div>
  );
}
