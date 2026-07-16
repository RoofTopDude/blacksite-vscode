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
import { acceptsSamplingParams, resolveEffort, resolveThinkingMode, supportedEfforts } from "../../../../thinking-modes.js";

const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max",
};

const SERVICE_TIERS: Array<{ id: ServiceTier; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "default", label: "Standard" },
  { id: "flex", label: "Flex" },
  { id: "priority", label: "Priority" },
];

// Shown dynamically below the segmented control for whichever tier is currently selected —
// one accurate, focused sentence instead of a static paragraph describing all four at once.
const SERVICE_TIER_HINTS: Record<ServiceTier, string> = {
  auto: "Sends no explicit tier — your account's default processing tier is used.",
  default: "Standard OpenAI rates and latency, the normal always-available tier.",
  flex: "Batch-API pricing (roughly half of Standard) in exchange for slower, queued responses and occasional capacity misses. Beta, with limited model availability — a turn automatically retries at Standard, just for that turn, if Flex capacity is unavailable or the model doesn't support it.",
  priority: "Faster, more consistent latency at a premium over Standard rates. A turn automatically retries at Standard, just for that turn, if priority capacity is unavailable or the model doesn't support it.",
};

export function GenerationPanel() {
  const store = useStore();
  const { settings } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const modelInfo = selectedModelInfo(settings, store.allModels);
  // OpenRouter carries the thinking setting via its unified `reasoning` parameter.
  const thinkingProvider = provider === "anthropic" || provider === "bedrock" || provider === "openrouter";
  const reasoning = isReasoningModel(ps.model);
  const thinking = ps.thinking || { enabled: false, budgetTokens: 10000, effort: "high" as const };

  // Which thinking dialect the selected model speaks decides what control to show: Claude 4.6+
  // replaced the fixed token budget with an effort rung and rejects `budget_tokens` outright, so
  // showing a token slider for those models would offer a setting that cannot be sent. Fall back
  // to the catalog's coarse flag only when the id isn't a Claude model we recognise.
  const thinkingMode = resolveThinkingMode(ps.model);
  const supportsThinking = thinkingMode !== "none"
    || (modelInfo ? !!modelInfo.supportsThinking : false);
  const efforts = supportedEfforts(ps.model);
  const noSampling = !acceptsSamplingParams(ps.model);

  return (
    <Section>
      <Field
        label="Temperature"
        hint={noSampling
          ? "This model doesn't accept temperature — Anthropic removed sampling parameters from Claude 4.7 / Sonnet 5 onward, so it is omitted from the request. Steer this model with prompting instead."
          : (provider === "anthropic" || provider === "bedrock")
          ? "Anthropic models accept 0–1; higher values are clamped to 1.00 at request time."
          : undefined}
      >
        <div className="flex items-center gap-3">
          <Slider
            min={0} max={2} step={0.05}
            value={[ps.temperature ?? 1]}
            disabled={noSampling}
            onValueChange={(v) => actions.setTemperature(provider, v[0] ?? 1)}
            className="flex-1 disabled:opacity-50"
          />
          <span className="w-9 text-right font-mono text-sm tabular-nums text-foreground">{(ps.temperature ?? 1).toFixed(2)}</span>
        </div>
      </Field>

      <Field
        label="Max Tokens"
        hint={ps.maxTokensUnlimited ? "Ignores the value above and requests the highest output budget the harness will ask for. A real provider ceiling still applies — there's no such thing as a literally unlimited response." : undefined}
      >
        <Input
          type="number" min={1} max={200000}
          value={ps.maxTokens ?? 8192}
          disabled={!!ps.maxTokensUnlimited}
          onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 1) actions.setMaxTokens(provider, n); }}
          className="h-7 w-28 text-sm disabled:opacity-50"
        />
        <Row label="Unlimited">
          <Switch checked={!!ps.maxTokensUnlimited} onCheckedChange={(c) => actions.setMaxTokensUnlimited(provider, c)} />
        </Row>
      </Field>

      {supportsThinking && thinkingProvider && (
        <Field
          label={thinkingMode === "adaptive" ? "Adaptive Thinking" : "Extended Thinking"}
          hint={thinkingMode === "adaptive"
            ? "This model decides how much to think per request. Effort sets the depth — there is no token budget to tune."
            : undefined}
        >
          <Row label={thinkingMode === "adaptive" ? "Enable adaptive thinking" : "Enable extended thinking"}>
            <Switch
              checked={thinking.enabled}
              onCheckedChange={(c) => actions.setThinking(provider, c, thinking.budgetTokens || 10000, thinking.effort)}
            />
          </Row>
          {thinking.enabled && thinkingMode === "budget" && (
            <div className="mt-1 flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Budget</span>
              <Slider
                min={1000} max={64000} step={1000}
                value={[thinking.budgetTokens || 10000]}
                onValueChange={(v) => actions.setThinking(provider, true, v[0] ?? 10000, thinking.effort)}
                className="flex-1"
              />
              <span className="w-9 text-right font-mono text-sm tabular-nums text-foreground">{fmtK(thinking.budgetTokens || 10000)}</span>
            </div>
          )}
        </Field>
      )}

      {/* Effort is its own control, not a sub-setting of the thinking toggle: it governs total token
          spend and how eagerly the model reaches for tools, so "thinking off + low effort" is a
          legitimate cheap/fast configuration that Anthropic documents. OpenRouter is excluded — its
          unified reasoning param can only carry an effort by *enabling* reasoning. */}
      {efforts.length > 0 && (provider === "anthropic" || provider === "bedrock") && (
        <Field
          label="Effort"
          hint="How much work the model puts into a turn — thinking depth, token spend, and tool-calling eagerness. Applies whether or not thinking is on."
        >
          <Segmented
            options={efforts.map((id) => ({ id, label: CLAUDE_EFFORT_LABELS[id] ?? id }))}
            value={resolveEffort(ps.model, thinking.effort) ?? "high"}
            onChange={(id) => actions.setThinking(provider, thinking.enabled, thinking.budgetTokens || 10000, id)}
          />
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
          hint={SERVICE_TIER_HINTS[ps.serviceTier || "auto"]}
        >
          <Segmented options={SERVICE_TIERS} value={ps.serviceTier || "auto"} onChange={(id) => actions.setServiceTier(provider, id)} />
        </Field>
      )}
    </Section>
  );
}
