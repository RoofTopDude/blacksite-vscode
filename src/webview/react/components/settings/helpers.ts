import type { ExtendedSettings, ModelInfo, ProviderName, ProviderSettings, ReasoningEffort } from "@/lib/protocol";
import { defaultBedrockModel } from "../../../../bedrock-config.js";

export const PROVIDER_DEFAULTS: Record<ProviderName, ProviderSettings> = {
  anthropic: { model: "claude-sonnet-4-6", temperature: 1.0, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } },
  openrouter: { model: "anthropic/claude-sonnet-4-6", temperature: 1.0, maxTokens: 8192 },
  openai: { model: "gpt-4o", temperature: 1.0, maxTokens: 8192, reasoningEffort: "medium" },
  bedrock: { model: defaultBedrockModel("converse"), temperature: 1.0, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } },
};

export const PROVIDER_TABS: Array<{ id: ProviderName; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
  { id: "bedrock", label: "Bedrock" },
];

export const KEY_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
  { id: "bedrock", label: "AWS Bedrock" },
  { id: "github", label: "GitHub PAT" },
  { id: "gitlab", label: "GitLab PAT" },
  { id: "jira", label: "Jira (email:token)" },
  { id: "confluence", label: "Confluence (email:token)" },
  { id: "salesforce", label: "Salesforce" },
];

export function providerSettingsWithDefaults(settings: ExtendedSettings, provider: ProviderName): ProviderSettings {
  const base = provider === "bedrock"
    ? { ...PROVIDER_DEFAULTS.bedrock, model: defaultBedrockModel(settings.bedrockApi) }
    : PROVIDER_DEFAULTS[provider];
  const merged = { ...base, ...(settings.providerSettings?.[provider] || {}) };
  if (!merged.model?.trim()) merged.model = base.model;
  return merged;
}

export function currentProviderSettings(settings: ExtendedSettings): ProviderSettings {
  const provider = settings.provider || "anthropic";
  return providerSettingsWithDefaults(settings, provider);
}

export function isReasoningModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  if (/^o[134]/.test(id) || /^openai\/o/.test(id)) return true;
  // gpt-5 and everything after it is reasoning-native — match gpt-N, N ≥ 5.
  const m = /^gpt-(\d+)/.exec(id);
  return m !== null && Number(m[1]) >= 5;
}

/**
 * Reasoning-effort rungs the selected OpenAI model accepts — UI mirror of the host's
 * supportedReasoningEfforts (agent-session.ts); keep the two family tables in step.
 * Families newer than the table (gpt-5.2+, incl. 5.6, and future majors) get the full
 * ladder so new depth levels appear in the picker the day a model ships; the host clamps
 * at request time, so an over-permissive UI choice can never 400.
 */
export function supportedReasoningEfforts(modelId: string | undefined): ReasoningEffort[] {
  const id = (modelId ?? "").toLowerCase();
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (!gpt) return ["low", "medium", "high"]; // o-series and unknown reasoning models
  const major = Number(gpt[1]);
  const minor = gpt[2] ? Number(gpt[2]) : 0;
  if (major === 5 && minor === 0) return ["minimal", "low", "medium", "high"];
  if (major === 5 && minor === 1) {
    return id.includes("codex") && id.includes("max")
      ? ["none", "low", "medium", "high", "xhigh"]
      : ["none", "low", "medium", "high"];
  }
  return ["none", "minimal", "low", "medium", "high", "xhigh"];
}

export const EFFORT_LABELS: Record<ReasoningEffort, { full: string; chip: string }> = {
  none:    { full: "None",    chip: "Off" },
  minimal: { full: "Minimal", chip: "Min" },
  low:     { full: "Low",     chip: "Lo" },
  medium:  { full: "Medium",  chip: "Med" },
  high:    { full: "High",    chip: "Hi" },
  xhigh:   { full: "X-High",  chip: "XHi" },
};

/** Default rung when the persisted effort isn't supported by the selected model. */
export function effectiveReasoningEffort(modelId: string | undefined, effort: ReasoningEffort | undefined): ReasoningEffort {
  const supported = supportedReasoningEfforts(modelId);
  return effort && supported.includes(effort) ? effort : "medium";
}

export function fmtCtx(n: number | undefined): string {
  if (!n) return "";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export function fmtPrice(inp: number | undefined, out: number | undefined): string {
  if (inp == null || out == null) return "";
  const fmt = (v: number) => (v >= 1 ? `$${v}` : `$${v.toFixed(2).replace(/\.?0+$/, "")}`);
  return `${fmt(inp)}/${fmt(out)}`;
}

export function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export function selectedModelInfo(settings: ExtendedSettings, models: ModelInfo[]): ModelInfo | null {
  const ps = currentProviderSettings(settings);
  return models.find((m) => m.id === ps.model) || null;
}

/** Compact display label for a model id/info — drops the provider prefix and version tail. */
export function modelShortLabel(model: ModelInfo | string | undefined): string {
  if (!model) return "";
  const id = typeof model === "string" ? model : (model.name || model.id);
  if (!id) return "";
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Resolve a free-text query (e.g. from `/model sonnet`) to a concrete model.
 * Ranks exact id > exact name > id-prefix > substring on id or name. Returns null
 * when nothing plausibly matches so callers can decide whether to fall back to the
 * raw string as a literal model id.
 */
export function findModelByQuery(models: ModelInfo[], query: string): ModelInfo | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best: ModelInfo | null = null;
  let bestScore = 0;
  for (const m of models) {
    const id = m.id.toLowerCase();
    const name = (m.name ?? "").toLowerCase();
    let score = 0;
    if (id === q || name === q) score = 5;
    else if (id.startsWith(q) || name.startsWith(q)) score = 4;
    else if (id.endsWith(`/${q}`)) score = 3;
    else if (id.includes(q) || name.includes(q)) score = 2;
    if (score > bestScore || (score === bestScore && score > 0 && m.id.length < (best?.id.length ?? Infinity))) {
      best = m;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}
