/**
 * AWS Bedrock Converse API types — including streaming and extended thinking.
 *
 * Ported from the chrome extension (src/shared/bedrock-types.ts). The VS Code
 * extension splits the long-lived AWS credentials (BedrockCredentials, stored in
 * SecretStorage) from the per-call model id, which travels with the session's
 * `model` field.
 */

/** AWS credentials + region, stored as a JSON blob in VS Code SecretStorage. */
export interface BedrockCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

export type BedrockImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface BedrockImageBlock {
  image: {
    format: BedrockImageFormat;
    source: { bytes: string };
  };
}

export type BedrockToolResultContentBlock =
  | { text: string }
  | BedrockImageBlock;

/**
 * A Bedrock Converse `cachePoint` content block. Insert one after a stable prefix
 * (system text, tool list, or conversation history) to mark that prefix as
 * cache-eligible. Bedrock reads the cache point from the position it is inserted
 * and caches everything before it in that array.
 */
export interface BedrockCachePoint {
  cachePoint: { type: "default" };
}

export type BedrockContentBlock =
  | { text: string }
  | BedrockImageBlock
  | BedrockCachePoint
  | { reasoningContent: { reasoningText: { text: string } } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: BedrockToolResultContentBlock[] } };

export interface BedrockConverseRequest {
  modelId: string;
  messages: BedrockMessage[];
  system?: Array<{ text: string } | BedrockCachePoint>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  performanceConfig?: {
    thinking?: {
      type: "enabled" | "disabled";
      budgetTokens?: number;
    };
  };
  toolConfig?: {
    // A cachePoint may appear as its own entry after the stable tool list to mark
    // the tool schema block as cache-eligible.
    tools: Array<BedrockToolDef | BedrockCachePoint>;
    toolChoice?: { auto: Record<string, never> };
  };
}

export interface BedrockToolDef {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export interface BedrockUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface BedrockConverseResponse {
  output: {
    message: BedrockMessage;
  };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: BedrockUsage;
  metrics?: {
    latencyMs: number;
  };
}

/**
 * One decoded frame from the Bedrock ConverseStream event stream. `eventType`
 * comes from the frame's `:event-type` (or `:exception-type`) header; `data` is
 * the JSON payload (e.g. contentBlockStart, contentBlockDelta, messageStop).
 */
export interface BedrockConverseStreamEvent {
  eventType: string;
  data: Record<string, unknown>;
}
