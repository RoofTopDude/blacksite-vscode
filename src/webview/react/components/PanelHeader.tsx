import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared header row for full-panel views (History, Settings). One title /
 * subtitle / trailing-actions pattern so every secondary view opens with the
 * same visual voice as the chat's Overview strip. The parent owns the border
 * and padding wrapper so headers with extra chrome (settings nav) can extend
 * the same block.
 */
export function PanelHeader({ title, sub, eyebrow, status, actions, className }: {
  title: string;
  sub?: ReactNode;
  eyebrow?: ReactNode;
  status?: { label: string; tone?: "idle" | "live" | "ok" | "warn"; pulse?: boolean };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-2", className)}>
      <div className="min-w-0">
        {eyebrow != null && <div className="eyebrow mb-0.5">{eyebrow}</div>}
        <div className="text-lg font-semibold text-foreground">{title}</div>
        {sub != null && <div className="text-xs leading-snug text-muted-foreground">{sub}</div>}
      </div>
      {(status != null || actions != null) && (
        <div className="flex shrink-0 items-center gap-1.5">
          {status != null && (
            <span className={cn("panel-presence", `is-${status.tone ?? "idle"}`)}>
              <span className={cn("panel-presence-dot", status.pulse && "signal-pulse")} aria-hidden="true" />
              {status.label}
            </span>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
