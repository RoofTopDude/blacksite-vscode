import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { actions, useStore } from "@/lib/store";
import type { ServiceTier } from "@/lib/protocol";
import { Field, Row, Section, Segmented } from "./common";
import {
  EFFORT_LABELS, currentProviderSettings, effectiveReasoningEffort, fmtK, isReasoningModel,
  selectedModelInfo, supportedReasoningEfforts,
} from "./helpers";

const SERVICE_TIERS: Array<{ id: ServiceTier; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "default", label: "Standard" },
  { id: "flex", label: "Flex" },
  { id: "priority", label: "Priority" },
];

export function GenerationPanel() {
  const store = useStore();
  const { settings } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const modelInfo = selectedModelInfo(settings, store.allModels);
  const supportsThinking = modelInfo ? !!modelInfo.supportsThinking : (provider === "anthropic" || provider === "bedrock");
  // OpenRouter carries the thinking budget via its unified `reasoning` parameter.
  const thinkingProvider = provider === "anthropic" || provider === "bedrock" || provider === "openrouter";
  const reasoning = isReasoningModel(ps.model);
  const thinking = ps.thinking || { enabled: false, budgetTokens: 10000 };

  return (
    <Section>
      <Field
        label="Temperature"
        hint={provider === "anthropic" || provider === "bedrock" ? "Anthropic models accept 0–1; higher values are clamped to 1.00 at request time." : undefined}
      >
        <div className="flex items-center gap-3">
          <Slider
            min={0} max={2} step={0.05}
            value={[ps.temperature ?? 1]}
            onValueChange={(v) => actions.setTemperature(provider, v[0] ?? 1)}
            className="flex-1"
          />
          <span className="w-9 text-right font-mono text-[11px] tabular-nums text-foreground">{(ps.temperature ?? 1).toFixed(2)}</span>
        </div>
      </Field>

      <Field label="Max Tokens">
        <Input
          type="number" min={1} max={200000}
          value={ps.maxTokens ?? 8192}
          onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1) actions.setMaxTokens(provider, n); }}
          className="h-7 w-28 text-[11px]"
        />
      </Field>

      {supportsThinking && thinkingProvider && (
        <Field label="Extended Thinking">
          <Row label="Enable extended thinking">
            <Switch checked={thinking.enabled} onCheckedChange={(c) => actions.setThinking(provider, c, thinking.budgetTokens || 10000)} />
          </Row>
          {thinking.enabled && (
            <div className="mt-1 flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground">Budget</span>
              <Slider
                min={1000} max={64000} step={1000}
                value={[thinking.budgetTokens || 10000]}
                onValueChange={(v) => actions.setThinking(provider, true, v[0] ?? 10000)}
                className="flex-1"
              />
              <span className="w-9 text-right font-mono text-[11px] tabular-nums text-foreground">{fmtK(thinking.budgetTokens || 10000)}</span>
            </div>
          )}
        </Field>
      )}

      {reasoning && provider === "openai" && (
        <Field
          label="Reasoning Effort"
          hint="Depth levels follow the selected model — newer GPT-5.x models add shallower (none/minimal) and deeper (x-high) rungs."
        >
          <Segmented
            options={supportedReasoningEfforts(ps.model).map((id) => ({ id, label: EFFORT_LABELS[id].full }))}
            value={effectiveReasoningEffort(ps.model, ps.reasoningEffort)}
            onChange={(id) => actions.setReasoningEffort(provider, id)}
          />
        </Field>
      )}

      {provider === "openai" && (
        <Field
          label="Service Tier"
          hint="Flex runs flagship models at reduced rates with queued, capacity-dependent latency (falls back to Standard for a turn when capacity is unavailable). Priority is faster at premium rates."
        >
          <Segmented options={SERVICE_TIERS} value={ps.serviceTier || "auto"} onChange={(id) => actions.setServiceTier(provider, id)} />
        </Field>
      )}
    </Section>
  );
}
