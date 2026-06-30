import { useState } from "react";
import { Boxes, SlidersHorizontal, Zap, Layers, Wrench, Users, Binary, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { currentProviderSettings } from "./helpers";
import { ModelPanel } from "./ModelPanel";
import { GenerationPanel } from "./GenerationPanel";
import { AgentPanel } from "./AgentPanel";
import { ContextPanel } from "./ContextPanel";
import { EmbeddingPanel } from "./EmbeddingPanel";
import { AdvancedPanel } from "./AdvancedPanel";
import { SubagentPanel } from "./SubagentPanel";

type TabId = "model" | "generation" | "agent" | "subagent" | "context" | "embedding" | "advanced";

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Boxes },
  { id: "generation", label: "Generation", icon: SlidersHorizontal },
  { id: "agent", label: "Agent", icon: Zap },
  { id: "subagent", label: "Subagents", icon: Users },
  { id: "context", label: "Context", icon: Layers },
  { id: "embedding", label: "Embedding", icon: Binary },
  { id: "advanced", label: "Advanced", icon: Wrench },
];

export function SettingsView() {
  const store = useStore();
  const [tab, setTab] = useState<TabId>("model");

  const ps = currentProviderSettings(store.settings);
  const subProvider = store.settings.subagent?.provider;
  const userProfileCount = (store.settings.subagent?.profiles ?? []).filter((p) => !p.builtin).length;
  const subtitle: Record<TabId, string> = {
    model: store.settings.provider,
    generation: `temp ${(ps.temperature ?? 1).toFixed(2)}`,
    agent: `${store.settings.maxIterations ?? 40} iterations`,
    subagent: subProvider ? `${subProvider} provider` : userProfileCount ? `${userProfileCount} custom profile${userProfileCount !== 1 ? "s" : ""}` : "4 builtin profiles",
    context: store.settings.compression?.enabled ? `On · ${store.settings.compression.triggerPct ?? 60}%` : "Off",
    embedding: store.settings.embedding?.model ?? "default",
    advanced: `${store.settings.disabledTools.length || "no"} tools off`,
  };
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-2.5 pt-2 pb-2">
        <div className="text-[13px] font-semibold text-foreground">Settings</div>
        <div className="mt-1.5 flex gap-1 rounded-lg border border-border bg-white/[0.02] p-0.5" role="tablist">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                title={t.label}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors",
                  isActive ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-foreground">{active.label}</span>
          <span className="truncate text-[10px] text-muted-foreground">· {subtitle[tab]}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {tab === "model" && <ModelPanel />}
        {tab === "generation" && <GenerationPanel />}
        {tab === "agent" && <AgentPanel />}
        {tab === "subagent" && <SubagentPanel />}
        {tab === "context" && <ContextPanel />}
        {tab === "embedding" && <EmbeddingPanel />}
        {tab === "advanced" && <AdvancedPanel />}
      </div>
    </div>
  );
}
