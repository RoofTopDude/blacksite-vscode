import { useState } from "react";
import {
  Boxes, SlidersHorizontal, Zap, Layers, Wrench, Users, Binary, Eye, Gauge, BrainCircuit,
  DatabaseZap, ShieldCheck, CheckCircle2, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/PanelHeader";
import { ALL_TOOL_NAMES } from "@/lib/format";
import { currentProviderSettings } from "./helpers";
import { ModelPanel } from "./ModelPanel";
import { GenerationPanel } from "./GenerationPanel";
import { AgentPanel } from "./AgentPanel";
import { ContextPanel } from "./ContextPanel";
import { EmbeddingPanel } from "./EmbeddingPanel";
import { VisionFallbackPanel } from "./VisionFallbackPanel";
import { AdvancedPanel } from "./AdvancedPanel";
import { SubagentPanel } from "./SubagentPanel";

type TabId = "model" | "generation" | "agent" | "subagent" | "context" | "embedding" | "vision" | "advanced";
type TabGroupId = "run" | "context" | "system";

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon; group: TabGroupId }> = [
  { id: "model", label: "Model", icon: Boxes, group: "run" },
  { id: "generation", label: "Generation", icon: SlidersHorizontal, group: "run" },
  { id: "agent", label: "Agent", icon: Zap, group: "run" },
  { id: "subagent", label: "Subagents", icon: Users, group: "context" },
  { id: "context", label: "Context", icon: Layers, group: "context" },
  { id: "embedding", label: "Embedding", icon: Binary, group: "context" },
  { id: "vision", label: "Vision", icon: Eye, group: "system" },
  { id: "advanced", label: "Advanced", icon: Wrench, group: "system" },
];

const TAB_GROUPS: Array<{ id: TabGroupId; label: string; columns: string }> = [
  { id: "run", label: "Run", columns: "grid-cols-3" },
  { id: "context", label: "Context & collaboration", columns: "grid-cols-3" },
  { id: "system", label: "System", columns: "grid-cols-2" },
];

/** One neutral fact in the settings status strip. States are reported, not
 *  scored — enabling more systems costs more, so nothing here implies that
 *  "on" is better than "off". */
function StatusFact({ icon: Icon, value, detail }: {
  icon: LucideIcon;
  value: string;
  detail: string;
}) {
  return (
    <span
      title={detail}
      className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-white/[0.02] px-2 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Icon className="size-2.5 shrink-0" />
      <span className="truncate">{value}</span>
    </span>
  );
}

export function SettingsView() {
  const store = useStore();
  const [tab, setTab] = useState<TabId>("model");

  const ps = currentProviderSettings(store.settings);
  const subProvider = store.settings.subagent?.provider;
  const userProfileCount = (store.settings.subagent?.profiles ?? []).filter((p) => !p.builtin).length;
  const disabledToolCount = store.settings.disabledTools.length;
  const enabledToolCount = Math.max(ALL_TOOL_NAMES.length - disabledToolCount, 0);
  const compressionEnabled = !!store.settings.compression?.enabled;
  const memoryEnabled = !!store.settings.agentMemory?.enabled;
  const subagentConcurrent = store.settings.subagent?.maxConcurrent ?? 4;
  const thinkingEnabled = !!ps.thinking?.enabled || ps.reasoningEffort === "high" || ps.reasoningEffort === "xhigh" || ps.reasoningEffort === "max";
  const subtitle: Record<TabId, string> = {
    model: store.settings.provider,
    generation: `temp ${(ps.temperature ?? 1).toFixed(2)}`,
    agent: `${store.settings.maxIterations ?? 40} iterations`,
    subagent: subProvider ? `${subProvider} provider` : userProfileCount ? `${userProfileCount} custom profile${userProfileCount !== 1 ? "s" : ""}` : "4 builtin profiles",
    context: store.settings.compression?.enabled ? `On · ${store.settings.compression.triggerPct ?? 60}%` : "Off",
    embedding: store.settings.embedding?.model ?? "default",
    vision: store.settings.visionFallback?.model ? store.settings.visionFallback.model : "off",
    advanced: `${store.settings.disabledTools.length || "no"} tools off`,
  };
  const active = TABS.find((t) => t.id === tab)!;

  function applyPreset(kind: "deep" | "fast"): void {
    if (kind === "deep") {
      actions.setMaxIterations(Math.max(store.settings.maxIterations ?? 40, 80));
      actions.setCompression({
        enabled: true,
        triggerPct: store.settings.compression?.triggerPct ?? 60,
        keepRecent: store.settings.compression?.keepRecent ?? 20,
        provider: store.settings.compression?.provider ?? store.settings.provider,
        model: store.settings.compression?.model,
      });
      actions.setMemoryIndex(true);
      actions.setSubagentMaxConcurrent(Math.max(subagentConcurrent, 4));
      return;
    }
    actions.setMaxIterations(25);
    actions.setCompression({
      enabled: false,
      triggerPct: store.settings.compression?.triggerPct ?? 60,
      keepRecent: store.settings.compression?.keepRecent ?? 20,
      provider: store.settings.compression?.provider ?? store.settings.provider,
      model: store.settings.compression?.model,
    });
    actions.setSubagentMaxConcurrent(Math.min(subagentConcurrent, 2));
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-2.5 pt-2 pb-2">
        <PanelHeader
          title="Settings"
          sub={`${store.settings.provider} · ${ps.model}`}
          actions={(
            <>
              <Button size="xs" variant="outline" title="Preset: more iterations, auto compaction, memory, parallel subagents — tuned for complex multi-step work (uses more tokens)" onClick={() => applyPreset("deep")}>
                <BrainCircuit className="size-3" /> Deep
              </Button>
              <Button size="xs" variant="outline" title="Preset: fewer iterations, no auto compaction, less concurrency — tuned for shorter, cheaper loops" onClick={() => applyPreset("fast")}>
                <Gauge className="size-3" /> Fast
              </Button>
            </>
          )}
        />

        {/* Neutral one-line status strip — replaces the tile grid that scored
            these as "systems ready". Each fact is a trade-off, not a checkbox. */}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <StatusFact
            icon={BrainCircuit}
            value={thinkingEnabled ? "Thinking on" : `${store.settings.maxIterations ?? 40} iterations`}
            detail={thinkingEnabled ? "Extended thinking or high reasoning effort is enabled." : `Up to ${store.settings.maxIterations ?? 40} agent iterations per turn.`}
          />
          <StatusFact
            icon={ShieldCheck}
            value={disabledToolCount ? `${enabledToolCount}/${ALL_TOOL_NAMES.length} tools` : "All tools"}
            detail={disabledToolCount ? `${disabledToolCount} tools disabled in Advanced.` : "The agent can use the full local toolset."}
          />
          <StatusFact
            icon={DatabaseZap}
            value={memoryEnabled ? "Memory on" : "Memory off"}
            detail={memoryEnabled ? `Semantic recall with ${store.memoryStats?.total ?? 0} indexed entries.` : "Semantic recall across sessions is off."}
          />
          <StatusFact
            icon={CheckCircle2}
            value={compressionEnabled ? `Compact @ ${store.settings.compression?.triggerPct ?? 60}%` : "Manual compact"}
            detail={compressionEnabled ? `History compacts automatically near ${store.settings.compression?.triggerPct ?? 60}% context usage.` : "History only compacts when you trigger it."}
          />
        </div>

        <nav className="settings-nav mt-2" role="tablist" aria-label="Settings areas">
          {TAB_GROUPS.map((group) => (
            <div key={group.id} className="settings-nav-group" role="group" aria-label={group.label}>
              <div className="settings-nav-group-title">{group.label}</div>
              <div className={cn("settings-nav-items", group.columns)}>
                {TABS.filter((item) => item.group === group.id).map((item) => {
                  const Icon = item.icon;
                  const isActive = item.id === tab;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      title={item.label}
                      onClick={() => setTab(item.id)}
                      className={cn("settings-nav-item", isActive && "is-active")}
                    >
                      <Icon className="size-3.5" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-foreground">{active.label}</span>
          <span className="truncate text-xs text-muted-foreground">· {subtitle[tab]}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
        {/* key={tab} remounts the wrapper per tab so each panel rises in with the
            same reveal curve the chat's disclosures use — one motion language. */}
        <div key={tab} className="reveal-in">
          {tab === "model" && <ModelPanel />}
          {tab === "generation" && <GenerationPanel />}
          {tab === "agent" && <AgentPanel />}
          {tab === "subagent" && <SubagentPanel />}
          {tab === "context" && <ContextPanel />}
          {tab === "embedding" && <EmbeddingPanel />}
          {tab === "vision" && <VisionFallbackPanel />}
          {tab === "advanced" && <AdvancedPanel />}
        </div>
      </div>
    </div>
  );
}
