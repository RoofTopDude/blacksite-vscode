import { useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { countLabel, formatDuration, liveElapsedMs } from "@/lib/format";
import { placeholderText, turnChrome, turnIsLive, type Turn as TurnModel } from "@/lib/chat-model";
import { useLiveClock } from "@/lib/use-live-clock";
import { agentLaneColor, cssColor } from "@/lib/graph/colors";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { QuestionCard } from "./QuestionCard";
import { ToolLog } from "./ToolLog";
import { StatusPill, turnStatusTone } from "./signal";

/** Rendered when the agent narrates while also invoking tools — gives it clear visual breathing room. */
function NarrationBlock({ raw, streaming }: { raw: string; streaming: boolean }) {
  return (
    <div className="narration-block">
      <Markdown raw={raw} />
      {streaming && <span className="cursor" />}
    </div>
  );
}

function AssistantBody({ turn }: { turn: TurnModel }) {
  const hasTools = turn.toolCallList.length > 0;

  return (
    <>
      <ThinkingBlock turn={turn} />
      {turn.questionCards.map((card) => (
        <QuestionCard key={card.toolCallId} turnId={turn.id} card={card} />
      ))}
      {turn.raw ? (
        hasTools ? (
          <NarrationBlock raw={turn.raw} streaming={turn.status === "streaming"} />
        ) : (
          <div>
            <Markdown raw={turn.raw} />
            {turn.status === "streaming" && <span className="cursor" />}
          </div>
        )
      ) : (
        !hasTools ? (
          <p className="text-[12px] italic text-muted-foreground">{placeholderText(turn)}</p>
        ) : null
      )}
      <ToolLog turn={turn} />
    </>
  );
}

function LaneTile({ lane }: { lane: TurnModel }) {
  const [open, setOpen] = useState(false);
  const now = useLiveClock(turnIsLive(lane));
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
      className="chat-surface chat-lane-surface overflow-hidden"
      style={{ "--lane-color": laneColor } as CSSProperties}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="chat-interactive w-full p-2 text-left hover:bg-white/[0.03]">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="chat-lane-marker" />
            <span className="truncate text-[10.5px] font-semibold text-foreground">{lane.label || "Delegated lane"}</span>
          </span>
          <StatusPill tone={turnStatusTone(chrome.statusClass)} className="text-[9px]">{chrome.statusText}</StatusPill>
        </div>
        {lane.task && <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{lane.task}</div>}
        <div className="mt-1 text-[9.5px] text-muted-foreground">{footer}</div>
      </button>
      {open && (
        <div className="reveal-in border-t border-border p-2">
          <AssistantBody turn={lane} />
        </div>
      )}
    </div>
  );
}

export function Turn({ turn }: { turn: TurnModel }) {
  const animate = !turn.historical;
  // Called unconditionally (Rules of Hooks) even for user turns, which are always
  // status "complete" — turnIsLive is false there, so the clock never ticks for them.
  const now = useLiveClock(turnIsLive(turn));

  if (turn.role === "user") {
    return (
      <div className={cn("flex flex-col items-end gap-1", animate && "turn-in")}>
        {turn.ctxLabel && (
          <span className="max-w-[92%] truncate rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
            Context: {turn.ctxLabel}
          </span>
        )}
        <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-primary/25 bg-primary/10 px-3 py-2 text-[12px] leading-relaxed shadow-sm">
          {turn.text}
        </div>
      </div>
    );
  }

  const chrome = turnChrome(turn, now);
  const showBadge = chrome.statusClass !== "complete";
  return (
    <div id={`turn-${turn.id}`} className={cn("flex flex-col gap-1.5", animate && "turn-in")}>
      <div className="flex items-center gap-1.5">
        <span className="agent-marker" />
        <span className="eyebrow">Blacksite</span>
        {showBadge && (
          <StatusPill tone={turnStatusTone(chrome.statusClass)} className={cn("ml-auto text-[9px]", chrome.statusClass === "streaming" && "live-breathe")}>
            {chrome.statusText}
          </StatusPill>
        )}
      </div>
      <AssistantBody turn={turn} />
      {turn.lanes.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          {turn.lanes.map((lane) => <LaneTile key={lane.id} lane={lane} />)}
        </div>
      )}
      <div className="text-[9.5px] text-muted-foreground">{chrome.meta}</div>
    </div>
  );
}
