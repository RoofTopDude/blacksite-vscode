import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  DollarSign,
  Eye,
  History,
  ListTodo,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Square,
  TicketCheck,
  Trash2,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/ui/status-badge";
import { onMessage, post, readUiState, writeUiState } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import {
  isLoopsHostMessage,
  type LoopActivity,
  type LoopExecution,
  type LoopsConfirmMessage,
  type LoopIteration,
  type LoopRecord,
  type LoopTicket,
  type LoopsNoticeMessage,
  type LoopsStateMessage,
} from "./protocol";

type DetailTab = "lanes" | "queue" | "executions";

const initialUi = readUiState("loops", { tab: "lanes" as DetailTab, composerOpen: false });

function money(value: number | undefined): string {
  const amount = Math.max(0, value ?? 0);
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

function time(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
}

function duration(start: string, end: string | undefined, now: number): string {
  const elapsed = Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start));
  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusCopy(loop: LoopRecord): string {
  switch (loop.definition.status) {
    case "running": return loop.activeLanes.length ? `${loop.activeLanes.length} lane${loop.activeLanes.length === 1 ? "" : "s"} working now` : "Looking for the next safe ticket";
    case "blocked": return "No safe ticket is dispatchable";
    case "drained": return "Queue attempted · work awaits review";
    case "draft": return "Configured and ready for your start";
    case "paused": return "Paused · running work has settled";
    default: return loop.definition.endedReason || loop.definition.status;
  }
}

function Metric({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string | number; tone?: string }) {
  return (
    <div className="loop-metric" data-tone={tone}>
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReviewerBanner({ running }: { running: boolean }) {
  return (
    <div className={cn("loop-reviewer", running && "is-live")}>
      <span className="loop-reviewer-orbit" aria-hidden><ShieldCheck /></span>
      <div>
        <strong>Continuation review</strong>
        <span>Routine edits proceed automatically. Risky or unclear work blocks only its ticket.</span>
      </div>
      <span className="loop-reviewer-state">{running ? "Active" : "Ready"}</span>
    </div>
  );
}

function ConfirmationDialog({ confirmation, onClose }: {
  confirmation: LoopsConfirmMessage;
  onClose: () => void;
}) {
  const destructive = confirmation.action === "stop" || confirmation.action === "delete";
  const actionLabel = confirmation.action === "start" ? "Start loop" : confirmation.action === "stop" ? "Stop loop" : "Delete loop";
  const ActionIcon = confirmation.action === "start" ? Play : confirmation.action === "stop" ? Square : Trash2;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      post({ type: "cancel_loop_action", token: confirmation.token });
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation.token, onClose]);

  const cancel = () => {
    post({ type: "cancel_loop_action", token: confirmation.token });
    onClose();
  };
  const confirm = () => {
    post({ type: "confirm_loop_action", token: confirmation.token });
    onClose();
  };

  return (
    <div className="loop-confirm-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <section className="loop-confirm reveal-in" role="dialog" aria-modal="true" aria-labelledby="loop-confirm-title">
        <header className="loop-confirm-head">
          <span>{confirmation.action === "start" ? "Unattended execution" : "Loop control"}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Close confirmation" onClick={cancel}><X /></Button>
        </header>
        <div className="loop-confirm-body">
          <span className={cn("loop-confirm-icon", destructive && "is-destructive")} aria-hidden><ActionIcon /></span>
          <div>
            <h2 id="loop-confirm-title">{confirmation.title}</h2>
            <p>{confirmation.description}</p>
          </div>
          <ul className="loop-confirm-details">
            {confirmation.details.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
          {confirmation.caution && <div className="loop-confirm-caution"><ShieldCheck />{confirmation.caution}</div>}
        </div>
        <footer className="loop-confirm-foot">
          <span>Esc to cancel</span>
          <div>
            <Button size="xs" variant="ghost" onClick={cancel}>Cancel</Button>
            <Button size="xs" variant={destructive ? "destructive" : "default"} autoFocus onClick={confirm}><ActionIcon />{actionLabel}</Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ActivityIcon({ entry }: { entry: LoopActivity }) {
  if (entry.kind === "review_allowed") return <ShieldCheck />;
  if (entry.kind === "review_blocked") return <ShieldX />;
  if (entry.kind === "review_started") return <Eye />;
  if (entry.kind === "tool_started") return <Wrench />;
  if (entry.kind === "tool_finished") return entry.ok === false ? <XCircle /> : <CheckCircle2 />;
  if (entry.kind === "lane_started") return <Radio />;
  if (entry.kind === "lane_finished") return entry.ok === false ? <XCircle /> : <Sparkles />;
  return <AlertTriangle />;
}

function LaneCard({
  iteration,
  ticket,
  now,
  onTicket,
  onAsk,
}: {
  iteration: LoopIteration;
  ticket?: LoopTicket;
  now: number;
  onTicket: () => void;
  onAsk: () => void;
}) {
  const live = !iteration.endedAt;
  return (
    <details className={cn("loop-lane", live && "is-live", iteration.outcome === "parked" && "is-blocked")} open={live ? true : undefined}>
      <summary>
        <span className="loop-lane-signal" aria-hidden>{live ? <Radio /> : iteration.outcome === "succeeded" ? <CheckCircle2 /> : <CircleDot />}</span>
        <span className="loop-lane-title">
          <strong>{iteration.ticketId}</strong>
          <span>{ticket?.title || "Ticket lane"}</span>
        </span>
        <span className="loop-lane-meta">
          <StatusBadge status={live ? "running" : iteration.outcome === "parked" ? "blocked" : iteration.outcome} />
          <small>{duration(iteration.startedAt, iteration.endedAt, now)}{iteration.usd != null ? ` · ${money(iteration.usd)}` : ""}</small>
        </span>
        <ChevronDown className="loop-chevron" aria-hidden />
      </summary>
      <div className="loop-lane-body">
        <div className="loop-lane-actions">
          <Button size="xs" variant="outline" onClick={onTicket}><Eye />Ticket</Button>
          <Button size="xs" variant="ghost" onClick={onAsk}><MessageSquare />Ask agent</Button>
          {iteration.laneId && <code>{iteration.laneId}</code>}
        </div>
        {iteration.activity.length ? (
          <div className="loop-activity-list">
            {iteration.activity.map((entry) => (
              <div className="loop-activity" data-kind={entry.kind} key={entry.id}>
                <span className="loop-activity-icon"><ActivityIcon entry={entry} /></span>
                <div>
                  <span className="loop-activity-line"><strong>{entry.label}</strong><time>{time(entry.at)}</time></span>
                  {entry.detail && <p>{entry.detail}</p>}
                  {(entry.tier || entry.toolName) && <small>{[entry.tier, entry.toolName].filter(Boolean).join(" · ")}</small>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="loop-inline-empty"><Activity />Detailed activity will appear as this lane uses tools.</div>
        )}
        {iteration.detail && <div className="loop-lane-result"><strong>Lane report</strong><p>{iteration.detail}</p></div>}
      </div>
    </details>
  );
}

function QueueView({ loop }: { loop: LoopRecord }) {
  const stateById = new Map(loop.ticketState.map((state) => [state.ticketId, state]));
  const latestById = new Map<string, LoopIteration>();
  for (const iteration of loop.iterations) latestById.set(iteration.ticketId, iteration);
  const tickets = [...loop.tickets].sort((left, right) => {
    const leftBlocked = stateById.get(left.id)?.parkedOnGate ? 0 : 1;
    const rightBlocked = stateById.get(right.id)?.parkedOnGate ? 0 : 1;
    return leftBlocked - rightBlocked || left.id.localeCompare(right.id);
  });
  if (!tickets.length) return <EmptyState icon={<ListTodo />} title="No tickets in view" detail="This draft's filter does not currently match an open ticket." />;
  return (
    <div className="loop-queue">
      {tickets.map((ticket) => {
        const state = stateById.get(ticket.id);
        const latest = latestById.get(ticket.id);
        const blocked = state?.parkedOnGate;
        return (
          <article className={cn("loop-ticket", blocked && "is-blocked")} key={ticket.id}>
            <div className="loop-ticket-main">
              <span className="loop-ticket-id">{ticket.id}</span>
              <strong>{ticket.title}</strong>
              <span>{blocked ? `Review blocked · ${blocked}` : latest ? `Latest: ${latest.outcome}` : "Waiting to dispatch"}</span>
            </div>
            <div className="loop-ticket-meta">
              <StatusBadge status={blocked ? "blocked" : ticket.status} />
              <small>{state?.attempts ?? 0} attempt{state?.attempts === 1 ? "" : "s"}</small>
            </div>
            <div className="loop-ticket-actions">
              <Button size="icon-xs" variant="ghost" title="Open ticket" aria-label={`Open ${ticket.id}`} onClick={() => post({ type: "open_ticket", ticketId: ticket.id })}><Eye /></Button>
              <Button size="icon-xs" variant="ghost" title="Ask agent" aria-label={`Ask agent about ${ticket.id}`} onClick={() => post({ type: "ask_agent", loopId: loop.definition.id, ticketId: ticket.id })}><MessageSquare /></Button>
              {blocked && <Button size="xs" variant="outline" onClick={() => post({ type: "release_ticket", loopId: loop.definition.id, ticketId: ticket.id })}><RotateCcw />Release</Button>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ExecutionRow({ execution, now }: { execution: LoopExecution; now: number }) {
  return (
    <article className={cn("loop-execution", !execution.endedAt && "is-live")}>
      <span className="loop-execution-icon">{execution.endedAt ? <History /> : <Radio />}</span>
      <div className="loop-execution-title">
        <strong>{execution.id.replace("execution_", "Run ")}</strong>
        <span>{time(execution.startedAt)} · {duration(execution.startedAt, execution.endedAt, now)}</span>
        {execution.reason && <p>{execution.reason}</p>}
      </div>
      <div className="loop-execution-stats">
        <strong>{money(execution.totals.usd)}</strong>
        <span>{execution.totals.dispatched} ticket{execution.totals.dispatched === 1 ? "" : "s"}</span>
        <StatusBadge status={execution.status} />
      </div>
    </article>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="loop-empty"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>;
}

function Composer({ state, onClose }: { state: LoopsStateMessage; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [concurrency, setConcurrency] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [maxTickets, setMaxTickets] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("");
  const visible = state.availableTickets.filter((ticket) => {
    const query = search.toLowerCase().trim();
    return !query || `${ticket.id} ${ticket.title} ${ticket.labels.join(" ")}`.toLowerCase().includes(query);
  }).slice(0, 80);
  const submit = () => {
    if (!title.trim()) return;
    post({
      type: "create_loop",
      title,
      concurrency,
      ticketIds: selected,
      maxTickets: maxTickets || undefined,
      maxUsd: maxUsd || undefined,
      maxWallClockMinutes: maxMinutes || undefined,
      maxConsecutiveFailures: 3,
    });
    onClose();
  };
  return (
    <section className="loop-composer reveal-in">
      <div className="loop-section-heading"><div><span>New loop</span><strong>Define the unattended boundary</strong></div><Button size="xs" variant="ghost" onClick={onClose}>Close</Button></div>
      <label className="loop-field"><span>Objective</span><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Drain the auth backlog" /></label>
      <div className="loop-composer-grid">
        <label className="loop-field"><span>Workers</span><Input type="number" min={1} max={state.maxConcurrency} value={concurrency} onChange={(event) => setConcurrency(Math.max(1, Math.min(state.maxConcurrency, Number(event.target.value) || 1)))} /></label>
        <label className="loop-field"><span>Ticket ceiling</span><Input type="number" min={1} value={maxTickets} onChange={(event) => setMaxTickets(event.target.value)} placeholder="No cap" /></label>
        <label className="loop-field"><span>Spend ceiling</span><Input type="number" min={0} step="0.5" value={maxUsd} onChange={(event) => setMaxUsd(event.target.value)} placeholder="$ —" /></label>
        <label className="loop-field"><span>Minutes</span><Input type="number" min={1} value={maxMinutes} onChange={(event) => setMaxMinutes(event.target.value)} placeholder="No cap" /></label>
      </div>
      <div className="loop-scope-heading"><span>Queue scope</span><small>{selected.length ? `${selected.length} selected` : "All ready backlog + triage tickets"}</small></div>
      <label className="loop-ticket-search"><Search /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find tickets to pin…" /></label>
      <div className="loop-ticket-picker">
        {visible.map((ticket) => {
          const checked = selected.includes(ticket.id);
          return (
            <button type="button" className={cn("loop-ticket-option", checked && "is-selected")} key={ticket.id} onClick={() => setSelected(checked ? selected.filter((id) => id !== ticket.id) : [...selected, ticket.id])}>
              <span>{checked ? <CheckCircle2 /> : <CircleDot />}</span><strong>{ticket.id}</strong><small>{ticket.title}</small>
            </button>
          );
        })}
      </div>
      <div className="loop-composer-note"><ShieldCheck />The continuation reviewer resolves lane approvals. Unsafe work becomes a ticket-level block.</div>
      <Button className="loop-create-submit" disabled={!title.trim()} onClick={submit}><Zap />Create draft</Button>
    </section>
  );
}

export function LoopsApp() {
  const [state, setState] = useState<LoopsStateMessage>();
  const [notice, setNotice] = useState<LoopsNoticeMessage>();
  const [confirmation, setConfirmation] = useState<LoopsConfirmMessage>();
  const [tab, setTab] = useState<DetailTab>(initialUi.tab);
  const [composerOpen, setComposerOpen] = useState(initialUi.composerOpen);
  const [now, setNow] = useState(Date.now());

  useEffect(() => onMessage((message) => {
    if (!isLoopsHostMessage(message)) return;
    if (message.type === "loops_state") setState(message);
    else if (message.type === "loops_notice") setNotice(message);
    else if (message.type === "loops_confirm") setConfirmation(message);
    else if (message.type === "loops_intent" && message.intent === "open_composer") setComposerOpen(true);
  }), []);
  useEffect(() => { post({ type: "ready" }); }, []);
  useEffect(() => {
    writeUiState("loops", { tab, composerOpen });
  }, [tab, composerOpen]);
  useEffect(() => {
    if (!state?.loops.some((loop) => loop.definition.status === "running")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(() => state?.loops.find((loop) => loop.definition.id === state.selectedLoopId) ?? state?.loops[0], [state]);
  const currentExecution = selected?.executions.at(-1);
  const queueCount = selected?.proposal?.matchedTicketIds.length ?? selected?.tickets.length ?? 0;
  const progressMax = selected?.definition.ceilings.maxTickets ?? Math.max(queueCount, selected?.totals.dispatched ?? 0, 1);
  const progress = selected ? Math.min(100, (selected.totals.dispatched / progressMax) * 100) : 0;

  if (!state) {
    return <main className="loops-root"><div className="loops-loading"><span><Activity /></span><strong>Connecting to loop supervisor…</strong></div></main>;
  }

  return (
    <main className="loops-root">
      <header className="loops-header">
        <div className="loops-title-row">
          <div className="loops-brand"><span className="loops-brand-icon"><Bot /></span><div><span>Autonomous operations</span><h1>Ticket Loops</h1></div></div>
          <div className="loops-header-actions">
            <Button size="icon-sm" variant="ghost" title="Refresh" aria-label="Refresh loops" onClick={() => post({ type: "refresh" })}><RefreshCw /></Button>
            <Button className="loops-new-button" size="sm" onClick={() => setComposerOpen((open) => !open)}><Plus />New loop</Button>
          </div>
        </div>
        {state.loops.length > 0 && (
          <div className="loops-picker" aria-label="Available loops">
            {state.loops.map((loop) => (
              <button type="button" aria-pressed={loop.definition.id === selected?.definition.id} className={cn("loops-picker-item", loop.definition.id === selected?.definition.id && "is-selected")} key={loop.definition.id} onClick={() => post({ type: "select_loop", loopId: loop.definition.id })}>
                <span className={cn("loops-picker-dot", loop.definition.status === "running" && "is-live")} />
                <span><strong>{loop.definition.title}</strong><small>{loop.definition.status} · {money(loop.executions.at(-1)?.totals.usd)}</small></span>
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="loops-scroll">
        {notice && <div className="loops-notice reveal-in" data-tone={notice.tone}>{notice.tone === "error" ? <AlertTriangle /> : <CheckCircle2 />}{notice.message}</div>}
        {composerOpen && <Composer state={state} onClose={() => setComposerOpen(false)} />}

        {!selected ? (
          <EmptyState icon={<Sparkles />} title="Build your first loop" detail="Turn a ready ticket queue into supervised, unattended subagent work with durable history and spend controls." />
        ) : (
          <>
            <section className={cn("loop-hero", selected.definition.status === "running" && "is-live")}>
              <div className="loop-hero-top">
                <div className="loop-hero-copy"><span className="loop-kicker"><i aria-hidden />{selected.supervisorRunning ? "Supervisor online" : "Supervisor ready"}</span><h2>{selected.definition.title}</h2><p>{statusCopy(selected)}</p></div>
                <StatusBadge status={selected.definition.status} />
              </div>
              <div className="loop-progress" role="progressbar" aria-label="Loop ticket progress" aria-valuemin={0} aria-valuemax={progressMax} aria-valuenow={Math.min(selected.totals.dispatched, progressMax)}><span style={{ width: `${progress}%` }} /></div>
              <div className="loop-progress-copy"><span>{selected.totals.dispatched} attempted</span><span>{progressMax === queueCount ? `${queueCount} in queue` : `ceiling ${progressMax}`}</span></div>
              <div className="loop-controls">
                {["draft", "paused", "blocked", "drained", "stopped", "failed"].includes(selected.definition.status) && <Button size="xs" onClick={() => post({ type: "start_loop", loopId: selected.definition.id })}><Play />{selected.definition.status === "draft" ? "Start loop" : "Start execution"}</Button>}
                {selected.definition.status === "running" && <Button size="xs" variant="outline" onClick={() => post({ type: "pause_loop", loopId: selected.definition.id })}><Pause />Pause</Button>}
                {selected.definition.status === "running" && <Button size="xs" variant="outline" onClick={() => post({ type: "stop_loop", loopId: selected.definition.id })}><Square />Stop</Button>}
                <Button size="xs" variant="ghost" onClick={() => post({ type: "ask_agent", loopId: selected.definition.id })}><MessageSquare />Ask agent</Button>
                {selected.definition.status !== "running" && <Button className="loop-delete" size="icon-sm" variant="ghost" title="Delete loop" aria-label="Delete loop" onClick={() => post({ type: "delete_loop", loopId: selected.definition.id })}><Trash2 /></Button>}
              </div>
            </section>

            <section className="loop-metrics">
              <Metric icon={<DollarSign />} label="This execution" value={money(currentExecution?.totals.usd)} tone="info" />
              <Metric icon={<History />} label="Lifetime" value={money(selected.totals.usd)} />
              <Metric icon={<TicketCheck />} label="Awaiting review" value={selected.totals.succeeded} tone="ok" />
              <Metric icon={<ShieldX />} label="Review blocked" value={selected.totals.parked} tone={selected.totals.parked ? "warning" : undefined} />
            </section>

            <ReviewerBanner running={selected.definition.status === "running"} />

            {selected.definition.endedReason && <div className="loop-ended-reason"><AlertTriangle />{selected.definition.endedReason}</div>}

            <section className="loop-detail">
              <nav className="loop-tabs" aria-label="Loop details" role="tablist">
                <button type="button" role="tab" aria-selected={tab === "lanes"} className={tab === "lanes" ? "is-active" : ""} onClick={() => setTab("lanes")}><Activity />Lanes <span>{selected.iterations.length}</span></button>
                <button type="button" role="tab" aria-selected={tab === "queue"} className={tab === "queue" ? "is-active" : ""} onClick={() => setTab("queue")}><ListTodo />Queue <span>{queueCount}</span></button>
                <button type="button" role="tab" aria-selected={tab === "executions"} className={tab === "executions" ? "is-active" : ""} onClick={() => setTab("executions")}><Clock3 />Executions <span>{selected.executions.length}</span></button>
              </nav>
              <Separator />
              <div className="loop-tab-panel">
                {tab === "lanes" && (selected.iterations.length ? (
                  <div className="loop-lanes">
                    {[...selected.iterations].reverse().map((iteration) => (
                      <LaneCard
                        iteration={iteration}
                        ticket={selected.tickets.find((ticket) => ticket.id === iteration.ticketId)}
                        now={now}
                        key={`${iteration.executionId}:${iteration.seq}`}
                        onTicket={() => post({ type: "open_ticket", ticketId: iteration.ticketId })}
                        onAsk={() => post({ type: "ask_agent", loopId: selected.definition.id, ticketId: iteration.ticketId })}
                      />
                    ))}
                  </div>
                ) : <EmptyState icon={<Bot />} title="No lanes yet" detail="Start the loop and each subagent execution will stream its tool and review activity here." />)}
                {tab === "queue" && <QueueView loop={selected} />}
                {tab === "executions" && (selected.executions.length ? <div className="loop-executions">{[...selected.executions].reverse().map((execution) => <ExecutionRow execution={execution} now={now} key={execution.id} />)}</div> : <EmptyState icon={<History />} title="No executions yet" detail="Every start or resume creates a separate spend and outcome ledger." />)}
              </div>
            </section>
          </>
        )}
      </div>
      {confirmation && <ConfirmationDialog confirmation={confirmation} onClose={() => setConfirmation(undefined)} />}
    </main>
  );
}
