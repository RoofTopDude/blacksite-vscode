import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional trailing detail, shown muted after the label in the open list. */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Accessible name, when no visible <label> is wired to this control. */
  ariaLabel?: string;
}

/**
 * Themed replacement for a native `<select>`.
 *
 * A native select's *popup* is drawn by the operating system: it ignores every custom
 * property, font and radius in this stylesheet, so opening one drops a platform-chrome
 * menu into the middle of the panel. The closed control can be styled; the list cannot.
 * This renders both from our own primitives instead, matching the disclosure and focus
 * language used everywhere else in the transcript.
 *
 * Deliberately not a full combobox — no typeahead, no search. These are short, fixed
 * option sets, and the extra affordances would be chrome nobody asked for.
 */
function Select({ value, options, onChange, disabled, placeholder = "Select…", className, ariaLabel }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = React.useState(Math.max(selectedIndex, 0));
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // Close on outside pointer or focus leaving the control entirely. Focus is tracked as
  // well as pointers so tabbing away closes the list rather than leaving it orphaned.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open]);

  // Opening always starts from the current value, and the active row is scrolled into
  // view so a long list does not open showing an unrelated part of itself.
  React.useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.max(selectedIndex, 0));
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  function commit(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  /** Skips disabled rows so arrow keys never park on an unselectable option. */
  function step(from: number, delta: number): number {
    for (let i = from + delta; i >= 0 && i < options.length; i += delta) {
      if (!options[i]?.disabled) return i;
    }
    return from;
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => step(index, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => step(index, -1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(step(-1, 1));
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(step(options.length, -1));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={rootRef} className={cn("bls-select", className)}>
      <button
        type="button"
        data-slot="select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((value_) => !value_)}
        onKeyDown={onKeyDown}
        className="bls-select-trigger"
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-180")} />
      </button>

      {open && (
        <div ref={listRef} role="listbox" aria-label={ariaLabel} className="bls-select-list reveal-in">
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                data-active={index === activeIndex}
                tabIndex={-1}
                onPointerEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => commit(index)}
                className={cn("bls-select-option", option.disabled && "bls-select-option-disabled")}
              >
                <Check className={cn("size-3 shrink-0", !isSelected && "opacity-0")} style={{ color: "var(--primary)" }} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && <span className="shrink-0 text-2xs text-muted-foreground">{option.hint}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { Select };
