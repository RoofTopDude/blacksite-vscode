import type { ExtendedSettings, ModelInfo, ProviderName, ProviderSettings } from "@/lib/protocol";

export const PROVIDER_DEFAULTS: Record<ProviderName, ProviderSettings> = {
  anthropic: { model: "claude-sonnet-4-6", temperature: 1.0, maxTokens: 8192, thinking: { enabled: false, budgetTokens: 10000 } },
  openrouter: { model: "anthropic/claude-sonnet-4-6", temperature: 1.0, maxTokens: 8192 },
  openai: { model: "gpt-4o", temperature: 1.0, maxTokens: 8192, reasoningEffort: "medium" },
};

export const PROVIDER_TABS: Array<{ id: ProviderName; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
];

export const KEY_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai", label: "OpenAI" },
  { id: "github", label: "GitHub PAT" },
  { id: "gitlab", label: "GitLab PAT" },
  { id: "jira", label: "Jira (email:token)" },
  { id: "confluence", label: "Confluence (email:token)" },
  { id: "salesforce", label: "Salesforce" },
];

export function currentProviderSettings(settings: ExtendedSettings): ProviderSettings {
  const provider = settings.provider || "anthropic";
  return { ...PROVIDER_DEFAULTS[provider], ...(settings.providerSettings?.[provider] || {}) };
}

export function isReasoningModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return /^o[134]/.test(id) || /^openai\/o/.test(id) || id.startsWith("gpt-5");
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
