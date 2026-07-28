import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/PanelHeader";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Markdown } from "@/components/ui/markdown";
import { TerritoryChips } from "@/components/ui/territory-chips";
import { formatRelativeTime } from "@/lib/format";
import { post, onMessage } from "@/lib/bridge";
import {
  byPriority, isOpen, PRIORITY_ORDER, STATUS_ORDER,
  type ResolvedTerritory, type Ticket, type TicketPriority,
} from "./types";

interface State {
  tickets: Ticket[];
  territory: Record<string, ResolvedTerritory>;
  labels: Array<{ label: string; count: number }>;
  dropped: number;
}

const EMPTY: State = { tickets: [], territory: {}, labels: [], dropped: 0 };

function TicketMarkdown({ raw, variant = "block" }: { raw: string; variant?: "block" | "inline" }) {
  return (
    <Markdown
      raw={raw}
      variant={variant}
      density="compact"
      onOpenFile={(path) => post({ type: "open_file", path })}
    />
  );
}

/** Priority as weight, not hue alone: urgent and high carry a mark, normal renders nothing
 *  (the default should be silent), low renders hollow and dimmed. */
function PriorityMark({ priority }: { priority: TicketPriority }) {
  if (priority === "normal") return null;
  const label = `${priority} priority`;
  if (priority === "low") {
    return <span className="ticket-priority is-low" title={label} aria-label={label}>○</span>;
  }
  return <span className={`ticket-priority is-${priority}`} title={label} aria-label={label}>●</span>;
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span key={label} className="ticket-label" data-label={label}>{label}</span>
      ))}
    </span>
  );
}

/** The activity timeline: comments get full Markdown, system entries collapse to one dim line
 *  each on a shared rail, so a ticket with thirty transitions and three comments still reads
 *  as three comments. */
function Timeline({ ticket }: { ticket: Ticket }) {
  const [draft, setDraft] = useState("");
  if (!ticket.events) return null;

  function submit(): void {
    const body = draft.trim();
    if (!body) return;
    post({ type: "comment_ticket", ticketId: ticket.id, body });
    setDraft("");
  }

  return (
    <div className="ticket-timeline">
      <div className="eyebrow">Activity</div>
      {ticket.events.map((event) => (
        event.kind === "comment" ? (
          <div key={event.id} className="ticket-comment">
            <div className="ticket-comment-meta">
              <span className={`ticket-actor is-${event.actor}`}>{event.actor}</span>
              <span>{formatRelativeTime(Date.parse(event.at))}</span>
            </div>
            <TicketMarkdown raw={event.body ?? ""} />
          </div>
        ) : (
          <div key={event.id} className="ticket-event">
            <span className="ticket-event-dot" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {describeEvent(event.kind, event.from, event.to, event.body)}
            </span>
            <span className="shrink-0 opacity-60">{formatRelativeTime(Date.parse(event.at))}</span>
          </div>
        )
      ))}
      <div className="mt-1.5 flex items-end gap-1.5">
        <textarea
          className="ticket-composer"
          placeholder="Add a comment…"
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
          }}
        />
        <Button size="xs" variant="outline" disabled={!draft.trim()} onClick={submit}>Post</Button>
      </div>
    </div>
  );
}

function describeEvent(kind: string, from?: string, to?: string, body?: string): string {
  if (body) return body;
  const transition = from && to ? `${from.replace(/_/g, " ")} → ${to.replace(/_/g, " ")}` : to ?? "";
  switch (kind) {
    case "created": return "filed";
    case "reopened": return "reopened";
    case "status": return `status ${transition}`;
    case "priority": return `priority ${transition}`;
    case "complexity": return `complexity ${transition}`;
    case "label": return `labels ${transition || "changed"}`;
    case "territory": return `territory ${transition}`;
    case "link": return transition ? `linked ${transition}` : "link changed";
    default: return kind.replace(/_/g, " ");
  }
}

function TicketCard(
  { ticket, resolved, expanded, onToggle }: {
    ticket: Ticket; resolved?: ResolvedTerritory; expanded: boolean; onToggle: () => void;
  },
) {
  const set = (patch: Record<string, unknown>) => post({ type: "update_ticket", ticketId: ticket.id, ...patch });
  const stale = new Set(resolved?.staleFiles ?? []);

  return (
    <article className={`ticket-card turn-in is-${ticket.priority} ${expanded ? "is-open" : ""}`}>
      <button type="button" className="ticket-card-summary" onClick={onToggle} aria-expanded={expanded}>
        <PriorityMark priority={ticket.priority} />
        <span className="ticket-id">{ticket.id}</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="ticket-title">{ticket.title}</span>
        </span>
        {ticket.origin === "agent" && ticket.status === "triage" && (
          <span className="ticket-origin" title="Filed by the agent, awaiting your triage">🤖</span>
        )}
        {ticket.planId && <span className="ticket-plan" title={`Linked to plan ${ticket.planId}`}>⧉</span>}
        <StatusBadge status={ticket.status} />
      </button>

      {expanded && (
        <div className="ticket-card-body">
          {ticket.description && <TicketMarkdown raw={ticket.description} />}

          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              ariaLabel="Status"
              className="min-w-[7.5rem]"
              value={ticket.status}
              options={STATUS_ORDER.map((status) => ({ value: status, label: status.replace(/_/g, " ") }))}
              onChange={(status) => set({ status })}
            />
            <Select
              ariaLabel="Priority"
              className="min-w-[6rem]"
              value={ticket.priority}
              options={PRIORITY_ORDER.map((priority) => ({ value: priority, label: priority }))}
              onChange={(priority) => set({ priority })}
            />
            <LabelChips labels={ticket.labels} />
          </div>

          {ticket.statusSource === "derived" && ticket.planId && (
            <div className="ticket-hint">Status follows plan {ticket.planId}. Setting it by hand detaches it.</div>
          )}
          {ticket.statusSource === "manual" && ticket.planId && (
            <div className="ticket-hint">
              Set by hand — no longer following plan {ticket.planId}.{" "}
              <button type="button" className="underline" onClick={() => set({ planId: ticket.planId })}>
                Follow the plan again
              </button>
            </div>
          )}

          {(ticket.territory.files.length > 0 || ticket.territory.areas.length > 0) && (
            <div className="flex flex-col gap-1">
              <TerritoryChips
                files={ticket.territory.files.filter((file) => !stale.has(file))}
                label="Territory:"
                onOpenFile={(path) => post({ type: "open_file", path })}
                onRevealOnMap={(path) => post({ type: "show_on_map", path })}
              />
              {resolved?.areas.map((area) => (
                <button
                  key={area.area}
                  type="button"
                  className="ticket-area"
                  title={`Show ${area.area} on the Codebase Map`}
                  onClick={() => post({ type: "show_on_map", path: area.area })}
                >
                  ▤ {area.area} · {area.files} file{area.files === 1 ? "" : "s"}
                  {area.truncated && <span className="ticket-area-warn"> · too broad to scope</span>}
                </button>
              ))}
              {(resolved?.staleFiles.length ?? 0) > 0 && (
                <div className="ticket-stale">
                  {resolved?.staleFiles.map((file) => (
                    <span key={file} title="Not in the current index — renamed, ignored, or beyond the index cap">
                      <s>{file.split("/").pop()}</s>
                    </span>
                  ))}
                  <span className="opacity-60">not in the current index</span>
                </div>
              )}
            </div>
          )}

          {(ticket.blockedBy.length > 0 || ticket.relatedTo.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {ticket.blockedBy.length > 0 && <span>⛔ Blocked by {ticket.blockedBy.join(", ")}</span>}
              {ticket.relatedTo.length > 0 && <span>↔ {ticket.relatedTo.join(", ")}</span>}
            </div>
          )}

          <Timeline ticket={ticket} />
        </div>
      )}
    </article>
  );
}

/** Filing from the panel — the user's own path to a ticket, independent of asking the agent. */
function Composer() {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("normal");

  function submit(): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    post({ type: "file_ticket", title: trimmed, priority, origin: "user" });
    setTitle("");
    setPriority("normal");
  }

  return (
    <div className="ticket-composer-row">
      <Input
        placeholder="File a ticket…"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
      />
      <Select
        ariaLabel="Priority"
        className="w-[6.5rem] shrink-0"
        value={priority}
        options={PRIORITY_ORDER.map((value) => ({ value, label: value }))}
        onChange={(value) => setPriority(value as TicketPriority)}
      />
      <Button size="xs" disabled={!title.trim()} onClick={submit}>Add</Button>
    </div>
  );
}

export function TicketsApp() {
  const [state, setState] = useState<State>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | "triage" | "mine" | "all">("open");

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type !== "tickets_state") return;
      setState({
        tickets: Array.isArray(msg.tickets) ? msg.tickets : [],
        territory: msg.territory ?? {},
        labels: Array.isArray(msg.labels) ? msg.labels : [],
        dropped: Number(msg.dropped) || 0,
      });
    });
    post({ type: "ready" });
    return off;
  }, []);

  const visible = useMemo(() => {
    const tickets = state.tickets.filter((ticket) => {
      if (filter === "all") return true;
      if (filter === "triage") return ticket.status === "triage";
      if (filter === "mine") return ticket.status === "in_progress" || ticket.status === "review";
      return isOpen(ticket.status);
    });
    return [...tickets].sort(byPriority);
  }, [state.tickets, filter]);

  const open = state.tickets.filter((ticket) => isOpen(ticket.status));
  const triage = open.filter((ticket) => ticket.status === "triage").length;
  const urgent = open.filter((ticket) => ticket.priority === "urgent" || ticket.priority === "high").length;
  const next = visible.find((ticket) => ticket.status !== "blocked" && ticket.blockedBy.length === 0);

  const tabs: Array<{ key: typeof filter; label: string; count: number }> = [
    { key: "open", label: "Open", count: open.length },
    { key: "triage", label: "Triage", count: triage },
    { key: "mine", label: "Active", count: state.tickets.filter((t) => t.status === "in_progress" || t.status === "review").length },
    { key: "all", label: "All", count: state.tickets.length },
  ];

  return (
    <div className="tickets-root flex flex-1 flex-col overflow-hidden">
      <header className="tickets-header living-panel-header shrink-0 border-b border-border px-3 py-2.5">
        <PanelHeader
          eyebrow="Work queue"
          title="Tickets"
          sub="Durable outcomes, independent of any one plan."
          status={{
            label: open.length ? `${open.length} open` : "Clear",
            tone: urgent > 0 ? "warn" : open.length ? "ok" : "idle",
          }}
        />
        <div className="mt-2 flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`tab-strip-item rounded-md px-2 py-1 text-xs ${filter === tab.key ? "is-active" : ""}`}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label} <span className="opacity-60">{tab.count}</span>
            </button>
          ))}
        </div>
      </header>

      <main className="tickets-content flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          <Composer />

          {state.dropped > 0 && (
            <div className="ticket-hint is-warn">
              {state.dropped} malformed {state.dropped === 1 ? "entry" : "entries"} in tickets.json could not be read.
            </div>
          )}

          {next && filter === "open" && (
            <section className="ticket-next" aria-label="Next up">
              <div className="ticket-next-kicker">Next up</div>
              <div className="ticket-next-title">{next.title}</div>
              <div className="ticket-next-copy">
                {next.id} · {next.priority}{next.complexity ? ` · ${next.complexity}` : ""}
                {next.complexityBasis ? ` — ${next.complexityBasis}` : ""}
              </div>
            </section>
          )}

          {visible.length === 0 ? (
            <div className="ticket-empty chat-surface border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
              Nothing here. Work the agent notices but isn&apos;t asked to do lands in Triage,
              so it stops getting lost in the transcript.
            </div>
          ) : visible.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              resolved={state.territory[ticket.id]}
              expanded={expanded === ticket.id}
              onToggle={() => setExpanded((current) => (current === ticket.id ? null : ticket.id))}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
