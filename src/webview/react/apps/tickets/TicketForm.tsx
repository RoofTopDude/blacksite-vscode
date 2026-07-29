/* The ticket editor: one form, used both for filing a new ticket and for editing an existing
 * one's whole shape at once.
 *
 * The layout is the point. Title and description sit at the top at full width, because that is
 * the part a human writes in prose; every structured property lives in a right-hand rail of
 * small pickers, because those are chosen, not composed. Sections below the fold — acceptance
 * criteria, territory, relations, references — are open when they hold something and collapsed
 * when they don't, so a two-line ticket stays a two-line ticket and a fully-specified one shows
 * everything it knows without a single click.
 *
 * Filing must stay cheap: a title alone is a valid ticket, and Cmd/Ctrl+Enter files from
 * anywhere in the form. Everything else is optional depth for when the ticket deserves it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PriorityIcon, StatusIcon, AssigneeIcon } from "./icons";
import { PickerField, TokenField } from "./TokenField";
import {
  ASSIGNEE_LABEL, ASSIGNEE_ORDER, COMPLEXITY_ORDER, PRIORITY_LABEL, PRIORITY_ORDER,
  STATUS_LABEL, STATUS_ORDER,
  type LinkablePlan, type Ticket, type TicketAssignee, type TicketComplexity,
  type TicketPriority, type TicketReference, type TicketStatus,
} from "./types";

export interface TicketDraft {
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  complexity: TicketComplexity | "";
  complexityBasis: string;
  assignee: TicketAssignee;
  labels: string[];
  acceptanceCriteria: string[];
  files: string[];
  areas: string[];
  references: TicketReference[];
  blockedBy: string[];
  blocks: string[];
  relatedTo: string[];
  duplicateOf: string;
  planId: string;
}

export function emptyDraft(): TicketDraft {
  return {
    title: "", description: "", status: "backlog", priority: "normal", complexity: "",
    complexityBasis: "", assignee: "unassigned", labels: [], acceptanceCriteria: [],
    files: [], areas: [], references: [], blockedBy: [], blocks: [], relatedTo: [],
    duplicateOf: "", planId: "",
  };
}

export function draftFromTicket(ticket: Ticket): TicketDraft {
  return {
    title: ticket.title,
    description: ticket.description ?? "",
    status: ticket.status,
    priority: ticket.priority,
    complexity: ticket.complexity ?? "",
    complexityBasis: ticket.complexityBasis ?? "",
    assignee: ticket.assignee,
    labels: [...ticket.labels],
    acceptanceCriteria: [...ticket.acceptanceCriteria],
    files: [...ticket.territory.files],
    areas: [...ticket.territory.areas],
    references: ticket.references.map((reference) => ({ ...reference })),
    blockedBy: [...ticket.blockedBy],
    blocks: [...ticket.blocks],
    relatedTo: [...ticket.relatedTo],
    duplicateOf: ticket.duplicateOf ?? "",
    planId: ticket.planId ?? "",
  };
}

/** Mirrors normalizeLabel in the store, so what the field shows is what gets persisted rather
 *  than something the host quietly rewrites after the fact. */
export function kebab(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1) || value;
}

/** The message payload for ticket_file / ticket_update. Empty collections are still sent on
 *  update — clearing every label has to be expressible, and an omitted key means "unchanged". */
export function draftToPayload(draft: TicketDraft): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    status: draft.status,
    priority: draft.priority,
    complexity: draft.complexity,
    complexityBasis: draft.complexityBasis.trim(),
    assignee: draft.assignee,
    labels: draft.labels,
    acceptanceCriteria: draft.acceptanceCriteria,
    files: draft.files,
    areas: draft.areas,
    references: draft.references,
    blockedBy: draft.blockedBy,
    blocks: draft.blocks,
    relatedTo: draft.relatedTo,
    duplicateOf: draft.duplicateOf,
    planId: draft.planId,
  };
}

function Section({ title, count, hint, defaultOpen, children }: {
  title: string; count?: number; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? (count ?? 0) > 0);
  return (
    <section className={cn("form-section", open && "is-open")}>
      <button type="button" className="form-section-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ChevronRight className={cn("disclosure size-3", open && "rotate-90")} />
        <span className="form-section-title">{title}</span>
        {(count ?? 0) > 0 && <span className="form-section-count">{count}</span>}
        <span className="flex-1" />
        {!open && hint && <span className="form-section-hint">{hint}</span>}
      </button>
      {open && <div className="form-section-body">{children}</div>}
    </section>
  );
}

function CriteriaEditor({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function add(): void {
    const clean = draft.trim();
    if (!clean || values.includes(clean)) return;
    onChange([...values, clean]);
    setDraft("");
  }

  return (
    <div className="criteria-editor">
      {values.map((value, index) => (
        <div key={`${value}-${index}`} className="criterion">
          {/* Deliberately not a checkbox. A ticket carries no progress — these state what done
              means so the work can be checked against them, and the plan tracks getting there. */}
          <span className="criterion-mark" aria-hidden="true" />
          <input
            className="criterion-input"
            value={value}
            aria-label={`Acceptance criterion ${index + 1}`}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
            onBlur={() => { if (!value.trim()) onChange(values.filter((_, at) => at !== index)); }}
          />
          <button
            type="button"
            className="criterion-remove"
            aria-label="Remove criterion"
            onClick={() => onChange(values.filter((_, at) => at !== index))}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <div className="criterion is-new">
        <span className="criterion-mark is-ghost" aria-hidden="true" />
        <input
          className="criterion-input"
          placeholder="Add a condition that makes this done…"
          value={draft}
          aria-label="New acceptance criterion"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); add(); }
          }}
          onBlur={add}
        />
        <Button size="icon-xs" variant="ghost" disabled={!draft.trim()} onClick={add} aria-label="Add criterion">
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function ReferenceEditor({ values, onChange }: {
  values: TicketReference[]; onChange: (next: TicketReference[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");

  function add(): void {
    const clean = url.trim();
    if (!clean || values.some((entry) => entry.url === clean)) return;
    onChange([...values, { url: clean, ...(title.trim() ? { title: title.trim() } : {}) }]);
    setUrl("");
    setTitle("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      {values.map((reference) => (
        <div key={reference.url} className="reference-row">
          <Link2 className="size-3 shrink-0 opacity-60" />
          <span className="reference-title">{reference.title || reference.url}</span>
          {reference.title && <span className="reference-url">{reference.url}</span>}
          <button
            type="button"
            className="criterion-remove"
            aria-label={`Remove ${reference.url}`}
            onClick={() => onChange(values.filter((entry) => entry.url !== reference.url))}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          className="h-7 flex-[2] text-xs"
          placeholder="https://… or docs/spec.md"
          value={url}
          aria-label="Reference URL"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        />
        <Input
          className="h-7 flex-1 text-xs"
          placeholder="Label (optional)"
          value={title}
          aria-label="Reference label"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        />
        <Button size="icon-xs" variant="ghost" disabled={!url.trim()} onClick={add} aria-label="Add reference">
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

export interface TicketFormProps {
  draft: TicketDraft;
  onChange: (draft: TicketDraft) => void;
  plans: LinkablePlan[];
  /** The ticket being edited, so relation pickers can exclude it from their own suggestions. */
  selfId?: string;
  /** Narrow surfaces stack the property rail under the body instead of beside it. */
  compact?: boolean;
}

export function TicketForm({ draft, onChange, plans, selfId, compact }: TicketFormProps) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]): void =>
    onChange({ ...draft, [key]: value });

  // The title grows with its content rather than scrolling inside two lines: a ticket title is
  // one sentence, and hiding half of it while it is being written invites a worse one.
  useEffect(() => {
    const node = titleRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [draft.title]);

  const planTitle = useMemo(() => {
    const lookup = new Map(plans.map((plan) => [plan.id, plan.title]));
    return (id: string) => lookup.get(id) ?? id;
  }, [plans]);

  const relationCount = draft.blockedBy.length + draft.blocks.length + draft.relatedTo.length
    + (draft.duplicateOf ? 1 : 0);
  const territoryCount = draft.files.length + draft.areas.length;

  return (
    <div className={cn("ticket-form", compact && "is-compact")}>
      <div className="ticket-form-main">
        <textarea
          ref={titleRef}
          className="ticket-form-title"
          placeholder="Ticket title — state the outcome, not the activity"
          value={draft.title}
          rows={1}
          onChange={(event) => set("title", event.target.value.replace(/\n/g, ""))}
        />
        <textarea
          className="ticket-form-description"
          placeholder="Description — what is wrong or missing, why it matters. Markdown, so `src/foo.ts:42` becomes a link."
          value={draft.description}
          rows={compact ? 4 : 6}
          onChange={(event) => set("description", event.target.value)}
        />

        <Section title="Acceptance criteria" count={draft.acceptanceCriteria.length} hint="what done means">
          <CriteriaEditor values={draft.acceptanceCriteria} onChange={(next) => set("acceptanceCriteria", next)} />
        </Section>

        <Section title="Territory" count={territoryCount} hint="files and areas on the map">
          <span className="form-label">Files</span>
          <TokenField
            field="file"
            values={draft.files}
            onChange={(next) => set("files", next)}
            placeholder="Search the Codebase Map…"
            renderToken={basename}
            ariaLabel="Territory files"
            max={60}
          />
          <span className="form-label mt-2">Areas</span>
          <TokenField
            field="area"
            values={draft.areas}
            onChange={(next) => set("areas", next)}
            placeholder="A directory prefix, e.g. src/graph"
            allowFreeform
            normalize={normalizePath}
            ariaLabel="Territory areas"
            max={12}
          />
          <p className="form-help">
            An area covers everything beneath it and stays true as files come and go — prefer one
            over enumerating the files under it.
          </p>
        </Section>

        <Section title="Relations" count={relationCount} hint="other tickets">
          <span className="form-label">Blocked by</span>
          <TokenField
            field="ticket" values={draft.blockedBy} onChange={(next) => set("blockedBy", next)}
            placeholder="Tickets that must close first…" ariaLabel="Blocked by"
          />
          <span className="form-label mt-2">Blocks</span>
          <TokenField
            field="ticket" values={draft.blocks} onChange={(next) => set("blocks", next)}
            placeholder="Tickets waiting on this one…" ariaLabel="Blocks"
          />
          <span className="form-label mt-2">Related</span>
          <TokenField
            field="ticket" values={draft.relatedTo} onChange={(next) => set("relatedTo", next)}
            placeholder="Tickets worth reading alongside this…" ariaLabel="Related tickets"
          />
          <span className="form-label mt-2">Duplicate of</span>
          <PickerField
            field="ticket" value={draft.duplicateOf} onChange={(next) => set("duplicateOf", next)}
            placeholder="The ticket this repeats…" ariaLabel="Duplicate of"
          />
          {selfId && <p className="form-help">{selfId} never appears in its own relation lists.</p>}
        </Section>

        <Section title="References" count={draft.references.length} hint="specs, PRs, upstream issues">
          <ReferenceEditor values={draft.references} onChange={(next) => set("references", next)} />
        </Section>
      </div>

      <aside className="ticket-form-rail">
        <div className="rail-field">
          <span className="rail-label">Status</span>
          <Select
            ariaLabel="Status"
            value={draft.status}
            options={STATUS_ORDER.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
            onChange={(status) => set("status", status as TicketStatus)}
          />
          <StatusIcon status={draft.status} className="rail-glyph" />
        </div>

        <div className="rail-field">
          <span className="rail-label">Priority</span>
          <Select
            ariaLabel="Priority"
            value={draft.priority}
            options={PRIORITY_ORDER.map((priority) => ({ value: priority, label: PRIORITY_LABEL[priority] }))}
            onChange={(priority) => set("priority", priority as TicketPriority)}
          />
          <PriorityIcon priority={draft.priority} className="rail-glyph" />
        </div>

        <div className="rail-field">
          <span className="rail-label">Assignee</span>
          <Select
            ariaLabel="Assignee"
            value={draft.assignee}
            options={ASSIGNEE_ORDER.map((assignee) => ({ value: assignee, label: ASSIGNEE_LABEL[assignee] }))}
            onChange={(assignee) => set("assignee", assignee as TicketAssignee)}
          />
          <AssigneeIcon assignee={draft.assignee} className="rail-glyph" />
        </div>

        <div className="rail-field">
          <span className="rail-label">Effort</span>
          <Select
            ariaLabel="Complexity"
            value={draft.complexity}
            placeholder="Unsized"
            options={[
              { value: "", label: "Unsized" },
              ...COMPLEXITY_ORDER.map((complexity) => ({ value: complexity, label: complexity })),
            ]}
            onChange={(complexity) => set("complexity", complexity as TicketComplexity | "")}
          />
        </div>

        {draft.complexity && (
          <Input
            className="h-7 text-xs"
            placeholder="Why that size — one clause"
            value={draft.complexityBasis}
            aria-label="Complexity basis"
            onChange={(event) => set("complexityBasis", event.target.value)}
          />
        )}

        <div className="rail-block">
          <span className="rail-label">Labels</span>
          <TokenField
            field="label"
            values={draft.labels}
            onChange={(next) => set("labels", next)}
            placeholder="Add a label…"
            allowFreeform
            normalize={kebab}
            ariaLabel="Labels"
            max={8}
          />
        </div>

        <div className="rail-block">
          <span className="rail-label">Plan</span>
          <PickerField
            field="plan"
            value={draft.planId}
            onChange={(next) => set("planId", next)}
            placeholder="Link a plan…"
            renderValue={planTitle}
            ariaLabel="Linked plan"
          />
          {draft.planId && (
            <p className="form-help">Status will follow this plan until you set it by hand.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
