/* Pure embedding-model catalog + provider-specific request/response shaping.
   Deliberately dependency-free (no node:crypto, no fetch) so it can be imported by
   BOTH the extension host (embedding-service, bedrock-client) and the webview
   settings panel without dragging Node built-ins into the browser bundle. */

export type EmbeddingProviderId = "openai" | "openrouter" | "bedrock" | "voyage";

/** A concrete embedding model + the output dimensionality requested from it. */
export interface EmbeddingModelSpec {
  /** Model id sent to the embeddings endpoint. */
  model: string;
  /** Output vector dimensions. Must stay fixed for a given index — changing it invalidates stored vectors. */
  dims: number;
}

export interface EmbeddingModelOption extends EmbeddingModelSpec {
  label: string;
  provider: EmbeddingProviderId;
}

/** OpenAI embedding models. OpenRouter proxies the same OpenAI-compatible endpoint. */
const OPENAI_MODELS: ReadonlyArray<EmbeddingModelSpec & { label: string }> = [
  { model: "text-embedding-3-small", dims: 512,  label: "3-small (512d) — default, fast & cheap" },
  { model: "text-embedding-3-small", dims: 1536, label: "3-small (1536d) — full quality" },
  { model: "text-embedding-3-large", dims: 1024, label: "3-large (1024d) — higher quality" },
  { model: "text-embedding-3-large", dims: 3072, label: "3-large (3072d) — max quality" },
];

/** Amazon Bedrock embedding models (Titan Text + Cohere Embed). */
const BEDROCK_MODELS: ReadonlyArray<EmbeddingModelSpec & { label: string }> = [
  { model: "amazon.titan-embed-text-v2:0", dims: 256,  label: "Titan Text v2 (256d) — compact" },
  { model: "amazon.titan-embed-text-v2:0", dims: 512,  label: "Titan Text v2 (512d) — default" },
  { model: "amazon.titan-embed-text-v2:0", dims: 1024, label: "Titan Text v2 (1024d) — max quality" },
  { model: "amazon.titan-embed-text-v1",   dims: 1536, label: "Titan Text v1 (1536d)" },
  { model: "cohere.embed-english-v3",       dims: 1024, label: "Cohere Embed English v3 (1024d)" },
  { model: "cohere.embed-multilingual-v3",  dims: 1024, label: "Cohere Embed Multilingual v3 (1024d)" },
];

/** Voyage AI embedding models — Anthropic's recommended embeddings partner (anthropic has no
 *  embeddings endpoint of its own). `output_dimension` is only accepted by voyage-3-large and
 *  voyage-code-3; the others have a fixed output size, so only one dims entry is listed for them. */
const VOYAGE_MODELS: ReadonlyArray<EmbeddingModelSpec & { label: string }> = [
  { model: "voyage-3.5",      dims: 1024, label: "Voyage 3.5 (1024d) — default, general purpose" },
  { model: "voyage-3.5-lite", dims: 1024, label: "Voyage 3.5 Lite (1024d) — fast & cheap" },
  { model: "voyage-code-3",   dims: 1024, label: "Voyage Code 3 (1024d) — code-optimized, default dims" },
  { model: "voyage-code-3",   dims: 512,  label: "Voyage Code 3 (512d) — code-optimized, compact" },
  { model: "voyage-3-large",  dims: 1024, label: "Voyage 3 Large (1024d) — max quality, default dims" },
];

export const EMBEDDING_MODELS: Record<EmbeddingProviderId, ReadonlyArray<EmbeddingModelOption>> = {
  openai:     OPENAI_MODELS.map((m) => ({ ...m, provider: "openai" as const })),
  openrouter: OPENAI_MODELS.map((m) => ({ ...m, provider: "openrouter" as const })),
  bedrock:    BEDROCK_MODELS.map((m) => ({ ...m, provider: "bedrock" as const })),
  voyage:     VOYAGE_MODELS.map((m) => ({ ...m, provider: "voyage" as const })),
};

export const DEFAULT_EMBEDDING_SPEC: EmbeddingModelSpec = { model: "text-embedding-3-small", dims: 512 };
const BEDROCK_DEFAULT_SPEC: EmbeddingModelSpec = { model: "amazon.titan-embed-text-v2:0", dims: 512 };
const VOYAGE_DEFAULT_SPEC: EmbeddingModelSpec = { model: "voyage-3.5", dims: 1024 };

/** Models offered for a given provider. Unknown/anthropic providers fall back to OpenAI. */
export function embeddingModelsForProvider(provider: string): ReadonlyArray<EmbeddingModelOption> {
  if (provider === "bedrock") return EMBEDDING_MODELS.bedrock;
  if (provider === "openrouter") return EMBEDDING_MODELS.openrouter;
  if (provider === "voyage") return EMBEDDING_MODELS.voyage;
  return EMBEDDING_MODELS.openai;
}

/** The default model+dims to seed when a provider is first selected. */
export function defaultEmbeddingForProvider(provider: string): EmbeddingModelSpec {
  if (provider === "bedrock") return { ...BEDROCK_DEFAULT_SPEC };
  if (provider === "voyage") return { ...VOYAGE_DEFAULT_SPEC };
  return { ...DEFAULT_EMBEDDING_SPEC };
}

/** True for a Voyage model that accepts `output_dimension` on the request — the rest have a
 *  fixed output size and reject the field. */
export function voyageSupportsOutputDimension(modelId: string): boolean {
  return modelId === "voyage-3-large" || modelId === "voyage-code-3";
}

export function isTitanV2EmbeddingModel(modelId: string): boolean {
  return modelId.startsWith("amazon.titan-embed-text-v2");
}
export function isTitanEmbeddingModel(modelId: string): boolean {
  return modelId.startsWith("amazon.titan-embed");
}
export function isCohereEmbeddingModel(modelId: string): boolean {
  return modelId.startsWith("cohere.embed");
}

const TITAN_V2_ALLOWED_DIMS = [256, 512, 1024];

/** Build the model-specific InvokeModel request body for a Bedrock embedding call. */
export function buildBedrockEmbeddingBody(modelId: string, text: string, dims?: number): Record<string, unknown> {
  const inputText = text.slice(0, 8_000);
  if (isTitanV2EmbeddingModel(modelId)) {
    const requested = dims && TITAN_V2_ALLOWED_DIMS.includes(dims) ? dims : 1024;
    return { inputText, dimensions: requested, normalize: true };
  }
  if (isTitanEmbeddingModel(modelId)) {
    // Titan v1 has a fixed output size — no dimensions parameter.
    return { inputText };
  }
  if (isCohereEmbeddingModel(modelId)) {
    return { texts: [inputText], input_type: "search_document", truncate: "END" };
  }
  // Unknown Bedrock embedding model — assume a Titan-style body.
  return { inputText };
}

/** Extract the embedding vector from a Bedrock InvokeModel response across Titan/Cohere shapes. */
export function parseBedrockEmbeddingResponse(_modelId: string, data: unknown): number[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;

  // Titan: { embedding: number[] }
  if (Array.isArray(record.embedding)) return record.embedding.map(Number);

  // Cohere v3: { embeddings: number[][] } or embeddings-by-type { embeddings: { float: number[][] } }
  const embs = record.embeddings;
  if (Array.isArray(embs) && Array.isArray(embs[0])) return (embs[0] as unknown[]).map(Number);
  if (embs && typeof embs === "object") {
    const byType = (embs as Record<string, unknown>).float ?? (embs as Record<string, unknown>).int8;
    if (Array.isArray(byType) && Array.isArray(byType[0])) return (byType[0] as unknown[]).map(Number);
  }
  return [];
}
