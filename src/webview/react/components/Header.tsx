import { Bug, GitBranchPlus, History, ScanSearch, Sparkles, Info, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { LiveDot } from "./chat/signal";
import type { ActiveRequestMode } from "@/lib/protocol";

const MODE_META = {
  general: { label: "Auto", icon: Sparkles },
  plan: { label: "Planning", icon: GitBranchPlus },
  review: { label: "Review", icon: ScanSearch },
  debug: { label: "Debug", icon: Bug },
} as const;

export function Header({ requestMode }: { requestMode: ActiveRequestMode }) {
  const store = useStore();
  const iconBtn = "chat-interactive inline-flex size-7 items-center justify-center rounded-lg border border-transparent text-muted-foreground hover:border-border hover:bg-white/[0.07] hover:text-foreground";
  const running = store.chat.running;
  const mode = MODE_META[requestMode];
  const ModeIcon = mode.icon;

  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-border bg-gradient-to-b from-white/[0.035] to-white/[0.01] px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => actions.setView("chat")}
        className="flex min-h-[28px] flex-1 items-center gap-1.5 text-lg font-bold tracking-tight"
        aria-label={running ? "Agent is running. Return to chat" : "Back to chat"}
        title={running ? "Blacksite — agent is running, click to view" : "Back to chat"}
      >
        <span className="brand-text">◈ Blacksite</span>
        {running && <LiveDot />}
        {store.view === "chat" && (
          <span className="request-mode-chip" title={`${mode.label} request profile`}>
            <ModeIcon className="size-2.5" />
            {mode.label}
          </span>
        )}
      </button>
      <button type="button" className={cn(iconBtn, store.view === "history" && "text-primary")} title="Conversation history" aria-label="Conversation history" aria-pressed={store.view === "history"} onClick={() => actions.setView("history")}>
        <History className="size-4" />
      </button>
      <button type="button" className={iconBtn} title="New conversation" aria-label="New conversation" onClick={() => actions.newChat()}>
        <Sparkles className="size-4" />
      </button>
      <button type="button" className={cn(iconBtn, store.inspectorOpen && "text-primary")} title="Conversation inspector" aria-label="Conversation inspector" aria-pressed={store.inspectorOpen} onClick={() => actions.toggleInspector()}>
        <Info className="size-4" />
      </button>
      <button type="button" className={cn(iconBtn, store.view === "settings" && "text-primary")} title="Settings" aria-label="Settings" aria-pressed={store.view === "settings"} onClick={() => actions.setView(store.view === "settings" ? "chat" : "settings")}>
        <Settings className="size-4" />
      </button>
    </header>
  );
}
