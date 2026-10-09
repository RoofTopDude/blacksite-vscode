import { AlertOctagon, CornerDownRight, FlagTriangleRight, PauseCircle, StopCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { Turn } from "@/lib/chat-model";

/**
 * Why a turn exists when the user did not start it. An automatic turn used to appear with no
 * message above it, as if the agent had decided to carry on by itself; this says who decided
 * and why, in one line, where the user's own message would have been.
 */
export function Seam({ turn }: { turn: Turn }) {
  if (!turn.seam) return null;
  return (
    <div className="turn-seam" role="note" title={turn.seam}>
      <CornerDownRight className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{turn.seam}</span>
    </div>
  );
}

const HANDOFF_META: Record<string, { title: string; icon: typeof StopCircle; tone: string }> = {
  max_iterations: { title: "Stopped at the round limit", icon: FlagTriangleRight, tone: "var(--s-warn)" },
  paused: { title: "Paused", icon: PauseCircle, tone: "var(--muted-foreground)" },
  cancelled: { title: "Stopped", icon: StopCircle, tone: "var(--muted-foreground)" },
  error: { title: "Stopped on an error", icon: AlertOctagon, tone: "var(--s-err)" },
};

/**
 * Where a turn that stopped short got to, written by the harness from what it saw. The bare
 * "Limit" label told a user that something ended and nothing about how far it had come.
 */
export function HandoffCard({ turn }: { turn: Turn }) {
  const store = useStore();
  const handoff = turn.handoff;
  if (!handoff) return null;
  const meta = HANDOFF_META[handoff.reason] ?? HANDOFF_META.error!;
  const Icon = meta.icon;
  const latest = store.chat.turns[store.chat.turns.length - 1]?.id === turn.id;
  // A plan run has its own Resume; an ordinary chat offers to carry on in a sentence.
  const canContinue = latest && !store.chat.running && !store.planRun && (handoff.reason === "max_iterations" || handoff.reason === "error");
  return (
    <div className={cn("handoff-card reveal-in")} role="note" style={{ "--handoff-tone": meta.tone } as React.CSSProperties}>
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" style={{ color: meta.tone }} aria-hidden />
        <span className="text-sm font-semibold">{meta.title}</span>
      </div>
      <pre className="handoff-text">{handoff.text}</pre>
      {canContinue && (
        <div className="mt-1.5">
          <button
            type="button"
            className="chat-interactive rounded-md border border-border bg-white/[0.03] px-2 py-0.5 text-xs font-medium hover:border-primary/40"
            onClick={() => actions.sendMessage("Continue from where you stopped.", [])}
            title="Send “Continue from where you stopped.” The agent has been told where it got to."
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
