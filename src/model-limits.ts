/* Moved to @blacksite-agent/llm (packages/llm/src/model-limits.ts). Re-exported for existing imports. */
export {
  bedrockSupportsCacheTtl1h,
  isOpenAIReasoningModel,
  resolveClaudeLimits,
  resolveContextWindow,
  resolveOutputCeiling,
  resolveReasoningEffort,
  shallowestReasoningEffort,
  supportedReasoningEfforts,
  toOpenRouterReasoningEffort,
  type ClaudeLimits,
  type OpenAIReasoningEffort,
} from "@blacksite-agent/llm";
