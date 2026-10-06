/* The Map's control vocabulary — one small set of primitives every panel is
   built from, so a button, a segmented choice, a switch, and a section title
   look and behave the same wherever they appear. Styling lives in
   theme.map.css (.map-btn, .map-seg, .map-switch-row, …) on the Map's own
   tokens; components here only choose structure and wire accessibility.

   Tooltips are plain `title`s on purpose: the Map is a dense instrument where
   a label has to stay short, and the title is where the full sentence goes. */

import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "ghost" | "outline" | "primary";

export function MapButton({ variant = "default", size = "sm", icon: Icon, active, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "xs" | "sm";
  icon?: LucideIcon;
  /** A toggle that is currently on. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn("map-btn", `map-btn-${variant}`, `map-btn-${size}`, active && "map-btn-active", className)}
      aria-pressed={active ?? props["aria-pressed"]}
    >
      {Icon && <Icon className="map-btn-icon" aria-hidden />}
      {children}
    </button>
  );
}

/** Square icon-only button; `label` is both its accessible name and its tooltip. */
export function MapIconButton({ icon: Icon, label, className, spin, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  /** Spin the glyph (work in progress, e.g. re-indexing). */
  spin?: boolean;
}) {
  return (
    <button type="button" className={cn("map-icon-btn", className)} aria-label={label} title={props.title ?? label} {...props}>
      <Icon className={cn("size-3.5", spin && "map-spin")} aria-hidden />
    </button>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** Stable hook for tests and the agent's map gateway. */
  control?: string;
}

/** One-of-N choice drawn as a single track (shadcn's tabs list), the chosen
    segment raised. Buttons with aria-pressed, which is what the Map's tests
    and screen readers already expect from these controls. */
export function MapSegmented<T extends string | number>({ value, options, onChange, label, className, size = "sm" }: {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: "xs" | "sm";
}) {
  return (
    <div className={cn("map-seg", `map-seg-${size}`, className)} role="group" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            className={cn("map-seg-item", on && "map-seg-on")}
            aria-pressed={on}
            title={option.title}
            disabled={option.disabled}
            data-map-control={option.control}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labelled on/off row: the whole row toggles, the switch shows the state. */
export function MapSwitchRow({ label, checked, onChange, title, meta, disabled, control, live }: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  /** Short trailing context (a count, "no data") shown before the switch. */
  meta?: ReactNode;
  disabled?: boolean;
  control?: string;
  /** Pulse a dot beside the label — something this switch is about is happening now. */
  live?: boolean;
}) {
  const id = useId();
  return (
    <label className={cn("map-switch-row", disabled && "map-switch-row-disabled")} htmlFor={id} title={title}>
      <span className="map-switch-label">
        {label}
        {live && <span className="map-live-pip" aria-hidden />}
      </span>
      {meta !== undefined && <span className="map-switch-meta">{meta}</span>}
      <Switch id={id} size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} data-map-control={control} aria-label={typeof label === "string" ? label : undefined} />
    </label>
  );
}

/** Titled group inside a panel. Sentence-case title, optional trailing action. */
export function MapSection({ title, action, children, className, region }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  region?: string;
}) {
  return (
    <div className={cn("map-section", className)} data-map-region={region}>
      {(title || action) && (
        <div className="map-section-head">
          {title && <div className="map-section-title">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/** Collapsible group. Native <details> so it is keyboard- and AT-correct for free. */
export function MapDisclosure({ title, meta, children, defaultOpen, region }: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  region?: string;
}) {
  return (
    <details className="map-disclosure" open={defaultOpen} data-map-region={region}>
      <summary>
        <ChevronRight className="map-disclosure-chevron" aria-hidden />
        <span className="map-disclosure-title">{title}</span>
        {meta !== undefined && <span className="map-disclosure-meta">{meta}</span>}
      </summary>
      <div className="map-disclosure-body">{children}</div>
    </details>
  );
}

export function MapKbd({ children }: { children: ReactNode }) {
  return <kbd className="map-kbd">{children}</kbd>;
}

/** Number + label cell for an inspector's stat strip; the full meaning goes in the tooltip. */
export function MapStat({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div className="map-stat-cell" title={title}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
