// ── Types ──────────────────────────────────────────────────────────────────────

// Local alias to avoid circular import with agent-session.ts
type EmbedProvider = "anthropic" | "openrouter" | "openai";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_EMBED_DIMS  = 512;   // reduced dims — excellent quality, half the storage of default
const SPARSE_DIMS         = 512;   // fallback sparse vector dimensions
const CACHE_MAX           = 2_000;

/** A known embedding model and the output dimensionality used when requesting it. */
export interface EmbeddingModelSpec {
  /** Model id sent to the embeddings endpoint. */
  model: string;
  /** Output vector dimensions. Must stay fixed for a given index — changing it invalidates stored vectors. */
  dims: number;
}

/**
 * Curated embedding models offered in the settings selector. Embedding endpoints
 * are only available on the openai/openrouter providers; anthropic/bedrock fall back
 * to these via whichever of those keys is configured. `dims` is the recommended
 * output size — changing the model (and therefore dims) requires re-indexing.
 */
export const KNOWN_EMBEDDING_MODELS: ReadonlyArray<EmbeddingModelSpec & { label: string }> = [
  { model: "text-embedding-3-small", dims: 512,  label: "OpenAI · 3-small (512d) — default, fast & cheap" },
  { model: "text-embedding-3-small", dims: 1536, label: "OpenAI · 3-small (1536d) — full quality" },
  { model: "text-embedding-3-large", dims: 1024, label: "OpenAI · 3-large (1024d) — higher quality" },
  { model: "text-embedding-3-large", dims: 3072, label: "OpenAI · 3-large (3072d) — max quality" },
];

export const DEFAULT_EMBEDDING_SPEC: EmbeddingModelSpec = { model: DEFAULT_EMBED_MODEL, dims: DEFAULT_EMBED_DIMS };

// ── EmbeddingService ───────────────────────────────────────────────────────────

/**
 * Generates embeddings for text using either an API endpoint or a local sparse
 * bag-of-words fallback. The fallback requires no network calls and still
 * produces reasonable cosine-similarity search results for code content.
 */
export class EmbeddingService {
  private readonly cache = new Map<string, number[]>();

  private readonly model: string;
  private readonly dims: number;

  constructor(
    private readonly provider: EmbedProvider,
    private readonly getKey: (p: string) => Promise<string | undefined>,
    private readonly baseUrl?: string,
    spec?: Partial<EmbeddingModelSpec>,
  ) {
    this.model = spec?.model?.trim() || DEFAULT_EMBED_MODEL;
    this.dims  = spec?.dims && spec.dims > 0 ? spec.dims : DEFAULT_EMBED_DIMS;
  }

  /** The model id this service embeds with. */
  get modelId(): string { return this.model; }

  /** The output dimensionality this service produces (API path). */
  get dimensions(): number { return this.dims; }

  async embed(text: string): Promise<number[]> {
    const key = text.slice(0, 256);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let vec: number[];
    try {
      vec = await this._apiEmbed(text);
    } catch {
      vec = sparseEmbed(text);
    }

    if (this.cache.size >= CACHE_MAX) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  get isApiAvailable(): boolean {
    // Optimistic — real check happens at embed time
    return this.provider !== "anthropic";
  }

  private async _apiEmbed(text: string): Promise<number[]> {
    let apiKey: string | undefined;
    let url: string;

    if (this.provider === "openai") {
      apiKey = await this.getKey("openai");
      url = this.baseUrl ?? "https://api.openai.com/v1/embeddings";
    } else if (this.provider === "openrouter") {
      apiKey = await this.getKey("openrouter");
      url = "https://openrouter.ai/api/v1/embeddings";
    } else {
      // Anthropic doesn't have an embedding endpoint — try openai key first, then openrouter
      const openaiKey = await this.getKey("openai");
      const openrouterKey = await this.getKey("openrouter");
      if (openaiKey) {
        apiKey = openaiKey;
        url = "https://api.openai.com/v1/embeddings";
      } else if (openrouterKey) {
        apiKey = openrouterKey;
        url = "https://openrouter.ai/api/v1/embeddings";
      } else {
        url = "";
      }
    }

    if (!apiKey || !url) throw new Error("no embedding API key available");

    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text.slice(0, 8_000), dimensions: this.dims }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) throw new Error("empty embedding response");
    return emb;
  }
}

// ── Sparse bag-of-words fallback ───────────────────────────────────────────────
// Produces a TF-weighted, L2-normalised sparse vector for BM25-like similarity.
// No network calls required. Works reasonably well for code-related content.

export function sparseEmbed(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const vec = new Float32Array(SPARSE_DIMS);
  const counts = new Map<number, number>();
  for (const tok of tokens) {
    const dim = fnv32(tok) % SPARSE_DIMS;
    counts.set(dim, (counts.get(dim) ?? 0) + 1);
  }
  const total = tokens.length || 1;
  for (const [dim, count] of counts) {
    vec[dim] = (1 + Math.log(count)) / Math.sqrt(total);
  }

  // L2 normalise
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map((x) => x / norm);
}

function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}
