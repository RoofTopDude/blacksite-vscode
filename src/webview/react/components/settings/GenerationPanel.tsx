import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { actions, useStore } from "@/lib/store";
import { Field, Row, Section, Segmented } from "./common";
import { currentProviderSettings, fmtK, isReasoningModel, selectedModelInfo } from "./helpers";

const EFFORTS: Array<{ id: "low" | "medium" | "high"; label: string }> = [
  { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" },
];

export function GenerationPanel() {
  const store = useStore();
  const { settings } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const modelInfo = selectedModelInfo(settings, store.allModels);
  const supportsThinking = modelInfo ? !!modelInfo.supportsThinking : (provider === "anthropic" || provider === "bedrock");
  const thinkingProvider = provider === "anthropic" || provider === "bedrock";
  const reasoning = isReasoningModel(ps.model);
  const thinking = ps.thinking || { enabled: false, budgetTokens: 10000 };

  return (
    <Section>
      <Field label="Temperature">
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
        <Field label="Reasoning Effort">
          <Segmented options={EFFORTS} value={ps.reasoningEffort || "medium"} onChange={(id) => actions.setReasoningEffort(provider, id)} />
        </Field>
      )}
    </Section>
  );
}
