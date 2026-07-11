import { useEffect, useState } from "react";
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

  // The list is live data — refresh it whenever this panel opens or the provider
  // changes, so the user is never picking from a stale catalog. TTL-guarded in the
  // store; the cached list stays rendered while the refresh runs.
  useEffect(() => {
    if (keySet) actions.refreshModels(provider);
  }, [provider, keySet]);

  const isBedrock = provider === "bedrock";
  const bedrockApi = settings.bedrockApi ?? "converse";
  const keyLabel = isBedrock ? "AWS Credentials" : "API Key";
  const keyHint = keySet
    ? undefined
    : isBedrock
      ? "Set your AWS region + access/secret keys to fetch live Bedrock models and start chatting."
      : `Set your ${provider} key to start chatting and fetch live models.`;

  return (
    <Section>
      <Field label="Provider">
        <Segmented options={PROVIDER_TABS} value={provider} onChange={(id) => actions.setProvider(id)} />
      </Field>

      {isBedrock && (
        <Field label="API">
          <Segmented
            options={[{ id: "converse", label: "Converse" }, { id: "mantle", label: "Messages (Mantle)" }]}
            value={bedrockApi}
            onChange={(id) => actions.setBedrockApi(id as "converse" | "mantle")}
          />
        </Field>
      )}

      <Field label={keyLabel} hint={keyHint}>
        <div className="flex items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", keySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
            {keySet ? (isBedrock ? "Credentials set" : "Key set") : (isBedrock ? "No credentials" : "No key")}
          </span>
          <Button size="xs" variant="outline" onClick={() => actions.setApiKey(provider)}>
            {keySet ? "Change" : (isBedrock ? "Set credentials" : "Set key")}
          </Button>
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
          onRefresh={() => actions.refreshModels(provider, { force: true })}
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
