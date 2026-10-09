import type { CSSProperties } from "react";
import { Bot } from "lucide-react";
import { agentLaneColor, cssColor } from "@/lib/graph/colors";
import { toolStateClass, type Turn } from "@/lib/chat-model";
import { useLiveClock } from "@/lib/use-live-clock";
import { formatRunDuration } from "@/lib/run-format";

/**
 * Every lane that is running, side by side, with how much of its allowance each has used.
 *
 * The live-action line follows one tool call across all lanes, which is right for "what is it
 * doing now" and wrong for "what are my four lanes doing" — three of them were invisible, and a
 * lane about to hit its round limit looked the same as one that had just started. Shown only
 * when there are at least two, because one running lane is already the live action.
 */
export function LaneStrip({ turn }: { turn: Turn }) {
  const running = turn.lanes.filter((lane) => lane.status === "streaming");
  const now = useLiveClock(running.length > 0);
  if (running.length < 2) return null;
  return (
    <div className="lane-strip" role="list" aria-label={`${running.length} lanes running`}>
      {running.map((lane) => {
        const tools = lane.toolCallList.length;
        const budget = lane.laneBudget;
        const elapsedMs = lane.startedAt ? Math.max(0, now - lane.startedAt) : 0;
        const roundShare = budget ? Math.min(tools / budget.maxToolRounds, 1) : 0;
        const timeShare = budget ? Math.min(elapsedMs / (budget.maxRuntimeSeconds * 1000), 1) : 0;
        // The nearer of the two limits is the one that will end the lane first.
        const used = Math.max(roundShare, timeShare);
        const waiting = lane.toolCallList.some((call) => toolStateClass(call) === "pending");
        const color = cssColor(agentLaneColor(lane.id) ?? 0x8aa6c0);
        const title = [
          lane.label || "Delegated lane",
          lane.task ?? "",
          budget ? `${tools} of ${budget.maxToolRounds} tool rounds · ${formatRunDuration(elapsedMs)} of ${formatRunDuration(budget.maxRuntimeSeconds * 1000)}` : `${tools} tool calls`,
          waiting ? "Waiting on an approval" : "",
          "Click to show it in the conversation.",
        ].filter(Boolean).join("\n");
        return (
          <button
            key={lane.id}
            type="button"
            role="listitem"
            className="lane-chip chat-interactive"
            style={{ "--lane-color": color } as CSSProperties}
            title={title}
            onClick={() => document.getElementById(`lane-${lane.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
          >
            <Bot className="size-3 shrink-0" style={{ color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{lane.label || "Lane"}</span>
            {waiting && <span className="text-2xs text-[color:var(--s-warn)]">waiting</span>}
            <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">{tools}{budget ? `/${budget.maxToolRounds}` : ""}</span>
            <span className="lane-chip-bar" aria-hidden>
              <i style={{ width: `${used * 100}%`, background: used >= 0.85 ? "var(--s-warn)" : color }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
