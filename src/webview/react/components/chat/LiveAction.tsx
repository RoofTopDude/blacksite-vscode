import { type CSSProperties } from "react";
import { formatDuration } from "@/lib/format";
import { toolActivityKind, toolIntentPhrase } from "@/lib/tool-presentation";
import { currentActionOf, toolCallLiveElapsedMs, type Turn } from "@/lib/chat-model";
import { agentLaneColor, cssColor } from "@/lib/graph/colors";
import { useLiveClock } from "@/lib/use-live-clock";
import { ToolIcon } from "./ToolLog";

/** Accent color per activity flavor. Mutating work (writes/edits/deletes) glows
 *  the brand violet so the panel visibly reacts when the agent is changing your
 *  files; running work is warm; reads stay a calm blue. */
const KIND_COLOR: Record<ReturnType<typeof toolActivityKind>, string> = {
  mutate: "var(--primary)",
  run: "var(--s-warn)",
  read: "var(--s-info)",
};

/**
 * A single, deliberate "here's what I'm doing right now" line for a streaming
 * turn — the agent's live pulse, distilled from the newest in-flight tool call's
 * intent (verb + target). Calm by design: one row, present tense, a soft breathing
 * dot, a quietly ticking duration. The in-thread ToolLog remains the deep record;
 * this is the glanceable surface above it. Renders nothing when idle.
 */
export function LiveAction({ turn }: { turn: Turn }) {
  const action = currentActionOf(turn);
  // Hook order is fixed: always call the clock, gate its ticking on liveness.
  const now = useLiveClock(action != null);
  if (!action) return null;

  const { call, laneLabel } = action;
  const kind = toolActivityKind(call.toolName);
  const accent = KIND_COLOR[kind];
  const { verb, target } = toolIntentPhrase(call.toolName, call.input);
  const elapsed = toolCallLiveElapsedMs(call, now);

  return (
    <div
      className="live-action fade-in flex items-center gap-2 px-2.5 py-1.5"
      style={{ "--activity-accent": accent } as CSSProperties}
    >
      <span className="live-action-sheen" aria-hidden />
      <span className="live-action-dot" />
      <ToolIcon toolName={call.toolName} />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: accent }}>{verb}</span>
        {target && <span className="truncate font-mono text-[10.5px] text-foreground/90">{target}</span>}
        {laneLabel && (
          <span
            className="ml-0.5 shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
            style={{ color: cssColor(agentLaneColor(action.laneId ?? "") ?? 0x8aa6c0), background: "rgba(255,255,255,0.05)" }}
          >
            {laneLabel}
          </span>
        )}
      </div>
      {elapsed != null && elapsed > 400 && (
        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground">{formatDuration(elapsed)}</span>
      )}
    </div>
  );
}
