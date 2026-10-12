/**
 * The sampling controls a model may expose beyond temperature, and how each maps onto the
 * wire.
 *
 * One table drives three things that previously had no shared source of truth: which
 * controls the settings UI offers for the selected model, which fields the request body
 * carries, and what a valid value is. Keeping them together is what stops the UI from
 * advertising a knob the request never sends (the bug this fixes — OpenRouter reports far
 * more accepted parameters for models like Kimi, DeepSeek and GLM than the panel exposed),
 * or the request from sending one the model rejects.
 *
 * Membership is per-model, not per-provider: OpenRouter publishes the exact accepted set
 * per routed model in `supported_parameters`, which is carried through the catalog as
 * ModelInfo.supportedParameters and consulted by both sides.
 *
 * Pure and dependency-free so the webview can import it directly (mirroring
 * embedding-models.ts / bedrock-config.ts).
 */

/** Keys of SamplingSettings — the settings-side name of each control. */
export type SamplingKey =
  | "topP" | "topK" | "minP"
  | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty"
  | "seed";

export interface SamplingParameterSpec {
  key: SamplingKey;
  /** OpenAI-compatible request field, and the name OpenRouter reports it under. */
  wire: string;
  label: string;
  /** What the control does, in one sentence, for the settings UI. */
  description: string;
  min: number;
  max: number;
  /** Slider granularity. Integer-valued controls use 1. */
  step: number;
  /** The value that means "off" for a penalty-style control, shown as the reset target.
   *  Undefined for controls with no neutral value (topK, seed). */
  neutral?: number;
}

export const SAMPLING_PARAMETERS: readonly SamplingParameterSpec[] = [
  {
    key: "topP", wire: "top_p", label: "Top P",
    description: "Nucleus sampling — consider only the most likely tokens making up this share of probability mass.",
    min: 0, max: 1, step: 0.01, neutral: 1,
  },
  {
    key: "topK", wire: "top_k", label: "Top K",
    description: "Consider only the K most likely tokens at each step. 0 disables the cutoff.",
    min: 0, max: 200, step: 1, neutral: 0,
  },
  {
    key: "minP", wire: "min_p", label: "Min P",
    description: "Drop tokens less likely than this fraction of the most likely token.",
    min: 0, max: 1, step: 0.01, neutral: 0,
  },
  {
    key: "frequencyPenalty", wire: "frequency_penalty", label: "Frequency penalty",
    description: "Discourage tokens in proportion to how often they have already appeared.",
    min: -2, max: 2, step: 0.01, neutral: 0,
  },
  {
    key: "presencePenalty", wire: "presence_penalty", label: "Presence penalty",
    description: "Discourage tokens that have appeared at all, regardless of how often.",
    min: -2, max: 2, step: 0.01, neutral: 0,
  },
  {
    key: "repetitionPenalty", wire: "repetition_penalty", label: "Repetition penalty",
    description: "Scale down the likelihood of tokens already used. 1 is off; above 1 discourages repetition.",
    min: 0.1, max: 2, step: 0.01, neutral: 1,
  },
  {
    key: "seed", wire: "seed", label: "Seed",
    description: "Fixed seed for reproducible sampling, where the routed provider honours it.",
    min: 0, max: 2_147_483_647, step: 1,
  },
];

const BY_KEY = new Map<SamplingKey, SamplingParameterSpec>(SAMPLING_PARAMETERS.map((p) => [p.key, p]));

export function samplingParameter(key: SamplingKey): SamplingParameterSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * The controls the given model accepts.
 *
 * A model with no published parameter list falls back to the OpenAI-compatible core that
 * every chat completions endpoint accepts — sending `top_k` or `min_p` to an endpoint that
 * has never heard of them is how you get a 400, so an unknown model gets the conservative
 * set rather than everything.
 */
const UNIVERSAL_KEYS: readonly SamplingKey[] = ["topP", "frequencyPenalty", "presencePenalty", "seed"];

export function supportedSamplingParameters(supportedParameters?: string[]): SamplingParameterSpec[] {
  if (!supportedParameters?.length) {
    return SAMPLING_PARAMETERS.filter((p) => UNIVERSAL_KEYS.includes(p.key));
  }
  const wire = new Set(supportedParameters.map((name) => name.trim().toLowerCase()));
  return SAMPLING_PARAMETERS.filter((p) => wire.has(p.wire));
}

/** Clamp to the control's range, and round to a whole number for integer-valued controls.
 *  Returns undefined for a non-finite value so a malformed input clears rather than
 *  poisoning the request body with NaN. */
export function normalizeSamplingValue(key: SamplingKey, value: unknown): number | undefined {
  const spec = BY_KEY.get(key);
  if (!spec) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const clamped = Math.min(Math.max(numeric, spec.min), spec.max);
  return spec.step === 1 ? Math.round(clamped) : clamped;
}

/**
 * The request-body fields for the configured sampling values the model actually accepts.
 *
 * Unset values are omitted rather than defaulted: leaving a field out keeps the routed
 * model's own default, which is not always the neutral value a default would impose.
 */
export function buildSamplingBody(
  settings: Partial<Record<SamplingKey, number | undefined>> | undefined,
  supportedParameters?: string[],
): Record<string, number> {
  if (!settings) return {};
  const body: Record<string, number> = {};
  for (const spec of supportedSamplingParameters(supportedParameters)) {
    const normalized = normalizeSamplingValue(spec.key, settings[spec.key]);
    if (normalized !== undefined) body[spec.wire] = normalized;
  }
  return body;
}
