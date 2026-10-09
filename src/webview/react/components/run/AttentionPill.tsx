import { Bell } from "lucide-react";
import { actions, useStore } from "@/lib/store";
import { RUN_STATE_META, runIsOver } from "@/lib/run-format";
import { LiveDot, StatusPill } from "@/components/chat/signal";

/**
 * The one thing the Header shows on every page: does anything need me, or is a run going.
 *
 * Approvals and questions live in the chat's action bar, which is invisible from History or
 * Settings. Without this, a user reading their history while the agent waits on an approval
 * would not know until they came back — which is the failure a long unattended run cannot
 * afford.
 */
export function AttentionPill() {
  const store = useStore();
  const needing = store.attention.filter((item) => item.severity === "needs_you" || item.severity === "error");
  const run = store.planRun && store.dismissedRunId !== store.planRun.id ? store.planRun : null;
  const title = needing.length
    ? needing.slice(0, 5).map((item) => item.title).join("\n")
    : run ? `${run.planTitle} — ${RUN_STATE_META[run.liveState].hint}` : "";

  if (needing.length > 0) {
    return (
      <button type="button" onClick={() => actions.setView("chat")} title={`${title}\nClick to go to the chat.`} className="chat-interactive">
        <StatusPill tone="warn" className="text-2xs live-breathe">
          <Bell className="size-2.5" />
          {needing.length === 1 ? "Needs you" : `${needing.length} need you`}
        </StatusPill>
      </button>
    );
  }
  if (run && !runIsOver(run)) {
    const meta = RUN_STATE_META[run.liveState];
    return (
      <button type="button" onClick={() => actions.setView("chat")} title={`${title}\nClick to go to the chat.`} className="chat-interactive">
        <StatusPill tone={meta.tone} className="text-2xs">
          {run.liveState === "working" && <LiveDot tone={meta.tone} />}
          {run.stepsTotal ? `${run.stepPosition}/${run.stepsTotal}` : meta.label}
        </StatusPill>
      </button>
    );
  }
  return null;
}
