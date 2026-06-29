export type BedrockApiMode = "converse" | "mantle";

export const BEDROCK_CONVERSE_DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-20250514-v1:0";
export const BEDROCK_MANTLE_DEFAULT_MODEL = "anthropic.claude-opus-4-8";

export function normalizeBedrockApi(api?: string): BedrockApiMode {
  return api === "mantle" ? "mantle" : "converse";
}

export function defaultBedrockModel(api?: string): string {
  return normalizeBedrockApi(api) === "mantle"
    ? BEDROCK_MANTLE_DEFAULT_MODEL
    : BEDROCK_CONVERSE_DEFAULT_MODEL;
}
