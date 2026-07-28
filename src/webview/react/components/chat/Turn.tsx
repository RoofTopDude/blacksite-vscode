import { useState, type CSSProperties } from "react";
import { Bot, Check, ChevronRight, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { countLabel, formatClock, formatDuration, liveElapsedMs } from "@/lib/format";
import {
  artifactCallsOf, placeholderText, questionCardResolved, turnChrome, turnIsLive, turnNarrative,
  type TextSegment, type Turn as TurnModel,
} from "@/lib/chat-model";
import { useLiveClock } from "@/lib/use-live-clock";
import { agentLaneColor, cssColor } from "@/lib/graph/colors";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { QuestionCard } from "./QuestionCard";
import { ToolLog } from "./ToolLog";
import { LiveAction } from "./LiveAction";
import { TranscriptDocumentCard } from "./TranscriptDocumentCard";
import { StatusPill, turnStatusTone } from "./signal";

/**
 * Deliverables the agent produced for the user, lifted out of the execution drawer.
 *
 * These land mid-run, before the turn has a reply — the point is that the user can start
 * reading the report while the agent is still working, which cannot happen while it sits
 * behind the Execution card's collapsed disclosure. Only transcript documents qualify
 * today; see ARTIFACT_TOOLS in chat-model for the membership rule.
 */
function Artifacts({ turn }: { turn: TurnModel }) {
  const calls = artifactCallsOf(turn);
  if (!calls.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {calls.map((call) => <TranscriptDocumentCard key={call.id} result={call.result} />)}
    </div>
  );
}

/**
 * The agent's running commentary — what it said to the user *between* tool calls, before
 * it had an answer.
 *
 * Rendered as a numbered sequence rather than one block of prose. These stretches are
 * written minutes and several tool calls apart, and concatenating them ran unrelated
 * status updates together into a wall with no seam between "what I just did" and "what
 * I'm about to do". The rail restates the turn's actual chronology, and the muted
 * treatment keeps the whole sequence subordinate to the reply underneath it.
 */
function NarrationLog({ updates }: { updates: TextSegment[] }) {
  if (!updates.length) return null;
  return (
    <div className="narration-log">
      {updates.map((segment, index) => (
        <div key={index} className="narration-step">
          <span className="narration-step-index" aria-hidden="true">{index + 1}</span>
          <div className="narration-step-body">
            <Markdown raw={segment.text} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AssistantBody({ turn }: { turn: TurnModel }) {
  const hasTools = turn.toolCallList.length > 0;
  const streaming = turn.status === "streaming";
  const { updates, reply } = turnNarrative(turn);
  // The turn produced nothing to show at all — no prose, no actions. placeholderText
  // explains why (cancelled, empty response, still starting).
  const empty = !updates.length && !reply && !hasTools;

  return (
    <>
      <ThinkingBlock turn={turn} />
      {turn.questionCards.filter(questionCardResolved).map((card) => (
        <QuestionCard key={card.toolCallId} turnId={turn.id} card={card} />
      ))}
      <NarrationLog updates={updates} />
      {reply && (
        <div className={updates.length ? "assistant-reply" : undefined}>
          <Markdown raw={reply} streaming={streaming} />
          {streaming && <span className="cursor" />}
        </div>
      )}
      {empty && <p className="text-base italic text-muted-foreground">{placeholderText(turn)}</p>}
      <Artifacts turn={turn} />
      <ToolLog turn={turn} />
    </>
  );
}

/**
 * A delegated subagent lane — deliberately not styled like a tool-call drawer.
 * A subagent is another agent working on your behalf, not a single action, so it
 * gets a persona-like identity (bot avatar, colored kicker, full-ring card) instead
 * of the tool log's icon-plus-row treatment, while still collapsing via the same
 * chevron-disclosure interaction used everywhere else in the transcript.
 */
function LaneTile({ lane }: { lane: TurnModel }) {
  const [open, setOpen] = useState(false);
  const live = turnIsLive(lane);
  const now = useLiveClock(live);
  const chrome = turnChrome(lane, now);
  const laneColor = cssColor(agentLaneColor(lane.id) ?? 0x8aa6c0);
  const tools = lane.toolCallList.length;
  const rawElapsed = !lane.historical ? liveElapsedMs(lane.startedAt, lane.endedAt, now) : null;
  const elapsed = rawElapsed != null ? formatDuration(rawElapsed) : "";
  const footer = [
    tools ? countLabel(tools, "tool") : "",
    lane.approvalCount ? countLabel(lane.approvalCount, "approval") : "",
    lane.failureCount ? `${lane.failureCount} failed` : "",
    elapsed,
  ].filter(Boolean).join(" · ") || (lane.status === "streaming" ? "Running…" : "Complete");

  return (
    <div
      id={`lane-${lane.id}`}
      className="subagent-card overflow-hidden"
      style={{ "--lane-color": laneColor } as CSSProperties}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="chat-interactive flex w-full items-start gap-2 p-2 text-left hover:bg-white/[0.03]">
        <span className={cn("subagent-avatar", live && "live-breathe")}>
          <Bot className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="subagent-eyebrow">Subagent</span>
            <StatusPill tone={turnStatusTone(chrome.statusClass)} className="ml-auto text-2xs">{chrome.statusText}</StatusPill>
          </div>
          <div className="truncate text-sm font-semibold text-foreground">{lane.label || "Delegated lane"}</div>
          {lane.task && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{lane.task}</div>}
          <div className="mt-1 text-xs text-muted-foreground">{footer}</div>
        </div>
        <ChevronRight className={cn("disclosure mt-0.5 size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </button>
      {open && (
        <div className="reveal-in border-t border-border p-2">
          <AssistantBody turn={lane} />
        </div>
      )}
    </div>
  );
}

/** Hover-revealed "copy this message" affordance. Used on both sides of the
 *  transcript: a user turn is just as likely to be worth reusing (a long prompt
 *  you want to re-run elsewhere) as an assistant reply. */
function CopyReplyButton({ raw, title = "Copy reply markdown" }: { raw: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className={cn(
        "chat-interactive rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground",
        copied ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      {copied ? <Check className="size-3" style={{ color: "var(--s-ok)" }} /> : <Copy className="size-3" />}
    </button>
  );
}

export function Turn({ turn }: { turn: TurnModel }) {
  const animate = !turn.historical;
  // Called unconditionally (Rules of Hooks) even for user turns, which are always
  // status "complete" — turnIsLive is false there, so the clock never ticks for them.
  const now = useLiveClock(turnIsLive(turn));

  if (turn.role === "user") {
    return (
      <div className={cn("group flex flex-col items-end gap-1", animate && "turn-in")}>
        {turn.ctxLabel && (
          <span className="max-w-[92%] truncate rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">
            Context: {turn.ctxLabel}
          </span>
        )}
        <div className="user-bubble max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm px-3 py-2 text-base leading-relaxed">
          {turn.text}
        </div>
        {/* Mirrors the assistant turn's meta line so both sides of the
            conversation carry a time reference and the same copy affordance.
            Restored history has no reliable per-message stamp, so it stays clean. */}
        <div className="flex items-center gap-1">
          {turn.text && <CopyReplyButton raw={turn.text} title="Copy message" />}
          {turn.startedAt != null && (
            <span className="text-2xs text-muted-foreground/80">{formatClock(turn.startedAt)}</span>
          )}
        </div>
      </div>
    );
  }

  const chrome = turnChrome(turn, now);
  const showBadge = chrome.statusClass !== "complete";
  return (
    <div id={`turn-${turn.id}`} className={cn("group flex flex-col gap-1.5", animate && "turn-in")}>
      <div className="flex items-center gap-1.5">
        <span className="agent-marker" />
        <span className="eyebrow">Blacksite</span>
        <div className="ml-auto flex items-center gap-1">
          {turn.raw && turn.status !== "streaming" && <CopyReplyButton raw={turn.raw} />}
          {showBadge && (
            <StatusPill tone={turnStatusTone(chrome.statusClass)} className={cn("text-2xs", chrome.statusClass === "streaming" && "live-breathe")}>
              {chrome.statusText}
            </StatusPill>
          )}
        </div>
      </div>
      <LiveAction turn={turn} />
      <AssistantBody turn={turn} />
      {turn.lanes.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          {turn.lanes.map((lane) => <LaneTile key={lane.id} lane={lane} />)}
        </div>
      )}
      <div className="text-xs text-muted-foreground">{chrome.meta}</div>
    </div>
  );
}
