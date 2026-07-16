import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A labelled settings row: small uppercase label above its control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      {children}
      {hint && <div className="text-xs leading-snug text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

/** An inline control row: label on the left, control on the right. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-base text-foreground">{label}</span>
      {children}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
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
