/* Shared model picker with search, org-filter chips, capability toggles, and sort.
   Used by ModelPanel (full list) and SubagentPanel (inline picker). */

import { useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { joinParts } from "@/lib/format";
import type { ModelInfo, ProviderName } from "@/lib/protocol";
import { fmtCtx, fmtPrice } from "./helpers";

// ── Badge ──────────────────────────────────────────────────────────────────────

function ModelBadge({ children, tone }: { children: string; tone: string }) {
  return (
    <span
      className="rounded px-1 py-px text-2xs font-semibold uppercase tracking-wide"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 16%, transparent)` }}
    >
      {children}
    </span>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────

function Chip({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "lift shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
        active
          ? "chip-active border-primary/50 bg-primary/15 text-primary"
          : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type SortKey = "name" | "price_asc" | "price_desc" | "context_desc";

const SORT_OPTS: Array<{ id: SortKey; label: string }> = [
  { id: "name", label: "Name" },
  { id: "price_asc", label: "Price ↑" },
  { id: "price_desc", label: "Price ↓" },
  { id: "context_desc", label: "Context ↓" },
];

function orgFromId(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash).toLowerCase() : "";
}

function sortModels(models: ModelInfo[], key: SortKey): ModelInfo[] {
  const copy = [...models];
  switch (key) {
    case "name":
      return copy.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    case "price_asc":
      return copy.sort((a, b) => {
        const pa = a.inputPricePerM ?? Infinity;
        const pb = b.inputPricePerM ?? Infinity;
        return pa - pb;
      });
    case "price_desc":
      return copy.sort((a, b) => {
        const pa = a.inputPricePerM ?? -Infinity;
        const pb = b.inputPricePerM ?? -Infinity;
        return pb - pa;
      });
    case "context_desc":
      return copy.sort((a, b) => {
        const ca = a.contextLength ?? 0;
        const cb = b.contextLength ?? 0;
        return cb - ca;
      });
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface ModelPickerListProps {
  models: ModelInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
  provider: ProviderName;
  loading?: boolean;
  error?: string | null;
  /** A live listing succeeded but is incomplete — e.g. Bedrock models the account cannot invoke
      on-demand. Distinct from `error`: the list on screen is real, not a fallback. */
  notice?: string | null;
  onRefresh?: () => void;
  /** Passed height constraint (Tailwind max-h class). Defaults to "max-h-[300px]". */
  maxHeightClass?: string;
}

export function ModelPickerList({
  models,
  selectedId,
  onSelect,
  provider,
  loading = false,
  error = null,
  notice = null,
  onRefresh,
  maxHeightClass = "max-h-[300px]",
}: ModelPickerListProps) {
  const [query, setQuery] = useState("");
  const [orgFilter, setOrgFilter] = useState<string | null>(null);
  const [capFilter, setCapFilter] = useState<Set<"thinking" | "vision" | "tools">>(new Set());
  const [sort, setSort] = useState<SortKey>("name");

  // Build sorted org list from models (only when provider is openrouter / multi-org)
  const isMultiOrg = provider === "openrouter";
  const orgs = useMemo<string[]>(() => {
    if (!isMultiOrg) return [];
    const counts = new Map<string, number>();
    for (const m of models) {
      const org = orgFromId(m.id);
      if (org) counts.set(org, (counts.get(org) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([org]) => org);
  }, [models, isMultiOrg]);

  // Apply filters + sort
  const filtered = useMemo(() => {
    let list = models;
    const q = query.toLowerCase().trim();
    if (q) list = list.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
    if (orgFilter) list = list.filter((m) => orgFromId(m.id) === orgFilter);
    if (capFilter.has("thinking")) list = list.filter((m) => m.supportsThinking);
    if (capFilter.has("vision"))   list = list.filter((m) => m.supportsVision);
    if (capFilter.has("tools"))    list = list.filter((m) => m.supportsTools);
    return sortModels(list, sort);
  }, [models, query, orgFilter, capFilter, sort]);

  const hasActiveFilter = !!orgFilter || capFilter.size > 0 || query;

  const toggleCap = (cap: "thinking" | "vision" | "tools") => {
    setCapFilter((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  // Sort is a view preference, not a filter — clearing filters shouldn't also
  // silently discard an unrelated sort choice the user made deliberately.
  const clearFilters = () => {
    setQuery("");
    setOrgFilter(null);
    setCapFilter(new Set());
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Search + refresh */}
      <div className="flex items-center gap-1.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          className="h-7 text-sm"
        />
        {onRefresh && (
          <Button size="xs" variant="outline" title="Refresh model list" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
        )}
        {hasActiveFilter && (
          <Button size="xs" variant="ghost" title="Clear filters" onClick={clearFilters} className="px-1.5">
            <X className="size-3" />
          </Button>
        )}
      </div>

      {/* Org filter row — only for OpenRouter */}
      {isMultiOrg && orgs.length > 0 && (
        <div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          <Chip active={orgFilter === null} onClick={() => setOrgFilter(null)}>All</Chip>
          {orgs.map((org) => (
            <Chip key={org} active={orgFilter === org} onClick={() => setOrgFilter(orgFilter === org ? null : org)}>
              {org}
            </Chip>
          ))}
        </div>
      )}

      {/* Capability + sort row — two distinct choice groups (filter chips vs. a
          single-select sort order), so sort gets its own bordered pill instead
          of floating text buttons that read as loose next to the chips. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex items-center gap-1">
          <Chip active={capFilter.has("thinking")} onClick={() => toggleCap("thinking")}>Thinking</Chip>
          <Chip active={capFilter.has("vision")} onClick={() => toggleCap("vision")}>Vision</Chip>
          <Chip active={capFilter.has("tools")} onClick={() => toggleCap("tools")}>Tools</Chip>
        </div>
        <div className="ml-auto flex items-center gap-0.5 rounded-full border border-border bg-white/[0.02] p-0.5">
          {SORT_OPTS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              title={`Sort by ${opt.label}`}
              onClick={() => setSort(opt.id)}
              className={cn(
                "lift rounded-full px-1.5 py-0.5 text-2xs font-medium",
                sort === opt.id
                  ? "chip-active bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-md border border-[color:var(--s-warn)]/30 bg-[color:var(--s-warn)]/10 px-2 py-1 text-xs text-[color:var(--s-warn)]">
          ⚠ {error} (showing fallbacks)
        </div>
      )}

      {/* Notice banner — the listing is live, just incomplete. */}
      {!error && notice && (
        <div className="rounded-md border border-[color:var(--s-info)]/30 bg-[color:var(--s-info)]/10 px-2 py-1 text-xs text-[color:var(--s-info)]">
          {notice}
        </div>
      )}

      {/* Refreshing with a cached list still on screen — keep it interactive and
          show a slim glint instead of blanking the list (stale-while-revalidate). */}
      {loading && models.length > 0 && <div className="refresh-glint" aria-hidden />}

      {/* Model list */}
      <div className={cn("flex flex-col gap-1 overflow-y-auto", maxHeightClass)}>
        {loading && models.length === 0 ? (
          <div className="py-3 text-center text-sm text-muted-foreground">Fetching models…</div>
        ) : filtered.length === 0 ? (
          <div className="py-3 text-center text-sm text-muted-foreground">
            {models.length ? "No models match the filters." : "No models loaded. Click Refresh to fetch."}
          </div>
        ) : filtered.map((model) => {
          const selected = model.id === selectedId;
          const meta = joinParts([
            fmtCtx(model.contextLength) ? `${fmtCtx(model.contextLength)} ctx` : "",
            fmtPrice(model.inputPricePerM, model.outputPricePerM)
              ? `${fmtPrice(model.inputPricePerM, model.outputPricePerM)} /1M`
              : "",
          ]);
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => onSelect(model.id)}
              className={cn(
                "chat-interactive rounded-md border px-2 py-1.5 text-left",
                selected
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-white/[0.02] hover:border-primary/25 hover:bg-white/[0.05]",
              )}
            >
              <div className="flex items-center gap-1.5">
                {selected && <span className="text-sm text-primary">✓</span>}
                <span className="truncate text-base font-medium text-foreground">
                  {model.name || model.id}
                </span>
                {model.name && model.name !== model.id && (
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground/60">{model.id}</span>
                )}
              </div>
              {meta && <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>}
              {(model.supportsThinking || model.supportsVision || model.supportsTools || model.source === "api") && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {model.supportsThinking && <ModelBadge tone="var(--primary)">Thinking</ModelBadge>}
                  {model.supportsVision && <ModelBadge tone="var(--s-info)">Vision</ModelBadge>}
                  {model.supportsTools && <ModelBadge tone="var(--s-ok)">Tools</ModelBadge>}
                  {model.source === "api" && <ModelBadge tone="var(--s-warn)">Live</ModelBadge>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {filtered.length > 0 && models.length > 0 && (
        <div className="text-right text-2xs text-muted-foreground/50">
          {filtered.length} of {models.length} model{models.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
