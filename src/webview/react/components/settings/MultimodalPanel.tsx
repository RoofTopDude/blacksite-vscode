import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { Field, Note, Row, Section, Segmented } from "./common";
import { PROVIDER_TABS } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

/** Media routing is deliberately collected into one panel. A user can see at a glance whether
 * image and audio attachments will be understood by the selected model or bridged elsewhere. */
export function MultimodalPanel() {
  const store = useStore();
  const vision = store.settings.visionFallback ?? undefined;
  const audio = store.settings.audioTranscription ?? {};
  const [provider, setProvider] = useState<ProviderName>(vision?.provider ?? store.settings.provider);
  const [language, setLanguage] = useState(audio.language ?? "");
  const models = store.providerModels[provider] ?? [];
  const loading = !!store.providerModelsLoading[provider];
  const providerKeySet = !!store.keyStatus[provider];
  const openAiKeySet = !!store.keyStatus.openai;
  const audioEnabled = audio.enabled !== false;

  useEffect(() => {
    if (providerKeySet) actions.refreshModels(provider);
  }, [provider, providerKeySet]);

  useEffect(() => {
    setLanguage(audio.language ?? "");
  }, [audio.language]);

  return (
    <Section>
      <Field label="Attachment routing">
        <Note>
          Images are sent directly to the active model when it supports vision. Text-only models can receive a
          separate model&apos;s description instead. Audio is transcribed to shared text context, so it works with
          Anthropic, OpenRouter, OpenAI, and Bedrock conversations alike.
        </Note>
      </Field>

      <div className="rounded-lg border border-border bg-white/[0.018] p-2.5">
        <Field label="Image fallback">
          <Note>
            Used automatically for image attachments when the active chat model has no native vision input.
          </Note>
        </Field>

        <div className="mt-2 flex items-center justify-between gap-2">
          {vision?.provider && vision.model ? (
            <span className="min-w-0 truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {vision.provider} · {vision.model}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">No fallback configured</span>
          )}
          {vision?.provider && vision.model && (
            <Button size="xs" variant="ghost" onClick={() => actions.clearVisionFallback()}>Disable</Button>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Field label="Fallback provider">
            <Segmented options={PROVIDER_TABS} value={provider} onChange={setProvider} />
          </Field>
          <Row label={provider === "bedrock" ? "AWS credentials" : "API key"}>
            <div className="flex items-center gap-1.5">
              <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", providerKeySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
                {providerKeySet ? "Ready" : "Not set"}
              </span>
              <Button size="xs" variant="outline" onClick={() => actions.setApiKey(provider)}>
                {providerKeySet ? "Change" : "Set"}
              </Button>
            </div>
          </Row>
          <Field label="Vision-capable model" hint="Use the Vision filter to narrow the catalog.">
            <ModelPickerList
              models={models}
              selectedId={vision?.provider === provider ? (vision.model ?? "") : ""}
              onSelect={(model) => actions.setVisionFallback({ provider, model })}
              provider={provider}
              loading={loading}
              onRefresh={() => actions.refreshModels(provider, { force: true })}
              maxHeightClass="max-h-[220px]"
            />
          </Field>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-white/[0.018] p-2.5">
        <Field label="Audio transcription bridge">
          <Note>
            On send, attached audio is uploaded to OpenAI&apos;s transcription endpoint using your OpenAI key. Its
            transcript is added to the agent turn and indexed with the original audio file. Audio never leaves the
            workspace when this is disabled or no key is configured.
          </Note>
        </Field>

        <div className="mt-2 flex flex-col gap-2">
          <Row label="Transcribe attached audio">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(event) => actions.setAudioTranscription({ enabled: event.target.checked })}
                className="size-3.5 accent-primary"
              />
              {audioEnabled ? "Enabled" : "Disabled"}
            </label>
          </Row>
          <Row label="OpenAI key">
            <div className="flex items-center gap-1.5">
              <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", openAiKeySet ? "border-[color:var(--s-ok)]/40 text-[color:var(--s-ok)]" : "border-border text-muted-foreground")}>
                {openAiKeySet ? "Ready" : "Not set"}
              </span>
              <Button size="xs" variant="outline" onClick={() => actions.setApiKey("openai")}>
                {openAiKeySet ? "Change" : "Set key"}
              </Button>
            </div>
          </Row>
          <Field label="Transcription model">
            <select
              value={audio.model ?? "gpt-4o-mini-transcribe"}
              onChange={(event) => actions.setAudioTranscription({ model: event.target.value })}
              disabled={!audioEnabled}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe — fast default</option>
              <option value="gpt-4o-transcribe">gpt-4o-transcribe — higher fidelity</option>
              <option value="whisper-1">whisper-1 — compatibility</option>
            </select>
          </Field>
          <Field label="Language hint" hint="Optional, for example en or es. Leave blank for automatic detection.">
            <Input
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              onBlur={() => actions.setAudioTranscription({ language })}
              disabled={!audioEnabled}
              placeholder="Auto-detect"
              maxLength={16}
              className="h-8 text-sm"
            />
          </Field>
        </div>
      </div>
    </Section>
  );
}
