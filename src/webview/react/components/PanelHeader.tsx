import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared header row for full-panel views (History, Settings). One title /
 * subtitle / trailing-actions pattern so every secondary view opens with the
 * same visual voice as the chat's Overview strip. The parent owns the border
 * and padding wrapper so headers with extra chrome (settings nav) can extend
 * the same block.
 */
export function PanelHeader({ title, sub, actions, className }: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-2", className)}>
      <div className="min-w-0">
        <div className="text-lg font-semibold text-foreground">{title}</div>
        {sub != null && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
