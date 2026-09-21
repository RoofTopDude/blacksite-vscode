import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, FileDiff, RotateCw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  countLabel, formatClock, formatCostUsd, formatDuration, formatTokenCount, iterationProgressLabel,
  joinParts, liveElapsedMs, shortText,
} from "@/lib/format";
import { conversationChangeLedger, conversationStats, lastUserPrompt, latestAssistantTurn, type ConversationChangeLedger } from "@/lib/chat-model";
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
  const latest = latestAssistantTurn(chat);

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
        live.providerActivity?.message || (live.toolCallList.length ? countLabel(live.toolCallList.length, "tool call") : "Drafting the assistant response"),
        iterationProgressLabel(live.iterations, store.settings.maxIterations),
        elapsedLabel,
      ]);
      pillClass = "live"; pillText = "Live";
    }
  } else if (chat.lastConversationError) {
    title = "Last turn hit an error"; sub = shortText(chat.lastConversationError, 110); pillClass = "error"; pillText = "Error";
  } else if (latest?.stopReason === "max_iterations") {
    title = "Iteration limit reached";
    sub = "Progress is saved. Continue the conversation to resume from the current workspace state.";
    pillClass = "limit"; pillText = "Paused";
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
      <span className="text-xl font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function ChangeDelta({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-2xs">
      {additions > 0 && <span style={{ color: "var(--s-ok)" }}>+{additions}</span>}
      {deletions > 0 && <span style={{ color: "var(--s-err)" }}>-{deletions}</span>}
    </span>
  );
}

/** A persistent, conversation-scoped account of every file the agent has
 * successfully changed. It stays folded until requested so long sessions do
 * not turn the header into another transcript. */
function ChangeLedgerTag({ ledger }: { ledger: ConversationChangeLedger }) {
  const [open, setOpen] = useState(false);
  if (!ledger.fileCount) return null;
  return (
    <div className="chat-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="chat-interactive flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/[0.04]"
      >
        <span className="eyebrow">Changes</span>
        <span className="text-xs font-medium text-foreground">{countLabel(ledger.fileCount, "file")}</span>
        <ChangeDelta additions={ledger.additions} deletions={ledger.deletions} />
        <ChevronDown className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-180")} />
      </button>
      {open && (
        <div className="reveal-in flex max-h-40 flex-col gap-0.5 overflow-y-auto border-t border-border px-1 py-1.5">
          {ledger.files.map((file) => {
            /* The ledger is the one place that survives scrolling past the turn that made the
               change, which makes it the most useful place to review one — so each row opens
               the diff from the last tool call that still has a snapshot for the file, and
               falls back to the file itself once that snapshot has been evicted. */
            const reviewable = !!file.diffToolCallId;
            const title = reviewable ? `Open the diff for ${file.path}` : `Open ${file.path}`;
            return (
              <button
                key={file.path}
                type="button"
                title={title}
                aria-label={title}
                onClick={() => {
                  if (file.diffToolCallId) actions.openToolDiff(file.diffToolCallId, file.diffPath ?? file.path);
                  else actions.openFile(file.path);
                }}
                className="chat-interactive group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-white/[0.06]"
              >
                {reviewable
                  ? <FileDiff className="size-3 shrink-0 text-muted-foreground/70 group-hover:text-[color:var(--primary)]" aria-hidden="true" />
                  : <ExternalLink className="size-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground" aria-hidden="true" />}
                <span className="truncate font-mono text-foreground group-hover:underline">{file.path}</span>
                <ChangeDelta additions={file.additions} deletions={file.deletions} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const store = useStore();
  const now = useLiveClock(store.chat.running);
  const stats = conversationStats(store.chat);
  const changeLedger = conversationChangeLedger(store.chat);
  const ov = computeOverview(store, now);
  const comp = computeCompaction(store);
  const meter = contextMeter();
  const canRetry = !store.chat.running && !!store.chat.lastConversationError && !!lastUserPrompt(store.chat);
  const usage = store.sessionUsage;
  const usageGrand = usageTotal(usage);
  const cachePct = cacheHitRatePct(usage);
  const cost = store.sessionCost;
  const verification = store.chat.sessionRuntime?.verification;
  const costBudget = store.chat.sessionRuntime?.costBudget;
  // Details (metrics, token spend, compaction card) fold away so the transcript
  // keeps the vertical space; the status line + context meter stay as the
  // always-on signal. Collapsed is the default posture.
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-2 border-b border-border px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Conversation</div>
          <div className="truncate text-base font-semibold text-foreground">{ov.title}</div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{ov.sub}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canRetry && (
            <button
              type="button"
              onClick={() => actions.retryLast()}
              title="Resend your last message"
              className="chat-interactive inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-2xs font-semibold text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              <RotateCw className="size-2.5" /> Retry
            </button>
          )}
          <StatusPill tone={overviewTone(ov.pillClass)} className={cn("text-2xs", ov.pillClass === "live" && "live-breathe")}>{ov.pillText}</StatusPill>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Hide session details" : "Show session details (tools, tokens, compaction)"}
            className="chat-interactive inline-flex size-5 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-white/[0.06] hover:text-foreground"
          >
            <ChevronDown className={cn("disclosure size-3.5", expanded && "rotate-180")} />
          </button>
        </div>
      </div>

      {meter.show && (
        <div className="flex items-center gap-2" title={`${formatTokenCount(store.chat.lastInputTokens)} tokens in the active context`}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${meter.pct}%`, background: meter.tone === "danger" ? "var(--s-err)" : meter.tone === "warn" ? "var(--s-warn)" : "var(--primary)" }}
            />
          </div>
          <span className="shrink-0 font-mono text-2xs uppercase tabular-nums text-muted-foreground">{meter.pct}% ctx</span>
        </div>
      )}

      <ChangeLedgerTag ledger={changeLedger} />

      {verification && verification.status !== "idle" && (
        <div className="chat-surface flex items-center gap-1.5 px-2 py-1" title={verification.detail}>
          <StatusPill
            tone={verification.status === "passed" ? "ok" : verification.status === "pending" ? "warn" : verification.status === "failed" ? "err" : "idle"}
            className="text-2xs"
          >
            {verification.status === "passed" ? "Verified" : verification.status === "pending" ? "Verification due" : verification.status === "failed" ? "Verification failed" : "Unverified"}
          </StatusPill>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {verification.method ? `${verification.method} / ` : ""}{verification.files.length} changed file{verification.files.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* A failed compaction is the one detail that must not hide behind the fold. */}
      {!expanded && comp.badgeClass === "error" && (
        <div className="truncate text-2xs text-[color:var(--s-err)]" title={comp.detail}>{comp.title}</div>
      )}

      {expanded && (
        <div className="reveal-in flex flex-col gap-2">
          <div className="chat-surface flex items-center justify-around gap-1 px-2 py-1.5">
            <Metric value={stats.assistantTurns} label="Turns" />
            <Metric value={stats.toolCalls} label="Tools" />
            <Metric value={stats.approvals} label="Approvals" tone={stats.approvals ? "var(--s-warn)" : undefined} />
            <Metric value={stats.failures} label="Failures" tone={stats.failures ? "var(--s-err)" : undefined} />
          </div>

          {(usageGrand > 0 || costBudget?.maxUsd) && (
            <div className="flex flex-col gap-1 px-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Session tokens</span>
                <span className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
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
                <span className="inline-flex items-center gap-0.5" title="Prompt tokens (fresh input + cache)">
                  <ArrowUp className="size-2.5" aria-hidden="true" /> {formatTokenCount(usagePromptTotal(usage))}
                </span>
                <span className="inline-flex items-center gap-0.5" title="Generated output tokens">
                  <ArrowDown className="size-2.5" aria-hidden="true" /> {formatTokenCount(usage.output)}
                </span>
                {cachePct !== null && (
                  <span className="inline-flex items-center gap-0.5 text-[color:var(--s-ok)]" title="Tokens served from prompt cache (share of all prompt tokens)">
                    <Zap className="size-2.5" aria-hidden="true" /> {formatTokenCount(usage.cacheRead)}<span className="opacity-75"> · {cachePct}%</span>
                  </span>
                )}
                </span>
              </div>
              {costBudget?.maxUsd && (
                <div className="flex items-center gap-2" title={`Session spend ceiling: ${formatCostUsd(costBudget.maxUsd)}`}>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: `${Math.min(cost.usd / costBudget.maxUsd * 100, 100)}%`,
                        background: costBudget.exceeded ? "var(--s-err)" : costBudget.warned ? "var(--s-warn)" : "var(--primary)",
                      }}
                    />
                  </div>
                  <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                    {formatCostUsd(cost.usd)} / {formatCostUsd(costBudget.maxUsd)}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="chat-surface flex items-center justify-between gap-2 px-2 py-1.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <StatusPill tone={overviewTone(comp.badgeClass)} className="text-xs">{comp.badgeText}</StatusPill>
                <span className="truncate text-sm font-medium text-foreground">{comp.title}</span>
              </div>
              <div className="line-clamp-1 text-xs text-muted-foreground">{comp.detail}</div>
            </div>
            <button
              type="button"
              disabled={!comp.canCompact}
              onClick={() => actions.compact()}
              className="chat-interactive shrink-0 rounded-md border border-border bg-white/5 px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-40 disabled:active:scale-100"
            >
              {comp.btnLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
