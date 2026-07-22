import { useState, type ReactNode } from "react";
import {
  AudioLines, Binary, Boxes, BrainCircuit, CheckCircle2, ChevronRight, DatabaseZap, Gauge,
  Layers, ShieldCheck, SlidersHorizontal, Users, Wrench, Zap, type LucideIcon,
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
import { MultimodalPanel } from "./MultimodalPanel";
import { AdvancedPanel } from "./AdvancedPanel";
import { SubagentPanel } from "./SubagentPanel";

type SectionId = "model" | "generation" | "agent" | "subagent" | "context" | "embedding" | "multimodal" | "advanced";
type WorkflowId = "run" | "agent" | "knowledge" | "system";

const SECTIONS: Record<SectionId, { label: string; description: string; icon: LucideIcon }> = {
  model: { label: "Model & provider", description: "Choose the provider, model, credentials, and routing.", icon: Boxes },
  generation: { label: "Generation", description: "Tune reasoning, output, and service behavior for a run.", icon: SlidersHorizontal },
  agent: { label: "Agent behavior", description: "Set autonomy, tool access, memory, and execution limits.", icon: Zap },
  subagent: { label: "Delegation", description: "Configure specialist profiles and concurrent subagent work.", icon: Users },
  context: { label: "Context management", description: "Control compaction and how long conversations stay useful.", icon: Layers },
  embedding: { label: "Memory index", description: "Manage semantic recall, embedding models, and index health.", icon: Binary },
  multimodal: { label: "Images & audio", description: "Set visual fallback and transcription behavior for attached media.", icon: AudioLines },
  advanced: { label: "Advanced", description: "Review diagnostics, API keys, and the most sensitive controls.", icon: Wrench },
};

const WORKFLOWS: Array<{ id: WorkflowId; label: string; description: string; icon: LucideIcon; sections: SectionId[] }> = [
  { id: "run", label: "Run setup", description: "Model and response quality", icon: Gauge, sections: ["model", "generation"] },
  { id: "agent", label: "Agent & delegation", description: "How work is performed", icon: Zap, sections: ["agent", "subagent"] },
  { id: "knowledge", label: "Context & memory", description: "What the agent can retain", icon: Layers, sections: ["context", "embedding"] },
  { id: "system", label: "Media & system", description: "Attachments, audio, and maintenance", icon: AudioLines, sections: ["multimodal", "advanced"] },
];

/** One neutral fact in the settings status strip. States are reported, not
 * scored — enabling more systems costs more, so nothing here implies that
 * "on" is better than "off". */
function StatusFact({ icon: Icon, value, detail }: { icon: LucideIcon; value: string; detail: string }) {
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

/** Keeps all settings panels mounted through their existing interfaces, while exposing
 * them as a focused workflow with one clearly active section instead of eight loose tabs. */
function SettingsSectionCard({
  section, summary, open, onOpen, children,
}: {
  section: SectionId;
  summary: string;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const detail = SECTIONS[section];
  const Icon = detail.icon;
  const contentId = `settings-section-${section}`;

  return (
    <section className={cn("settings-workflow-card", open && "is-open")}>
      <button
        type="button"
        className="settings-workflow-card-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onOpen}
      >
        <span className="settings-workflow-card-icon"><Icon className="size-4" /></span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-semibold text-foreground">{detail.label}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{open ? detail.description : summary}</span>
        </span>
        <ChevronRight className={cn("disclosure size-4 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </button>
      {open && <div id={contentId} className="settings-workflow-card-body reveal-in">{children}</div>}
    </section>
  );
}

export function SettingsView() {
  const store = useStore();
  const [workflow, setWorkflow] = useState<WorkflowId>("run");
  const [openSection, setOpenSection] = useState<SectionId>("model");

  const ps = currentProviderSettings(store.settings);
  const subProvider = store.settings.subagent?.provider;
  const userProfileCount = (store.settings.subagent?.profiles ?? []).filter((profile) => !profile.builtin).length;
  const disabledToolCount = store.settings.disabledTools.length;
  const enabledToolCount = Math.max(ALL_TOOL_NAMES.length - disabledToolCount, 0);
  const compressionEnabled = !!store.settings.compression?.enabled;
  const memoryEnabled = !!store.settings.agentMemory?.enabled;
  const subagentConcurrent = store.settings.subagent?.maxConcurrent ?? 4;
  const thinkingEnabled = !!ps.thinking?.enabled || ps.reasoningEffort === "high" || ps.reasoningEffort === "xhigh" || ps.reasoningEffort === "max";
  const activeWorkflow = WORKFLOWS.find((item) => item.id === workflow)!;

  const summaries: Record<SectionId, string> = {
    model: `${store.settings.provider} · ${ps.model ?? "choose a model"}`,
    generation: `temp ${(ps.temperature ?? 1).toFixed(2)} · ${thinkingEnabled ? "reasoning on" : "standard"}`,
    agent: `${store.settings.maxIterations ?? 40} iterations · ${disabledToolCount ? `${disabledToolCount} tools off` : "all tools"}`,
    subagent: subProvider ? `${subProvider} provider` : userProfileCount ? `${userProfileCount} custom profile${userProfileCount !== 1 ? "s" : ""}` : "4 builtin profiles",
    context: compressionEnabled ? `auto compact at ${store.settings.compression?.triggerPct ?? 60}%` : "manual compaction",
    embedding: memoryEnabled ? `${store.memoryStats?.total ?? 0} indexed entries` : "semantic memory off",
    multimodal: store.settings.audioTranscription?.enabled === false ? "audio transcription off" : store.settings.visionFallback?.model ? "vision fallback + audio" : "audio transcription ready",
    advanced: `${disabledToolCount || "no"} tools off · diagnostics and keys`,
  };

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

  function selectWorkflow(next: WorkflowId): void {
    const target = WORKFLOWS.find((item) => item.id === next)!;
    setWorkflow(next);
    setOpenSection(target.sections[0]!);
  }

  function renderPanel(section: SectionId): ReactNode {
    switch (section) {
      case "model": return <ModelPanel />;
      case "generation": return <GenerationPanel />;
      case "agent": return <AgentPanel />;
      case "subagent": return <SubagentPanel />;
      case "context": return <ContextPanel />;
      case "embedding": return <EmbeddingPanel />;
      case "multimodal": return <MultimodalPanel />;
      case "advanced": return <AdvancedPanel />;
    }
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

        <nav className="settings-nav settings-workflow-nav mt-2" role="tablist" aria-label="Settings workflows">
          <div className="settings-nav-items grid-cols-2">
            {WORKFLOWS.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === workflow;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  title={item.description}
                  onClick={() => selectWorkflow(item.id)}
                  className={cn("settings-nav-item", isActive && "is-active")}
                >
                  <Icon className="size-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-sm font-semibold text-foreground">{activeWorkflow.label}</span>
          <span className="truncate text-xs text-muted-foreground">· {activeWorkflow.description}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
        <div className="flex flex-col gap-2.5">
          {activeWorkflow.sections.map((section) => (
            <SettingsSectionCard
              key={section}
              section={section}
              summary={summaries[section]}
              open={openSection === section}
              onOpen={() => setOpenSection(section)}
            >
              {renderPanel(section)}
            </SettingsSectionCard>
          ))}
        </div>
      </div>
    </div>
  );
}
