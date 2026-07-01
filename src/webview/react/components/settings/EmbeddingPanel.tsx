import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { Field, Note, Section, Segmented } from "./common";
import {
  embeddingModelsForProvider, defaultEmbeddingForProvider, type EmbeddingProviderId,
} from "../../../../embedding-models.js";

// Embeddings run on these providers; anthropic has no embeddings endpoint (falls back).
const EMBED_PROVIDERS: Array<{ id: EmbeddingProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "bedrock", label: "Bedrock" },
];

function resolveEmbedProvider(embProvider: ProviderName | undefined, mainProvider: ProviderName): EmbeddingProviderId {
  const candidate = embProvider ?? mainProvider;
  if (candidate === "bedrock" || candidate === "openrouter") return candidate;
  return "openai";
}

export function EmbeddingPanel() {
  const store = useStore();
  const emb = store.settings.embedding ?? undefined;

  const provider = resolveEmbedProvider(emb?.provider, store.settings.provider);
  const fallbackSpec = defaultEmbeddingForProvider(provider);
  const model = emb?.model ?? fallbackSpec.model;
  const dims = emb?.dims ?? fallbackSpec.dims;
  const models = embeddingModelsForProvider(provider);

  const isBedrock = provider === "bedrock";
  const keySet = isBedrock
    ? !!store.keyStatus.bedrock
    : !!store.keyStatus.openai || !!store.keyStatus.openrouter;
  const memTotal = store.memoryStats?.total ?? 0;

  function selectModel(spec: { model: string; dims: number }): void {
    actions.setEmbedding({ provider, model: spec.model, dims: spec.dims });
  }

  function selectProvider(p: EmbeddingProviderId): void {
    // Model catalogs differ per provider, so reseed to the new provider's default.
    const def = defaultEmbeddingForProvider(p);
    actions.setEmbedding({ provider: p, model: def.model, dims: def.dims });
  }

  return (
    <Section>
      <Field label="Embedding Model">
        <Note>
          Used for the agent memory index (semantic search over past actions &amp; compressed history) and the
          Data workbench vectors. OpenAI &amp; OpenRouter embed with a bearer key; Bedrock embeds with your AWS
          credentials (Titan / Cohere). Without a usable key, a local sparse fallback is used.
        </Note>
      </Field>

      <Field label="Embedding Provider">
        <Segmented options={EMBED_PROVIDERS} value={provider} onChange={selectProvider} />
        {!keySet && (
          <div className="text-[9.5px] text-[color:var(--s-warn)]">
            {isBedrock
              ? "No AWS credentials set — embeddings fall back to local sparse vectors. Add credentials in the Model tab."
              : "No OpenAI/OpenRouter key set — embeddings fall back to local sparse vectors. Add a key in the Model tab."}
          </div>
        )}
      </Field>

      <Field label="Model" hint="Dimensions are fixed per model. Changing the model or dimensions invalidates existing vectors — rebuild after switching.">
        <div className="flex flex-col gap-1">
          {models.map((spec) => {
            const selected = spec.model === model && spec.dims === dims;
            return (
              <button
                key={`${spec.model}:${spec.dims}`}
                type="button"
                onClick={() => selectModel(spec)}
                className={cn(
                  "chat-interactive flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px]",
                  selected
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                {selected && <span className="text-[11px] text-primary">✓</span>}
                <span className="truncate">{spec.label}</span>
                <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/60">{spec.dims}d</span>
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Rebuild Index" hint="Clears vectors embedded under the previous model so search stays correct. The agent memory index re-populates as the agent works; re-import Data workbench collections to re-embed them.">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => actions.rebuildEmbeddings()}>
            <RefreshCw className="size-3" /> Rebuild now
          </Button>
          <span className="text-[9.5px] text-muted-foreground">
            {memTotal > 0 ? `${memTotal} vector${memTotal !== 1 ? "s" : ""} in memory index` : "Index empty"}
          </span>
        </div>
      </Field>
    </Section>
  );
}
