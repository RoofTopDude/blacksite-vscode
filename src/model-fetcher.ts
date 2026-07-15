import https from "https";
import http from "http";
import type { ProviderName } from "./agent-session.js";
import { resolveContextWindow } from "./model-limits.js";
import { supportsThinking } from "./thinking-modes.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  inputPricePerM?: number;   // USD per 1M input tokens
  outputPricePerM?: number;  // USD per 1M output tokens
  /** USD per 1M cache-read tokens (a prompt-cache hit) — cheaper than fresh input on providers
      that report it. Currently only populated from OpenRouter's live pricing. */
  cacheReadPricePerM?: number;
  /** USD per 1M cache-write tokens (writing a new cache entry) — usually pricier than fresh
      input. Currently only populated from OpenRouter's live pricing. */
  cacheWritePricePerM?: number;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  source: "api" | "fallback";
}

/** The subset of ModelInfo cost-tracking actually needs. */
export type ModelPricing = Pick<ModelInfo, "inputPricePerM" | "outputPricePerM" | "cacheReadPricePerM" | "cacheWritePricePerM">;

// ── Bedrock Mantle (Messages API) static model list ────────────────────────────
// Mantle has no listing API; these are the documented model IDs.
export { BEDROCK_MANTLE_DEFAULT_MODEL } from "./bedrock-config.js";
export const BEDROCK_MANTLE_MODELS: ModelInfo[] = [
  { id: "anthropic.claude-fable-5",   name: "Claude Fable 5 (Mantle)",   contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-8",  name: "Claude Opus 4.8 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-7",  name: "Claude Opus 4.7 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-sonnet-5",  name: "Claude Sonnet 5 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5 (Mantle)", contextLength: 200_000,   supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
];

// ── Hardcoded fallbacks ────────────────────────────────────────────────────────
//
// Context windows must agree with resolveClaudeLimits (model-limits.ts) — this table is consulted
// first, so a wrong number here silently wins. Getting one wrong is not cosmetic: the old table
// said 200K for Opus 4.8, a 1M-window model, so compaction fired at roughly 12% of its real
// capacity and long runs shed history they had ample room for.

const FALLBACK_MODELS: Record<ProviderName, ModelInfo[]> = {
  anthropic: [
    { id: "claude-opus-4-8",              name: "Claude Opus 4.8",       contextLength: 1_000_000, inputPricePerM: 5,  outputPricePerM: 25,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-opus-4-7",              name: "Claude Opus 4.7",       contextLength: 1_000_000, inputPricePerM: 5,  outputPricePerM: 25,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-5",              name: "Claude Sonnet 5",       contextLength: 1_000_000, inputPricePerM: 3,  outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6",     contextLength: 1_000_000, inputPricePerM: 3,  outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-fable-5",               name: "Claude Fable 5",        contextLength: 1_000_000, inputPricePerM: 10, outputPricePerM: 50,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-haiku-4-5",             name: "Claude Haiku 4.5",      contextLength: 200_000,   inputPricePerM: 1,  outputPricePerM: 5,    supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-3-7-sonnet-20250219",   name: "Claude 3.7 Sonnet",     contextLength: 200_000,   inputPricePerM: 3,  outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4.8",    name: "Claude Opus 4.8 (OR)",   contextLength: 1_000_000, inputPricePerM: 5, outputPricePerM: 25,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-5",    name: "Claude Sonnet 5 (OR)",   contextLength: 1_000_000, inputPricePerM: 3, outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-4.6",  name: "Claude Sonnet 4.6 (OR)", contextLength: 1_000_000, inputPricePerM: 3, outputPricePerM: 15,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-4o",               name: "GPT-4o (OR)",            contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,   supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "google/gemini-2.5-pro",        name: "Gemini 2.5 Pro (OR)",   contextLength: 1048576,inputPricePerM: 1.25, outputPricePerM: 10,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/o3-mini",              name: "o3-mini (OR)",           contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4,  supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
  ],
  openai: [
    { id: "gpt-4o",        name: "GPT-4o",        contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,  supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-4o-mini",   name: "GPT-4o mini",   contextLength: 128000, inputPricePerM: 0.15, outputPricePerM: 0.60,supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3",            name: "o3",             contextLength: 200000, inputPricePerM: 10,   outputPricePerM: 40,  supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3-mini",       name: "o3-mini",        contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4, supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
    { id: "o1",            name: "o1",             contextLength: 200000, inputPricePerM: 15,   outputPricePerM: 60,  supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o1-mini",       name: "o1-mini",        contextLength: 128000, inputPricePerM: 1.1,  outputPricePerM: 4.4, supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
  ],
  // Best-effort offline fallback only — the live ListFoundationModels +
  // ListInferenceProfiles call (bedrock-models.ts) is authoritative and returns
  // the exact IDs for the caller's region. These are US cross-region inference
  // profiles in the Converse format (us.anthropic.<dated-snapshot>-vN:0).
  // Opus 4.6 / 4.7 / 4.8 and Sonnet 4.6 are intentionally omitted: their Bedrock
  // inference-profile IDs are not published as static dated snapshots and the
  // version suffix isn't derivable, so they're surfaced via live listing rather
  // than a guessed ID that would 404. Add them here verbatim if you pin specific
  // IDs from the live picker / AWS console.
  bedrock: [
    { id: "us.anthropic.claude-opus-4-5-20251101-v1:0",   name: "Claude Opus 4.5 (Bedrock)",   contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (Bedrock)", contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",  name: "Claude Haiku 4.5 (Bedrock)",  contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-1-20250805-v1:0",   name: "Claude Opus 4.1 (Bedrock)",   contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-20250514-v1:0",     name: "Claude Opus 4 (Bedrock)",     contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-20250514-v1:0",   name: "Claude Sonnet 4 (Bedrock)",   contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", name: "Claude 3.7 Sonnet (Bedrock)", contextLength: 200000, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", name: "Claude 3.5 Sonnet (Bedrock)", contextLength: 200000, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",  name: "Claude 3.5 Haiku (Bedrock)",  contextLength: 200000, supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
  ],
};

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new Error(`Bad URL: ${url}`)); return; }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// ── Thinking detection ─────────────────────────────────────────────────────────

function detectsThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Claude: delegate to the shared table so the picker's badge can never disagree with whether the
  // request layer will actually enable thinking. The old substring rules here missed Sonnet 5 and
  // Fable 5 entirely (no "-4" in the id) and wrongly excluded Haiku 4.5.
  if (supportsThinking(id)) return true;
  // OpenAI reasoning models (o-series + GPT-5 family)
  if (/^(anthropic\/)?o[13]/.test(id) || id.startsWith("o1") || id.startsWith("o3")) return true;
  if (id.startsWith("gpt-5") || id.startsWith("openai/gpt-5")) return true;
  // OpenRouter-prefixed
  if (id.startsWith("openai/o")) return true;
  return false;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`Anthropic /v1/models returned ${status}`);
  // The Models API reports the context window as `max_input_tokens`. Reading it beats inferring
  // from the id — a model released after this build still gets its true window, and the window is
  // what the compaction trigger divides by. resolveContextWindow covers older API responses that
  // don't carry the field.
  const data = (JSON.parse(body) as {
    data?: Array<{ id: string; display_name?: string; max_input_tokens?: number }>;
  }).data ?? [];
  return data.map((m) => ({
    id: m.id,
    name: m.display_name ?? m.id,
    contextLength: m.max_input_tokens ?? resolveContextWindow(m.id),
    supportsThinking: detectsThinking(m.id),
    supportsVision: true,
    supportsTools: true,
    source: "api" as const,
  }));
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

async function fetchOpenRouter(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://openrouter.ai/api/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`OpenRouter /api/v1/models returned ${status}`);
  const data = (JSON.parse(body) as {
    data?: Array<{
      id: string; name?: string; context_length?: number;
      pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
    }>
  }).data ?? [];

  // Per-token USD strings -> USD per 1M tokens, rounded to a sane display precision.
  const perM = (perToken: string | undefined): number | undefined => {
    const usd = perToken ? parseFloat(perToken) * 1_000_000 : undefined;
    return usd ? Math.round(usd * 100) / 100 : undefined;
  };

  return data
    .filter((m) => Boolean(m.id)) // include free tier models too
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length,
      inputPricePerM: perM(m.pricing?.prompt),
      outputPricePerM: perM(m.pricing?.completion),
      // Only models that support prompt caching (mainly Anthropic routes) report these —
      // absent for most others, which is fine: estimateUsageCostUsd treats missing cache
      // pricing as "unpriced" rather than free or full-input-price.
      cacheReadPricePerM: perM(m.pricing?.input_cache_read),
      cacheWritePricePerM: perM(m.pricing?.input_cache_write),
      supportsThinking: detectsThinking(m.id),
      supportsVision: true,
      supportsTools: true,
      source: "api" as const,
    }));
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

// Pricing/context hardcoded since /v1/models doesn't return it
const OPENAI_META: Record<string, { ctx: number; inp: number; out: number }> = {
  "gpt-4o":                 { ctx: 128000,  inp: 2.50,  out: 10.00 },
  "gpt-4o-mini":            { ctx: 128000,  inp: 0.15,  out: 0.60  },
  "gpt-4-turbo":            { ctx: 128000,  inp: 10.00, out: 30.00 },
  "gpt-4":                  { ctx: 8192,    inp: 30.00, out: 60.00 },
  "gpt-3.5-turbo":          { ctx: 16385,   inp: 0.50,  out: 1.50  },
  "o1":                     { ctx: 200000,  inp: 15.00, out: 60.00 },
  "o1-mini":                { ctx: 128000,  inp: 1.10,  out: 4.40  },
  "o1-preview":             { ctx: 128000,  inp: 15.00, out: 60.00 },
  "o3":                     { ctx: 200000,  inp: 10.00, out: 40.00 },
  "o3-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40  },
  "o4-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40  },
};

const CHAT_MODEL_RE = /^(gpt-[45]|gpt-3\.5-turbo|o[134])/;

async function fetchOpenAI(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://api.openai.com/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`OpenAI /v1/models returned ${status}`);
  const data = (JSON.parse(body) as { data?: Array<{ id: string }> }).data ?? [];
  return data
    .filter((m) => CHAT_MODEL_RE.test(m.id) && !m.id.includes("instruct") && !m.id.includes("audio"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const meta = OPENAI_META[m.id];
      return {
        id: m.id,
        name: m.id,
        contextLength:    meta?.ctx,
        inputPricePerM:   meta?.inp,
        outputPricePerM:  meta?.out,
        supportsThinking: detectsThinking(m.id),
        supportsVision:   m.id.includes("4o") || m.id.startsWith("o") || m.id.startsWith("gpt-5") || m.id.includes("vision"),
        supportsTools:    true,
        source: "api" as const,
      };
    });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fetchModels(provider: ProviderName, apiKey: string): Promise<ModelInfo[]> {
  switch (provider) {
    case "anthropic":  return fetchAnthropic(apiKey);
    case "openrouter": return fetchOpenRouter(apiKey);
    case "openai":     return fetchOpenAI(apiKey);
    default:           return FALLBACK_MODELS[provider] ?? [];
  }
}

export function getFallbackModels(provider: ProviderName): ModelInfo[] {
  return FALLBACK_MODELS[provider] ?? [];
}

/** Known per-token pricing for a provider/model, or undefined if unpriced (e.g. Bedrock, which
    publishes no pricing API, or an OpenRouter model id this build hasn't fetched live yet).
    Callers should prefer live-fetched pricing (a session's cached model catalog) and only fall
    back to this when nothing better is available — this mirrors getContextLength's own
    fallback-table-first strategy. */
export function getModelPricing(provider: ProviderName, modelId: string): ModelPricing | undefined {
  const fallback = FALLBACK_MODELS[provider]?.find((m) => m.id === modelId);
  if (fallback?.inputPricePerM != null || fallback?.outputPricePerM != null) return fallback;

  if (provider === "openai") {
    const meta = OPENAI_META[modelId];
    if (meta) return { inputPricePerM: meta.inp, outputPricePerM: meta.out };
  }

  return undefined;
}

export interface UsageTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface UsageCostEstimate {
  costUsd: number;
  /** True when some billed token category (usually cache read/write) had no known price and
      was left out of costUsd — so the real spend is at least this much, possibly more. Never
      guesses a price for an unpriced category (e.g. by reusing the input rate for cache
      tokens), since cache tokens are typically priced well below fresh input and doing so
      would inflate the estimate rather than merely under-count it. */
  partial: boolean;
}

/** Estimate USD spend for one usage event. Returns undefined when the model has no known
    pricing at all, so callers can distinguish "$0 spent" from "cost unknown". */
export function estimateUsageCostUsd(pricing: ModelPricing | undefined, tokens: UsageTokens): UsageCostEstimate | undefined {
  if (!pricing || (pricing.inputPricePerM == null && pricing.outputPricePerM == null)) return undefined;
  let costUsd = 0;
  let partial = false;
  const bill = (count: number | undefined, pricePerM: number | undefined): void => {
    if (!count) return;
    if (pricePerM == null) { partial = true; return; }
    costUsd += (count / 1_000_000) * pricePerM;
  };
  bill(tokens.input, pricing.inputPricePerM);
  bill(tokens.output, pricing.outputPricePerM);
  bill(tokens.cacheRead, pricing.cacheReadPricePerM);
  bill(tokens.cacheWrite, pricing.cacheWritePricePerM);
  return { costUsd, partial };
}

/** Returns the context window size (tokens) for a given provider/model, or undefined if unknown. */
export function getContextLength(provider: ProviderName, modelId: string): number | undefined {
  // Check fallback table first (has accurate context lengths)
  const fallback = FALLBACK_MODELS[provider]?.find((m) => m.id === modelId);
  if (fallback?.contextLength) return fallback.contextLength;

  // OpenAI: use hardcoded meta table
  if (provider === "openai") {
    const meta = OPENAI_META[modelId];
    if (meta?.ctx) return meta.ctx;
  }

  // Mantle model IDs (anthropic.claude-*) — check the static list first
  const mantleModel = BEDROCK_MANTLE_MODELS.find((m) => m.id === modelId);
  if (mantleModel?.contextLength) return mantleModel.contextLength;

  // Claude: derive from the model's version rather than the old flat 200K assumption. Every current
  // Claude model has a 1M window, and under-reporting it makes compaction fire at a fraction of the
  // real capacity — the trigger divides by this number.
  const claudeWindow = resolveContextWindow(modelId);
  if (claudeWindow) return claudeWindow;

  // Heuristic defaults for the remaining model families
  const id = modelId.toLowerCase();
  if (id.includes("gemini-2.5")) return 1_048_576;
  if (id.includes("gemini-2.0") || id.includes("gemini-1.5")) return 1_000_000;
  if (/^(openai\/)?o[134]/.test(id) || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return 200_000;
  if (id.includes("gpt-5")) return 400_000;
  if (id.includes("gpt-4o") || id.includes("gpt-4-turbo")) return 128_000;
  if (id.includes("gpt-4")) return 8_192;
  if (id.includes("gpt-3.5")) return 16_385;

  // Bedrock custom inference-profile ARNs (arn:aws:bedrock:...:application-inference-profile/xxxx)
  // don't carry a recognizable model name, so none of the substring heuristics above can match
  // them. This extension only targets Anthropic models on Bedrock, so default to Claude's
  // context window rather than leaving it undefined — which silently disables the auto-compression
  // trigger (agent-session.ts gates it on `this.opts.contextLength` being truthy).
  if (provider === "bedrock") return 200_000;

  return undefined;
}
