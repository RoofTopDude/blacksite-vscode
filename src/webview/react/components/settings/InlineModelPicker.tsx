/* Reusable inline chat-model picker keyed by provider. Generalised from the
   subagent picker so the Context (compaction) and other panels can let users
   SELECT a model instead of typing its id. Lazy-fetches the provider's model
   list on first open and caches it in the store. */

import { useEffect, useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { ModelPickerList } from "./ModelPickerList";

export interface InlineModelPickerProps {
  provider: ProviderName;
  selectedModel: string;
  onSelect: (model: string | undefined) => void;
  /** Label shown when nothing is selected (and the cleared state). */
  placeholder?: string;
}

export function InlineModelPicker({ provider, selectedModel, onSelect, placeholder = "Inherit parent model" }: InlineModelPickerProps) {
  const store = useStore();
  const [open, setOpen] = useState(false);

  const models = store.providerModels[provider] ?? [];
  const loading = store.providerModelsLoading[provider] ?? false;
  const keySet = !!store.keyStatus[provider];

  // Refresh on every open so the catalog is never stale — TTL-guarded in the store,
  // and the cached list stays rendered while the refresh runs.
  useEffect(() => {
    if (open && keySet) actions.refreshModels(provider);
  }, [open, provider, keySet]);

  const selectedName = models.find((m) => m.id === selectedModel)?.name ?? selectedModel;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-sm transition-colors",
            selectedModel
              ? "border-primary/40 bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
          )}
        >
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {selectedModel ? selectedName : placeholder}
          </span>
          {selectedModel && selectedName !== selectedModel && (
            <span className="ml-auto shrink-0 text-2xs text-muted-foreground/60">{selectedModel}</span>
          )}
        </button>
        {selectedModel && (
          <button
            type="button"
            title="Clear model"
            onClick={() => onSelect(undefined)}
            className="chat-interactive shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            if (!open) setOpen(true);
            actions.refreshModels(provider, { force: true });
          }}
          disabled={loading}
          title="Refresh model list"
        >
          Browse
        </Button>
      </div>

      {!keySet && (
        <div className="text-xs text-[color:var(--s-warn)]">
          No API key for {provider} — set it in the Model tab to browse live models.
        </div>
      )}

      {open && (
        <div className="rounded-md border border-border bg-white/[0.02] p-2">
          <ModelPickerList
            models={models}
            selectedId={selectedModel}
            onSelect={(id) => {
              onSelect(id === selectedModel ? undefined : id);
              setOpen(false);
            }}
            provider={provider}
            loading={loading}
            onRefresh={() => actions.refreshModels(provider, { force: true })}
            maxHeightClass="max-h-[240px]"
          />
        </div>
      )}
    </div>
  );
}
