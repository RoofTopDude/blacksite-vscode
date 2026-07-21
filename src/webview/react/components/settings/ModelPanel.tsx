import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { Field, Note, Row, Section, Segmented } from "./common";
import { PROVIDER_TABS, currentProviderSettings } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

/** Comma-separated draft text <-> the trimmed, non-empty string array the setting stores. */
function parseCommaList(text: string): string[] | undefined {
  const arr = text.split(",").map((s) => s.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export function ModelPanel() {
  const store = useStore();
  const { settings, allModels, modelsLoading, modelsError, modelsNotice } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const orCfg = settings.openrouterConfig ?? {};
  const [orReferer, setOrReferer] = useState(orCfg.httpReferer ?? "");
  const [orTitle, setOrTitle] = useState(orCfg.xTitle ?? "");
  const [orFallbackModels, setOrFallbackModels] = useState((orCfg.fallbackModels ?? []).join(", "));
  const [orProviderOrder, setOrProviderOrder] = useState((orCfg.providerOrder ?? []).join(", "));
  const [baseUrl, setBaseUrl] = useState(ps.baseUrl ?? "");
  // Keep the local draft in step when the provider tab changes (each provider has its own override).
  useEffect(() => { setBaseUrl(currentProviderSettings(settings).baseUrl ?? ""); }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

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
      ? "Set your AWS region + access/secret keys, or leave this unset if you already have AWS credentials configured elsewhere (AWS_* environment variables, or a profile in ~/.aws/credentials) — Blacksite picks those up automatically."
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
          <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", keySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
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
          notice={modelsNotice}
          onRefresh={() => actions.refreshModels(provider, { force: true })}
        />
      </Field>

      {!isBedrock && (
        <Field
          label="Endpoint"
          hint="Optional full URL override for the chat endpoint — an Azure OpenAI deployment, a corporate proxy, or a local OpenAI-compatible server (Ollama, LM Studio, vLLM). Blank uses the provider's official endpoint. Model listing still uses the official catalog; with an unreachable catalog the built-in model list applies."
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => actions.setBaseUrl(provider, baseUrl)}
            placeholder={DEFAULT_ENDPOINTS[provider] ?? ""}
            className="h-7 text-sm"
          />
        </Field>
      )}

      {provider === "openrouter" && (
        <>
          <Separator />
          <Field
            label="OpenRouter Headers"
            hint="Optional. Controls which site is credited in the OpenRouter dashboard and usage stats."
          >
            <Note>
              These headers are sent with every request. Leave blank to use the Blacksite defaults
              (<code className="rounded bg-primary/15 px-1 text-xs text-primary">blacksite.dev</code> / <code className="rounded bg-primary/15 px-1 text-xs text-primary">Blacksite</code>).
            </Note>
            <div className="mt-1 flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">HTTP-Referer</label>
                <Input
                  value={orReferer}
                  onChange={(e) => setOrReferer(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ httpReferer: orReferer.trim() || undefined, xTitle: orTitle.trim() || undefined })}
                  placeholder="https://your-domain.com"
                  className="h-7 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">X-Title</label>
                <Input
                  value={orTitle}
                  onChange={(e) => setOrTitle(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ httpReferer: orReferer.trim() || undefined, xTitle: orTitle.trim() || undefined })}
                  placeholder="My App"
                  className="h-7 text-sm"
                />
              </div>
            </div>
          </Field>

          <Field
            label="Provider Routing"
            hint="Optional. Controls which upstream providers OpenRouter routes this model to, and in what order."
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Model fallback list (comma-separated)</label>
                <Input
                  value={orFallbackModels}
                  onChange={(e) => setOrFallbackModels(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ fallbackModels: parseCommaList(orFallbackModels) ?? [] })}
                  placeholder="anthropic/claude-sonnet-5, openai/gpt-5.1"
                  className="h-7 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Provider order (comma-separated slugs)</label>
                <Input
                  value={orProviderOrder}
                  onChange={(e) => setOrProviderOrder(e.target.value)}
                  onBlur={() => actions.setOpenRouterConfig({ providerOrder: parseCommaList(orProviderOrder) ?? [] })}
                  placeholder="anthropic, google-vertex"
                  className="h-7 text-sm"
                />
              </div>
              <Row label="Allow fallback providers">
                <Switch
                  checked={orCfg.allowFallbacks !== false}
                  onCheckedChange={(c) => actions.setOpenRouterConfig({ allowFallbacks: c })}
                />
              </Row>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Data collection</label>
                <Segmented
                  options={[{ id: "unset", label: "Default" }, { id: "allow", label: "Allow" }, { id: "deny", label: "Deny (ZDR)" }]}
                  value={orCfg.dataCollection ?? "unset"}
                  onChange={(id) => actions.setOpenRouterConfig({ dataCollection: id === "unset" ? undefined : id })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Sort</label>
                <Segmented
                  options={[{ id: "unset", label: "Default" }, { id: "price", label: "Price" }, { id: "throughput", label: "Throughput" }, { id: "latency", label: "Latency" }]}
                  value={orCfg.sort ?? "unset"}
                  onChange={(id) => actions.setOpenRouterConfig({ sort: id === "unset" ? undefined : id })}
                />
              </div>
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}
