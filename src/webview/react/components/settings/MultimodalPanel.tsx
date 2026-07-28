import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { Field, Note, Row, Section, Segmented } from "./common";
import { PROVIDER_TABS } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

const TRANSCRIPTION_MODELS = [
  { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe", hint: "fast default" },
  { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe", hint: "higher fidelity" },
  { value: "whisper-1", label: "whisper-1", hint: "compatibility" },
];

/** Media routing is deliberately collected into one panel. A user can see at a glance whether
 * image and audio attachments will be understood by the selected model or bridged elsewhere. */
export function MultimodalPanel() {
  const store = useStore();
  const vision = store.settings.visionFallback ?? undefined;
  const audio = store.settings.audioTranscription ?? {};
  const [provider, setProvider] = useState<ProviderName>(vision?.provider ?? store.settings.provider);
  const [language, setLanguage] = useState(audio.language ?? "");
  const models = store.providerModels[provider] ?? [];
  // A fallback receives an image block directly. Allowing a text-only model here creates a
  // configuration that looks valid but fails only when the user sends an image.
  const visionModels = models.filter((model) => model.supportsVision);
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
          <Field label="Vision-capable model" hint="Only models the catalog reports as vision-capable are shown.">
            <ModelPickerList
              models={visionModels}
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
            {/* Switch rather than a native checkbox: the OS checkbox is the one control
                here that CSS cannot fully reskin, and every other on/off in Settings is
                already a Switch. */}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Switch
                checked={audioEnabled}
                onCheckedChange={(checked) => actions.setAudioTranscription({ enabled: checked })}
                aria-label="Transcribe attached audio"
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
            <Select
              value={audio.model ?? "gpt-4o-mini-transcribe"}
              onChange={(value) => actions.setAudioTranscription({ model: value })}
              disabled={!audioEnabled}
              ariaLabel="Transcription model"
              options={TRANSCRIPTION_MODELS}
            />
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
