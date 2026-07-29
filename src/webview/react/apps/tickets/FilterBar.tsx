/* Search, scope, filters, grouping, sort — the whole navigation surface for a queue that is
 * allowed to get large.
 *
 * Three layers, deliberately separate. The search box answers "I know roughly what it says";
 * the scope tabs answer "which slice am I working in" and are one click each because that is
 * the switch made twenty times a day; the filter menu answers everything else and stays folded
 * away, with whatever is active shown as removable chips so no filter can be on without being
 * visible. A list that is quietly filtered is a list that lies.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ListFilter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AssigneeIcon, PriorityIcon, StatusIcon } from "./icons";
import {
  activeFilterCount, clearFilters, toggleIn, GROUP_LABEL, SORT_LABEL, SCOPE_LABEL,
  type Filters, type GroupBy, type Scope, type SortBy,
} from "./query";
import {
  ASSIGNEE_LABEL, ASSIGNEE_ORDER, PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, STATUS_ORDER,
  type TicketAssignee, type TicketPriority, type TicketStatus,
} from "./types";

const SCOPES: Scope[] = ["open", "active", "triage", "mine", "all"];
const GROUPS: GroupBy[] = ["status", "priority", "assignee", "label", "area", "none"];
const SORTS: SortBy[] = ["priority", "updated", "created", "title", "manual"];

export interface FilterBarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  counts: Record<Scope, number>;
  labels: Array<{ label: string; count: number }>;
  /** Result count after filtering, so "12 of 318" is always on screen. */
  shown: number;
  total: number;
  compact?: boolean;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  actions?: React.ReactNode;
}

export function FilterBar({
  filters, onChange, counts, labels, shown, total, compact, searchRef, actions,
}: FilterBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = activeFilterCount(filters);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menuOpen]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]): void =>
    onChange({ ...filters, [key]: value });

  return (
    <div className={cn("filter-bar", compact && "is-compact")}>
      <div className="filter-bar-row">
        <div className="filter-search">
          <Search className="size-3 shrink-0 opacity-50" />
          <input
            ref={searchRef}
            className="filter-search-input"
            placeholder={compact ? "Search…" : "Search tickets — #label, @me, or any text"}
            value={filters.query}
            aria-label="Search tickets"
            onChange={(event) => set("query", event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filters.query) { event.stopPropagation(); set("query", ""); }
            }}
          />
          {filters.query && (
            <button type="button" className="filter-search-clear" aria-label="Clear search" onClick={() => set("query", "")}>
              <X className="size-3" />
            </button>
          )}
        </div>
        {actions}
      </div>

      {/* The tabs share a row with the display controls only when there is room for both. In a
          sidebar they would otherwise be squeezed to a sliver by two fixed-width selects — and
          the scope switch is the control used most, so it is the one that keeps its width. */}
      <div className={cn("filter-bar-row", compact && "is-tabs-only")}>
        <div className="scope-tabs" role="tablist" aria-label="Ticket scope">
          {SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={filters.scope === scope}
              className={cn("scope-tab", filters.scope === scope && "is-active")}
              onClick={() => set("scope", scope)}
            >
              {SCOPE_LABEL[scope]}
              <span className="scope-tab-count">{counts[scope]}</span>
            </button>
          ))}
        </div>
        {!compact && <span className="flex-1" />}
      </div>

      <div className="filter-bar-row is-controls">
        <div ref={menuRef} className="filter-menu-root">
          <button
            type="button"
            className={cn("filter-trigger", (menuOpen || active > 0) && "is-active")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <ListFilter className="size-3" />
            Filter
            {active > 0 && <span className="filter-trigger-count">{active}</span>}
          </button>

          {menuOpen && (
            <div className="filter-menu reveal-in" role="menu">
              <FilterGroup
                title="Status"
                options={STATUS_ORDER.map((status) => ({
                  value: status,
                  label: STATUS_LABEL[status],
                  icon: <StatusIcon status={status} size={12} />,
                }))}
                selected={filters.statuses}
                onToggle={(value) => set("statuses", toggleIn(filters.statuses, value as TicketStatus))}
              />
              <FilterGroup
                title="Priority"
                options={PRIORITY_ORDER.map((priority) => ({
                  value: priority,
                  label: PRIORITY_LABEL[priority],
                  icon: <PriorityIcon priority={priority} size={12} />,
                }))}
                selected={filters.priorities}
                onToggle={(value) => set("priorities", toggleIn(filters.priorities, value as TicketPriority))}
              />
              <FilterGroup
                title="Assignee"
                options={ASSIGNEE_ORDER.map((assignee) => ({
                  value: assignee,
                  label: ASSIGNEE_LABEL[assignee],
                  icon: <AssigneeIcon assignee={assignee} size={12} />,
                }))}
                selected={filters.assignees}
                onToggle={(value) => set("assignees", toggleIn(filters.assignees, value as TicketAssignee))}
              />
              {labels.length > 0 && (
                <FilterGroup
                  title="Label"
                  scroll
                  options={labels.map((entry) => ({
                    value: entry.label,
                    label: entry.label,
                    hint: String(entry.count),
                  }))}
                  selected={filters.labels}
                  onToggle={(value) => set("labels", toggleIn(filters.labels, value))}
                />
              )}
              {active > 0 && (
                <div className="filter-menu-foot">
                  <Button size="xs" variant="ghost" onClick={() => onChange(clearFilters(filters))}>
                    Clear all
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <Select
          ariaLabel="Group by"
          className="filter-select"
          value={filters.groupBy}
          options={GROUPS.map((group) => ({ value: group, label: `Group: ${GROUP_LABEL[group]}` }))}
          onChange={(group) => set("groupBy", group as GroupBy)}
        />
        <Select
          ariaLabel="Sort by"
          className="filter-select"
          value={filters.sortBy}
          options={SORTS.map((sort) => ({ value: sort, label: `Sort: ${SORT_LABEL[sort]}` }))}
          onChange={(sort) => set("sortBy", sort as SortBy)}
        />
      </div>

      {(active > 0 || filters.areas.length > 0) && (
        <div className="filter-chips">
          {filters.statuses.map((status) => (
            <FilterChip key={`s-${status}`} label={STATUS_LABEL[status]} onRemove={() => set("statuses", toggleIn(filters.statuses, status))} />
          ))}
          {filters.priorities.map((priority) => (
            <FilterChip key={`p-${priority}`} label={PRIORITY_LABEL[priority]} onRemove={() => set("priorities", toggleIn(filters.priorities, priority))} />
          ))}
          {filters.assignees.map((assignee) => (
            <FilterChip key={`a-${assignee}`} label={ASSIGNEE_LABEL[assignee]} onRemove={() => set("assignees", toggleIn(filters.assignees, assignee))} />
          ))}
          {filters.labels.map((label) => (
            <FilterChip key={`l-${label}`} label={`#${label}`} onRemove={() => set("labels", toggleIn(filters.labels, label))} />
          ))}
          {filters.areas.map((area) => (
            <FilterChip key={`r-${area}`} label={`▤ ${area}`} onRemove={() => set("areas", toggleIn(filters.areas, area))} />
          ))}
          <button type="button" className="link-quiet" onClick={() => onChange(clearFilters(filters))}>Clear</button>
          <span className="flex-1" />
          <span className="filter-count">{shown} of {total}</span>
        </div>
      )}
      {active === 0 && filters.areas.length === 0 && shown !== total && (
        <div className="filter-chips">
          <span className="flex-1" />
          <span className="filter-count">{shown} of {total}</span>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="filter-chip">
      {label}
      <button type="button" aria-label={`Remove ${label} filter`} onClick={onRemove}>
        <X className="size-2.5" />
      </button>
    </span>
  );
}

function FilterGroup({ title, options, selected, onToggle, scroll }: {
  title: string;
  options: Array<{ value: string; label: string; icon?: React.ReactNode; hint?: string }>;
  selected: readonly string[];
  onToggle: (value: string) => void;
  scroll?: boolean;
}) {
  return (
    <div className="filter-group">
      <div className="filter-group-title">{title}</div>
      <div className={cn("filter-group-body", scroll && "is-scroll")}>
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              className={cn("filter-option", on && "is-on")}
              onClick={() => onToggle(option.value)}
            >
              <Check className={cn("size-3 shrink-0", !on && "opacity-0")} />
              {option.icon}
              <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
              {option.hint && <span className="filter-option-hint">{option.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
