/* Autocompleting relation fields.
 *
 * One component behind every "which files?", "which labels?", "which tickets?" question, with
 * the vocabulary swapped by `field`. Consistency matters more than it looks here: these are the
 * fields that turn a ticket from a sentence into something joinable to the Codebase Map, and if
 * adding a file feels different from adding a label, people add neither.
 *
 * Keyboard contract, identical in every instance: type to filter, ↑/↓ to move, Enter to accept
 * the highlighted row, Tab to accept and stay, Backspace on an empty input to remove the last
 * token, Escape to close the list without losing what's typed.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSuggest, type SuggestField, type Suggestion } from "./useSuggest";

export interface TokenFieldProps {
  field: SuggestField;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Accept values with no matching suggestion — right for labels, wrong for file ids. */
  allowFreeform?: boolean;
  /** Shape a freeform entry before it is accepted (labels are kebab-cased, paths normalized). */
  normalize?: (raw: string) => string;
  /** Render a token's visible text; defaults to the value itself. */
  renderToken?: (value: string) => string;
  max?: number;
  ariaLabel?: string;
  className?: string;
  autoFocus?: boolean;
}

export function TokenField({
  field, values, onChange, placeholder, allowFreeform = false, normalize,
  renderToken, max = 20, ariaLabel, className, autoFocus,
}: TokenFieldProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { items, loading } = useSuggest(field, draft, values, open);

  const atCapacity = values.length >= max;
  const freeformValue = allowFreeform && draft.trim() ? (normalize ? normalize(draft) : draft.trim()) : "";
  const showCreate = Boolean(freeformValue)
    && !values.includes(freeformValue)
    && !items.some((item) => item.value === freeformValue);
  const rows: Array<Suggestion & { isCreate?: boolean }> = showCreate
    ? [{ value: freeformValue, label: freeformValue, hint: "new", isCreate: true }, ...items]
    : items;

  useEffect(() => { setActive(0); }, [draft, open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("focusin", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("focusin", close, true);
    };
  }, [open]);

  const accept = useCallback((value: string) => {
    const clean = value.trim();
    if (!clean || values.includes(clean) || values.length >= max) return;
    onChange([...values, clean]);
    setDraft("");
    setActive(0);
    inputRef.current?.focus();
  }, [values, onChange, max]);

  function remove(value: string): void {
    onChange(values.filter((entry) => entry !== value));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Backspace" && !draft && values.length > 0) {
      event.preventDefault();
      onChange(values.slice(0, -1));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => {
        const next = index + (event.key === "ArrowDown" ? 1 : -1);
        return Math.max(0, Math.min(next, rows.length - 1));
      });
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const row = rows[active];
      if (!row && !(event.key === "Enter" && freeformValue)) return;
      // Tab still moves focus when there is nothing to accept, so the form stays traversable.
      event.preventDefault();
      accept(row ? row.value : freeformValue);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={cn("token-field", open && "is-open", className)}>
      <div className="token-field-box" onClick={() => inputRef.current?.focus()}>
        {values.map((value) => (
          <span key={value} className="token" data-field={field}>
            <span className="token-text" title={value}>{renderToken ? renderToken(value) : value}</span>
            <button
              type="button"
              className="token-remove"
              aria-label={`Remove ${value}`}
              onClick={(event) => { event.stopPropagation(); remove(value); }}
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}
        {!atCapacity && (
          <input
            ref={inputRef}
            className="token-input"
            value={draft}
            placeholder={values.length === 0 ? placeholder : ""}
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listId}
            autoFocus={autoFocus}
            onFocus={() => setOpen(true)}
            onChange={(event) => { setDraft(event.target.value); setOpen(true); }}
            onKeyDown={onKeyDown}
          />
        )}
        {/* At max 1 the filled token IS the answer; announcing a cap of one would be noise. */}
        {atCapacity && max > 1 && <span className="token-field-full">max {max}</span>}
      </div>

      {open && (rows.length > 0 || loading) && (
        <div id={listId} role="listbox" className="token-list reveal-in">
          {rows.map((row, index) => (
            <div
              key={`${row.value}-${index}`}
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              className="token-option"
              onPointerEnter={() => setActive(index)}
              onClick={() => accept(row.value)}
            >
              <span className="token-option-label">{row.label}</span>
              {row.kind && <span className={`token-option-kind is-${row.kind}`}>{row.kind.replace(/_/g, " ")}</span>}
              {row.hint && <span className="token-option-hint">{row.isCreate ? "create" : row.hint}</span>}
            </div>
          ))}
          {loading && rows.length === 0 && <div className="token-option is-quiet">Searching…</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The single-value form of the same control — a plan link, a duplicate-of pointer.
 *
 * Shares TokenField's list rather than reimplementing it: at one value the token IS the state,
 * so the input hides once something is chosen and the ✕ is how you change your mind.
 */
export function PickerField({
  field, value, onChange, placeholder, renderValue, ariaLabel, className,
}: {
  field: SuggestField;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  renderValue?: (value: string) => string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <TokenField
      field={field}
      values={value ? [value] : []}
      onChange={(values) => onChange(values[values.length - 1] ?? "")}
      max={1}
      placeholder={placeholder}
      renderToken={renderValue}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}
