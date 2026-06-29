import { History, Sparkles, Info, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";

export function Header() {
  const store = useStore();
  const iconBtn = "inline-flex size-7 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-white/[0.07] hover:text-foreground";

  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-border bg-gradient-to-b from-white/[0.035] to-white/[0.01] px-2.5 py-1.5">
      <button type="button" onClick={() => actions.setView("chat")} className="flex min-h-[28px] flex-1 items-center text-[12.5px] font-bold tracking-tight brand-text" title="Back to chat">
        ◈ Blacksite
      </button>
      <button type="button" className={cn(iconBtn, store.view === "history" && "text-primary")} title="Conversation history" onClick={() => actions.setView("history")}>
        <History className="size-4" />
      </button>
      <button type="button" className={iconBtn} title="New conversation" onClick={() => actions.newChat()}>
        <Sparkles className="size-4" />
      </button>
      <button type="button" className={cn(iconBtn, store.inspectorOpen && "text-primary")} title="Conversation inspector" onClick={() => actions.toggleInspector()}>
        <Info className="size-4" />
      </button>
      <button type="button" className={cn(iconBtn, store.view === "settings" && "text-primary")} title="Settings" onClick={() => actions.setView(store.view === "settings" ? "chat" : "settings")}>
        <Settings className="size-4" />
      </button>
    </header>
  );
}
