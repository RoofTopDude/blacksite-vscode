import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { countLabel, formatDuration, shortText, toolStateText } from "@/lib/format";
import {
  thinkingElapsedMs, thinkingTickerLine, toolStateClass, turnIsLive,
  type ThinkingSegment, type ToolCall, type Turn,
} from "@/lib/chat-model";
import { useLiveClock } from "@/lib/use-live-clock";
import { Markdown } from "./Markdown";
import { ToolIcon } from "./ToolLog";
import { StatusPill, toolStateTone } from "./signal";

/** The actions one burst of reasoning produced, listed in the order they were issued.
 *  Informational only — payload inspection stays in the Execution card, so these rows
 *  never promise a drill-down that a collapsed Execution card couldn't deliver. */
function SegmentTools({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-px">
      {calls.map((call) => {
        const state = toolStateClass(call);
        return (
          <div key={call.id} className="flex items-center gap-1.5 py-0.5 text-xs">
            <ToolIcon toolName={call.toolName} />
            <span className="shrink-0 font-medium text-foreground/90">{call.label || call.displayName}</span>
            {call.preview && (
              <span className="truncate font-mono text-muted-foreground/80" title={call.preview}>
                {shortText(call.preview, 80)}
              </span>
            )}
            <span className="ml-auto shrink-0">
              {state === "ok"
                ? <span className="text-2xs text-muted-foreground/70">{toolStateText(state)}</span>
                : <StatusPill tone={toolStateTone(state)} className="text-2xs">{toolStateText(state)}</StatusPill>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Stanza({ segment, index, turn, live }: { segment: ThinkingSegment; index: number; turn: Turn; live: boolean }) {
  // A question card owns its own presentation in the transcript and must not leak its
  // choices here before the user has answered it.
  const calls = segment.toolCallIds
    .map((id) => turn.toolCalls.get(id))
    .filter((c): c is ToolCall => !!c && c.toolName !== "question_card");
  const streaming = live && segment.endedAt == null;

  return (
    <div className="thinking-stanza">
      {/* Absolutely positioned onto the rail — see .thinking-step-num. */}
      <span className="thinking-step-num">{index + 1}</span>
      <div className="thinking-prose">
        <Markdown raw={segment.text} streaming={streaming} />
        {streaming && <span className="cursor" />}
      </div>
      <SegmentTools calls={calls} />
    </div>
  );
}

export function ThinkingBlock({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(turn.thinkingOpen);
  const live = turnIsLive(turn) && turn.thinkingActive;
  const now = useLiveClock(live);

  if (!turn.thinkingSegments.length) return null;

  const steps = turn.thinkingSegments.length;
  const actions = turn.thinkingSegments.reduce((n, s) => n + s.toolCallIds.length, 0);
  // Restored history has no trustworthy timing — the blocks all replay in the same tick,
  // so a duration there would read as "thought for 0s" on genuinely long turns.
  const elapsed = turn.historical ? 0 : thinkingElapsedMs(turn, now);
  const ticker = thinkingTickerLine(turn);

  const summary = live
    ? formatDuration(elapsed)
    : [
        elapsed > 0 ? `Thought for ${formatDuration(elapsed)}` : "Thought",
        countLabel(steps, "step"),
        actions > 0 ? countLabel(actions, "action") : "",
      ].filter(Boolean).join(" · ");

  return (
    <div className="thinking-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chat-interactive flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/[0.03]"
      >
        {live && <span className="pulse-dot shrink-0" />}
        <span className="shrink-0 text-2xs font-bold uppercase tracking-[0.07em] text-primary">
          {live ? "Thinking…" : "Thought"}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">{summary}</span>
        <ChevronRight className={cn("disclosure ml-auto size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </button>

      {/* Folded-but-live: the trailing line stands in for the whole burst, so a collapsed
          block still reads as working rather than as stalled. Hidden once expanded, where
          the same text is already on screen in full. */}
      {live && !open && ticker && (
        <div className="thinking-ticker" key={ticker}>{shortText(ticker, 120)}</div>
      )}

      {open && (
        <div className="reveal-in thinking-body">
          {turn.thinkingSegments.map((segment, i) => (
            <Stanza key={i} segment={segment} index={i} turn={turn} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}
