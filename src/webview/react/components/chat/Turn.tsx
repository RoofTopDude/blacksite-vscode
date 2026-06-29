import { useState, type CSSProperties } from "react";
import { countLabel, formatDuration } from "@/lib/format";
import { placeholderText, turnChrome, type Turn as TurnModel } from "@/lib/chat-model";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { QuestionCard } from "./QuestionCard";
import { ToolLog } from "./ToolLog";

const STATUS_COLOR: Record<string, string> = {
  streaming: "var(--s-info)",
  pending: "var(--s-warn)",
  error: "var(--s-err)",
  complete: "var(--s-ok)",
};

function statusStyle(statusClass: string): CSSProperties {
  const c = STATUS_COLOR[statusClass] || "var(--muted-foreground)";
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${c} 28%, transparent)`,
  };
}

function AssistantBody({ turn }: { turn: TurnModel }) {
  return (
    <>
      <ThinkingBlock turn={turn} />
      {turn.questionCards.map((card) => (
        <QuestionCard key={card.toolCallId} turnId={turn.id} card={card} />
      ))}
      <div>
        {turn.raw
          ? <Markdown raw={turn.raw} />
          : <p className="text-[12px] italic text-muted-foreground">{placeholderText(turn)}</p>}
        {turn.status === "streaming" && <span className="cursor" />}
      </div>
      <ToolLog turn={turn} />
    </>
  );
}

function LaneTile({ lane }: { lane: TurnModel }) {
  const [open, setOpen] = useState(false);
  const chrome = turnChrome(lane);
  const badge = lane.status === "error" ? "Error" : lane.status === "streaming" ? "Live" : "Done";
  const tools = lane.toolCallList.length;
  const elapsed = !lane.historical && lane.startedAt != null ? formatDuration((lane.endedAt ?? Date.now()) - lane.startedAt) : "";
  const footer = [
    tools ? countLabel(tools, "tool") : "",
    lane.approvalCount ? countLabel(lane.approvalCount, "approval") : "",
    lane.failureCount ? `${lane.failureCount} failed` : "",
    elapsed,
  ].filter(Boolean).join(" · ") || (lane.status === "streaming" ? "Running…" : "Complete");

  return (
    <div className="rounded-lg border border-border bg-white/[0.02]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full p-2 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[10.5px] font-semibold text-foreground">{lane.label || "Delegated lane"}</span>
          <span className="shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold" style={statusStyle(chrome.statusClass)}>{badge}</span>
        </div>
        {lane.task && <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{lane.task}</div>}
        <div className="mt-1 text-[9.5px] text-muted-foreground">{footer}</div>
      </button>
      {open && (
        <div className="border-t border-border p-2">
          <AssistantBody turn={lane} />
        </div>
      )}
    </div>
  );
}

export function Turn({ turn }: { turn: TurnModel }) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {turn.ctxLabel && (
          <span className="max-w-[92%] truncate rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
            Context: {turn.ctxLabel}
          </span>
        )}
        <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[12px] leading-relaxed">
          {turn.text}
        </div>
      </div>
    );
  }

  const chrome = turnChrome(turn);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.07em] text-muted-foreground">Assistant {turn.index}</span>
        <span className="rounded-full border px-1.5 py-px text-[9px] font-semibold" style={statusStyle(chrome.statusClass)}>{chrome.statusText}</span>
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
