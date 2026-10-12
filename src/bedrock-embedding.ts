/* Bedrock text embeddings (InvokeModel). Kept in the extension: embeddings are not part of the
   model transport package yet. Signing and error handling come from it. */
import { bedrockRuntimeEndpoint, readBedrockHttpError, signBedrockRequest, type BedrockCredentials } from "@blacksite-agent/llm";
import { buildBedrockEmbeddingBody, parseBedrockEmbeddingResponse } from "./embedding-models.js";


/**
 * Generate an embedding via a Bedrock text-embedding model (Titan Text v1/v2 or
 * Cohere Embed v3) using the InvokeModel endpoint. Request/response shaping is
 * delegated to the pure embedding-models helpers so it can be unit-tested without
 * network or crypto. Throws on a non-OK response or an empty vector.
 */
export async function invokeBedrockEmbedding(
  credentials: BedrockCredentials,
  modelId: string,
  text: string,
  dims?: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const url = `${bedrockRuntimeEndpoint(credentials.region)}/model/${encodeURIComponent(modelId)}/invoke`;
  const body = JSON.stringify(buildBedrockEmbeddingBody(modelId, text, dims));
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const signedHeaders = await signBedrockRequest(credentials, "POST", url, headers, body);

  const response = await fetch(url, { method: "POST", headers: signedHeaders, body, signal });
  if (!response.ok) throw await readBedrockHttpError(response);
  const data = (await response.json()) as unknown;
  const embedding = parseBedrockEmbeddingResponse(modelId, data);
  if (!embedding.length) throw new Error("empty Bedrock embedding response");
  return embedding;
}
