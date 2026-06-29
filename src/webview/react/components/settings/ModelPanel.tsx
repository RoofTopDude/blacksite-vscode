import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { Field, Note, Section, Segmented } from "./common";
import { PROVIDER_TABS, currentProviderSettings } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

export function ModelPanel() {
  const store = useStore();
  const { settings, allModels, modelsLoading, modelsError } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const orCfg = settings.openrouterConfig ?? {};
  const [orReferer, setOrReferer] = useState(orCfg.httpReferer ?? "");
  const [orTitle, setOrTitle] = useState(orCfg.xTitle ?? "");

  const keySet = !!store.keyStatus[provider];

  return (
    <Section>
      <Field label="Provider">
        <Segmented options={PROVIDER_TABS} value={provider} onChange={(id) => actions.setProvider(id)} />
      </Field>

      <Field label="API Key" hint={keySet ? undefined : `Set your ${provider} key to start chatting and fetch live models.`}>
        <div className="flex items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", keySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
            {keySet ? "Key set" : "No key"}
          </span>
          <Button size="xs" variant="outline" onClick={() => actions.setApiKey(provider)}>{keySet ? "Change" : "Set key"}</Button>
          {keySet && <Button size="xs" variant="ghost" onClick={() => actions.clearApiKey(provider)}>Clear</Button>}
        </div>
      </Field>

      <Field label="Model">
        <ModelPickerList
          models={allModels}
          selectedId={ps.model}
          onSelect={(id) => actions.setModel(provider, id)}
          provider={provider}
          loading={modelsLoading}
          error={modelsError}
          onRefresh={() => actions.fetchModels(provider)}
        />
      </Field>

      {provider === "openrouter" && (
        <>
          <Separator />
          <Field
            label="OpenRouter Headers"
            hint="Optional. Controls which site is credited in the OpenRouter dashboard and usage stats."
          >
            <Note>
              These headers are sent with every request. Leave blank to use the Blacksite defaults
              (<code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">blacksite.dev</code> / <code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">Blacksite</code>).
            </Note>
            <div className="mt-1 flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-muted-foreground">HTTP-Referer</label>
                <Input
                  value={orReferer}
                  onChange={(e) => setOrReferer(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ httpReferer: orReferer.trim() || undefined, xTitle: orTitle.trim() || undefined })}
                  placeholder="https://your-domain.com"
                  className="h-7 text-[11px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-muted-foreground">X-Title</label>
                <Input
                  value={orTitle}
                  onChange={(e) => setOrTitle(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ httpReferer: orReferer.trim() || undefined, xTitle: orTitle.trim() || undefined })}
                  placeholder="My App"
                  className="h-7 text-[11px]"
                />
              </div>
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}
