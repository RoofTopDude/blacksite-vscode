import { settingAnchor } from "./search";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Sentence case preserves acronyms and provider names. */
function sentenceCase(label: string): string {
  return label.replace(/\b[A-Z][a-z]+\b/g, (word, offset: number) => offset === 0 ? word : word.toLowerCase());
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const split = hint && hint.length > 160 ? hint.search(/\.\s/) : -1;
  const summary = split > 0 ? hint!.slice(0, split + 1) : hint;
  const details = split > 0 ? hint!.slice(split + 2) : undefined;
  return (
    <fieldset className="settings-field" data-setting={settingAnchor(label)} aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="settings-field-label">{sentenceCase(label)}</legend>
      {hint && <div id={`${id}-hint`} className="settings-field-hint">{summary}</div>}
      <div className="settings-field-controls">{children}</div>
      {details && <details className="settings-help"><summary>Details</summary><p>{details}</p></details>}
    </fieldset>
  );
}
export function Row({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div className="settings-control-row" data-setting={settingAnchor(label)} role="group" aria-labelledby={id}>
    <span id={id}>{sentenceCase(label)}</span><div className="settings-row-control">{children}</div>
  </div>;
}
export function Note({ children }: { children: ReactNode }) { return <p className="settings-note">{children}</p>; }
export function Section({ children }: { children: ReactNode }) { return <div className="settings-field-group">{children}</div>; }

/** Compact segmented control (provider pickers, etc.). */
export function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md border border-border bg-white/[0.02] p-0.5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-[var(--dur-2)] ease-[var(--ease-out)] active:scale-[0.97]",
            value === opt.id
              ? "bg-primary/20 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_1px_6px_rgba(139,92,246,0.16)]"
              : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
