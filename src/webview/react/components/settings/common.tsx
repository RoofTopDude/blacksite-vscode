import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A labelled settings row: small uppercase label above its control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-[9.5px] leading-snug text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

/** An inline control row: label on the left, control on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11.5px] text-foreground">{label}</span>
      {children}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-[10px] leading-relaxed text-muted-foreground">{children}</p>;
}

export function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}

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
            "flex-1 rounded px-2 py-1 text-[10.5px] font-medium transition-colors",
            value === opt.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
