import { useState } from "react";
import {
  Boxes, SlidersHorizontal, Zap, Layers, Wrench, Users, Binary, Eye, Gauge, BrainCircuit,
  DatabaseZap, ShieldCheck, CheckCircle2, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
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

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Boxes },
  { id: "generation", label: "Generation", icon: SlidersHorizontal },
  { id: "agent", label: "Agent", icon: Zap },
  { id: "subagent", label: "Subagents", icon: Users },
  { id: "context", label: "Context", icon: Layers },
  { id: "embedding", label: "Embedding", icon: Binary },
  { id: "vision", label: "Vision", icon: Eye },
  { id: "advanced", label: "Advanced", icon: Wrench },
];

function CapabilityTile({
  icon: Icon, label, value, detail, tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "ready" | "warn";
}) {
  return (
    <div className={cn(
      "flex min-w-0 gap-2 rounded-md border px-2 py-2",
      tone === "ready" ? "border-primary/25 bg-primary/10" : tone === "warn" ? "border-[color:var(--s-warn)]/30 bg-[color:var(--s-warn)]/10" : "border-border bg-white/[0.02]",
    )}>
      <div className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border",
        tone === "ready" ? "border-primary/30 bg-primary/15 text-primary" : tone === "warn" ? "border-[color:var(--s-warn)]/35 text-[color:var(--s-warn)]" : "border-border text-muted-foreground",
      )}>
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
        <div className="truncate text-[11.5px] font-semibold text-foreground">{value}</div>
        <div className="line-clamp-2 text-[9.5px] leading-snug text-muted-foreground">{detail}</div>
      </div>
    </div>
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
  const thinkingEnabled = !!ps.thinking?.enabled || ps.reasoningEffort === "high";
  const readySignals = [
    enabledToolCount >= Math.max(ALL_TOOL_NAMES.length - 2, 1),
    compressionEnabled,
    memoryEnabled,
    subagentConcurrent > 1,
    (store.settings.maxIterations ?? 40) >= 50,
  ].filter(Boolean).length;
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
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground">Settings</div>
            <div className="truncate text-[10px] text-muted-foreground">{readySignals}/5 deep-work systems ready</div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="xs" variant="outline" title="Tune for complex, multi-step work" onClick={() => applyPreset("deep")}>
              <BrainCircuit className="size-3" /> Deep
            </Button>
            <Button size="xs" variant="outline" title="Tune for shorter, cheaper loops" onClick={() => applyPreset("fast")}>
              <Gauge className="size-3" /> Fast
            </Button>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <CapabilityTile
            icon={BrainCircuit}
            label="Reasoning"
            value={thinkingEnabled ? "Expanded" : `${store.settings.maxIterations ?? 40} loops`}
            detail={thinkingEnabled ? "Thinking or high reasoning is enabled for harder tasks." : "Raise iterations or model reasoning for deeper work."}
            tone={(store.settings.maxIterations ?? 40) >= 50 || thinkingEnabled ? "ready" : "neutral"}
          />
          <CapabilityTile
            icon={ShieldCheck}
            label="Tools"
            value={`${enabledToolCount}/${ALL_TOOL_NAMES.length} enabled`}
            detail={disabledToolCount ? "Some capabilities are intentionally unavailable." : "Agent can use the full local toolset."}
            tone={disabledToolCount ? "warn" : "ready"}
          />
          <CapabilityTile
            icon={DatabaseZap}
            label="Recall"
            value={memoryEnabled ? "Memory on" : "Memory off"}
            detail={memoryEnabled ? `${store.memoryStats?.total ?? 0} indexed entries available.` : "Enable semantic recall for long-running projects."}
            tone={memoryEnabled ? "ready" : "neutral"}
          />
          <CapabilityTile
            icon={CheckCircle2}
            label="Context"
            value={compressionEnabled ? "Auto compact" : "Manual only"}
            detail={compressionEnabled ? `Compacts near ${store.settings.compression?.triggerPct ?? 60}% context usage.` : "Long sessions may need manual compaction."}
            tone={compressionEnabled ? "ready" : "neutral"}
          />
        </div>

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
        {tab === "vision" && <VisionFallbackPanel />}
        {tab === "advanced" && <AdvancedPanel />}
      </div>
    </div>
  );
}
