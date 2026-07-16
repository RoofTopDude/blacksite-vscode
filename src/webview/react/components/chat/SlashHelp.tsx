import { X } from "lucide-react";
import { actions } from "@/lib/store";
import { SLASH_COMMANDS, slashUsage } from "@/lib/slash-commands";

/** Dismissable reference card listing every slash command. Opened by `/help`. */
export function SlashHelp() {
  return (
    <div className="menu-pop absolute inset-x-2 bottom-full z-30 mb-1.5 rounded-lg border border-border bg-popover p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Slash commands</span>
        <button type="button" onClick={() => actions.toggleSlashHelp(false)} className="text-muted-foreground hover:text-foreground" title="Close">
          <X className="size-3" />
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {SLASH_COMMANDS.map((def) => (
          <div key={def.name} className="flex items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-white/5">
            <span className="shrink-0 font-mono text-sm font-medium text-primary">{slashUsage(def)}</span>
            <span className="truncate text-sm text-muted-foreground">{def.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
