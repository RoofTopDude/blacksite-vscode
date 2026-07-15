import { useEffect, useMemo, useRef, useState } from "react";
import { Zap, ChevronDown, Check } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import {
  EFFORT_LABELS,
  currentProviderSettings,
  effectiveReasoningEffort,
  fmtCtx,
  fmtK,
  isReasoningModel,
  modelShortLabel,
  selectedModelInfo,
  supportedReasoningEfforts,
} from "@/components/settings/helpers";

// ── Chip ───────────────────────────────────────────────────────────────────────

function Chip({
  active,
  onClick,
  children,
  title,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "lift flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9.5px] font-medium",
        active
          ? "chip-active border-primary/50 bg-primary/15 text-primary"
          : "border-border text-muted-foreground hover:border-border/60 hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Budget selector ────────────────────────────────────────────────────────────

const BUDGETS = [1000, 5000, 10000, 16000, 32000, 64000];

// ── Main component ─────────────────────────────────────────────────────────────

export function QuickSettings() {
  const store = useStore();
  const { settings } = store;
  const provider = settings.provider;
  const ps = currentProviderSettings(settings);
  const modelInfo = selectedModelInfo(settings, store.allModels);
  const supportsThinking = modelInfo ? !!modelInfo.supportsThinking : (provider === "anthropic" || provider === "bedrock");
  // OpenRouter carries the thinking budget via its unified `reasoning` parameter,
  // so the same toggle works there for models that support reasoning.
  const thinkingProvider = provider === "anthropic" || provider === "bedrock" || provider === "openrouter";
  const reasoning = isReasoningModel(ps.model);
  const thinking = ps.thinking ?? { enabled: false, budgetTokens: 10000 };

  const [tempOpen, setTempOpen] = useState(false);
  const tempRef = useRef<HTMLDivElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const modelRef = useRef<HTMLDivElement>(null);

  // Close popovers when clicking outside
  useEffect(() => {
    if (!tempOpen && !modelOpen) return;
    function onDown(e: MouseEvent) {
      if (tempOpen && !tempRef.current?.contains(e.target as Node)) setTempOpen(false);
      if (modelOpen && !modelRef.current?.contains(e.target as Node)) setModelOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [tempOpen, modelOpen]);

  // The switcher is live data — refresh the catalog every time it opens (TTL-guarded
  // in the store; the cached list stays rendered while the refresh runs).
  useEffect(() => {
    if (modelOpen && store.keyStatus[provider]) actions.refreshModels(provider);
  }, [modelOpen, provider, store.keyStatus]);

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    const list = store.allModels;
    if (!q) return list.slice(0, 50);
    return list.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)).slice(0, 50);
  }, [store.allModels, modelFilter]);

  return (
    <div className="flex flex-wrap items-center gap-1">

      {/* ── Model switcher ── */}
      <div className="relative" ref={modelRef}>
        <Chip
          active={modelOpen}
          title={`Model: ${ps.model}`}
          onClick={() => { setModelOpen((v) => !v); setModelFilter(""); }}
          className="max-w-[150px]"
        >
          <span className="truncate">{modelShortLabel(modelInfo ?? ps.model)}</span>
          <ChevronDown className="size-2.5 shrink-0 opacity-70" />
        </Chip>

        {modelOpen && (
          <div className="menu-pop absolute bottom-full left-0 z-30 mb-1.5 w-64 rounded-lg border border-border bg-popover p-1.5" style={{ "--pop-origin": "bottom left" } as React.CSSProperties}>
            <input
              autoFocus
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="Filter models…"
              className="mb-1.5 w-full rounded-md border border-border bg-white/[0.03] px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/40"
            />
            {store.modelsLoading && filteredModels.length > 0 && <div className="refresh-glint mb-1" aria-hidden />}
            <div className="max-h-[220px] overflow-y-auto">
              {store.modelsLoading && filteredModels.length === 0 ? (
                <div className="px-2 py-2 text-center text-[10.5px] text-muted-foreground">Loading models…</div>
              ) : filteredModels.length === 0 ? (
                <div className="px-2 py-2 text-center text-[10.5px] text-muted-foreground">No matching models</div>
              ) : filteredModels.map((m) => {
                const isSel = m.id === ps.model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { actions.setModel(provider, m.id); setModelOpen(false); }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/5",
                      isSel && "bg-primary/10",
                    )}
                  >
                    <Check className={cn("size-3 shrink-0", isSel ? "text-primary" : "opacity-0")} />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{modelShortLabel(m)}</span>
                    {m.contextLength ? <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{fmtCtx(m.contextLength)}</span> : null}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => { setModelOpen(false); actions.setView("settings"); }}
              className="mt-1 w-full rounded-md px-1.5 py-1 text-left text-[10px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              Manage models in Settings →
            </button>
          </div>
        )}
      </div>

      {/* ── Temperature ── */}
      <div className="relative" ref={tempRef}>
        <Chip
          active={tempOpen}
          title="Temperature"
          onClick={() => setTempOpen((v) => !v)}
        >
          T {(ps.temperature ?? 1).toFixed(2)}
        </Chip>

        {tempOpen && (
          <div className="menu-pop absolute bottom-full left-0 z-30 mb-1.5 w-52 rounded-lg border border-border bg-popover p-2.5" style={{ "--pop-origin": "bottom left" } as React.CSSProperties}>
            <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              Temperature
            </div>
            <div className="flex items-center gap-2">
              <Slider
                min={0} max={2} step={0.05}
                value={[ps.temperature ?? 1]}
                onValueChange={(v) => actions.setTemperature(provider, v[0] ?? 1)}
                className="flex-1"
              />
              <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
                {(ps.temperature ?? 1).toFixed(2)}
              </span>
            </div>
            <div className="mt-1.5 flex gap-1">
              {[0, 0.3, 0.7, 1.0, 1.3, 1.7].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => actions.setTemperature(provider, t)}
                  className={cn(
                    "flex-1 rounded py-0.5 text-[8.5px] font-medium transition-colors",
                    Math.abs((ps.temperature ?? 1) - t) < 0.01
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                  )}
                >
                  {t.toFixed(1)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Extended Thinking (Anthropic / Bedrock) ── */}
      {supportsThinking && thinkingProvider && (
        <>
          <Chip
            active={thinking.enabled}
            title={thinking.enabled ? "Extended thinking on — click to disable" : "Enable extended thinking"}
            onClick={() => actions.setThinking(provider, !thinking.enabled, thinking.budgetTokens || 10000)}
          >
            <Zap className="size-2.5" />
            {thinking.enabled ? fmtK(thinking.budgetTokens || 10000) : "Thinking"}
          </Chip>

          {thinking.enabled && BUDGETS.map((b) => (
            <Chip
              key={b}
              active={(thinking.budgetTokens || 10000) === b}
              title={`Thinking budget: ${fmtK(b)} tokens`}
              onClick={() => actions.setThinking(provider, true, b)}
            >
              {fmtK(b)}
            </Chip>
          ))}
        </>
      )}

      {/* ── Reasoning Effort (OpenAI) — rungs follow the selected model family ── */}
      {reasoning && provider === "openai" && (
        <div
          className="flex items-center gap-px rounded-full border border-border bg-white/[0.02] px-0.5 py-0.5"
          title="Reasoning effort"
        >
          {supportedReasoningEfforts(ps.model).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => actions.setReasoningEffort(provider, e)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-medium transition-colors",
                effectiveReasoningEffort(ps.model, ps.reasoningEffort) === e
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {EFFORT_LABELS[e].chip}
            </button>
          ))}
        </div>
      )}

      {/* ── Service tier (OpenAI) — quick flex toggle for cost-conscious runs ── */}
      {provider === "openai" && (
        <Chip
          active={(ps.serviceTier ?? "auto") === "flex"}
          title="Flex tier: reduced rates on flagship models with queued, capacity-dependent latency. Falls back to the standard tier for a turn when capacity is unavailable."
          onClick={() => actions.setServiceTier(provider, (ps.serviceTier ?? "auto") === "flex" ? "auto" : "flex")}
        >
          <Zap className="size-2.5" /> Flex
        </Chip>
      )}

    </div>
  );
}
