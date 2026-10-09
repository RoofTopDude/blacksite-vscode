import { memo, useState, type CSSProperties } from "react";
import { Bot, Check, ChevronRight, Copy, Undo2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { countLabel, formatClock, formatDuration, liveElapsedMs } from "@/lib/format";
import {
  artifactCallsOf, pendingItemsOf, placeholderText, questionCardSettled, rewindTargetFor, turnChrome, turnIsLive, turnNarrative,
  type TextSegment, type Turn as TurnModel,
} from "@/lib/chat-model";
import { actions, useStoreSelector } from "@/lib/store";
import { useLiveClock } from "@/lib/use-live-clock";
import { agentLaneColor, cssColor } from "@/lib/graph/colors";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { QuestionCard } from "./QuestionCard";
import { ToolLog } from "./ToolLog";
import { LiveAction } from "./LiveAction";
import { TranscriptDocumentCard } from "./TranscriptDocumentCard";
import { StatusPill, turnStatusTone } from "./signal";
import { HandoffCard, Seam } from "@/components/run/TurnNotes";

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

/**
 * Why the run stopped, set apart from the reply. The message comes from the provider or the
 * host, not the agent, so it gets its own signal-toned surface instead of reading as prose.
 */
function ErrorCallout({ message }: { message: string }) {
  return (
    <div role="alert" className="turn-error-callout">
      <XCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">The run stopped with an error</div>
        <div className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">{message}</div>
      </div>
    </div>
  );
}

function AssistantBody({ turn }: { turn: TurnModel }) {
  const hasTools = turn.toolCallList.length > 0;
  const streaming = turn.status === "streaming";
  const { updates, reply } = turnNarrative(turn);
  const error = turn.status === "error" ? turn.errorMessage : "";
  // The turn produced nothing to show at all — no prose, no actions. placeholderText
  // explains why (cancelled, empty response, still starting); an error explains itself.
  const empty = !updates.length && !reply && !hasTools && !error;

  return (
    <>
      <ThinkingBlock turn={turn} />
      {turn.questionCards.filter(questionCardSettled).map((card) => (
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
      {error && <ErrorCallout message={error} />}
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
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const live = turnIsLive(lane);
  const now = useLiveClock(live);
  const chrome = turnChrome(lane, now);
  const laneColor = cssColor(agentLaneColor(lane.id) ?? 0x8aa6c0);
  const tools = lane.toolCallList.length;
  const rounds = lane.rounds ?? [];
  const rawElapsed = !lane.historical ? liveElapsedMs(lane.startedAt, lane.endedAt, now) : null;
  const elapsed = rawElapsed != null ? formatDuration(rawElapsed) : "";
  // A resumed lane opens itself. The follow-up was invisible before precisely because its work
  // landed inside a tile the user had already collapsed and had no reason to reopen.
  const open = manualOpen ?? (live && rounds.length > 0);
  const footer = [
    tools ? countLabel(tools, "tool") : "",
    rounds.length ? countLabel(rounds.length, "follow-up") : "",
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
      <button type="button" onClick={() => setManualOpen(!open)} className="chat-interactive flex w-full items-start gap-2 p-2 text-left hover:bg-white/[0.03]">
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
          <LaneFollowUps rounds={rounds} />
          <LiveAction turn={lane} />
          <AssistantBody turn={lane} />
        </div>
      )}
    </div>
  );
}

/**
 * What the parent asked this lane after it had already finished.
 *
 * Shown at the top of the open lane rather than inline with the lane's prose: the follow-up is
 * the parent's question, not the subagent's work, and the lane's body is a single accumulated
 * transcript that has no seam to thread it into. Listing the questions here is what makes a
 * resumed lane legible — without them the follow-up's answer appears with nothing prompting it.
 */
function LaneFollowUps({ rounds }: { rounds: NonNullable<TurnModel["rounds"]> }) {
  if (!rounds.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-1">
      {rounds.map((round, index) => (
        <div key={index} className="rounded border-l-2 border-[var(--lane-color)] bg-white/[0.03] px-2 py-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">
            Follow-up {rounds.length > 1 ? index + 1 : ""}
          </div>
          <div className="text-xs text-foreground">{round.message}</div>
        </div>
      ))}
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

/** Rewind to before this message. The host shows what will be restored, lost and left undone
 *  before anything changes, so the button itself asks nothing. */
function RewindButton({ userTurnId }: { userTurnId: string }) {
  const { target, running } = useStoreSelector(
    (state) => ({ target: rewindTargetFor(state.chat.turns, userTurnId, state.rewindableTurnIds), running: state.chat.running }),
    (a, b) => a.target === b.target && a.running === b.running,
  );
  if (!target || running) return null;
  return (
    <button
      type="button"
      onClick={() => actions.rewindTo(target)}
      title="Rewind to before this message"
      className="chat-interactive rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
    >
      <Undo2 className="size-3" />
    </button>
  );
}

/** Where a message sent mid-run stands, in the words the user needs: will the agent see it, and when. */
function SteerChip({ state }: { state: NonNullable<TurnModel["steer"]>["state"] }) {
  const anythingPending = useStoreSelector((snapshot) => pendingItemsOf(snapshot.chat).length > 0);
  const waiting = (state === "sending" || state === "queued") && anythingPending;
  const label = state === "delivered" ? "Read by the agent"
    : state === "sent_as_turn" ? "Sent as a new message"
    : state === "returned" ? "Not sent"
    : waiting ? "Delivered after you answer the pending request"
    : "Delivered at the agent's next step";
  const done = state === "delivered" || state === "sent_as_turn";
  return (
    <span className={cn("text-2xs", done ? "text-muted-foreground/80" : "text-[color:var(--s-warn)] live-breathe")} role="status">
      {label}
    </span>
  );
}

interface TurnProps {
  turn: TurnModel;
  /** This turn's own revision, and the store's: the only things that can change what it shows
   *  that are not already a hook inside it. They exist so the memo below can tell. */
  rev?: number;
  allRev?: number;
}

/** A turn re-renders when it, or something that can reach any turn, has changed. */
function sameTurn(a: TurnProps, b: TurnProps): boolean {
  return a.turn === b.turn && a.rev === b.rev && a.allRev === b.allRev;
}

export const Turn = memo(function Turn({ turn }: TurnProps) {
  const animate = !turn.historical;
  const railShowsAction = useStoreSelector((state) => !!state.planRun && state.dismissedRunId !== state.planRun.id && state.chat.currentLiveTurnId === turn.id);
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
          {turn.steer && <SteerChip state={turn.steer.state} />}
          <RewindButton userTurnId={turn.id} />
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
      <Seam turn={turn} />
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
      {/* While a plan run is open its bar carries the live action, where it cannot scroll away. */}
      {!railShowsAction && <LiveAction turn={turn} />}
      <AssistantBody turn={turn} />
      {turn.lanes.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          {turn.lanes.map((lane) => <LaneTile key={lane.id} lane={lane} />)}
        </div>
      )}
      <HandoffCard turn={turn} />
      <div className="text-xs text-muted-foreground">{chrome.meta}</div>
    </div>
  );
}, sameTurn);
