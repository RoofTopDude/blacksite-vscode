import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { Field, Note, Section, Segmented } from "./common";
import { PROVIDER_TABS } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

export function VisionFallbackPanel() {
  const store = useStore();
  const vf = store.settings.visionFallback ?? undefined;
  const [provider, setProvider] = useState<ProviderName>(vf?.provider ?? store.settings.provider);

  const models = store.providerModels[provider] ?? [];
  const loading = !!store.providerModelsLoading[provider];
  const keySet = !!store.keyStatus[provider];
  const isBedrock = provider === "bedrock";

  // Refresh whenever this panel opens or the picked provider changes — TTL-guarded
  // in the store, cached list stays rendered while the refresh runs.
  useEffect(() => {
    if (keySet) actions.refreshModels(provider);
  }, [provider, keySet]);

  function selectProvider(p: ProviderName): void {
    setProvider(p);
  }

  return (
    <Section>
      <Field label="Vision Fallback Model">
        <Note>
          When the active chat model can&apos;t see images, reference_zoom_image routes the cropped region to
          this model instead and returns its text description in place of the raw image. Leave unset to have
          zoomed images go unseen on non-vision models — the human user can still view them in the transcript.
        </Note>
      </Field>

      <Field label="Currently configured">
        {vf?.provider && vf.model ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {vf.provider} · {vf.model}
            </span>
            <Button size="xs" variant="ghost" onClick={() => actions.clearVisionFallback()}>Disable</Button>
          </div>
        ) : (
          <span className="text-[10.5px] text-muted-foreground">Not configured — vision fallback is off.</span>
        )}
      </Field>

      <Field label="Provider">
        <Segmented options={PROVIDER_TABS} value={provider} onChange={selectProvider} />
      </Field>

      <Field label={isBedrock ? "AWS Credentials" : "API Key"} hint={keySet ? undefined : `Set your ${provider} key to fetch live models.`}>
        <div className="flex items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", keySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
            {keySet ? (isBedrock ? "Credentials set" : "Key set") : (isBedrock ? "No credentials" : "No key")}
          </span>
          <Button size="xs" variant="outline" onClick={() => actions.setApiKey(provider)}>
            {keySet ? "Change" : (isBedrock ? "Set credentials" : "Set key")}
          </Button>
        </div>
      </Field>

      <Field label="Model" hint="Pick a vision-capable model — use the Vision filter chip below to narrow the list.">
        <ModelPickerList
          models={models}
          selectedId={vf?.provider === provider ? (vf?.model ?? "") : ""}
          onSelect={(id) => actions.setVisionFallback({ provider, model: id })}
          provider={provider}
          loading={loading}
          onRefresh={() => actions.refreshModels(provider, { force: true })}
        />
      </Field>
    </Section>
  );
}
