import { RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ServiceTier } from "@/lib/protocol";
import { supportedSamplingParameters } from "../../../../sampling-parameters.js";
import { Field, Row, Section, Segmented } from "./common";
import {
  EFFORT_LABELS, OPENROUTER_EFFORTS, currentProviderSettings, effectiveOpenRouterEffort,
  effectiveReasoningEffort, fmtK, isOpenRouterReasoningModel, isReasoningModel,
  selectedModelInfo, supportedReasoningEfforts,
} from "./helpers";
import type { ReasoningEffort } from "@/lib/protocol";
import {
  acceptsSamplingParams, recommendsRefusalFallback, resolveEffort, resolveThinkingMode, supportedEfforts,
  supportsFastMode, supportsTaskBudget,
} from "../../../../thinking-modes.js";

const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max",
};

// "priority" is OpenAI's pre-July-2026 name for Fast mode and is still accepted on the wire, so
// it stays in the type for settings persisted before the rename — it just isn't offered here.
const SERVICE_TIERS: Array<{ id: ServiceTier; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "default", label: "Standard" },
  { id: "flex", label: "Flex" },
  { id: "fast", label: "Fast" },
];

// Shown dynamically below the segmented control for whichever tier is currently selected —
// one accurate, focused sentence instead of a static paragraph describing all four at once.
const SERVICE_TIER_HINTS: Record<ServiceTier, string> = {
  auto: "Sends no explicit tier — your account's default processing tier is used.",
  default: "Standard OpenAI rates and latency, the normal always-available tier.",
  flex: "Batch-API pricing (half of Standard) in exchange for slower, queued responses and occasional capacity misses. Beta, with limited model availability — a turn automatically retries at Standard, just for that turn, if Flex capacity is unavailable or the model doesn't support it. Cost is always reported at whichever tier actually served the turn.",
  fast: "Up to 2.5x Standard speed at double the rates. A turn automatically retries at Standard, just for that turn, if Fast capacity is unavailable or the model doesn't support it.",
  priority: "The former name for Fast mode; OpenAI now routes it there. Behaves identically to Fast — reselect Fast to update the stored setting.",
};

/**
 * Sampling controls beyond temperature, for whichever ones the selected model accepts.
 *
 * The set is per-model, not per-provider — OpenRouter publishes it per routed model, and it
 * varies widely (a Kimi / DeepSeek / GLM row exposes several that a Claude row does not).
 * Reading it from the catalog is what makes those models fully configurable here instead of
 * being limited to the lowest common denominator, and equally what keeps a control the model
 * would reject from being offered at all.
 *
 * Each control is unset by default, deliberately: an unset value leaves the model's own
 * default in charge, which is not the same as pinning it to a neutral number. That is why
 * every row has an explicit Clear rather than a "reset to default" position on the slider.
 */
function SamplingControls() {
  const store = useStore();
  const { settings } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const modelInfo = selectedModelInfo(settings, store.allModels);
  const sampling = ps.sampling ?? {};

  // A model that takes no sampling parameters at all (Claude 4.7+/Sonnet 5) has nothing to
  // show here — Temperature above already explains why for that family.
  if (!acceptsSamplingParams(ps.model)) return null;
  const available = supportedSamplingParameters(modelInfo?.supportedParameters);
  if (!available.length) return null;

  return (
    <>
      {available.map((spec) => {
        const value = sampling[spec.key];
        const isSet = value !== undefined;
        return (
          <Field key={spec.key} label={spec.label} hint={spec.description}>
            <div className="flex items-center gap-3">
              <Slider
                min={spec.min} max={spec.max} step={spec.step}
                // An unset control still needs a thumb position: park it at the neutral value
                // where one exists, otherwise at the bottom of the range. Nothing is sent until
                // the user actually moves it.
                value={[value ?? spec.neutral ?? spec.min]}
                onValueChange={(v) => actions.setSampling(provider, spec.key, v[0] ?? spec.min)}
                className="flex-1"
              />
              <span
                className={cn(
                  "w-12 text-right font-mono text-sm tabular-nums",
                  isSet ? "text-foreground" : "text-muted-foreground/60",
                )}
              >
                {isSet ? (spec.step === 1 ? value : value.toFixed(2)) : "auto"}
              </span>
              <button
                type="button"
                onClick={() => actions.setSampling(provider, spec.key, null)}
                disabled={!isSet}
                title={`Clear ${spec.label} — use the model's own default`}
                className="chat-interactive shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <RotateCcw className="size-3" />
              </button>
            </div>
          </Field>
        );
      })}
    </>
  );
}

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
  // to the catalog's coarse flag only when the id isn't a Claude model we recognise — except on
  // OpenRouter, where the catalog flag is now accurate for non-Claude reasoning models (Gemini,
  // DeepSeek R1, …) whose reasoning is driven by the effort control below, not this toggle.
  const thinkingMode = resolveThinkingMode(ps.model);
  const supportsThinking = provider === "openrouter"
    ? thinkingMode !== "none"
    : thinkingMode !== "none" || (modelInfo ? !!modelInfo.supportsThinking : false);
  const orReasoning = provider === "openrouter" && isOpenRouterReasoningModel(ps.model, modelInfo);
  const efforts = supportedEfforts(ps.model);
  const noSampling = !acceptsSamplingParams(ps.model);
  const cacheProvider = provider === "anthropic" || provider === "bedrock" || provider === "openrouter";
  const fastModeEligible = provider === "anthropic" && supportsFastMode(ps.model);
  const taskBudgetEligible = provider === "anthropic" && supportsTaskBudget(ps.model);
  // Context editing and compaction speak the Messages API wire format verbatim, so they're
  // wired for Anthropic-direct and Bedrock Mantle only — NOT Bedrock Converse, which has no
  // request field for them. Gating on the provider tab alone (without bedrockApi) would show
  // the toggle while on Converse and have it silently do nothing.
  const isMantle = settings.bedrockApi === "mantle";
  const messagesApiSurface = provider === "anthropic" || (provider === "bedrock" && isMantle);
  const contextEditingProvider = messagesApiSurface;
  const compactionProvider = messagesApiSurface;
  const refusalFallbackEligible = provider === "anthropic" && recommendsRefusalFallback(ps.model);
  // Responses API benefit (reasoning continuity) only applies to actual reasoning models —
  // showing it for gpt-4o etc. would offer a toggle with no effect.
  const responsesApiEligible = provider === "openai" && isReasoningModel(ps.model);

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

      <SamplingControls />

      <Field
        label="Max Tokens"
        hint={ps.maxTokensUnlimited
          ? modelInfo?.maxOutputTokens
            ? `Uses this model's detected ${modelInfo.maxOutputTokens.toLocaleString()}-token output ceiling. Changing models recalculates it immediately; provider corrections are remembered per model.`
            : "No output ceiling was reported for this model, so Unlimited uses the safe 65,536-token fallback and learns any lower ceiling returned by the provider."
          : modelInfo?.maxOutputTokens
            ? `Requests above this model's detected ${modelInfo.maxOutputTokens.toLocaleString()}-token ceiling are clamped automatically.`
            : undefined}
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

      {orReasoning && (
        <Field
          label="Reasoning Effort"
          hint="Sent through OpenRouter's unified reasoning parameter to whatever the routed model natively supports (Gemini thinking, DeepSeek R1, GPT-5, …). Off sends nothing, leaving the routed model's default in charge."
        >
          <Segmented
            options={OPENROUTER_EFFORTS.map((id) => ({ id, label: id === "none" ? "Off" : EFFORT_LABELS[id].full }))}
            value={effectiveOpenRouterEffort(ps.reasoningEffort)}
            onChange={(id) => actions.setReasoningEffort(provider, id as ReasoningEffort)}
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

      {cacheProvider && (
        <Field
          label="Cache TTL"
          hint="How long a prompt-cache breakpoint stays warm. 1h costs a bigger write premium (2x vs 1.25x) but survives gaps in bursty traffic that would otherwise miss the 5-minute default."
        >
          <Segmented
            options={[{ id: "5m", label: "5 min" }, { id: "1h", label: "1 hour" }]}
            value={ps.cacheTtl === "1h" ? "1h" : "5m"}
            onChange={(id) => actions.setCacheTtl(provider, id as "5m" | "1h")}
          />
        </Field>
      )}

      {fastModeEligible && (
        <Field
          label="Fast Mode"
          hint="Beta. Runs this model at up to 2.5x higher output tokens/sec, at premium pricing. First-party Anthropic API only."
        >
          <Row label="Enable fast mode">
            <Switch checked={!!ps.fastMode} onCheckedChange={(c) => actions.setFastMode(provider, c)} />
          </Row>
        </Field>
      )}

      {taskBudgetEligible && (
        <Field
          label="Task Budget"
          hint="Beta. Gives the model a self-paced token ceiling for an agentic loop instead of an enforced per-response cut-off. Minimum 20,000 (clamped up). Blank disables it."
        >
          <Input
            type="number" min={0} step={1000}
            value={ps.taskBudgetTokens ?? ""}
            placeholder="Disabled"
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              actions.setTaskBudget(provider, isNaN(n) || n < 0 ? 0 : n);
            }}
            className="h-7 w-28 text-sm"
          />
        </Field>
      )}

      {contextEditingProvider && (
        <Field
          label="Context Editing"
          hint="Beta. Clears stale tool_use/tool_result content server-side before the model sees it, keeping the effective prompt lean without summarizing."
        >
          <Row label="Enable context editing">
            <Switch checked={!!ps.contextEditingEnabled} onCheckedChange={(c) => actions.setContextEditing(provider, c)} />
          </Row>
        </Field>
      )}

      {compactionProvider && (
        <Field
          label="Server-Side Compaction"
          hint={
            ps.compactionTriggerTokens
              ? "Beta. When input reaches this size, the API summarizes earlier history into the conversation itself and drops everything before it on future requests. Disables this session's own client-side auto-compaction — running both would double-summarize."
              : "Beta. When input reaches this size, the API summarizes earlier history into the conversation itself and drops everything before it on future requests. Blank disables it (minimum 50,000, clamped up)."
          }
        >
          <Input
            type="number" min={0} step={10000}
            value={ps.compactionTriggerTokens ?? ""}
            placeholder="Disabled"
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              actions.setCompaction(provider, isNaN(n) || n < 0 ? 0 : n);
            }}
            className="h-7 w-28 text-sm"
          />
        </Field>
      )}

      {refusalFallbackEligible && (
        <Field
          label="Refusal Fallback"
          hint="Beta. This model's safety classifiers may decline a request; on by default, this retries a declined turn on Anthropic's recommended substitute — chosen per refusal category — within the same request, instead of ending the run."
        >
          <Row label="Enable refusal fallback">
            <Switch checked={ps.refusalFallbackEnabled !== false} onCheckedChange={(c) => actions.setRefusalFallback(provider, c)} />
          </Row>
        </Field>
      )}

      {responsesApiEligible && (
        <Field
          label="Responses API"
          hint="Uses OpenAI's Responses API instead of Chat Completions. Preserves this model's internal reasoning state across tool-call round trips, instead of re-reasoning from scratch every turn — most valuable for multi-step tool-heavy tasks. No effect on non-reasoning models."
        >
          <Row label="Enable Responses API">
            <Switch checked={!!ps.useResponsesApi} onCheckedChange={(c) => actions.setResponsesApi(provider, c)} />
          </Row>
        </Field>
      )}
    </Section>
  );
}
