/* Project-local ticketing: a durable queue of independently-schedulable work.
 *
 * Stored at .blacksite/tickets.json, modeled on planning-store.ts (schema version, tolerant
 * normalization on read, full-document rewrite on mutation, an onDidChange emitter, and a
 * dispatch() surface backing the agent tools).
 *
 * The load-bearing constraint, restated here because it is the one most likely to erode:
 * A TICKET HAS NO STEPS. There is no steps[], no per-item status, no progress meter the agent
 * can maintain. A ticket carries a status and a planId; where a plan is linked, status is
 * *derived* from that plan's phase state (see reconcileTicket). Procedure and progress live in
 * exactly one place — the plan — so this surface is additive rather than a second tracker.
 *
 * Design doc: docs/ticket-entity-design.md. System plan: docs/tickets-implementation-plan.md.
 *
 * Text helpers are duplicated from planning-store rather than imported, for the same reason
 * that store keeps appendProjectMemory local: TicketStore stays independently constructible
 * (as every test does today) without threading another store through its constructor.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const BLACKSITE_DIR = ".blacksite";
const TICKETS_FILE = "tickets.json";
/* v2 added acceptanceCriteria, references, assignee, duplicateOf, and the stored `blocks`
   mirror of blockedBy. Every one of them is optional with a defaulted normalization, so a v1
   document reads as a valid v2 document with no migration pass — the same additive discipline
   planning-store.ts uses for its own v2. */
const TICKETS_SCHEMA_VERSION = 2;

/* Caps. Generous rather than tight, and every one truncates or drops rather than rejecting
   the call — a rejected ticket is a ticket not filed. See docs/ticket-entity-design.md §10.1. */
const MAX_TITLE = 160;
const MAX_DESCRIPTION = 8_000;
const MAX_COMPLEXITY_BASIS = 200;
const MAX_LABELS = 8;
const MAX_LABEL_CHARS = 24;
const MAX_TERRITORY_FILES = 60;
const MAX_TERRITORY_AREAS = 12;
const MAX_LINKS = 20;
const MAX_EVENTS = 200;
const MAX_COMMENT = 4_000;
const MAX_NOTE_TEXT = 400;
const MAX_CRITERIA = 20;
const MAX_CRITERION_CHARS = 300;
const MAX_REFERENCES = 12;
const MAX_REFERENCE_URL = 600;
const MAX_REFERENCE_TITLE = 120;
/** An area resolving to more than this reports a count instead of a list — a ticket scoped to
 *  the whole repository is a scoping error, and the UI should make that feel like one. */
export const MAX_RESOLVED_AREA_FILES = 200;
/** Consecutive same-kind system events by the same actor inside this window collapse into one. */
const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PROMPT_CHARS = 800;

export type TicketStatus =
  | "triage" | "backlog" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketComplexity = "small" | "medium" | "large";
export type TicketOrigin = "user" | "agent" | "map_note" | "diagnostic" | "review";
export type TicketActor = "user" | "agent" | "system";
/** Who owns the outcome. Not a person — this is a single-user tool with one collaborator,
 *  and the only distinction worth persisting is "I'll do it" versus "the agent should". */
export type TicketAssignee = "unassigned" | "user" | "agent";

export type TicketEventKind =
  | "created" | "comment"
  | "status" | "priority" | "complexity" | "label"
  | "territory" | "link" | "doc" | "reopened"
  | "assignee" | "criteria" | "reference";

/** One entry in a ticket's activity timeline. Comments and system transitions share one array
 *  because that is how the story actually reads — splitting them into separate tabs forces the
 *  reader to reconstruct the sequence by timestamp. */
export interface TicketEvent {
  id: string;
  at: string;
  actor: TicketActor;
  /** Correlates a comment back to the chat session that left it. */
  sessionId?: string;
  kind: TicketEventKind;
  /** Markdown, for kind "comment". */
  body?: string;
  from?: string;
  to?: string;
}

/**
 * What a ticket claims to be about.
 *
 * `files` are exact Codebase Map node ids; `areas` are directory prefixes matched the way
 * map-queries' area filter matches them. Both are stored as *intent* — the set of files an
 * area currently resolves to is derived at read time (resolveTerritory), never persisted, so
 * a ticket scoped to "src/graph/" stays true as files come and go.
 */
export interface TicketTerritory {
  files: string[];
  areas: string[];
}

/**
 * An outward pointer: an issue tracker URL, a spec, a PR, a design doc.
 *
 * Deliberately distinct from territory (which is *inside* the codebase and resolvable against
 * the Map index) and from ticket links (which are graph edges the store keeps symmetric).
 * These are inert strings the UI makes clickable and nothing else reasons about.
 */
export interface TicketReference {
  url: string;
  title?: string;
}

export interface Ticket {
  id: string;
  title: string;
  description?: string;
  status: TicketStatus;
  /** "derived" while a linked plan drives status; the first manual change flips it to
   *  "manual" and derivation stops overriding. */
  statusSource: "manual" | "derived";
  priority: TicketPriority;
  complexity?: TicketComplexity;
  /** One clause on why that complexity — carried in the queue tooltip. */
  complexityBasis?: string;
  labels: string[];
  /**
   * Definition of done, as statements rather than steps.
   *
   * The no-steps rule still holds: these carry no per-item completion state and no progress
   * meter, exactly as a plan phase's acceptanceCriteria do. They say what "done" means so the
   * agent has a bar to check its work against and the user has something to verify at review
   * time — procedure and progress still live only in the linked plan.
   */
  acceptanceCriteria: string[];
  territory: TicketTerritory;
  /** Outward pointers — specs, PRs, upstream issues. Inert; nothing derives from them. */
  references: TicketReference[];
  planId?: string;
  phaseId?: string;
  /** Ticket ids that must close first. Informational, never enforced. */
  blockedBy: string[];
  /** The other end of blockedBy — stored, not derived, so one read answers both directions.
   *  The store writes both sides of every edit; neither is authored independently. */
  blocks: string[];
  /** Symmetric association — the store writes the reverse side. */
  relatedTo: string[];
  /** Points at the ticket this one duplicates. Kept rather than deleted, because the duplicate
   *  is often where the better description lives. */
  duplicateOf?: string;
  assignee: TicketAssignee;
  origin: TicketOrigin;
  originRef?: string;
  events: TicketEvent[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  sessionId?: string;
}

export interface TicketDocument {
  schemaVersion: number;
  updatedAt: string | null;
  /** Array order is backlog rank; the board reorders in place. */
  tickets: Ticket[];
}

/** The slice of a plan that ticket status derivation needs. Keeps TicketStore constructible
 *  without a PlanningStore, and keeps the dependency one-directional. */
export interface LinkedPlanState {
  id: string;
  status: string;
  executionApproved: boolean;
  phases: Array<{ id: string; status: string }>;
}

export interface TicketContext {
  sessionId: string;
  signal?: AbortSignal;
}

/** Backs the ticket_* agent tools ("tickets.*" runtime types). */
export interface TicketToolProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: TicketContext): Promise<Record<string, unknown>>;
}

/** Kept structural so TicketStore stays independent of the VS Code-facing
 * scanner. Sweeps propose; this store remains the sole writer of tickets. */
export interface TicketSweepProvider {
  run(options: { area?: string; includeMarkers?: boolean; includeDiagnostics?: boolean; limit?: number; testFailures?: Array<{ file: string; message: string; line?: number; source?: string; severity: "error" | "warning" }> }, signal?: AbortSignal): Promise<{
    proposals: Array<{ title: string; file: string; line?: number; source: string; priority: TicketPriority; detail?: string; key: string }>;
    scannedFiles: number;
    totalFound: number;
  }>;
}

const OPEN_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "triage", "backlog", "in_progress", "blocked", "review",
]);

export function isOpenStatus(status: TicketStatus): boolean {
  return OPEN_STATUSES.has(status);
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxChars) : "";
}

function cleanParagraph(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function statusKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Coerce a free-text status to the canonical set, accepting the synonym families a model
 * actually reaches for. Like normalizePlanStatus, this never rejects a recognizable value —
 * a failed call over "wip" versus "in_progress" is a wasted turn.
 */
export function normalizeTicketStatus(value: unknown): TicketStatus | null {
  switch (statusKey(value)) {
    case "triage": case "new": case "untriaged": case "inbox": case "filed":
      return "triage";
    case "backlog": case "todo": case "pending": case "accepted": case "open": case "planned": case "not_started":
      return "backlog";
    case "in_progress": case "inprogress": case "active": case "doing": case "started": case "wip": case "running":
      return "in_progress";
    case "blocked": case "block": case "stuck": case "waiting": case "on_hold": case "paused":
      return "blocked";
    case "review": case "in_review": case "needs_review": case "verifying": case "ready_for_review":
      return "review";
    case "done": case "complete": case "completed": case "finished": case "closed": case "shipped": case "resolved":
      return "done";
    case "cancelled": case "canceled": case "cancel": case "wontfix": case "wont_fix": case "abandoned": case "dropped":
      return "cancelled";
    default:
      return null;
  }
}

export function normalizeTicketPriority(value: unknown): TicketPriority | null {
  switch (statusKey(value)) {
    case "urgent": case "critical": case "p0": case "highest": case "blocker":
      return "urgent";
    case "high": case "p1": case "important":
      return "high";
    case "normal": case "medium": case "default": case "p2": case "none":
      return "normal";
    case "low": case "minor": case "p3": case "trivial": case "nice_to_have":
      return "low";
    default:
      return null;
  }
}

export function normalizeTicketComplexity(value: unknown): TicketComplexity | null {
  const key = statusKey(value);
  return key === "small" || key === "medium" || key === "large" ? key : null;
}

function normalizeOrigin(value: unknown): TicketOrigin {
  switch (statusKey(value)) {
    case "user": case "human": return "user";
    case "map_note": case "note": return "map_note";
    case "diagnostic": case "diagnostics": case "lint": return "diagnostic";
    case "review": case "code_review": return "review";
    default: return "agent";
  }
}

function normalizeActor(value: unknown): TicketActor {
  const key = statusKey(value);
  return key === "user" || key === "system" ? key : "agent";
}

export function normalizeAssignee(value: unknown): TicketAssignee {
  switch (statusKey(value)) {
    case "user": case "me": case "human": case "you": return "user";
    case "agent": case "blacksite": case "ai": case "assistant": return "agent";
    default: return "unassigned";
  }
}

/** Definition-of-done bullets: one line each, deduplicated, capped. Empty entries drop rather
 *  than persisting a blank row the UI then has to render. */
function normalizeCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value.map((entry) => cleanText(entry, MAX_CRITERION_CHARS)).filter(Boolean);
  return [...new Set(entries)].slice(0, MAX_CRITERIA);
}

/**
 * Coerce one outward reference.
 *
 * Only http(s) and workspace-relative paths survive. A `javascript:` or `data:` URL reaching a
 * webview's anchor href is the whole reason this filter exists — the queue accepts strings
 * authored by a model, and an inert-looking field is exactly where that would go unnoticed.
 */
function normalizeReference(value: unknown): TicketReference | null {
  const record = (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : { url: value };
  const url = cleanText(record.url, MAX_REFERENCE_URL);
  if (!url) return null;
  const isWeb = /^https?:\/\/\S+$/i.test(url);
  const isWorkspacePath = !/^[a-z][a-z0-9+.-]*:/i.test(url);
  if (!isWeb && !isWorkspacePath) return null;
  const title = cleanText(record.title, MAX_REFERENCE_TITLE);
  return { url, ...(title ? { title } : {}) };
}

function normalizeReferences(value: unknown): TicketReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TicketReference[] = [];
  for (const entry of value) {
    const reference = normalizeReference(entry);
    if (!reference || seen.has(reference.url)) continue;
    seen.add(reference.url);
    out.push(reference);
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}

/**
 * Labels are free-form but normalized to one shape so `auth`, `Auth`, and `Auth Service`
 * cannot coexist as three different labels. No fixed taxonomy and no reserved values —
 * anything deserving consistent behavior gets a real field instead.
 */
export function normalizeLabel(value: unknown): string {
  return cleanText(value, MAX_LABEL_CHARS * 2)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LABEL_CHARS);
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = value.map(normalizeLabel).filter(Boolean);
  return [...new Set(seen)].slice(0, MAX_LABELS);
}

/**
 * One path dialect for territory files, matching the one plan phases, map notes, git, and
 * every file tool already speak: forward slashes, no leading "./", de-duplicated.
 */
export function normalizeTerritoryFile(value: unknown): string {
  return cleanText(value, 400).replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/** Directory prefix, normalized the way map-queries' area filter normalizes one. */
export function normalizeArea(value: unknown): string {
  return cleanText(value, 400).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function normalizeTerritory(value: unknown): TicketTerritory {
  const record = (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
  const files = Array.isArray(record.files) ? record.files.map(normalizeTerritoryFile).filter(Boolean) : [];
  const areas = Array.isArray(record.areas) ? record.areas.map(normalizeArea).filter(Boolean) : [];
  return {
    files: [...new Set(files)].slice(0, MAX_TERRITORY_FILES),
    areas: [...new Set(areas)].slice(0, MAX_TERRITORY_AREAS),
  };
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((entry) => cleanText(entry, 60)).filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_LINKS);
}

function normalizeEvent(value: unknown): TicketEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = statusKey(record.kind) as TicketEventKind;
  const known: TicketEventKind[] = [
    "created", "comment", "status", "priority", "complexity", "label", "territory", "link", "doc", "reopened",
    "assignee", "criteria", "reference",
  ];
  if (!known.includes(kind)) return null;
  const body = kind === "comment" ? cleanParagraph(record.body, MAX_COMMENT) : cleanParagraph(record.body, MAX_NOTE_TEXT);
  if (kind === "comment" && !body) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("evt"),
    at: typeof record.at === "string" && record.at ? record.at : nowIso(),
    actor: normalizeActor(record.actor),
    sessionId: cleanText(record.sessionId, 120) || undefined,
    kind,
    body: body || undefined,
    from: cleanText(record.from, 120) || undefined,
    to: cleanText(record.to, 120) || undefined,
  };
}

/**
 * Prune a timeline back under the cap.
 *
 * Asymmetric on purpose: system events drop oldest-first and comments are never auto-pruned.
 * Comments are authored content; transitions are reconstructible from the ticket's own state.
 * "created" is pinned so a ticket never loses its provenance.
 */
function pruneEvents(events: TicketEvent[]): TicketEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  const keep = new Set<TicketEvent>();
  for (const event of events) {
    if (event.kind === "comment" || event.kind === "created") keep.add(event);
  }
  const system = events.filter((event) => !keep.has(event));
  const budget = Math.max(0, MAX_EVENTS - keep.size);
  for (const event of system.slice(-budget)) keep.add(event);
  return events.filter((event) => keep.has(event));
}

/** True when `next` should fold into `previous` rather than becoming its own entry. */
function canCoalesce(previous: TicketEvent, next: TicketEvent): boolean {
  if (previous.kind !== next.kind || previous.actor !== next.actor) return false;
  if (next.kind === "comment" || next.kind === "created") return false;
  const gap = Date.parse(next.at) - Date.parse(previous.at);
  return Number.isFinite(gap) && gap >= 0 && gap <= COALESCE_WINDOW_MS;
}

function appendEvent(ticket: Ticket, event: TicketEvent): void {
  const previous = ticket.events[ticket.events.length - 1];
  if (previous && canCoalesce(previous, event)) {
    // Keep the original `from` so the collapsed entry still reads as one whole transition.
    previous.to = event.to;
    previous.at = event.at;
    if (event.body) previous.body = event.body;
    return;
  }
  ticket.events.push(event);
  ticket.events = pruneEvents(ticket.events);
}

function systemEvent(
  kind: TicketEventKind,
  actor: TicketActor,
  detail: { from?: string; to?: string; body?: string; sessionId?: string } = {},
): TicketEvent {
  return {
    id: newId("evt"),
    at: nowIso(),
    actor,
    kind,
    ...(detail.body ? { body: cleanParagraph(detail.body, MAX_NOTE_TEXT) } : {}),
    ...(detail.from ? { from: detail.from } : {}),
    ...(detail.to ? { to: detail.to } : {}),
    ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
  };
}

function normalizeTicket(value: unknown): Ticket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = cleanText(record.title, MAX_TITLE);
  if (!title) return null;
  const id = cleanText(record.id, 60);
  if (!id) return null;
  const events = Array.isArray(record.events)
    ? record.events.map(normalizeEvent).filter((event): event is TicketEvent => event !== null)
    : [];
  const status = normalizeTicketStatus(record.status) ?? "triage";
  return {
    id,
    title,
    description: cleanParagraph(record.description, MAX_DESCRIPTION) || undefined,
    status,
    statusSource: record.statusSource === "manual" ? "manual" : "derived",
    priority: normalizeTicketPriority(record.priority) ?? "normal",
    complexity: normalizeTicketComplexity(record.complexity) ?? undefined,
    complexityBasis: cleanText(record.complexityBasis, MAX_COMPLEXITY_BASIS) || undefined,
    labels: normalizeLabels(record.labels),
    acceptanceCriteria: normalizeCriteria(record.acceptanceCriteria),
    territory: normalizeTerritory(record.territory),
    references: normalizeReferences(record.references),
    planId: cleanText(record.planId, 120) || undefined,
    phaseId: cleanText(record.phaseId, 120) || undefined,
    blockedBy: normalizeIdList(record.blockedBy),
    blocks: normalizeIdList(record.blocks),
    relatedTo: normalizeIdList(record.relatedTo),
    duplicateOf: cleanText(record.duplicateOf, 60) || undefined,
    assignee: normalizeAssignee(record.assignee),
    origin: normalizeOrigin(record.origin),
    originRef: cleanText(record.originRef, 200) || undefined,
    events: pruneEvents(events),
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    closedAt: cleanText(record.closedAt, 40) || undefined,
    sessionId: cleanText(record.sessionId, 120) || undefined,
  };
}

/**
 * Make the relation graph consistent on every read.
 *
 * Three jobs, all of them healing rather than validating: drop ids that point at tickets which
 * no longer exist, make `relatedTo` symmetric, and rebuild `blocks` as the exact inverse of
 * `blockedBy`. Doing this at read time rather than trusting the file means a v1 document (which
 * has no `blocks` at all), a hand-edited tickets.json, and a half-applied write all converge on
 * the same graph — and no surface ever has to render a link whose other end is missing.
 *
 * `blockedBy` is the sole authority for that edge and `blocks` is derived from it, never the
 * other way round. Honouring both directions as authored would make removal impossible: clearing
 * B from A.blockedBy would only see it restored from the stale A in B.blocks on the next read.
 * Editing `blocks` is still supported — updateTicket translates it into the blockedBy of the
 * tickets named, which is the edge this then rebuilds from.
 */
function reconcileLinks(tickets: Ticket[]): void {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const blocks = new Map<string, Set<string>>(tickets.map((ticket) => [ticket.id, new Set<string>()]));
  const related = new Map<string, Set<string>>(tickets.map((ticket) => [ticket.id, new Set<string>()]));

  for (const ticket of tickets) {
    ticket.blockedBy = ticket.blockedBy.filter((id) => id !== ticket.id && byId.has(id));
    for (const id of ticket.blockedBy) blocks.get(id)?.add(ticket.id);
    for (const id of ticket.relatedTo) {
      if (id === ticket.id || !byId.has(id)) continue;
      related.get(ticket.id)?.add(id);
      related.get(id)?.add(ticket.id);
    }
    if (ticket.duplicateOf && (ticket.duplicateOf === ticket.id || !byId.has(ticket.duplicateOf))) {
      ticket.duplicateOf = undefined;
    }
  }

  for (const ticket of tickets) {
    ticket.blocks = [...(blocks.get(ticket.id) ?? [])].slice(0, MAX_LINKS);
    ticket.relatedTo = [...(related.get(ticket.id) ?? [])].slice(0, MAX_LINKS);
  }
}

export interface NormalizeResult {
  document: TicketDocument;
  /** Entries that could not be salvaged, so corruption is reported rather than silently eaten. */
  dropped: number;
}

export function normalizeTicketDocument(value: unknown): NormalizeResult {
  const record = (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
  const raw = Array.isArray(record.tickets) ? record.tickets : [];
  const tickets: Ticket[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of raw) {
    const ticket = normalizeTicket(entry);
    if (!ticket || seen.has(ticket.id)) { dropped += 1; continue; }
    seen.add(ticket.id);
    tickets.push(ticket);
  }
  reconcileLinks(tickets);
  return {
    document: {
      schemaVersion: TICKETS_SCHEMA_VERSION,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      tickets,
    },
    dropped,
  };
}

function defaultDocument(): TicketDocument {
  return { schemaVersion: TICKETS_SCHEMA_VERSION, updatedAt: null, tickets: [] };
}

/** Next sequential id above the highest existing one. Ids are never reused, including by
 *  closed tickets, because they leak into commit messages and branch names. */
function nextTicketId(tickets: Ticket[], prefix: string): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, "i");
  let max = 0;
  for (const ticket of tickets) {
    const match = pattern.exec(ticket.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Drive a ticket's status from its linked plan.
 *
 * Runs on every read, mirroring reconcilePlan in planning-store. `done` is never derived —
 * closing a ticket is an explicit act, by the user or by an agent the user has permitted.
 * A manual status change detaches the ticket (statusSource "manual") and this leaves it alone.
 *
 * Returns true when it changed something, so the caller can decide whether to persist.
 */
export function reconcileTicket(ticket: Ticket, plans: readonly LinkedPlanState[]): boolean {
  if (!ticket.planId) return false;
  const plan = plans.find((candidate) => candidate.id === ticket.planId);

  /* A plan that no longer exists (or was cancelled outright) must not leave the ticket
     pointing at nothing — clear the link, record why, and freeze the status where it landed. */
  if (!plan || plan.status === "cancelled") {
    const reason = plan ? "its plan was cancelled" : "its plan no longer exists";
    ticket.planId = undefined;
    ticket.phaseId = undefined;
    if (ticket.statusSource === "derived" && isOpenStatus(ticket.status)) ticket.status = "backlog";
    appendEvent(ticket, systemEvent("link", "system", { body: `Plan link cleared — ${reason}.` }));
    ticket.updatedAt = nowIso();
    return true;
  }

  if (ticket.statusSource !== "derived") return false;

  const derived = derivePlanStatus(plan);
  if (derived === ticket.status) return false;
  const from = ticket.status;
  ticket.status = derived;
  ticket.closedAt = undefined;
  appendEvent(ticket, systemEvent("status", "system", { from, to: derived, body: "Followed the linked plan." }));
  ticket.updatedAt = nowIso();
  return true;
}

/** The §5.3 derivation table, in table order — see docs/tickets-implementation-plan.md. */
function derivePlanStatus(plan: LinkedPlanState): TicketStatus {
  if (plan.status === "on_hold") return "blocked";
  if (!plan.executionApproved) return "backlog";
  const phaseStatuses = plan.phases.map((phase) => statusKey(phase.status));
  if (phaseStatuses.some((status) => status === "in_progress")) return "in_progress";
  if (phaseStatuses.some((status) => status === "blocked")) return "blocked";
  if (plan.status === "completed") return "review";
  if (phaseStatuses.length > 0 && phaseStatuses.every((status) => status === "completed")) return "review";
  return "backlog";
}

export interface ResolvedTerritory {
  /** Explicit files plus every indexed node under a declared area. */
  files: string[];
  /** Declared files absent from the index — kept and flagged, never silently dropped. */
  staleFiles: string[];
  /** Per-area membership counts, so an over-broad area reads as a scoping error. */
  areas: Array<{ area: string; files: number; truncated: boolean }>;
}

/**
 * What a ticket's declared territory currently covers.
 *
 * Derived, never stored: an area's membership changes as files come and go, and persisting a
 * snapshot of it would go stale the moment someone adds a file. A declared file that is absent
 * from the index is *flagged*, not removed — it may be renamed, gitignored, or simply beyond a
 * render cap, all of which a silent drop would turn into lost intent.
 */
export function resolveTerritory(
  territory: TicketTerritory,
  indexedFiles: readonly string[],
): ResolvedTerritory {
  const indexed = new Set(indexedFiles);
  const hasIndex = indexed.size > 0;
  const files = new Set<string>();
  const staleFiles: string[] = [];

  for (const file of territory.files) {
    if (!hasIndex || indexed.has(file)) files.add(file);
    else staleFiles.push(file);
  }

  const areas: ResolvedTerritory["areas"] = [];
  for (const area of territory.areas) {
    const members = indexedFiles.filter((id) => id === area || id.startsWith(`${area}/`));
    const truncated = members.length > MAX_RESOLVED_AREA_FILES;
    if (!truncated) for (const member of members) files.add(member);
    areas.push({ area, files: members.length, truncated });
  }

  return { files: [...files], staleFiles, areas };
}

const HEAT_WEIGHT: Record<TicketPriority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

/**
 * Open-ticket weight per file, for the Map's ticket heat lens.
 *
 * Resolved on the host because areas need the live index to expand, and the webview has no
 * business re-deriving that. Priority-weighted so one urgent ticket outweighs three low ones,
 * and an area that resolves to an unreasonable number of files is skipped rather than smearing
 * uniform heat across half the map — a ticket scoped that broadly says nothing about where the
 * work actually is.
 */
export function ticketHeatWeights(
  tickets: readonly Ticket[],
  indexedFiles: readonly string[],
): { weights: Record<string, number>; openCount: number } {
  const weights: Record<string, number> = {};
  let openCount = 0;
  for (const ticket of tickets) {
    if (!isOpenStatus(ticket.status)) continue;
    openCount += 1;
    const weight = HEAT_WEIGHT[ticket.priority];
    const resolved = resolveTerritory(ticket.territory, indexedFiles);
    for (const file of resolved.files) weights[file] = (weights[file] ?? 0) + weight;
  }
  return { weights, openCount };
}

/**
 * Free-text match across everything a ticket says about itself.
 *
 * AND across whitespace-separated terms, substring within each — so "graph layout" finds the
 * ticket whose title mentions the layout of the graph without demanding that exact phrase.
 * Deliberately not fuzzy: at three hundred tickets, a search that returns near-misses ranked
 * above exact hits is worse than one that returns nothing and lets you retype.
 */
export function matchesTicketQuery(ticket: Ticket, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    ticket.id,
    ticket.title,
    ticket.description ?? "",
    ticket.labels.join(" "),
    ticket.acceptanceCriteria.join(" "),
    ticket.territory.files.join(" "),
    ticket.territory.areas.join(" "),
    ticket.references.map((reference) => `${reference.title ?? ""} ${reference.url}`).join(" "),
    ticket.planId ?? "",
    ticket.status,
    ticket.priority,
  ].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Tickets whose territory intersects any of `paths`, most recently updated first. */
export function ticketsTouchingFiles(
  tickets: readonly Ticket[],
  paths: readonly string[],
): Ticket[] {
  const wanted = paths.map(normalizeTerritoryFile).filter(Boolean);
  if (wanted.length === 0) return [];
  return tickets
    .filter((ticket) => isOpenStatus(ticket.status))
    .filter((ticket) => wanted.some((file) => (
      ticket.territory.files.includes(file)
      || ticket.territory.areas.some((area) => file === area || file.startsWith(`${area}/`))
    )))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The per-turn context block: tickets intersecting the files currently in play, then one line
 * of queue posture. Deliberately narrow — this runs on every turn, and everything else is one
 * ticket_list call away.
 */
export function summarizeTicketsForPrompt(
  workspaceRoot: string,
  openFiles: readonly string[] = [],
  maxChars = MAX_PROMPT_CHARS,
): string {
  const { document } = normalizeTicketDocument(readJsonFile(path.join(workspaceRoot, BLACKSITE_DIR, TICKETS_FILE)));
  const open = document.tickets.filter((ticket) => isOpenStatus(ticket.status));
  if (open.length === 0) return "";

  const lines: string[] = [];
  const touching = ticketsTouchingFiles(document.tickets, openFiles).slice(0, 4);
  if (touching.length > 0) {
    lines.push("Open tickets touching your current files:");
    for (const ticket of touching) {
      lines.push(`- ${ticket.id} [${ticket.status}, ${ticket.priority}] ${ticket.title}`);
      const where = [
        ticket.territory.files.slice(0, 2).join(", "),
        ticket.planId ? `plan ${ticket.planId}${ticket.phaseId ? ` phase ${ticket.phaseId}` : ""}` : "",
      ].filter(Boolean).join(" · ");
      if (where) lines.push(`    ${where}`);
    }
    lines.push("");
  }

  const urgent = open.filter((ticket) => ticket.priority === "urgent" || ticket.priority === "high").length;
  const triage = open.filter((ticket) => ticket.status === "triage").length;
  const mine = open.filter((ticket) => ticket.assignee === "agent");
  const posture = [`Queue: ${open.length} open`];
  if (urgent > 0) posture.push(`(${urgent} urgent/high)`);
  if (triage > 0) posture.push(`· ${triage} in triage awaiting your review`);
  lines.push(posture.join(" "));
  /* Assignment is the one queue fact worth spending per-turn budget on beyond posture: a
     ticket the user handed to the agent is a standing instruction, and it should not need a
     ticket_list call to be remembered. */
  if (mine.length > 0) {
    lines.push(`Assigned to you: ${mine.slice(0, 3).map((ticket) => `${ticket.id} ${ticket.title}`).join("; ")}`
      + (mine.length > 3 ? ` (+${mine.length - 3} more)` : ""));
  }

  return lines.join("\n").slice(0, maxChars);
}

export class TicketStore implements TicketToolProvider, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<TicketDocument>();
  private _sweepProvider?: TicketSweepProvider;

  readonly onDidChange = this._emitter.event;

  constructor(
    private readonly _workspaceRoot: string,
    /** Live plan state for status derivation. Optional so the store stays constructible
     *  (and unit-testable) without a PlanningStore. */
    private readonly _plans: () => LinkedPlanState[] = () => [],
    /** Whether the agent may move a ticket to "done" itself. Mirrors the Plans posture
     *  toward archiving: permitted only because the user said so. */
    private readonly _agentMayClose: () => boolean = () => false,
    /** Indexed Codebase Map node ids, for territory resolution. */
    private readonly _indexedFiles: () => string[] = () => [],
    private readonly _idPrefix: () => string = () => "BLK",
  ) {}

  dispose(): void {
    this._emitter.dispose();
  }

  ensureInitialized(): void {
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs.existsSync(this.filePath())) {
      fs.writeFileSync(this.filePath(), `${JSON.stringify(defaultDocument(), null, 2)}\n`, "utf8");
    }
  }

  filePath(): string {
    return path.join(this._workspaceRoot, BLACKSITE_DIR, TICKETS_FILE);
  }

  read(): TicketDocument {
    const { document } = normalizeTicketDocument(readJsonFile(this.filePath()));
    const plans = this._plans();
    for (const ticket of document.tickets) reconcileTicket(ticket, plans);
    return document;
  }

  /** Read plus the corruption count, for the surface that wants to report it. */
  readWithDiagnostics(): NormalizeResult {
    const result = normalizeTicketDocument(readJsonFile(this.filePath()));
    const plans = this._plans();
    for (const ticket of result.document.tickets) reconcileTicket(ticket, plans);
    return result;
  }

  resolveTerritoryFor(ticket: Ticket): ResolvedTerritory {
    return resolveTerritory(ticket.territory, this._indexedFiles());
  }

  setSweepProvider(provider: TicketSweepProvider): void {
    this._sweepProvider = provider;
  }

  async dispatch(op: string, payload: Record<string, unknown>, ctx: TicketContext): Promise<Record<string, unknown>> {
    switch (op) {
      case "file": return this.fileTicket(payload, ctx);
      case "update": return this.updateTicket(payload, ctx);
      case "list": return this.listTickets(payload);
      case "get": return this.getTicket(payload);
      case "comment": return this.commentOnTicket(payload, ctx);
      case "promote": return this.promoteTicket(payload);
      case "next": return this.nextTickets(payload);
      case "sweep": return this.sweepTickets(payload, ctx.signal);
      default: return { ok: false, error: `Unknown ticket operation: ${op}` };
    }
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  fileTicket(payload: Record<string, unknown>, ctx: TicketContext): Record<string, unknown> {
    const title = cleanText(payload.title, MAX_TITLE);
    if (!title) return { ok: false, error: "A ticket needs a title." };

    const document = this.read();
    const timestamp = nowIso();
    const actor: TicketActor = ctx.sessionId === "webview" ? "user" : "agent";
    const origin = payload.origin === undefined && actor === "user" ? "user" : normalizeOrigin(payload.origin);
    const ticket: Ticket = {
      id: nextTicketId(document.tickets, this._idPrefix()),
      title,
      description: cleanParagraph(payload.description, MAX_DESCRIPTION) || undefined,
      status: normalizeTicketStatus(payload.status) ?? (actor === "user" ? "backlog" : "triage"),
      statusSource: "manual",
      priority: normalizeTicketPriority(payload.priority) ?? "normal",
      complexity: normalizeTicketComplexity(payload.complexity) ?? undefined,
      complexityBasis: cleanText(payload.complexityBasis, MAX_COMPLEXITY_BASIS) || undefined,
      labels: normalizeLabels(payload.labels),
      acceptanceCriteria: normalizeCriteria(payload.acceptanceCriteria),
      territory: normalizeTerritory(payload.territory ?? { files: payload.files, areas: payload.areas }),
      references: normalizeReferences(payload.references),
      blockedBy: normalizeIdList(payload.blockedBy).filter((id) => document.tickets.some((t) => t.id === id)),
      blocks: [],
      relatedTo: normalizeIdList(payload.relatedTo).filter((id) => document.tickets.some((t) => t.id === id)),
      duplicateOf: normalizeIdList([payload.duplicateOf]).find((id) => document.tickets.some((t) => t.id === id)),
      assignee: normalizeAssignee(payload.assignee),
      origin,
      originRef: cleanText(payload.originRef, 200) || undefined,
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionId: ctx.sessionId,
    };
    ticket.events.push(systemEvent("created", actor, {
      sessionId: ctx.sessionId,
      body: origin === "map_note" ? "Promoted from a Codebase Map note." : undefined,
    }));

    document.tickets.push(ticket);
    this.write(document);
    return { ok: true, ticketId: ticket.id, ticket: this.publicView(ticket) };
  }

  updateTicket(payload: Record<string, unknown>, ctx: TicketContext): Record<string, unknown> {
    const document = this.read();
    const ticket = document.tickets.find((candidate) => candidate.id === cleanText(payload.ticketId, 60));
    if (!ticket) return { ok: false, error: `No ticket with id ${String(payload.ticketId ?? "")}.` };

    const actor: TicketActor = ctx.sessionId === "webview" ? "user" : "agent";
    const changed: string[] = [];

    if (payload.status !== undefined) {
      const next = normalizeTicketStatus(payload.status);
      if (!next) return { ok: false, error: `Unrecognized ticket status: ${String(payload.status)}.` };
      if (next === "done" && actor === "agent" && !this._agentMayClose()) {
        return {
          ok: false,
          error: "Closing a ticket is the user's action. Move it to \"review\" instead, or ask them to enable "
            + "blacksite.tickets.agentMayClose if they want you to close tickets yourself.",
        };
      }
      if (next !== ticket.status) {
        appendEvent(ticket, systemEvent("status", actor, { from: ticket.status, to: next, sessionId: ctx.sessionId }));
        if (isOpenStatus(next) && ticket.closedAt) {
          ticket.closedAt = undefined;
          appendEvent(ticket, systemEvent("reopened", actor, { sessionId: ctx.sessionId }));
        }
        if (!isOpenStatus(next)) ticket.closedAt = nowIso();
        ticket.status = next;
        ticket.statusSource = "manual";
        changed.push("status");
      }
    }

    if (payload.priority !== undefined) {
      const next = normalizeTicketPriority(payload.priority);
      if (next && next !== ticket.priority) {
        appendEvent(ticket, systemEvent("priority", actor, { from: ticket.priority, to: next, sessionId: ctx.sessionId }));
        ticket.priority = next;
        changed.push("priority");
      }
    }

    if (payload.complexity !== undefined) {
      /* An explicitly empty value un-sizes the ticket. Without this, a size set by mistake is
         permanent — "unsized" would be the one state reachable only by hand-editing the file. */
      const cleared = payload.complexity === null || cleanText(payload.complexity, 20) === "";
      const next = cleared ? undefined : normalizeTicketComplexity(payload.complexity) ?? undefined;
      if ((cleared || next) && next !== ticket.complexity) {
        appendEvent(ticket, systemEvent("complexity", actor, {
          from: ticket.complexity, to: next ?? "unsized", sessionId: ctx.sessionId,
        }));
        ticket.complexity = next;
        if (!next) ticket.complexityBasis = undefined;
        changed.push("complexity");
      }
    }
    if (payload.complexityBasis !== undefined) {
      ticket.complexityBasis = cleanText(payload.complexityBasis, MAX_COMPLEXITY_BASIS) || undefined;
      changed.push("complexityBasis");
    }

    if (payload.assignee !== undefined) {
      const next = normalizeAssignee(payload.assignee);
      if (next !== ticket.assignee) {
        appendEvent(ticket, systemEvent("assignee", actor, { from: ticket.assignee, to: next, sessionId: ctx.sessionId }));
        ticket.assignee = next;
        changed.push("assignee");
      }
    }

    if (payload.title !== undefined) {
      const next = cleanText(payload.title, MAX_TITLE);
      if (next) { ticket.title = next; changed.push("title"); }
    }
    if (payload.description !== undefined) {
      ticket.description = cleanParagraph(payload.description, MAX_DESCRIPTION) || undefined;
      changed.push("description");
    }

    if (payload.acceptanceCriteria !== undefined) {
      const next = normalizeCriteria(payload.acceptanceCriteria);
      if (next.join(" ") !== ticket.acceptanceCriteria.join(" ")) {
        appendEvent(ticket, systemEvent("criteria", actor, {
          from: `${ticket.acceptanceCriteria.length}`,
          to: `${next.length}`,
          sessionId: ctx.sessionId,
        }));
        ticket.acceptanceCriteria = next;
        changed.push("acceptanceCriteria");
      }
    }

    if (payload.references !== undefined) {
      const next = normalizeReferences(payload.references);
      if (next.map((ref) => ref.url).join(" ") !== ticket.references.map((ref) => ref.url).join(" ")) {
        appendEvent(ticket, systemEvent("reference", actor, {
          from: `${ticket.references.length}`,
          to: `${next.length}`,
          sessionId: ctx.sessionId,
        }));
        ticket.references = next;
        changed.push("references");
      }
    }

    if (payload.labels !== undefined) {
      const next = normalizeLabels(payload.labels);
      if (next.join() !== ticket.labels.join()) {
        appendEvent(ticket, systemEvent("label", actor, { from: ticket.labels.join(", "), to: next.join(", "), sessionId: ctx.sessionId }));
        ticket.labels = next;
        changed.push("labels");
      }
    }

    if (payload.territory !== undefined || payload.files !== undefined || payload.areas !== undefined) {
      const next = normalizeTerritory(
        payload.territory ?? { files: payload.files ?? ticket.territory.files, areas: payload.areas ?? ticket.territory.areas },
      );
      appendEvent(ticket, systemEvent("territory", actor, {
        from: `${ticket.territory.files.length} files, ${ticket.territory.areas.length} areas`,
        to: `${next.files.length} files, ${next.areas.length} areas`,
        sessionId: ctx.sessionId,
      }));
      ticket.territory = next;
      changed.push("territory");
    }

    if (payload.planId !== undefined) {
      const next = cleanText(payload.planId, 120);
      ticket.planId = next || undefined;
      ticket.phaseId = next ? cleanText(payload.phaseId, 120) || undefined : undefined;
      // Re-linking a plan hands status back to it; that is the whole point of the link.
      ticket.statusSource = next ? "derived" : "manual";
      appendEvent(ticket, systemEvent("link", actor, {
        to: next || "(none)",
        body: next ? "Linked to a plan — status now follows it." : "Plan link removed.",
        sessionId: ctx.sessionId,
      }));
      changed.push("planId");
    } else if (payload.phaseId !== undefined && ticket.planId) {
      ticket.phaseId = cleanText(payload.phaseId, 120) || undefined;
      changed.push("phaseId");
    }

    if (payload.blockedBy !== undefined) {
      const next = normalizeIdList(payload.blockedBy)
        .filter((id) => id !== ticket.id && document.tickets.some((candidate) => candidate.id === id));
      /* A two-cycle is rejected outright; anything longer is allowed and surfaced as a warning
         at read time, because enforcement in a personal tracker costs more friction than it
         prevents. */
      const twoCycle = next.filter((id) => document.tickets.find((c) => c.id === id)?.blockedBy.includes(ticket.id));
      ticket.blockedBy = next.filter((id) => !twoCycle.includes(id));
      changed.push("blockedBy");
    }

    /* `blocks` is the same edge written from the other end. Editing it rewrites the blockedBy
       of the tickets named — the authoritative side — and reconcileLinks rebuilds every `blocks`
       array from those on the next read, so the two spellings can never drift apart. */
    if (payload.blocks !== undefined) {
      const next = normalizeIdList(payload.blocks)
        .filter((id) => id !== ticket.id && document.tickets.some((candidate) => candidate.id === id));
      for (const other of document.tickets) {
        if (other.id === ticket.id) continue;
        const shouldBlock = next.includes(other.id);
        const blocked = other.blockedBy.includes(ticket.id);
        if (shouldBlock && !blocked && !ticket.blockedBy.includes(other.id)) {
          other.blockedBy = [...other.blockedBy, ticket.id].slice(0, MAX_LINKS);
        }
        if (!shouldBlock && blocked) other.blockedBy = other.blockedBy.filter((id) => id !== ticket.id);
      }
      ticket.blocks = next;
      changed.push("blocks");
    }

    if (payload.relatedTo !== undefined) {
      const next = normalizeIdList(payload.relatedTo)
        .filter((id) => id !== ticket.id && document.tickets.some((candidate) => candidate.id === id));
      // Symmetric by construction: the store writes the reverse side so a "related" link can
      // never be visible from only one end.
      for (const other of document.tickets) {
        const shouldLink = next.includes(other.id);
        const linked = other.relatedTo.includes(ticket.id);
        if (shouldLink && !linked) other.relatedTo = [...other.relatedTo, ticket.id].slice(0, MAX_LINKS);
        if (!shouldLink && linked) other.relatedTo = other.relatedTo.filter((id) => id !== ticket.id);
      }
      ticket.relatedTo = next;
      changed.push("relatedTo");
    }

    if (payload.duplicateOf !== undefined) {
      const raw = cleanText(payload.duplicateOf, 60);
      const next = raw && raw !== ticket.id && document.tickets.some((candidate) => candidate.id === raw)
        ? raw
        : undefined;
      if (raw && !next) return { ok: false, error: `No ticket with id ${raw} to mark this a duplicate of.` };
      if (next !== ticket.duplicateOf) {
        appendEvent(ticket, systemEvent("link", actor, {
          to: next ?? "(none)",
          body: next ? `Marked a duplicate of ${next}.` : "No longer marked a duplicate.",
          sessionId: ctx.sessionId,
        }));
        ticket.duplicateOf = next;
        changed.push("duplicateOf");
      }
    }

    if (payload.note !== undefined) {
      const body = cleanParagraph(payload.note, MAX_NOTE_TEXT);
      if (body) appendEvent(ticket, systemEvent("link", actor, { body, sessionId: ctx.sessionId }));
    }

    if (changed.length === 0) return { ok: true, ticketId: ticket.id, changed: [], ticket: this.publicView(ticket) };
    ticket.updatedAt = nowIso();
    this.write(document);
    return { ok: true, ticketId: ticket.id, changed, ticket: this.publicView(ticket) };
  }

  commentOnTicket(payload: Record<string, unknown>, ctx: TicketContext): Record<string, unknown> {
    const document = this.read();
    const ticket = document.tickets.find((candidate) => candidate.id === cleanText(payload.ticketId, 60));
    if (!ticket) return { ok: false, error: `No ticket with id ${String(payload.ticketId ?? "")}.` };
    const body = cleanParagraph(payload.body, MAX_COMMENT);
    if (!body) return { ok: false, error: "A comment needs a body." };

    const actor: TicketActor = ctx.sessionId === "webview" ? "user" : "agent";
    appendEvent(ticket, {
      id: newId("evt"), at: nowIso(), actor, kind: "comment", body, sessionId: ctx.sessionId,
    });
    ticket.updatedAt = nowIso();
    this.write(document);
    return { ok: true, ticketId: ticket.id };
  }

  deleteTicket(ticketId: string): TicketDocument {
    const document = this.read();
    document.tickets = document.tickets.filter((ticket) => ticket.id !== ticketId);
    for (const ticket of document.tickets) {
      ticket.relatedTo = ticket.relatedTo.filter((id) => id !== ticketId);
      ticket.blockedBy = ticket.blockedBy.filter((id) => id !== ticketId);
      ticket.blocks = ticket.blocks.filter((id) => id !== ticketId);
      if (ticket.duplicateOf === ticketId) ticket.duplicateOf = undefined;
    }
    this.write(document);
    return document;
  }

  /** Move a ticket to a new rank (array position) — the board's drag target. */
  reorderTicket(ticketId: string, toIndex: number): TicketDocument {
    const document = this.read();
    const from = document.tickets.findIndex((ticket) => ticket.id === ticketId);
    if (from === -1) return document;
    const [moved] = document.tickets.splice(from, 1);
    if (moved) document.tickets.splice(Math.max(0, Math.min(toIndex, document.tickets.length)), 0, moved);
    this.write(document);
    return document;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  listTickets(payload: Record<string, unknown>): Record<string, unknown> {
    const document = this.read();
    const status = normalizeTicketStatus(payload.status);
    const priority = normalizeTicketPriority(payload.priority);
    const label = normalizeLabel(payload.label);
    const area = normalizeArea(payload.area);
    const file = normalizeTerritoryFile(payload.file);
    const planId = cleanText(payload.planId, 120);
    const assignee = payload.assignee === undefined ? null : normalizeAssignee(payload.assignee);
    const query = cleanText(payload.query, 200);
    const openOnly = payload.openOnly !== false && !status;
    const limit = Math.max(1, Math.min(100, Number(payload.limit) || 25));
    const offset = Math.max(0, Math.floor(Number(payload.offset) || 0));

    let matched = document.tickets.filter((ticket) => {
      if (status && ticket.status !== status) return false;
      if (openOnly && !isOpenStatus(ticket.status)) return false;
      if (priority && ticket.priority !== priority) return false;
      if (assignee && ticket.assignee !== assignee) return false;
      if (label && !ticket.labels.includes(label)) return false;
      if (planId && ticket.planId !== planId) return false;
      if (area && !ticket.territory.areas.includes(area)
        && !ticket.territory.files.some((f) => f === area || f.startsWith(`${area}/`))) return false;
      if (file && !ticket.territory.files.includes(file)
        && !ticket.territory.areas.some((a) => file === a || file.startsWith(`${a}/`))) return false;
      if (query && !matchesTicketQuery(ticket, query)) return false;
      return true;
    });

    const total = matched.length;
    if (payload.rankBy === "priority") matched = [...matched].sort(byPriorityThenRecency);
    else if (payload.rankBy === "recent") matched = [...matched].sort((l, r) => r.updatedAt.localeCompare(l.updatedAt));

    const page = matched.slice(offset, offset + limit);
    return {
      ok: true,
      matched: total,
      offset,
      /* Stated rather than implied: a queue with 300 tickets in it will routinely exceed one
         page, and an agent that cannot tell "that was all of them" from "that was the first 25"
         will confidently report the wrong answer. */
      nextOffset: offset + page.length < total ? offset + page.length : undefined,
      tickets: page.map((ticket) => this.publicView(ticket)),
    };
  }

  /** One ticket in full, including its activity timeline — the detail read that `list` elides. */
  getTicket(payload: Record<string, unknown>): Record<string, unknown> {
    const document = this.read();
    const wanted = cleanText(payload.ticketId, 60);
    const ticket = document.tickets.find((candidate) => candidate.id === wanted)
      ?? document.tickets.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase());
    if (!ticket) return { ok: false, error: `No ticket with id ${wanted || "(none given)"}.` };
    const resolved = this.resolveTerritoryFor(ticket);
    return {
      ok: true,
      ticket: {
        ...this.publicView(ticket),
        resolvedFiles: resolved.files.slice(0, 60),
        staleFiles: resolved.staleFiles,
        events: ticket.events.map((event) => ({
          at: event.at, actor: event.actor, kind: event.kind, body: event.body, from: event.from, to: event.to,
        })),
      },
    };
  }

  /**
   * The ranked "what should I pick up next" answer, each candidate carrying the factors that
   * produced its position so the agent can state a defensible reason rather than asserting one.
   */
  nextTickets(payload: Record<string, unknown>): Record<string, unknown> {
    const document = this.read();
    const area = normalizeArea(payload.area);
    const limit = Math.max(1, Math.min(10, Number(payload.limit) || 3));
    const pool = area
      ? document.tickets.filter((ticket) => (
        ticket.territory.areas.includes(area)
        || ticket.territory.files.some((file) => file === area || file.startsWith(`${area}/`))
      ))
      : document.tickets;

    const ranked = rankTickets(pool);
    const actionable = ranked.filter((entry) => entry.blockedByOpen.length === 0 && entry.ticket.status !== "blocked");
    return {
      ok: true,
      openCount: ranked.length,
      blockedCount: ranked.length - actionable.length,
      /* Blocked tickets are reported separately rather than omitted: "everything is blocked
         on BLK-9" is a different situation from "there is nothing to do", and an agent that
         cannot tell them apart will report the wrong one. */
      candidates: ranked.slice(0, limit).map((entry) => ({
        id: entry.ticket.id,
        title: entry.ticket.title,
        status: entry.ticket.status,
        priority: entry.ticket.priority,
        complexity: entry.ticket.complexity,
        territory: entry.ticket.territory,
        planId: entry.ticket.planId,
        blockedBy: entry.blockedByOpen,
        why: entry.reasons.join(", "),
      })),
    };
  }

  /** Return proposed work only. The caller must make acceptance explicit with
   * ticket_file (or the command's multi-select UI), and accepted results land in
   * triage rather than silently entering the backlog. */
  async sweepTickets(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this._sweepProvider) return { ok: false, error: "Ticket sweeps are not available in this workspace." };
    const rawFailures = Array.isArray(payload.testFailures) ? payload.testFailures : [];
    const testFailures = rawFailures
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => ({
        file: normalizeTerritoryFile(entry.file),
        message: cleanText(entry.message, 240),
        line: Number.isFinite(Number(entry.line)) ? Math.max(1, Math.floor(Number(entry.line))) : undefined,
        source: cleanText(entry.source, 80) || undefined,
        severity: "error" as const,
      }))
      .filter((entry) => entry.file && entry.message);
    const result = await this._sweepProvider.run({
      area: normalizeArea(payload.area) || undefined,
      includeMarkers: payload.includeMarkers !== false,
      includeDiagnostics: payload.includeDiagnostics !== false,
      limit: Math.max(1, Math.min(100, Number(payload.limit) || 25)),
      testFailures,
    }, signal);
    return {
      ok: true,
      ...result,
      next: "These are proposals only. Ask the user which to accept, then file each accepted item with ticket_file using status 'triage', origin 'diagnostic', and originRef `sweep:<key>`.",
    };
  }

  /** A plan-shaped seed for a ticket about to be executed, so the follow-up plan_create call
   *  needs no re-derivation of the ticket's own scope. */
  promoteTicket(payload: Record<string, unknown>): Record<string, unknown> {
    const document = this.read();
    const ticket = document.tickets.find((candidate) => candidate.id === cleanText(payload.ticketId, 60));
    if (!ticket) return { ok: false, error: `No ticket with id ${String(payload.ticketId ?? "")}.` };
    if (ticket.planId) {
      return { ok: false, error: `${ticket.id} is already linked to plan ${ticket.planId}. Continue that plan with plan_update.` };
    }
    const resolved = this.resolveTerritoryFor(ticket);
    return {
      ok: true,
      ticketId: ticket.id,
      seed: {
        title: ticket.title,
        summary: ticket.description ?? ticket.title,
        firstPhaseFiles: resolved.files.slice(0, 24),
        complexity: ticket.complexity,
        labels: ticket.labels,
        /* Carried through verbatim so the plan's definition of done is the ticket's, not a
           paraphrase of it — the two drifting apart is how a plan completes without the
           ticket actually being satisfied. */
        acceptanceCriteria: ticket.acceptanceCriteria,
        references: ticket.references,
      },
      next: "Call plan_create with this seed, then ticket_update with the new planId to hand status over to the plan.",
    };
  }

  /** The agent-facing shape: everything except the full event log, which is read on demand. */
  private publicView(ticket: Ticket): Record<string, unknown> {
    const comments = ticket.events.filter((event) => event.kind === "comment");
    return {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      statusSource: ticket.statusSource,
      priority: ticket.priority,
      complexity: ticket.complexity,
      complexityBasis: ticket.complexityBasis,
      labels: ticket.labels,
      acceptanceCriteria: ticket.acceptanceCriteria,
      territory: ticket.territory,
      references: ticket.references,
      assignee: ticket.assignee,
      planId: ticket.planId,
      phaseId: ticket.phaseId,
      blockedBy: ticket.blockedBy,
      blocks: ticket.blocks,
      relatedTo: ticket.relatedTo,
      duplicateOf: ticket.duplicateOf,
      origin: ticket.origin,
      commentCount: comments.length,
      latestComment: comments[comments.length - 1]?.body,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      closedAt: ticket.closedAt,
    };
  }

  private write(document: TicketDocument): void {
    const { document: normalized } = normalizeTicketDocument({
      ...document,
      schemaVersion: TICKETS_SCHEMA_VERSION,
      updatedAt: nowIso(),
    });
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    fs.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this._emitter.fire(normalized);
  }
}

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function byPriorityThenRecency(left: Ticket, right: Ticket): number {
  const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  return rank !== 0 ? rank : right.updatedAt.localeCompare(left.updatedAt);
}

export interface RankedTicket {
  ticket: Ticket;
  score: number;
  /** Why this ranked where it did, in the order the factors were applied. */
  reasons: string[];
  blockedByOpen: string[];
}

const PRIORITY_SCORE: Record<TicketPriority, number> = { urgent: 100, high: 70, normal: 40, low: 15 };
const COMPLEXITY_BONUS: Record<TicketComplexity, number> = { small: 8, medium: 0, large: -6 };
/** A day of untouched age, in points — bounded so age nudges rather than dominates. */
const AGE_POINTS_PER_DAY = 1.5;
const MAX_AGE_POINTS = 25;

/**
 * Rank open tickets for "what should I pick up next".
 *
 * Deliberately explainable rather than clever: the score is a sum of named factors and each
 * one is reported, because an agent proposing work needs to be able to say *why* — a ranking
 * that cannot be argued with is a ranking nobody should act on.
 *
 * Blocked tickets are not silently dropped; they are ranked last and carry their open blockers,
 * so "everything is blocked on BLK-9" stays visible instead of looking like an empty queue.
 */
export function rankTickets(tickets: readonly Ticket[], now = Date.now()): RankedTicket[] {
  const openIds = new Set(tickets.filter((ticket) => isOpenStatus(ticket.status)).map((ticket) => ticket.id));

  return tickets
    .filter((ticket) => isOpenStatus(ticket.status))
    .map((ticket) => {
      const reasons: string[] = [];
      let score = PRIORITY_SCORE[ticket.priority];
      reasons.push(`${ticket.priority} priority`);

      const blockedByOpen = ticket.blockedBy.filter((id) => openIds.has(id));
      if (blockedByOpen.length > 0 || ticket.status === "blocked") {
        score -= 1000;
        reasons.push(blockedByOpen.length > 0 ? `blocked by ${blockedByOpen.join(", ")}` : "marked blocked");
      }

      if (ticket.status === "in_progress") {
        score += 30;
        reasons.push("already in progress");
      }
      if (ticket.status === "review") {
        score -= 20;
        reasons.push("awaiting verification, not new work");
      }

      /* An explicit assignment outranks the heuristics: "the user handed me this one" is the
         strongest signal in the queue, and a ticket they kept for themselves should not be
         proposed back to them as agent work. */
      if (ticket.assignee === "agent") {
        score += 45;
        reasons.push("assigned to you");
      } else if (ticket.assignee === "user") {
        score -= 35;
        reasons.push("the user is handling this one");
      }

      if (ticket.duplicateOf) {
        score -= 60;
        reasons.push(`duplicate of ${ticket.duplicateOf}`);
      }

      if (ticket.complexity) {
        score += COMPLEXITY_BONUS[ticket.complexity];
        if (ticket.complexity === "small") reasons.push("small enough to finish");
        if (ticket.complexity === "large") reasons.push("large");
      }

      /* Age surfaces things that would otherwise rot at the bottom of the backlog forever.
         Capped, so a stale low-priority ticket never outranks a fresh urgent one. */
      const ageDays = Math.max(0, (now - Date.parse(ticket.updatedAt)) / 86_400_000);
      const agePoints = Math.min(MAX_AGE_POINTS, ageDays * AGE_POINTS_PER_DAY);
      if (agePoints >= 3) {
        score += agePoints;
        reasons.push(`untouched for ${Math.round(ageDays)}d`);
      }

      if (ticket.status === "triage") {
        score -= 10;
        reasons.push("not yet triaged");
      }

      return { ticket, score, reasons, blockedByOpen };
    })
    .sort((left, right) => right.score - left.score || byPriorityThenRecency(left.ticket, right.ticket));
}
