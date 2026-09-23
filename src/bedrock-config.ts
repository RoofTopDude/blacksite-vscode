export type BedrockApiMode = "converse" | "mantle";

/** Converse default for a user who has not picked a model. Sonnet 5 through the US geo profile —
 *  the same routing geography the previous default used, one generation newer. */
export const BEDROCK_CONVERSE_DEFAULT_MODEL = "us.anthropic.claude-sonnet-5";
/** The previous Converse default (Claude Sonnet 4, May 2025). Still selectable through
 *  `blacksite.bedrock.latestDefaultModel: false`, for an account whose model access or approved
 *  model list has not caught up with Sonnet 5. */
export const BEDROCK_CONVERSE_LEGACY_DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-20250514-v1:0";
export const BEDROCK_MANTLE_DEFAULT_MODEL = "anthropic.claude-opus-5";

export function normalizeBedrockApi(api?: string): BedrockApiMode {
  return api === "mantle" ? "mantle" : "converse";
}

/** `latest: false` keeps the pre-Sonnet-5 Converse default. Mantle is unaffected: its default was
 *  already current. Only ever applies when no model has been chosen explicitly. */
export function defaultBedrockModel(api?: string, options: { latest?: boolean } = {}): string {
  if (normalizeBedrockApi(api) === "mantle") return BEDROCK_MANTLE_DEFAULT_MODEL;
  return options.latest === false ? BEDROCK_CONVERSE_LEGACY_DEFAULT_MODEL : BEDROCK_CONVERSE_DEFAULT_MODEL;
}
