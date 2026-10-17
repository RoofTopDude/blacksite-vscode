import type { ProviderName } from "./types.js";
import { resolveContextWindow, resolveOutputCeiling } from "./model-limits.js";
import { parseClaudeVersion, stripBedrockProfilePrefix, supportsThinking } from "./thinking-modes.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** Maximum output accepted for this provider/model. Prefer live provider-catalog metadata;
   *  model-family metadata supplies providers whose listing API omits limits. AgentSession uses
   *  this value directly for request planning, so the picker and runtime share one ceiling. */
  maxOutputTokens?: number;
  inputPricePerM?: number;   // USD per 1M input tokens
  outputPricePerM?: number;  // USD per 1M output tokens
  /** USD per 1M cache-read tokens (a prompt-cache hit) — cheaper than fresh input on providers
      that report it. Populated from OpenRouter's live pricing and from the pinned OpenAI table. */
  cacheReadPricePerM?: number;
  /** USD per 1M cache-write tokens (writing a new cache entry) — usually pricier than fresh
      input. Populated from OpenRouter's live pricing and from the pinned OpenAI table; 0 on
      OpenAI models older than GPT-5.6, which write to cache for free. */
  cacheWritePricePerM?: number;
  /**
   * Rates that apply to the whole request once its prompt (input + cache reads + cache writes)
   * exceeds `aboveInputTokens`. Haiku 5.5 is priced this way; most models are not.
   */
  longContextPricing?: {
    aboveInputTokens: number;
    inputPricePerM?: number;
    outputPricePerM?: number;
    cacheReadPricePerM?: number;
    cacheWritePricePerM?: number;
  };
  supportsThinking?: boolean;
  supportsVision?: boolean;
  /** The provider catalog reports that this model accepts audio input directly. */
  supportsAudio?: boolean;
  supportsTools?: boolean;
  /** Request parameters the routed model accepts, verbatim from the provider catalog
   *  (OpenRouter's `supported_parameters`). Gates which sampling controls the settings UI
   *  offers and which are put on the wire — see sampling-parameters.ts. Undefined when the
   *  provider publishes no such list. */
  supportedParameters?: string[];
  /** Reasoning depths this model accepts, shallowest first, as its provider catalog reports them.
   *  Only ChatGPT sign-in fills it: there the catalog, not a model-name pattern, is the authority
   *  (Codex models start at "low" and never offer "none"). */
  reasoningEfforts?: string[];
  /** The depth the model runs at when the request names none. */
  defaultReasoningEffort?: string;
  /** Processing tiers offered above Standard, e.g. `{ id: "priority", name: "Fast" }`. */
  serviceTiers?: Array<{ id: string; name: string; description: string }>;
  source: "api" | "fallback";
}

/** The subset of ModelInfo cost-tracking actually needs. */
export type ModelPricing = Pick<ModelInfo, "inputPricePerM" | "outputPricePerM" | "cacheReadPricePerM" | "cacheWritePricePerM" | "longContextPricing">;

/**
 * Reduce a model id to its comparable core: strip a provider/prefix path (OpenRouter's
 * "anthropic/claude-sonnet-5", Bedrock Mantle's "anthropic.claude-opus-4-8") and any trailing
 * dated-snapshot or version suffix (":latest", "-20250219", "-2024-07-18", "-v1:0"). Used only
 * for fallback lookups (pricing/context) so a dated snapshot the static table doesn't have
 * verbatim (e.g. a new Bedrock inference-profile date stamp, or an OpenAI dash-dated snapshot)
 * can still match its undated or differently-dated sibling instead of returning "unknown".
 */
export function normalizeModelIdForFallbackLookup(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  // Bedrock Mantle's provider-namespace prefix only — NOT a generic "strip before the last dot"
  // rule, which would also eat the decimal version dot in ids like "gemini-2.5-pro" or "gpt-4.1".
  id = stripBedrockProfilePrefix(id).replace(/^anthropic\./, "");
  id = id.replace(/-v\d+:\d+$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/[-:]\d{8}$/, "").replace(/:.*/, "");
  return id;
}

/** True when two model ids plausibly name the same model once normalized — exact match first,
 *  then a normalized-id match, then a prefix match on the normalized form (so "gpt-5.1" matches
 *  a "gpt-5.1-preview" and vice versa).
 *
 *  The prefix never continues into a version number: "claude-opus-5-5" is not "claude-opus-5",
 *  and "gpt-5.6-sol" is not "gpt-5". Allowing that priced every point release at its
 *  predecessor's rate, which for Opus 5.5 overstated spend by a quarter. */
function modelIdFallbackMatches(candidateId: string, targetId: string): boolean {
  if (candidateId === targetId) return true;
  const a = normalizeModelIdForFallbackLookup(candidateId);
  const b = normalizeModelIdForFallbackLookup(targetId);
  if (a === b) return true;
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && !/^[-.]\d/.test(longer.slice(shorter.length));
}

// ── Claude pricing ─────────────────────────────────────────────────────────────

/** Per-MTok USD rates for one Claude model, as Anthropic's pricing page lists them. */
interface ClaudeRates {
  input: number;
  output: number;
  /** Cache hits. 0.1x input on most models, but 0.025x on Fable 5.1 / Mythos 5.1 and 0.05x on
   *  Opus 5.5 / Sonnet 5.5, so it is listed per model rather than derived. */
  cacheRead: number;
  /** 5-minute cache writes (1.25x input). The 1-hour rate is 2x input; `estimateUsageCostUsd`
   *  scales to it from the session's TTL, since the TTL is a per-request choice. */
  cacheWrite: number;
}

interface ClaudePriceEntry extends ClaudeRates {
  /** Rates for a request whose prompt (input + cache reads + cache writes) exceeds `aboveTokens`.
   *  The whole request is billed at them. Only Haiku 5.5 is priced by prompt length. */
  longContext?: ClaudeRates & { aboveTokens: number };
}

const OPUS_STANDARD: ClaudeRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const OPUS_LEGACY: ClaudeRates = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const SONNET_STANDARD: ClaudeRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const FABLE_5: ClaudeRates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const FABLE_5_1: ClaudeRates = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

/**
 * First-party list prices, keyed by canonical model id (see {@link canonicalClaudeModelId}). Every
 * route prices Claude from this one table: the Anthropic API, Bedrock (Mantle and Converse),
 * OpenRouter's offline fallback and Vertex. Before, each route had its own copy, and a model added
 * to one was unpriced on the others.
 *
 * Bedrock and Vertex bill through AWS and Google, which may differ. These are the published
 * Anthropic rates, used as the estimate. Bedrock's regional premium is applied by
 * {@link bedrockEndpointMultiplier}.
 */
const CLAUDE_PRICES: Readonly<Record<string, ClaudePriceEntry>> = {
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": OPUS_STANDARD,
  "claude-opus-4-8": OPUS_STANDARD,
  "claude-opus-4-7": OPUS_STANDARD,
  "claude-opus-4-6": OPUS_STANDARD,
  "claude-opus-4-5": OPUS_STANDARD,
  "claude-opus-4-1": OPUS_LEGACY,
  "claude-opus-4": OPUS_LEGACY,
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // $2/$10 was announced as introductory through 2026-08-31; Anthropic made it the standard price.
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": SONNET_STANDARD,
  "claude-sonnet-4-5": SONNET_STANDARD,
  "claude-sonnet-4": SONNET_STANDARD,
  "claude-3-7-sonnet": SONNET_STANDARD,
  "claude-3-5-sonnet": SONNET_STANDARD,
  "claude-haiku-5-5": {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/** Spellings that name the same model as a table key. */
const CLAUDE_ID_ALIASES: Readonly<Record<string, string>> = {
  "claude-opus-4-0": "claude-opus-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
};

/**
 * Any route's spelling of a Claude model id, reduced to the first-party id: Bedrock profile and
 * provider prefixes, `-v1:0` and dated snapshots, Vertex's `@date`, OpenRouter's `anthropic/`
 * path and dotted versions (`claude-opus-4.8`). Undefined for anything that is not Claude, and
 * for an ARN that does not name its model.
 */
export function canonicalClaudeModelId(modelId: string): string | undefined {
  let id = normalizeModelIdForFallbackLookup(modelId.replace(/@[^/]*$/, ""));
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  if (!id.startsWith("claude-")) return undefined;
  return CLAUDE_ID_ALIASES[id] ?? id;
}

/** Bedrock geographic cross-Region inference profiles. `global.` profiles carry no premium. */
const BEDROCK_GEO_PROFILE = /^(?:us|eu|apac|jp|au)\./i;

/** Bedrock's premium for regional and geographic endpoints over global ones, Claude 4.5 and later. */
export const BEDROCK_REGIONAL_PREMIUM = 1.1;

/**
 * The multiplier Bedrock applies to a Claude model's rates for the endpoint the id names. A
 * geographic profile (`us.`, `eu.`, `apac.`, `jp.`, `au.`) on Claude 4.5 or later costs 10% more
 * than global routing. Everything else is 1: `global.` profiles, older models, and bare ids,
 * whose routing (a Mantle endpoint or an in-region model) the id alone does not reveal.
 */
export function bedrockEndpointMultiplier(modelId: string): number {
  if (!BEDROCK_GEO_PROFILE.test(modelId.trim())) return 1;
  const v = parseClaudeVersion(modelId);
  if (!v) return 1;
  const premiumGeneration = v.family === "fable" || v.family === "mythos" || v.major >= 5 || (v.major === 4 && v.minor >= 5);
  return premiumGeneration ? BEDROCK_REGIONAL_PREMIUM : 1;
}

function scaledRates(rates: ClaudeRates, scale: number): Pick<ModelInfo, "inputPricePerM" | "outputPricePerM" | "cacheReadPricePerM" | "cacheWritePricePerM"> {
  return {
    inputPricePerM: rates.input * scale,
    outputPricePerM: rates.output * scale,
    cacheReadPricePerM: rates.cacheRead * scale,
    cacheWritePricePerM: rates.cacheWrite * scale,
  };
}

/**
 * Published pricing for a Claude model on a route, or undefined when the id is not a Claude model
 * this build has a price for. Never borrows a sibling's price: an unknown point release is
 * reported as unknown rather than billed at its predecessor's rate.
 */
export function getClaudeModelPricing(modelId: string, provider?: ProviderName): ModelPricing | undefined {
  const canonical = canonicalClaudeModelId(modelId);
  const entry = canonical ? CLAUDE_PRICES[canonical] : undefined;
  if (!entry) return undefined;
  const scale = provider === "bedrock" ? bedrockEndpointMultiplier(modelId) : 1;
  return {
    ...scaledRates(entry, scale),
    ...(entry.longContext
      ? { longContextPricing: { aboveInputTokens: entry.longContext.aboveTokens, ...scaledRates(entry.longContext, scale) } }
      : {}),
  };
}

/** Price columns for a static table row, from the same table. */
function claudeListPrice(modelId: string, provider?: ProviderName): ModelPricing {
  const pricing = getClaudeModelPricing(modelId, provider);
  if (!pricing) throw new Error(`No Claude price listed for ${modelId}`);
  return pricing;
}

// ── Bedrock Mantle (Messages API) static model list ────────────────────────────
// Mantle has no listing API; these are the documented model IDs.
export { BEDROCK_MANTLE_DEFAULT_MODEL } from "./bedrock-config.js";
const BEDROCK_MANTLE_MODEL_CATALOG: ModelInfo[] = [
  { id: "anthropic.claude-opus-5-5",  name: "Claude Opus 5.5 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-fable-5-1", name: "Claude Fable 5.1 (Mantle)", contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Mantle)", contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-haiku-5-5", name: "Claude Haiku 5.5 (Mantle)", contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-5",    name: "Claude Opus 5 (Mantle)",    contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-fable-5",   name: "Claude Fable 5 (Mantle)",   contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-8",  name: "Claude Opus 4.8 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-opus-4-7",  name: "Claude Opus 4.7 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-sonnet-5",  name: "Claude Sonnet 5 (Mantle)",  contextLength: 1_000_000, supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
  { id: "anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5 (Mantle)", contextLength: 200_000,   supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
];
export const BEDROCK_MANTLE_MODELS: ModelInfo[] = BEDROCK_MANTLE_MODEL_CATALOG.map((model) => ({
  ...model,
  ...claudeListPrice(model.id, "bedrock"),
  maxOutputTokens: resolveOutputCeiling(model.id, "bedrock") ?? undefined,
}));

// ── Hardcoded fallbacks ────────────────────────────────────────────────────────
//
/**
 * Anthropic's usual cache ratios: a cache read is 0.1x input, and a cache write is 1.25x for the
 * default 5-minute breakpoint TTL and 2x for the 1-hour TTL. {@link estimateUsageCostUsd} scales a
 * listed 5-minute write rate to the 1-hour one from the session's setting, since the TTL is a
 * per-request choice rather than a model property.
 *
 * The read ratio is no longer universal (Fable 5.1, Opus 5.5 and Sonnet 5.5 charge less), so the
 * Claude price table lists cache reads per model instead of deriving them from this constant.
 */
export const CLAUDE_CACHE_READ_RATIO = 0.1;
export const CLAUDE_CACHE_WRITE_RATIO_5M = 1.25;
export const CLAUDE_CACHE_WRITE_RATIO_1H = 2;

/**
 * @deprecated Sonnet 5's $2/$10 rate, announced as introductory through this date, is now its
 * standard price; the scheduled rise to $3/$15 did not happen. Kept for callers of the old API.
 */
export const SONNET_5_INTRO_PRICING_ENDS = Date.UTC(2026, 7, 31, 23, 59, 59); // 2026-08-31T23:59:59Z

/** Claude Sonnet 5's price. The argument is ignored: the rate no longer changes with the date. */
export function sonnet5Pricing(_now: number = Date.now()): Pick<ModelInfo, "inputPricePerM" | "outputPricePerM" | "cacheReadPricePerM" | "cacheWritePricePerM"> {
  const { inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM } = claudeListPrice("claude-sonnet-5");
  return { inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM };
}

// Context windows must agree with resolveClaudeLimits (model-limits.ts) — this table is consulted
// first, so a wrong number here silently wins. Getting one wrong is not cosmetic: the old table
// said 200K for Opus 4.8, a 1M-window model, so compaction fired at roughly 12% of its real
// capacity and long runs shed history they had ample room for.

const FALLBACK_MODELS: Record<ProviderName, ModelInfo[]> = {
  // Prices come from CLAUDE_PRICES, the one table every route reads, so a row here can never
  // disagree with what a session on another route is billed.
  anthropic: [
    { id: "claude-opus-5-5",              name: "Claude Opus 5.5",       contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-opus-5-5"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-5-5",            name: "Claude Sonnet 5.5",     contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-sonnet-5-5"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-haiku-5-5",             name: "Claude Haiku 5.5",      contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-haiku-5-5"),  supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-fable-5-1",             name: "Claude Fable 5.1",      contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-fable-5-1"),  supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-opus-5",                name: "Claude Opus 5",         contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-opus-5"),     supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-opus-4-8",              name: "Claude Opus 4.8",       contextLength: 1_000_000, ...claudeListPrice("claude-opus-4-8"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-opus-4-7",              name: "Claude Opus 4.7",       contextLength: 1_000_000, ...claudeListPrice("claude-opus-4-7"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-opus-4-6",              name: "Claude Opus 4.6",       contextLength: 1_000_000, ...claudeListPrice("claude-opus-4-6"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-5",              name: "Claude Sonnet 5",       contextLength: 1_000_000, ...claudeListPrice("claude-sonnet-5"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6",     contextLength: 1_000_000, ...claudeListPrice("claude-sonnet-4-6"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-fable-5",               name: "Claude Fable 5",        contextLength: 1_000_000, ...claudeListPrice("claude-fable-5"),    supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    // Project Glasswing only — same specs and pricing as the Fable release they mirror. Listed so
    // a session that does have access resolves real limits and cost instead of "unknown".
    { id: "claude-mythos-5-1",            name: "Claude Mythos 5.1",     contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-mythos-5-1"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-mythos-5",              name: "Claude Mythos 5",       contextLength: 1_000_000, maxOutputTokens: 128_000, ...claudeListPrice("claude-mythos-5"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "claude-haiku-4-5",             name: "Claude Haiku 4.5",      contextLength: 200_000,   ...claudeListPrice("claude-haiku-4-5"),  supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
  ],
  // Offline seed only — the live /models fetch supersedes this and carries OpenRouter's own
  // per-model cache pricing. Kept current anyway: it is what the picker shows before the first
  // successful fetch, and what pricing falls back to if the catalog can't be reached.
  openrouter: [
    { id: "anthropic/claude-opus-5",      name: "Claude Opus 5 (OR)",     contextLength: 1_000_000, ...claudeListPrice("claude-opus-5"),     supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-opus-4.8",    name: "Claude Opus 4.8 (OR)",   contextLength: 1_000_000, ...claudeListPrice("claude-opus-4-8"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-5",    name: "Claude Sonnet 5 (OR)",   contextLength: 1_000_000, ...claudeListPrice("claude-sonnet-5"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "anthropic/claude-sonnet-4.6",  name: "Claude Sonnet 4.6 (OR)", contextLength: 1_000_000, ...claudeListPrice("claude-sonnet-4-6"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-5.6-sol",          name: "GPT-5.6 Sol (OR)",       contextLength: 1_050_000, inputPricePerM: 5,    outputPricePerM: 30, cacheReadPricePerM: 0.50,  cacheWritePricePerM: 6.25, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-5.6-terra",        name: "GPT-5.6 Terra (OR)",     contextLength: 1_050_000, inputPricePerM: 2,    outputPricePerM: 12, cacheReadPricePerM: 0.20,  cacheWritePricePerM: 2.50, supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-5.1",              name: "GPT-5.1 (OR)",           contextLength: 400000, inputPricePerM: 1.25, outputPricePerM: 10,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/gpt-4o",               name: "GPT-4o (OR)",            contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,   supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "google/gemini-2.5-pro",        name: "Gemini 2.5 Pro (OR)",   contextLength: 1048576,inputPricePerM: 1.25, outputPricePerM: 10,   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "openai/o3-mini",              name: "o3-mini (OR)",           contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4,  supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
  ],
  // Cache read/write rates mirror OPENAI_META — this list is consulted *before* that table in
  // getModelPricing, so omitting them here would silently drop cache tokens from every cost
  // estimate for a model that appears in both.
  openai: [
    { id: "gpt-5.6-sol",   name: "GPT-5.6 Sol",    contextLength: 1050000, maxOutputTokens: 128000, inputPricePerM: 5,    outputPricePerM: 30,  cacheReadPricePerM: 0.50,  cacheWritePricePerM: 6.25, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra",  contextLength: 1050000, maxOutputTokens: 128000, inputPricePerM: 2,    outputPricePerM: 12,  cacheReadPricePerM: 0.20,  cacheWritePricePerM: 2.50, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-5.6-luna",  name: "GPT-5.6 Luna",   contextLength: 1050000, maxOutputTokens: 128000, inputPricePerM: 0.20, outputPricePerM: 1.20, cacheReadPricePerM: 0.02, cacheWritePricePerM: 0.25, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-5.1",       name: "GPT-5.1",        contextLength: 400000, inputPricePerM: 1.25, outputPricePerM: 10,  cacheReadPricePerM: 0.125, cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-5",         name: "GPT-5",          contextLength: 400000, inputPricePerM: 1.25, outputPricePerM: 10,  cacheReadPricePerM: 0.125, cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-5-mini",    name: "GPT-5 mini",     contextLength: 400000, inputPricePerM: 0.25, outputPricePerM: 2,   cacheReadPricePerM: 0.025, cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-4o",        name: "GPT-4o",        contextLength: 128000, inputPricePerM: 2.5,  outputPricePerM: 10,  cacheReadPricePerM: 1.25,  cacheWritePricePerM: 0, supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "gpt-4o-mini",   name: "GPT-4o mini",   contextLength: 128000, inputPricePerM: 0.15, outputPricePerM: 0.60,cacheReadPricePerM: 0.075, cacheWritePricePerM: 0, supportsThinking: false, supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3",            name: "o3",             contextLength: 200000, inputPricePerM: 2,    outputPricePerM: 8,   cacheReadPricePerM: 0.50,  cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o4-mini",       name: "o4-mini",        contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4, cacheReadPricePerM: 0.275, cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: true,  supportsTools: true, source: "fallback" },
    { id: "o3-mini",       name: "o3-mini",        contextLength: 200000, inputPricePerM: 1.1,  outputPricePerM: 4.4, cacheReadPricePerM: 0.55,  cacheWritePricePerM: 0, supportsThinking: true,  supportsVision: false, supportsTools: true, source: "fallback" },
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
  // Pricing mirrors Anthropic's published per-model rates, with Bedrock's 10% premium for the
  // geographic (`us.`) profiles below on Claude 4.5 and later. Bedrock publishes no pricing API
  // (unlike context length, which AWS returns per inference profile), so treat these as a display
  // estimate and reconcile against the AWS Bedrock pricing page if they drift. These rows used to
  // carry no cache rates at all, so every cache read and write on Converse went unbilled.
  bedrock: [
    // Current-generation profiles carry no dated/-v1:0 suffix. `us.` rather than `global.` keeps
    // the default inside US/Canada regions, matching the geography the previous default used.
    { id: "us.anthropic.claude-sonnet-5",                 name: "Claude Sonnet 5 (Bedrock)",   contextLength: 1_000_000, ...claudeListPrice("us.anthropic.claude-sonnet-5", "bedrock"), supportsThinking: true, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-5-20251101-v1:0",  name: "Claude Opus 4.5 (Bedrock)",   contextLength: 200000, ...claudeListPrice("us.anthropic.claude-opus-4-5-20251101-v1:0", "bedrock"),  supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (Bedrock)", contextLength: 200000, ...claudeListPrice("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",  name: "Claude Haiku 4.5 (Bedrock)",  contextLength: 200000, ...claudeListPrice("us.anthropic.claude-haiku-4-5-20251001-v1:0", "bedrock"),  supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-1-20250805-v1:0",   name: "Claude Opus 4.1 (Bedrock)",   contextLength: 200000, ...claudeListPrice("us.anthropic.claude-opus-4-1-20250805-v1:0", "bedrock"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-opus-4-20250514-v1:0",     name: "Claude Opus 4 (Bedrock)",     contextLength: 200000, ...claudeListPrice("us.anthropic.claude-opus-4-20250514-v1:0", "bedrock"),     supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-sonnet-4-20250514-v1:0",   name: "Claude Sonnet 4 (Bedrock)",   contextLength: 200000, ...claudeListPrice("us.anthropic.claude-sonnet-4-20250514-v1:0", "bedrock"),   supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", name: "Claude 3.7 Sonnet (Bedrock)", contextLength: 200000, ...claudeListPrice("us.anthropic.claude-3-7-sonnet-20250219-v1:0", "bedrock"), supportsThinking: true,  supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", name: "Claude 3.5 Sonnet (Bedrock)", contextLength: 200000, ...claudeListPrice("us.anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock"), supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
    { id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",  name: "Claude 3.5 Haiku (Bedrock)",  contextLength: 200000, ...claudeListPrice("us.anthropic.claude-3-5-haiku-20241022-v1:0", "bedrock"),  supportsThinking: false, supportsVision: true, supportsTools: true, source: "fallback" },
  ],
};

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  try { new URL(url); } catch { throw new Error(`Bad URL: ${url}`); }
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new Error("Timeout");
    throw err;
  }
  return { status: response.status, body: await response.text() };
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

// ── Vision detection ──────────────────────────────────────────────────────────

/** Families that take text only, checked before the vision families below so that, for
 *  example, o3-mini is not caught by the o-series rule. */
const TEXT_ONLY_FAMILIES = [
  /^o1-(?:mini|preview)\b/,
  /^o3-mini\b/,
  /^gpt-3\.5/,
  /^gpt-4(?:-32k)?(?:-\d{4})?$/, // the original GPT-4; gpt-4-turbo and later are matched below
  /\bgpt-oss\b/,
  /\bnova-micro\b/,
  /\bclaude-(?:instant|2)\b/,
];

const VISION_FAMILIES = [
  /\bclaude\b/, // every Claude from the 3 family on
  /^(?:chatgpt-)?gpt-4o\b/, /^gpt-4\.1\b/, /^gpt-4\.5\b/, /^gpt-4-turbo\b/, /^gpt-5/,
  /^o[134]\b/,
  /\bgemini\b/,
  /\bgrok-4\b/,
  /\bllama-?4\b/, /\bllama-?3[.-]2-(?:11|90)b\b/, // OpenRouter `llama-3.2-90b`, Bedrock `llama3-2-90b`
  /\bnova-(?:\d+-)?(?:pro|lite|premier)\b/,
  /\bpixtral\b/, /\bmistral-medium-3\b/, /\bmistral-small-3\.[1-9]\b/,
  /(?:^|[-_.])vl(?:\d|[-_.]|$)/, // Qwen-VL, DeepSeek-VL, Kimi-VL and the like
  /\bvision\b/, /\bllava\b/,
];

/**
 * Whether a model family accepts image input, judged from its id alone. Undefined for a family
 * this build does not know, so a caller can tell "known to be text-only" from "never heard of it".
 *
 * This is what answers when no live catalog row does. The previous answer was the static model
 * table matched on the exact id, so a dated snapshot, a regional Bedrock profile (`eu.`, `global.`),
 * or any model newer or older than the table came back text-only — and every image a session
 * produced (attachments, screenshots, rendered previews) was withheld from a model that could have
 * seen it. Keep the families conservative: a false positive puts an image on the wire to a model
 * that rejects the whole request.
 */
export function modelFamilySupportsVision(modelId: string): boolean | undefined {
  const id = normalizeModelIdForFallbackLookup(modelId);
  if (!id) return undefined;
  if (TEXT_ONLY_FAMILIES.some((pattern) => pattern.test(id))) return false;
  if (VISION_FAMILIES.some((pattern) => pattern.test(id))) return true;
  return undefined;
}

/**
 * Vision support from what this build ships with: a row in the provider's static table (matched on
 * the normalized id, so `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` finds its `us.` sibling),
 * then the model family. Only an exact normalized match counts for the table — the prefix matching
 * {@link modelIdFallbackMatches} allows would let `o3` answer for `o3-mini`.
 */
export function getVisionSupport(provider: ProviderName, modelId: string): boolean | undefined {
  const target = normalizeModelIdForFallbackLookup(modelId);
  const tables = provider === "bedrock" ? [FALLBACK_MODELS.bedrock, BEDROCK_MANTLE_MODELS] : [FALLBACK_MODELS[provider] ?? []];
  for (const table of tables) {
    const row = table.find((model) => normalizeModelIdForFallbackLookup(model.id) === target);
    if (typeof row?.supportsVision === "boolean") return row.supportsVision;
  }
  return modelFamilySupportsVision(modelId);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

/** The subset of the Models API's `capabilities` tree this build reads. Untyped/nested by
 *  design on Anthropic's side — every leaf carries `{supported: boolean}`, so bracket access
 *  with an explicit fallback is the correct way to read it, not a `.get()` chain. */
interface AnthropicModelCapabilities {
  image_input?: { supported?: boolean };
  thinking?: { supported?: boolean };
}

export interface RawAnthropicModelEntry {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: AnthropicModelCapabilities;
}

/**
 * Map one `/v1/models` entry to a ModelInfo. Exported (and split out of fetchAnthropic) purely
 * so the capability-consumption logic is unit-testable without mocking network I/O.
 *
 * The Models API reports the context window as `max_input_tokens` and the output ceiling as
 * `max_tokens`. Reading them beats inferring from the id — a model released after this build
 * still gets its true window, and the window is what the compaction trigger divides by.
 * resolveContextWindow covers older API responses that don't carry the field. `capabilities`
 * (added March 2026) is read the same way: present and reliable on new responses, silently
 * absent on older ones, in which case the existing id-based heuristics are the only signal and
 * nothing here should downgrade what they already conclude — see the `||`/`??` fallbacks below,
 * not `&&`.
 */
export function mapAnthropicModelEntry(m: RawAnthropicModelEntry): ModelInfo {
  return {
    id: m.id,
    name: m.display_name ?? m.id,
    contextLength: m.max_input_tokens ?? resolveContextWindow(m.id),
    maxOutputTokens: m.max_tokens,
    // OR, not AND: a capability the live response doesn't mention must not override a
    // capability the id-based heuristic already knows about.
    supportsThinking: detectsThinking(m.id) || !!m.capabilities?.thinking?.supported,
    supportsVision: m.capabilities?.image_input?.supported ?? true,
    supportsTools: true,
    source: "api" as const,
  };
}

async function fetchAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://api.anthropic.com/v1/models", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`Anthropic /v1/models returned ${status}`);
  const data = (JSON.parse(body) as { data?: RawAnthropicModelEntry[] }).data ?? [];
  return data.map(mapAnthropicModelEntry);
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

export interface RawOpenRouterModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  top_provider?: { max_completion_tokens?: number | null };
}

/** Map one live catalog row. OpenRouter exposes its output cap as
 *  `top_provider.max_completion_tokens`; family metadata is only the offline fallback. */
export function mapOpenRouterModelEntry(m: RawOpenRouterModelEntry): ModelInfo {
  // A "0" price is free, not unknown, so a free route bills $0 instead of marking the session's
  // spend partial. Negative values ("-1") are OpenRouter's "variable", which is unknown. Rounded to
  // the micro-dollar: two decimals turned Haiku-class rates such as $0.125 into $0.13.
  const perM = (perToken: string | undefined): number | undefined => {
    const usd = perToken ? parseFloat(perToken) * 1_000_000 : NaN;
    return Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 1_000_000) / 1_000_000 : undefined;
  };
  const modalities = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : undefined;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined;
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length,
    maxOutputTokens: resolveOutputCeiling(m.id, "openrouter", m.top_provider?.max_completion_tokens) ?? undefined,
    inputPricePerM: perM(m.pricing?.prompt),
    outputPricePerM: perM(m.pricing?.completion),
    cacheReadPricePerM: perM(m.pricing?.input_cache_read),
    cacheWritePricePerM: perM(m.pricing?.input_cache_write),
    supportsThinking: detectsThinking(m.id) || (params?.includes("reasoning") ?? false),
    supportsVision: modalities ? modalities.includes("image") : modelFamilySupportsVision(m.id) ?? true,
    supportsAudio: modalities?.includes("audio") ?? false,
    supportsTools: params ? params.includes("tools") : true,
    // Carried through verbatim: this is the only authority on which sampling controls the
    // routed model accepts, and models differ widely (a Kimi/DeepSeek/GLM row lists several
    // that a Claude row does not). Consumed by sampling-parameters.ts.
    supportedParameters: params,
    source: "api",
  };
}

async function fetchOpenRouter(apiKey: string): Promise<ModelInfo[]> {
  const { status, body } = await get("https://openrouter.ai/api/v1/models", {
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": "Blacksite-VSCode/1.0",
  });
  if (status !== 200) throw new Error(`OpenRouter /api/v1/models returned ${status}`);
  const data = (JSON.parse(body) as {
    data?: RawOpenRouterModelEntry[];
  }).data ?? [];

  return data
    .filter((m) => Boolean(m.id)) // include free tier models too
    .map(mapOpenRouterModelEntry);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

/**
 * Pricing/context hardcoded since /v1/models doesn't return it.
 *
 * `cacheRead` is the prompt-cache-hit rate and `cacheWrite` the rate for tokens newly written
 * into the cache. Both are real billed categories and both used to be missing here entirely,
 * which made every OpenAI session under-report its spend: `estimateUsageCostUsd` drops any
 * category with no price (and flags the estimate `partial`), so on a long agent run — where the
 * cache carries most of the prompt — the reported cost was a fraction of the invoice.
 *
 * Cache writes are free on every model before GPT-5.6 (`cacheWrite: 0`, not `undefined`, so the
 * estimate is exact rather than partial). GPT-5.6 and later bill writes at 1.25x the uncached
 * input rate, which is why the 5.6 rows carry a real number.
 */
interface OpenAIModelMeta {
  ctx: number;
  inp: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

const OPENAI_META: Record<string, OpenAIModelMeta> = {
  // GPT-5.6 family (GA 2026-07-09). Sol/Terra/Luna are capability tiers of one generation;
  // the bare "gpt-5.6" alias routes to Sol. Terra and Luna were repriced down on 2026-07-30.
  // These are the first OpenAI models to charge for cache writes (1.25x uncached input).
  "gpt-5.6":                { ctx: 1050000, inp: 5.00,  out: 30.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  "gpt-5.6-sol":            { ctx: 1050000, inp: 5.00,  out: 30.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  "gpt-5.6-terra":          { ctx: 1050000, inp: 2.00,  out: 12.00, cacheRead: 0.20,  cacheWrite: 2.50  },
  "gpt-5.6-luna":           { ctx: 1050000, inp: 0.20,  out: 1.20,  cacheRead: 0.02,  cacheWrite: 0.25  },
  "gpt-5.5":                { ctx: 400000,  inp: 5.00,  out: 30.00, cacheRead: 0.50,  cacheWrite: 0     },
  "gpt-5.1":                { ctx: 400000,  inp: 1.25,  out: 10.00, cacheRead: 0.125, cacheWrite: 0     },
  "gpt-5.1-codex":          { ctx: 400000,  inp: 1.25,  out: 10.00, cacheRead: 0.125, cacheWrite: 0     },
  "gpt-5.1-codex-mini":     { ctx: 400000,  inp: 0.25,  out: 2.00,  cacheRead: 0.025, cacheWrite: 0     },
  "gpt-5":                  { ctx: 400000,  inp: 1.25,  out: 10.00, cacheRead: 0.125, cacheWrite: 0     },
  "gpt-5-mini":             { ctx: 400000,  inp: 0.25,  out: 2.00,  cacheRead: 0.025, cacheWrite: 0     },
  "gpt-5-nano":             { ctx: 400000,  inp: 0.05,  out: 0.40,  cacheRead: 0.005, cacheWrite: 0     },
  "gpt-4.1":                { ctx: 1047576, inp: 2.00,  out: 8.00,  cacheRead: 0.50,  cacheWrite: 0     },
  "gpt-4.1-mini":           { ctx: 1047576, inp: 0.40,  out: 1.60,  cacheRead: 0.10,  cacheWrite: 0     },
  "gpt-4.1-nano":           { ctx: 1047576, inp: 0.10,  out: 0.40,  cacheRead: 0.025, cacheWrite: 0     },
  "gpt-4o":                 { ctx: 128000,  inp: 2.50,  out: 10.00, cacheRead: 1.25,  cacheWrite: 0     },
  "gpt-4o-mini":            { ctx: 128000,  inp: 0.15,  out: 0.60,  cacheRead: 0.075, cacheWrite: 0     },
  "gpt-4-turbo":            { ctx: 128000,  inp: 10.00, out: 30.00, cacheRead: 10.00, cacheWrite: 0     },
  "gpt-4":                  { ctx: 8192,    inp: 30.00, out: 60.00, cacheRead: 30.00, cacheWrite: 0     },
  "gpt-3.5-turbo":          { ctx: 16385,   inp: 0.50,  out: 1.50,  cacheRead: 0.50,  cacheWrite: 0     },
  "o1":                     { ctx: 200000,  inp: 15.00, out: 60.00, cacheRead: 7.50,  cacheWrite: 0     },
  "o1-mini":                { ctx: 128000,  inp: 1.10,  out: 4.40,  cacheRead: 0.55,  cacheWrite: 0     },
  "o1-preview":             { ctx: 128000,  inp: 15.00, out: 60.00, cacheRead: 7.50,  cacheWrite: 0     },
  // o3 was repriced to $2/$8 in June 2025 — the old $10/$40 sticker overstated cost 5x.
  "o3":                     { ctx: 200000,  inp: 2.00,  out: 8.00,  cacheRead: 0.50,  cacheWrite: 0     },
  "o3-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40,  cacheRead: 0.55,  cacheWrite: 0     },
  "o4-mini":                { ctx: 200000,  inp: 1.10,  out: 4.40,  cacheRead: 0.275, cacheWrite: 0     },
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
        maxOutputTokens:  resolveOutputCeiling(m.id, "openai") ?? undefined,
        inputPricePerM:   meta?.inp,
        outputPricePerM:  meta?.out,
        cacheReadPricePerM:  meta?.cacheRead,
        cacheWritePricePerM: meta?.cacheWrite,
        supportsThinking: detectsThinking(m.id),
        // The listing carries no modalities. The old substring rule missed gpt-4.1 and passed
        // o1-mini and o3-mini, which reject images.
        supportsVision:   modelFamilySupportsVision(m.id) ?? false,
        supportsAudio:    m.id.includes("audio") || m.id.startsWith("gpt-4o") || m.id.startsWith("gpt-5"),
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
  return (FALLBACK_MODELS[provider] ?? []).map((model) => ({
    ...model,
    maxOutputTokens: model.maxOutputTokens
      ?? resolveOutputCeiling(model.id, provider)
      ?? undefined,
  }));
}

/** Best available output ceiling when no live catalog row is cached. Provider listings that
 *  expose a cap override this at session creation; unknown future models intentionally return
 *  undefined so the runtime can use its explicit conservative fallback. */
export function getMaxOutputTokens(provider: ProviderName, modelId: string): number | undefined {
  const fallback = FALLBACK_MODELS[provider]?.find((model) => modelIdFallbackMatches(model.id, modelId));
  return fallback?.maxOutputTokens
    ?? resolveOutputCeiling(modelId, provider)
    ?? undefined;
}

/** Known per-token pricing for a provider/model, or undefined if unpriced (e.g. Bedrock, which
    publishes no pricing API, or an OpenRouter model id this build hasn't fetched live yet).
    Callers should prefer live-fetched pricing (a session's cached model catalog) and only fall
    back to this when nothing better is available — this mirrors getContextLength's own
    fallback-table-first strategy. */
export function getModelPricing(provider: ProviderName, modelId: string): ModelPricing | undefined {
  // Claude is priced from one table on every route that serves it. A Claude id the table does not
  // list is unknown, never billed at a sibling's rate by the fuzzy match below.
  if (provider !== "openai" && canonicalClaudeModelId(modelId)) return getClaudeModelPricing(modelId, provider);

  const fallback = FALLBACK_MODELS[provider]?.find((m) => m.id === modelId);
  if (fallback?.inputPricePerM != null || fallback?.outputPricePerM != null) return fallback;

  if (provider === "openai") {
    const meta = OPENAI_META[modelId] ?? OPENAI_META[normalizeModelIdForFallbackLookup(modelId)];
    if (meta) {
      return {
        inputPricePerM: meta.inp,
        outputPricePerM: meta.out,
        cacheReadPricePerM: meta.cacheRead,
        cacheWritePricePerM: meta.cacheWrite,
      };
    }
  }

  // Last resort: a dated-snapshot or provider-prefixed id (a new Bedrock inference-profile date
  // stamp, an OpenRouter "anthropic/claude-x" id) that doesn't match the fallback table verbatim
  // but plausibly names a model the table already prices. Prefer the most specific match (the
  // longest normalized id): declaration order would otherwise let a short, unrelated sibling
  // that's merely a string-prefix ("gpt-4o") win over the real match ("gpt-4o-mini") just by
  // appearing earlier in the table.
  const fuzzyMatches = FALLBACK_MODELS[provider]?.filter((m) => modelIdFallbackMatches(m.id, modelId)) ?? [];
  const fuzzy = fuzzyMatches.reduce<ModelInfo | undefined>((best, m) =>
    !best || normalizeModelIdForFallbackLookup(m.id).length > normalizeModelIdForFallbackLookup(best.id).length ? m : best,
    undefined);
  if (fuzzy?.inputPricePerM != null || fuzzy?.outputPricePerM != null) return fuzzy;

  return undefined;
}

export interface UsageTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /**
   * The processing tier that actually served the request, read back from OpenAI's echoed
   * `service_tier` — NOT the tier that was requested. OpenAI is explicit that the two can
   * differ (a flex request served at the standard tier when flex capacity was out, an "auto"
   * request resolved to whatever the account defaults to), and billing follows the tier that
   * served it. Pricing tables quote standard-tier rates, so this scales them.
   */
  serviceTier?: string;
  /**
   * Prompt-cache breakpoint TTL for this request (Anthropic family). A cache write costs 1.25x
   * input at the default 5-minute TTL and 2x at the 1-hour TTL — a per-request choice, not a
   * model property, so the catalog quotes the 5m rate and this scales it. Omitted or "5m"
   * leaves the quoted rate alone.
   */
  cacheTtl?: string;
}

/**
 * Per-tier multiplier applied to every billed token category. OpenAI prices flex at the Batch
 * API rate — half of standard — and Fast mode (the July 2026 rename of Priority Processing;
 * both spellings are accepted on the wire) at double it. "default"/"auto"/"scale" bill at the
 * quoted standard rate.
 */
function serviceTierMultiplier(tier: string | undefined): number {
  switch (tier) {
    case "flex":     return 0.5;
    case "priority":
    case "fast":     return 2;
    default:         return 1;
  }
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

/** Estimate USD spend for one usage event, scaled by the processing tier that served it
    ({@link UsageTokens.serviceTier}). Returns undefined when the model has no known pricing at
    all, so callers can distinguish "$0 spent" from "cost unknown". */
export function estimateUsageCostUsd(pricing: ModelPricing | undefined, tokens: UsageTokens): UsageCostEstimate | undefined {
  if (!pricing || (pricing.inputPricePerM == null && pricing.outputPricePerM == null)) return undefined;
  // A prompt-length tier (Haiku 5.5 above 100K tokens) prices the whole request, cached tokens
  // included, and the prompt it is measured on counts them too.
  const promptTokens = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  const long = pricing.longContextPricing;
  const rates = long && promptTokens > long.aboveInputTokens ? long : pricing;
  let costUsd = 0;
  let partial = false;
  const tierMultiplier = serviceTierMultiplier(tokens.serviceTier);
  const bill = (count: number | undefined, pricePerM: number | undefined): void => {
    if (!count) return;
    if (pricePerM == null) { partial = true; return; }
    costUsd += (count / 1_000_000) * pricePerM * tierMultiplier;
  };
  // Catalog cache-write rates are the 5-minute figure; a 1-hour breakpoint costs 2x input
  // instead of 1.25x, so scale by the ratio between the two rather than re-deriving from input
  // (which a live OpenRouter row may not agree with).
  const cacheWritePricePerM = tokens.cacheTtl === "1h" && rates.cacheWritePricePerM != null
    ? rates.cacheWritePricePerM * (CLAUDE_CACHE_WRITE_RATIO_1H / CLAUDE_CACHE_WRITE_RATIO_5M)
    : rates.cacheWritePricePerM;
  bill(tokens.input, rates.inputPricePerM);
  bill(tokens.output, rates.outputPricePerM);
  bill(tokens.cacheRead, rates.cacheReadPricePerM);
  bill(tokens.cacheWrite, cacheWritePricePerM);
  return { costUsd, partial };
}

/** Returns the context window size (tokens) for a given provider/model, or undefined if unknown. */
export function getContextLength(provider: ProviderName, modelId: string): number | undefined {
  // Check fallback table first (has accurate context lengths)
  const fallback = FALLBACK_MODELS[provider]?.find((m) => m.id === modelId);
  if (fallback?.contextLength) return fallback.contextLength;

  // OpenAI: use hardcoded meta table
  if (provider === "openai") {
    const meta = OPENAI_META[modelId] ?? OPENAI_META[normalizeModelIdForFallbackLookup(modelId)];
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
  // Checked before the general gpt-5 rule: 5.6 and later carry a ~1M window, and inheriting the
  // 400K figure from the earlier 5.x line would trip auto-compaction at ~38% of real capacity.
  if (/gpt-5\.(?:[6-9]|\d{2,})/.test(id)) return 1_050_000;
  if (id.includes("gpt-5")) return 400_000;
  // Checked before the bare "gpt-4" rule: the 4.1 family has a 1M window, and letting it
  // fall through to the legacy 8K default would trigger compaction at ~0.5% of capacity.
  if (id.includes("gpt-4.1")) return 1_047_576;
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
