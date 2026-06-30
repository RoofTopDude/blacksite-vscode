import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useStore, actions } from "@/lib/store";
import type { ProviderName } from "@/lib/protocol";
import { Field, Note, Row, Section, Segmented } from "./common";
import { PROVIDER_TABS } from "./helpers";
import { InlineModelPicker } from "./InlineModelPicker";

interface Form { enabled: boolean; triggerPct: number; keepRecent: number; provider: ProviderName; model: string; }

export function ContextPanel() {
  const store = useStore();
  const cmp = store.settings.compression;
  const [form, setForm] = useState<Form>({
    enabled: !!cmp?.enabled,
    triggerPct: cmp?.triggerPct ?? 60,
    keepRecent: cmp?.keepRecent ?? 20,
    provider: cmp?.provider ?? store.settings.provider,
    model: cmp?.model ?? "",
  });

  function save(next: Partial<Form>): void {
    const merged = { ...form, ...next };
    setForm(merged);
    actions.setCompression({
      enabled: merged.enabled,
      triggerPct: merged.triggerPct,
      keepRecent: merged.keepRecent,
      provider: merged.provider,
      model: merged.model || undefined,
    });
  }

  return (
    <Section>
      <Field label="History Compression">
        <Note>
          Automatically compresses older messages when the context window fills up. The agent receives a structured
          summary and a <code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">transcript_read</code> tool for the full history.
        </Note>
        <Row label="Enable compression">
          <Switch checked={form.enabled} onCheckedChange={(c) => save({ enabled: c })} />
        </Row>
      </Field>

      {form.enabled && (
        <>
          <Field label="Trigger At" hint="% of the context window that triggers compression.">
            <div className="flex items-center gap-3">
              <Slider min={20} max={85} step={5} value={[form.triggerPct]} onValueChange={(v) => setForm((f) => ({ ...f, triggerPct: v[0] ?? 60 }))} onValueCommit={(v) => save({ triggerPct: v[0] ?? 60 })} className="flex-1" />
              <span className="w-9 text-right font-mono text-[11px] tabular-nums text-foreground">{form.triggerPct}%</span>
            </div>
          </Field>

          <Field label="Keep Recent" hint="Messages kept verbatim after compression.">
            <Input type="number" min={4} max={80} value={form.keepRecent} onChange={(e) => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 4) save({ keepRecent: n }); }} className="h-7 w-24 text-[11px]" />
          </Field>

          <Field label="Compression Model" hint="Optional — leave blank to use the active model. A faster/cheaper model can be used for compression.">
            <Segmented options={PROVIDER_TABS} value={form.provider} onChange={(id) => save({ provider: id, model: "" })} />
            <div className="mt-1.5">
              <InlineModelPicker
                provider={form.provider}
                selectedModel={form.model}
                onSelect={(model) => save({ model: model ?? "" })}
                placeholder="Same as main model"
              />
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}
