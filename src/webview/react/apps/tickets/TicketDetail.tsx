/* One ticket, in full.
 *
 * Two editing speeds on purpose. The property rail commits on change — status, priority,
 * assignee, labels are single decisions and making them go through a save button turns a
 * one-second act into four. Prose and structure (title, description, criteria, territory,
 * relations) go through the dialog, because those are edits you make deliberately and might
 * abandon halfway.
 *
 * Everything a ticket knows is reachable here without leaving: its territory opens files and
 * flies the Map, its relations jump to the tickets they name, its references open outward, and
 * its timeline carries the investigation that has already happened. That last one is the whole
 * argument for the entity — the reasoning lives on the ticket, not in a transcript nobody can
 * see any more.
 */

import { useMemo, useState } from "react";
import {
  ArrowUpRight, Copy, ExternalLink, Link2, PanelRightOpen, Pencil, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { Select } from "@/components/ui/select";
import { post } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { absoluteTime, basename, shortRelative } from "./format";
import { AssigneeIcon, PriorityIcon, StatusIcon } from "./icons";
import {
  ASSIGNEE_LABEL, ASSIGNEE_ORDER, COMPLEXITY_ORDER, PRIORITY_LABEL, PRIORITY_ORDER,
  STATUS_LABEL, STATUS_ORDER,
  type LinkablePlan, type ResolvedTerritory, type Ticket, type TicketEvent,
} from "./types";

function TicketMarkdown({ raw, variant = "block" }: { raw: string; variant?: "block" | "inline" }) {
  return (
    <Markdown
      raw={raw}
      variant={variant}
      density="compact"
      onOpenFile={(path, line) => post({ type: "open_file", path: line ? `${path}:${line}` : path })}
    />
  );
}

function describeEvent(event: TicketEvent): string {
  const { kind, from, to, body } = event;
  if (body) return body;
  const transition = from && to ? `${from.replace(/_/g, " ")} → ${to.replace(/_/g, " ")}` : to ?? "";
  switch (kind) {
    case "created": return "filed this";
    case "reopened": return "reopened it";
    case "status": return `moved it ${transition}`;
    case "priority": return `set priority ${transition}`;
    case "complexity": return `sized it ${transition}`;
    case "assignee": return `assigned it ${transition}`;
    case "label": return `changed labels ${transition || ""}`.trim();
    case "criteria": return `changed acceptance criteria (${from} → ${to})`;
    case "reference": return `changed references (${from} → ${to})`;
    case "territory": return `changed territory ${transition}`;
    case "link": return transition ? `linked ${transition}` : "changed a link";
    default: return kind.replace(/_/g, " ");
  }
}

/** Comments get full Markdown; system entries collapse to one dim line each on a shared rail,
 *  so a ticket with thirty transitions and three comments still reads as three comments. */
function Timeline({ ticket }: { ticket: Ticket }) {
  const [draft, setDraft] = useState("");
  const [showSystem, setShowSystem] = useState(false);

  const comments = ticket.events.filter((event) => event.kind === "comment");
  const shown = showSystem ? ticket.events : comments;
  const hidden = ticket.events.length - comments.length;

  function submit(): void {
    const body = draft.trim();
    if (!body) return;
    post({ type: "comment_ticket", ticketId: ticket.id, body });
    setDraft("");
  }

  return (
    <section className="ticket-timeline">
      <div className="detail-section-head">
        <span className="eyebrow">Activity</span>
        <span className="flex-1" />
        {hidden > 0 && (
          <button type="button" className="link-quiet" onClick={() => setShowSystem((value) => !value)}>
            {showSystem ? "Comments only" : `Show ${hidden} change${hidden === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {shown.length === 0 && (
        <p className="detail-empty">No comments yet. Findings recorded here outlive the chat that produced them.</p>
      )}

      {shown.map((event) => (
        event.kind === "comment" ? (
          <article key={event.id} className="ticket-comment">
            <header className="ticket-comment-meta">
              <span className={`ticket-actor is-${event.actor}`}>{event.actor}</span>
              <span title={absoluteTime(event.at)}>{shortRelative(event.at)}</span>
            </header>
            <TicketMarkdown raw={event.body ?? ""} />
          </article>
        ) : (
          <div key={event.id} className="ticket-event">
            <span className="ticket-event-dot" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className={`ticket-actor is-${event.actor}`}>{event.actor}</span> {describeEvent(event)}
            </span>
            <span className="shrink-0 opacity-60" title={absoluteTime(event.at)}>{shortRelative(event.at)}</span>
          </div>
        )
      ))}

      <div className="mt-2 flex items-end gap-1.5">
        <textarea
          className="ticket-composer"
          placeholder="Leave a finding, a dead end you ruled out, a decision…"
          value={draft}
          rows={2}
          aria-label="New comment"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
          }}
        />
        <Button size="xs" variant="outline" disabled={!draft.trim()} onClick={submit}>Post</Button>
      </div>
    </section>
  );
}

function RelationList({ label, ids, tone, byId, onOpen }: {
  label: string;
  ids: string[];
  tone?: "blocked" | "blocking" | "related" | "duplicate";
  byId: Map<string, Ticket>;
  onOpen: (id: string) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="relation-group">
      <span className="relation-label">{label}</span>
      <div className="relation-items">
        {ids.map((id) => {
          const other = byId.get(id);
          return (
            <button
              key={id}
              type="button"
              className={cn("relation-chip", tone && `is-${tone}`)}
              title={other ? `${id} — ${other.title}` : id}
              onClick={() => onOpen(id)}
            >
              {other && <StatusIcon status={other.status} size={11} />}
              <span className="relation-chip-id">{id}</span>
              {other && <span className="relation-chip-title">{other.title}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface TicketDetailProps {
  ticket: Ticket;
  resolved?: ResolvedTerritory;
  all: readonly Ticket[];
  plans: LinkablePlan[];
  onClose: () => void;
  onOpenTicket: (id: string) => void;
  onEdit: () => void;
  /** Present only in the sidebar — the board is already the wide surface. */
  onOpenInBoard?: () => void;
}

export function TicketDetail({
  ticket, resolved, all, plans, onClose, onOpenTicket, onEdit, onOpenInBoard,
}: TicketDetailProps) {
  const set = (patch: Record<string, unknown>): void =>
    post({ type: "update_ticket", ticketId: ticket.id, ...patch });
  const byId = useMemo(() => new Map(all.map((entry) => [entry.id, entry])), [all]);
  const plan = plans.find((entry) => entry.id === ticket.planId);
  const stale = new Set(resolved?.staleFiles ?? []);
  const liveFiles = ticket.territory.files.filter((file) => !stale.has(file));
  const runIds = ticket.runIds ?? [];
  const visibleRunIds = runIds.slice(-12).reverse();

  return (
    <div className="ticket-detail">
      <header className="ticket-detail-head">
        <StatusIcon status={ticket.status} size={15} />
        <button
          type="button"
          className="ticket-detail-id"
          title="Copy ticket id"
          onClick={() => post({ type: "copy_text", text: ticket.id })}
        >
          {ticket.id}
          <Copy className="size-2.5 opacity-0 transition-opacity" />
        </button>
        <span className="flex-1" />
        {onOpenInBoard && (
          <Button size="icon-xs" variant="ghost" title="Open on the board" onClick={onOpenInBoard}>
            <PanelRightOpen className="size-3" />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" title="Edit everything" onClick={onEdit}>
          <Pencil className="size-3" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Delete this ticket"
          onClick={() => post({ type: "delete_ticket", ticketId: ticket.id })}
        >
          <Trash2 className="size-3" />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Close" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>

      <h1 className="ticket-detail-title">{ticket.title}</h1>

      <div className="ticket-detail-scroll">
        <div className="ticket-detail-body">
          {ticket.duplicateOf && (
            <div className="ticket-hint is-warn">
              Marked a duplicate of{" "}
              <button type="button" className="underline" onClick={() => onOpenTicket(ticket.duplicateOf!)}>
                {ticket.duplicateOf}
              </button>.
            </div>
          )}

          {ticket.description
            ? <TicketMarkdown raw={ticket.description} />
            : <p className="detail-empty">No description. <button type="button" className="link-quiet" onClick={onEdit}>Add one</button>.</p>}

          {ticket.acceptanceCriteria.length > 0 && (
            <section className="detail-section">
              <div className="detail-section-head"><span className="eyebrow">Acceptance criteria</span></div>
              <ul className="criteria-list">
                {ticket.acceptanceCriteria.map((criterion, index) => (
                  <li key={`${criterion}-${index}`}>
                    <span className="criterion-mark" aria-hidden="true" />
                    <TicketMarkdown raw={criterion} variant="inline" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(liveFiles.length > 0 || (resolved?.areas.length ?? 0) > 0 || stale.size > 0) && (
            <section className="detail-section">
              <div className="detail-section-head"><span className="eyebrow">Territory</span></div>
              <div className="territory-grid">
                {resolved?.areas.map((area) => (
                  <button
                    key={area.area}
                    type="button"
                    className={cn("territory-chip is-area", area.truncated && "is-warn")}
                    title={`Show ${area.area} on the Codebase Map`}
                    onClick={() => post({ type: "show_on_map", path: area.area })}
                  >
                    <span className="territory-glyph">▤</span>
                    <span className="territory-name">{area.area}</span>
                    <span className="territory-count">
                      {area.truncated ? "too broad to scope" : `${area.files}`}
                    </span>
                  </button>
                ))}
                {liveFiles.map((file) => (
                  <span key={file} className="territory-chip">
                    <button
                      type="button"
                      className="territory-name"
                      title={`Open ${file}`}
                      onClick={() => post({ type: "open_file", path: file })}
                    >
                      {basename(file)}
                    </button>
                    <button
                      type="button"
                      className="territory-reveal"
                      title={`Show ${file} on the Codebase Map`}
                      onClick={() => post({ type: "show_on_map", path: file })}
                    >
                      ◎
                    </button>
                  </span>
                ))}
                {[...stale].map((file) => (
                  <span
                    key={file}
                    className="territory-chip is-stale"
                    title="Not in the current index — renamed, ignored, or beyond the index cap"
                  >
                    <s>{basename(file)}</s>
                  </span>
                ))}
              </div>
            </section>
          )}

          {ticket.references.length > 0 && (
            <section className="detail-section">
              <div className="detail-section-head"><span className="eyebrow">References</span></div>
              <div className="flex flex-col gap-1">
                {ticket.references.map((reference) => (
                  <button
                    key={reference.url}
                    type="button"
                    className="reference-row is-link"
                    title={reference.url}
                    onClick={() => post({ type: "open_reference", url: reference.url })}
                  >
                    <Link2 className="size-3 shrink-0 opacity-60" />
                    <span className="reference-title">{reference.title || reference.url}</span>
                    <span className="flex-1" />
                    <ExternalLink className="size-2.5 shrink-0 opacity-40" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {runIds.length > 0 && (
            <section className="detail-section" aria-label="Linked execution runs">
              <div className="detail-section-head">
                <span className="eyebrow">Execution runs</span>
                <span className="text-2xs text-muted-foreground">
                  {runIds.length} linked · latest first
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {visibleRunIds.map((runId, index) => (
                  <span
                    key={runId}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-1 font-mono text-xs text-muted-foreground"
                    title={`${index === 0 ? "Latest run: " : ""}${runId}`}
                  >
                    {index === 0 && <span className="font-sans text-2xs uppercase tracking-wide opacity-70">Latest</span>}
                    <span className="truncate text-foreground">{runId}</span>
                  </span>
                ))}
                {runIds.length > visibleRunIds.length && (
                  <span className="self-center text-2xs text-muted-foreground">
                    +{runIds.length - visibleRunIds.length} older
                  </span>
                )}
              </div>
            </section>
          )}

          {(ticket.blockedBy.length > 0 || ticket.blocks.length > 0 || ticket.relatedTo.length > 0) && (
            <section className="detail-section">
              <div className="detail-section-head"><span className="eyebrow">Relations</span></div>
              <RelationList label="Blocked by" ids={ticket.blockedBy} tone="blocked" byId={byId} onOpen={onOpenTicket} />
              <RelationList label="Blocks" ids={ticket.blocks} tone="blocking" byId={byId} onOpen={onOpenTicket} />
              <RelationList label="Related" ids={ticket.relatedTo} tone="related" byId={byId} onOpen={onOpenTicket} />
            </section>
          )}

          <Timeline ticket={ticket} />
        </div>

        <aside className="ticket-detail-rail">
          <div className="rail-field">
            <span className="rail-label">Status</span>
            <Select
              ariaLabel="Status"
              value={ticket.status}
              options={STATUS_ORDER.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
              onChange={(status) => set({ status })}
            />
          </div>
          <div className="rail-field">
            <span className="rail-label">Priority</span>
            <Select
              ariaLabel="Priority"
              value={ticket.priority}
              options={PRIORITY_ORDER.map((priority) => ({ value: priority, label: PRIORITY_LABEL[priority] }))}
              onChange={(priority) => set({ priority })}
            />
            <PriorityIcon priority={ticket.priority} className="rail-glyph" />
          </div>
          <div className="rail-field">
            <span className="rail-label">Assignee</span>
            <Select
              ariaLabel="Assignee"
              value={ticket.assignee}
              options={ASSIGNEE_ORDER.map((assignee) => ({ value: assignee, label: ASSIGNEE_LABEL[assignee] }))}
              onChange={(assignee) => set({ assignee })}
            />
            <AssigneeIcon assignee={ticket.assignee} className="rail-glyph" />
          </div>
          <div className="rail-field">
            <span className="rail-label">Effort</span>
            <Select
              ariaLabel="Complexity"
              value={ticket.complexity ?? ""}
              options={[
                { value: "", label: "Unsized" },
                ...COMPLEXITY_ORDER.map((complexity) => ({ value: complexity, label: complexity })),
              ]}
              onChange={(complexity) => set({ complexity })}
            />
          </div>
          {ticket.complexityBasis && <p className="rail-note">{ticket.complexityBasis}</p>}

          <div className="rail-block">
            <span className="rail-label">Labels</span>
            {ticket.labels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {ticket.labels.map((label) => <span key={label} className="ticket-label">{label}</span>)}
              </div>
            ) : (
              <button type="button" className="link-quiet self-start" onClick={onEdit}>Add labels</button>
            )}
          </div>

          <div className="rail-block">
            <span className="rail-label">Plan</span>
            {ticket.planId ? (
              <>
                <button type="button" className="rail-link" onClick={() => post({ type: "open_plan", planId: ticket.planId })}>
                  <ArrowUpRight className="size-3" />
                  <span className="truncate">{plan?.title ?? ticket.planId}</span>
                </button>
                {ticket.statusSource === "derived" ? (
                  <p className="rail-note">Status follows this plan. Setting it by hand detaches it.</p>
                ) : (
                  <p className="rail-note">
                    Set by hand — no longer following.{" "}
                    <button type="button" className="underline" onClick={() => set({ planId: ticket.planId })}>
                      Follow again
                    </button>
                  </p>
                )}
              </>
            ) : (
              <button type="button" className="link-quiet self-start" onClick={onEdit}>Link a plan</button>
            )}
          </div>

          <div className="rail-block">
            <span className="rail-label">Filed</span>
            <p className="rail-note" title={absoluteTime(ticket.createdAt)}>
              {shortRelative(ticket.createdAt)} ago by {ticket.origin === "user" ? "you" : ticket.origin.replace(/_/g, " ")}
            </p>
            <p className="rail-note" title={absoluteTime(ticket.updatedAt)}>
              Updated {shortRelative(ticket.updatedAt)} ago
            </p>
            {ticket.closedAt && (
              <p className="rail-note" title={absoluteTime(ticket.closedAt)}>
                Closed {shortRelative(ticket.closedAt)} ago
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
