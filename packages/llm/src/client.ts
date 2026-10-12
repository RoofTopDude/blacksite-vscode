/*
  The entry point: a client for one conversation on one provider route. It picks the route from
  its config and the requested model, and keeps what the routes learn about the endpoint (the
  capability latches) for the rest of the conversation.
*/
import { isOpenAIReasoningModel } from "./model-limits.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamBedrockConverseTurn } from "./providers/bedrock-converse.js";
import { streamBedrockMantle } from "./providers/bedrock-mantle.js";
import { streamOpenAIChat } from "./providers/openai-chat.js";
import { streamOpenAIResponses } from "./providers/openai-responses.js";
import { freshLatches, type ModelClientConfig, type ModelRequest, type TransportLatches } from "./transport/request.js";
import type { ProviderTurnStreamEvent } from "./types.js";

/** The wire format a request goes out in. */
export type ModelRoute = "anthropic" | "bedrock-converse" | "bedrock-mantle" | "openai-chat" | "openai-responses";

/** Anything that can stream a model turn: the built-in client, a gateway, a test double. */
export interface ModelTransport {
  stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ProviderTurnStreamEvent>;
}

/** Which route a request for `model` takes under `config`. */
export function modelRouteFor(config: ModelClientConfig, model: string): ModelRoute {
  switch (config.provider) {
    case "anthropic": return "anthropic";
    case "bedrock": return config.bedrockApi === "mantle" ? "bedrock-mantle" : "bedrock-converse";
    case "openai": return config.useResponsesApi && isOpenAIReasoningModel(model) ? "openai-responses" : "openai-chat";
    case "openrouter": return "openai-chat";
  }
}

/**
 * Streams model turns for one conversation. Create one per conversation, never share one: the
 * latches it keeps (a rejected cache marker, an unsupported strict schema) are facts about this
 * conversation's endpoint and model.
 */
export class ModelClient implements ModelTransport {
  readonly latches: TransportLatches = freshLatches();

  constructor(readonly config: ModelClientConfig) {}

  stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ProviderTurnStreamEvent> {
    const ctx = { config: this.config, latches: this.latches, signal };
    switch (modelRouteFor(this.config, req.model)) {
      case "anthropic": return streamAnthropic(ctx, req);
      case "bedrock-converse": return streamBedrockConverseTurn(ctx, req);
      case "bedrock-mantle": return streamBedrockMantle(ctx, req);
      case "openai-responses": return streamOpenAIResponses(ctx, req);
      case "openai-chat": return streamOpenAIChat(ctx, req);
    }
  }
}

export function createModelClient(config: ModelClientConfig): ModelClient {
  return new ModelClient(config);
}
