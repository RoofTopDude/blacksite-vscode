/* Moved to @blacksite-agent/llm (packages/llm/src/bedrock-client.ts). Re-exported for existing imports. */
export {
  bedrockRuntimeEndpoint,
  buildRequestBody,
  converseBedrock,
  mantleEndpoint,
  mantleMessage,
  parseEventHeaders,
  readBedrockHttpError,
  readEventFrame,
  signBedrockRequest,
  streamBedrockConverse,
  type ConverseOptions,
  type EventFrameStep,
  type MantleMessageOptions,
  type MantleMessageResponse,
} from "@blacksite-agent/llm";
export { invokeBedrockEmbedding } from "./bedrock-embedding.js";
