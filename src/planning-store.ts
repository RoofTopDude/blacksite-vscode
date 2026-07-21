import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PlanDocStore, MAX_DOC_BODY } from "./plan-doc-store.js";

const BLACKSITE_DIR = ".blacksite";
const PLANNING_FILE = "planning.json";
// v2 added optional TaskPlanPhase.risks/dependsOn/acceptanceCriteria/complexity and
// TaskPlanStep.acceptanceCriteria. TaskPlanPhase.rationale was added the same additive way
// afterward, with no further version bump needed. Purely a breadcrumb — normalizeDocument
// doesn't branch on this value, so older documents load fine without migration (missing
// fields are valid undefined).
const PLANNING_SCHEMA_VERSION = 2;
const MAX_TEXT = 2_000;
const MAX_NOTES = 12;
const MAX_PROMPT_CHARS = 5_500;
// blocks/maxIterations were added the same additive way as v2's other optional fields (see the
// breadcrumb below) — no further version bump needed, older documents load fine without migration.
const MAX_BLOCKS = 8;
const MAX_BLOCK_LABEL = 120;
const MAX_BLOCK_BODY = 1_200;
const MIN_MAX_ITERATIONS = 2;
const MAX_MAX_ITERATIONS = 6;
// Plan/phase documentation docs — see PlanDocMeta. A distinct, much larger cap than
// MAX_BLOCKS/MAX_BLOCK_BODY: docs are full-length reference material read on demand
// (plan_doc_read), not short blurbs injected into every prompt like `blocks` are.
const MAX_DOCS = 20;
const MAX_DOC_TITLE = 160;

export type PlanStatus = "draft" | "active" | "on_hold" | "archived" | "completed" | "blocked" | "cancelled";
export type PlanPhaseStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TodoStepStatus = "pending" | "running" | "done" | "failed";
export type PlanComplexity = "small" | "medium" | "large";
/** Recommended vocabulary for modular plan/phase content blocks — see {@link PlanBlock}. Not
 *  strictly enforced (normalizeBlockKind coerces anything else to "custom") so a plan can always
 *  carry a block this set didn't anticipate. */
export type PlanBlockKind =
  | "findings" | "open_questions" | "options_considered" | "deliverables"
  | "rollout_plan" | "rollback_plan" | "custom";

/**
 * A modular, freeform content block attached to a plan or a phase — how a plan is "assembled"
 * differently depending on what it's for (a research spike carries findings/open_questions, a
 * migration carries rollout_plan/rollback_plan) instead of every plan defaulting to the same
 * bare phases-and-steps shape. Identified for upsert purposes by (kind, label) — see upsertBlock.
 */
export interface PlanBlock {
  id: string;
  kind: PlanBlockKind;
  /** Heading override; shown title-cased from `kind` when omitted. In effect required for
   *  "custom" blocks, which otherwise have nothing to distinguish them from one another. */
  label?: string;
  body: string;
  updatedAt: string;
}

/** Recommended vocabulary for plan/phase documentation docs — see {@link PlanDocMeta}. Like
 *  PlanBlockKind, not strictly enforced (normalizeDocKind coerces anything else to "custom"). */
export type PlanDocKind = "research" | "reference" | "decision" | "notes" | "spec" | "custom";

/**
 * Metadata for one documentation doc attached to a plan or one of its phases — durable,
 * full-length reference material (research writeups, decision records, specs, or a copy of a
 * file the user attached) that persists in the project until the user deletes it, independent
 * of the plan's own lifecycle. Distinct from {@link PlanBlock}: blocks are short blurbs meant
 * to live inline in the agent's prompt context; docs are read on demand (plan_doc_read) and
 * their bodies live on disk via PlanDocStore, not inline here, so this array stays cheap to
 * carry on every plan mutation.
 */
export interface PlanDocMeta {
  id: string;
  kind: PlanDocKind;
  title: string;
  /** "agent" for docs written via plan_doc_write, "user" for files attached through the webview. */
  source: "agent" | "user";
  /** Set only for a copied file attachment (kind is usually "reference" then) — when present,
   *  the doc's content lives at PlanDocStore's files directory under this name instead of as a
   *  markdown body, and plan_doc_read refuses to return it as text. */
  attachmentFilename?: string;
  createdAt: string;
  updatedAt: string;
  byteSize: number;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  detail?: string;
  /** Optional definition-of-done for this specific step. */
  acceptanceCriteria?: string;
  /** Optional cap (2-6) on inline self-review passes for this step — set when the step is
   *  genuinely worth iterating on (ambiguous UX/logic) rather than a one-shot mechanical edit.
   *  Purely a signal for the agent's own judgment; nothing here enforces it structurally. */
  maxIterations?: number;
  status: PlanStepStatus;
  notes: string[];
  updatedAt: string;
}

export interface TaskPlanPhase {
  id: string;
  title: string;
  objective?: string;
  /** Optional design rationale — why this approach over the alternatives considered. Durable
   *  and cross-session, unlike free-form chat text, so later sessions don't re-litigate it blind. */
  rationale?: string;
  /** Optional current risk/consideration note — a single current-state field, unlike notes[] which is a running log. */
  risks?: string;
  /** Optional phase IDs this phase assumes are already done. Informational only, never enforced. */
  dependsOn?: string[];
  /** Optional definition-of-done bullets for this phase. */
  acceptanceCriteria?: string[];
  /** Optional coarse, qualitative effort hint — deliberately not a numeric estimate the model can't calibrate honestly. */
  complexity?: PlanComplexity;
  /** Optional modular content blocks scoped to this phase (e.g. findings, options_considered). */
  blocks: PlanBlock[];
  /** Optional documentation docs scoped to this phase — see {@link PlanDocMeta}. */
  docs: PlanDocMeta[];
  status: PlanPhaseStatus;
  steps: TaskPlanStep[];
  notes: string[];
  linkedTodoIds: string[];
  updatedAt: string;
  completedAt?: string;
}

export interface TaskPlan {
  id: string;
  title: string;
  summary?: string;
  status: PlanStatus;
  phases: TaskPlanPhase[];
  /** Optional modular content blocks scoped to the whole plan (e.g. deliverables, open_questions). */
  blocks: PlanBlock[];
  /** Optional documentation docs scoped to the whole plan — see {@link PlanDocMeta}. */
  docs: PlanDocMeta[];
  /** Whether the user has explicitly granted the agent permission to archive THIS plan itself
   *  via plan_update once it's done, instead of archiving always being a user action from the
   *  Plans panel. False by default — the agent sets this only when the user actually said so
   *  (e.g. "archive it yourself when you're finished"), and the user can revoke it from the panel. */
  agentCanArchive: boolean;
  notes: string[];
  activePhaseId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  sessionId?: string;
  lastRequestId?: string;
}

export interface TodoStep {
  id: string;
  label: string;
  status: TodoStepStatus;
  result?: string;
}

export interface TodoRun {
  id: string;
  name: string;
  steps: TodoStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  sessionId?: string;
  requestId?: string;
  lastRequestId?: string;
  planId?: string;
  phaseId?: string;
}

export interface PlanningDocument {
  schemaVersion: number;
  updatedAt: string | null;
  plans: TaskPlan[];
  todoRuns: TodoRun[];
}

export interface PlanPhaseSummary {
  id: string;
  title: string;
  objective?: string;
  rationale?: string;
  risks?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  complexity?: PlanComplexity;
  blocks: PlanBlock[];
  docs: PlanDocMeta[];
  status: PlanPhaseStatus;
  counts: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
  };
  currentStep?: {
    id: string;
    title: string;
    status: PlanStepStatus;
  };
  steps: Array<{
    id: string;
    title: string;
    status: PlanStepStatus;
    detail?: string;
    acceptanceCriteria?: string;
    maxIterations?: number;
  }>;
  linkedTodoIds: string[];
}

export interface PlanSummary {
  id: string;
  title: string;
  summary?: string;
  status: PlanStatus;
  activePhaseId?: string;
  activePhaseTitle?: string;
  phaseCount: number;
  completedPhaseCount: number;
  phases: PlanPhaseSummary[];
  blocks: PlanBlock[];
  docs: PlanDocMeta[];
  agentCanArchive: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type TodoRunStatus = "pending" | "running" | "in_progress" | "completed" | "failed";

export interface TodoRunSummary {
  id: string;
  name: string;
  status: TodoRunStatus;
  isActive: boolean;
  progress: string;
  counts: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
  };
  currentStep?: TodoStep;
  nextStep?: TodoStep;
  completedSteps: TodoStep[];
  runningSteps: TodoStep[];
  pendingSteps: TodoStep[];
  failedSteps: TodoStep[];
  steps: TodoStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  planId?: string;
  phaseId?: string;
}

export interface PlanningProviderContext {
  sessionId: string;
  requestId?: string;
}

export interface PlanningProvider {
  dispatch(op: string, payload: Record<string, unknown>, ctx: PlanningProviderContext): Promise<Record<string, unknown>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Next `${prefix}-N` id above the highest existing sequential id (stable, human-readable). */
function nextSeq(ids: string[], prefix: string): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function buildPlanStep(record: Record<string, unknown>, id: string, timestamp: string): TaskPlanStep | null {
  const title = cleanText(record.title, 160);
  if (!title) return null;
  return {
    id,
    title,
    detail: cleanParagraph(record.detail, 500) || undefined,
    acceptanceCriteria: cleanParagraph(record.acceptanceCriteria, 500) || undefined,
    maxIterations: normalizeMaxIterations(record.maxIterations),
    status: normalizeStepStatus(record.status) ?? "pending",
    notes: [],
    updatedAt: timestamp,
  };
}

/** Short free-text list (dependsOn / acceptanceCriteria bullets) — same shape as normalizeNotes but with independent length/count caps. */
function normalizeShortList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => cleanText(entry, maxChars)).filter(Boolean).slice(0, maxItems);
}

function normalizeComplexity(value: unknown): PlanComplexity | null {
  const key = statusKey(value);
  return key === "small" || key === "medium" || key === "large" ? key : null;
}

/** Clamps to [2, 6]; `undefined`/unparseable leaves the field unset rather than defaulting it —
 *  most steps don't warrant a self-review loop at all, so absence, not a low number, is the norm. */
function normalizeMaxIterations(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(MAX_MAX_ITERATIONS, Math.max(MIN_MAX_ITERATIONS, Math.round(n)));
}

/** Tolerant coercion to the recommended block-kind vocabulary — like normalizePlanStatus, this
 *  never rejects; anything unrecognized becomes "custom" so a block is never dropped for having
 *  a kind the model phrased slightly differently. */
function normalizeBlockKind(value: unknown): PlanBlockKind {
  switch (statusKey(value)) {
    case "findings": case "finding": case "research_findings": case "research":
      return "findings";
    case "open_questions": case "open_question": case "questions": case "unresolved":
      return "open_questions";
    case "options_considered": case "options": case "alternatives": case "options_considered_and_tradeoffs":
      return "options_considered";
    case "deliverables": case "deliverable":
      return "deliverables";
    case "rollout_plan": case "rollout": case "cutover":
      return "rollout_plan";
    case "rollback_plan": case "rollback": case "backout": case "backout_plan":
      return "rollback_plan";
    default:
      return "custom";
  }
}

function normalizePlanBlock(value: unknown, id: string, timestamp: string): PlanBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const body = cleanParagraph(record.body, MAX_BLOCK_BODY);
  if (!body) return null;
  return {
    id,
    kind: normalizeBlockKind(record.kind),
    label: cleanText(record.label, MAX_BLOCK_LABEL) || undefined,
    body,
    updatedAt: timestamp,
  };
}

/** Tolerant coercion to the recommended doc-kind vocabulary — like normalizeBlockKind, never
 *  rejects; anything unrecognized becomes "custom" so a doc is never dropped for having a kind
 *  the model phrased slightly differently. */
function normalizeDocKind(value: unknown): PlanDocKind {
  switch (statusKey(value)) {
    case "research": case "findings": case "finding": case "investigation":
      return "research";
    case "reference": case "ref": case "attachment": case "file": case "link":
      return "reference";
    case "decision": case "design_decision": case "rationale": case "adr":
      return "decision";
    case "notes": case "note":
      return "notes";
    case "spec": case "specification": case "requirements": case "design_spec":
      return "spec";
    default:
      return "custom";
  }
}

/** Parses a doc's metadata as stored on disk — preserves its existing id (unlike a fresh
 *  plan_doc_write, which mints one for a genuinely new doc) so reloading a document is idempotent. */
function normalizeDocMeta(value: unknown): PlanDocMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = cleanText(record.title, MAX_DOC_TITLE);
  if (!title) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("plan_doc"),
    kind: normalizeDocKind(record.kind),
    title,
    source: record.source === "user" ? "user" : "agent",
    attachmentFilename: cleanText(record.attachmentFilename, 260) || undefined,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    byteSize: typeof record.byteSize === "number" && record.byteSize >= 0 ? record.byteSize : 0,
  };
}

function normalizeDocMetaList(value: unknown): PlanDocMeta[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeDocMeta).filter((doc): doc is PlanDocMeta => doc !== null).slice(0, MAX_DOCS);
}

/** Upsert key: blocks collide (and replace) when kind+label match, so re-adding a
 *  "findings" block updates the existing one instead of duplicating. An unlabeled "custom"
 *  block never collides with another — label is the only thing that distinguishes custom
 *  blocks from each other, so without one there's nothing safe to match on. */
function blockMatchKey(kind: PlanBlockKind, label: string | undefined): string | null {
  if (kind === "custom" && !label) return null;
  return `${kind}::${(label ?? "").trim().toLowerCase()}`;
}

/**
 * Appends each normalized incoming block to `list`, replacing an existing block with the same
 * (kind, label) identity in place (upsert) rather than duplicating it. Shared by plan-level and
 * phase-level block updates in createPlan/updatePlan. Caps the result at MAX_BLOCKS, keeping the
 * most recently touched blocks (new/updated entries win over older untouched ones).
 */
function upsertBlocks(list: PlanBlock[], raw: unknown[], seq: { next: number }, timestamp: string): PlanBlock[] {
  const result = list.slice();
  for (const entry of raw) {
    const built = normalizePlanBlock(entry, `block-${seq.next}`, timestamp);
    if (!built) continue;
    const key = blockMatchKey(built.kind, built.label);
    const existingIndex = key ? result.findIndex((b) => blockMatchKey(b.kind, b.label) === key) : -1;
    if (existingIndex !== -1) {
      result[existingIndex] = { ...built, id: result[existingIndex]!.id };
    } else {
      result.push(built);
      seq.next += 1;
    }
  }
  return result.slice(-MAX_BLOCKS);
}

/**
 * True when `order` is an exact permutation of `currentIds` — same length, no duplicates in
 * `order`, and every id in `order` present in `currentIds`. Shared by reorderStepIds and
 * reorderPhaseIds in updatePlan so the two can't drift apart. Set-based (not `.includes()`
 * inside `.every()`) to stay O(n) instead of O(n^2) for larger phase/step counts.
 */
function isExactPermutation(order: string[], currentIds: string[]): boolean {
  if (order.length !== currentIds.length) return false;
  const orderSet = new Set(order);
  if (orderSet.size !== order.length) return false;
  const currentSet = new Set(currentIds);
  for (const id of orderSet) {
    if (!currentSet.has(id)) return false;
  }
  return true;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/** Mirrors MemoryStore.appendMemory's format exactly, kept local rather than importing
 *  MemoryStore so PlanningStore stays independently constructible (as every test does today)
 *  without threading a second store through its constructor. */
function appendProjectMemory(workspaceRoot: string, entry: string): void {
  try {
    const dir = path.join(workspaceRoot, BLACKSITE_DIR);
    ensureDir(dir);
    const memoryPath = path.join(dir, "memory.md");
    if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, "# Project Memory\n\n", "utf8");
    const timestamp = new Date().toISOString().slice(0, 16);
    fs.appendFileSync(memoryPath, `\n## ${timestamp}\n\n${entry.trim()}\n`, "utf8");
  } catch { /* best-effort — must not block the deletion the caller actually asked for */ }
}

function defaultDocument(): PlanningDocument {
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    updatedAt: null,
    plans: [],
    todoRuns: [],
  };
}

function cleanText(value: unknown, maxChars = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxChars) : "";
}

function cleanParagraph(value: unknown, maxChars = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function statusKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Coerce a free-text plan status to the canonical set. Accepts natural synonyms the
 * model reaches for ("paused", "on hold", "done", "in progress") instead of rejecting
 * the call — a common source of failed plan_update turns in the logs.
 */
export function normalizePlanStatus(value: unknown): PlanStatus | null {
  switch (statusKey(value)) {
    case "draft": case "new": case "planned": case "planning":
      return "draft";
    case "active": case "in_progress": case "inprogress": case "doing": case "started": case "resumed": case "resume": case "wip":
      return "active";
    case "on_hold": case "onhold": case "hold": case "held": case "paused": case "pause": case "suspended": case "parked": case "shelved":
      return "on_hold";
    case "archived": case "archive": case "filed":
      return "archived";
    case "completed": case "complete": case "done": case "finished": case "success": case "shipped":
      return "completed";
    case "blocked": case "block": case "stuck": case "waiting":
      return "blocked";
    case "cancelled": case "canceled": case "cancel": case "abandoned": case "dropped": case "closed":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Coerce a free-text phase/step status to the canonical set, mapping synonyms so an
 * update never silently no-ops on "done"/"in progress"/etc.
 */
export function normalizePhaseStatus(value: unknown): PlanPhaseStatus | null {
  switch (statusKey(value)) {
    case "pending": case "todo": case "not_started": case "notstarted": case "queued": case "new": case "waiting":
      return "pending";
    case "in_progress": case "inprogress": case "active": case "doing": case "started": case "running": case "wip":
      return "in_progress";
    case "completed": case "complete": case "done": case "finished": case "success": case "passed": case "shipped":
      return "completed";
    case "blocked": case "block": case "stuck": case "on_hold": case "held": case "paused":
      return "blocked";
    default:
      return null;
  }
}

function normalizeStepStatus(value: unknown): PlanStepStatus | null {
  return normalizePhaseStatus(value);
}

/** Statuses the agent must not act on until the user resumes them — includes "archived",
 *  which (unlike the old destructive archivePlan) now just freezes a plan out of the active
 *  view rather than deleting it, so reconcilePlan must leave it alone like on_hold/cancelled. */
export function isManualHoldStatus(status: PlanStatus): boolean {
  return status === "on_hold" || status === "cancelled" || status === "archived";
}

export function normalizeTodoStatus(value: unknown): TodoStepStatus | null {
  if (value === "pending" || value === "running" || value === "done" || value === "failed") return value;
  // Models reach for natural synonyms ("in_progress", "completed", "blocked"). Map them to
  // the canonical set instead of rejecting the call — a wasted turn observed in the logs.
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "in_progress": case "inprogress": case "active": case "started": case "doing": case "wip":
      return "running";
    case "complete": case "completed": case "success": case "succeeded": case "finished": case "ok": case "passed":
      return "done";
    case "error": case "errored": case "blocked": case "cancelled": case "canceled": case "aborted": case "fail":
      return "failed";
    case "todo": case "not_started": case "queued": case "waiting": case "new":
      return "pending";
    default:
      return null;
  }
}

function normalizeNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((note) => cleanParagraph(note, 400))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
}

/** Parses a block as stored on disk — preserves its existing id (unlike upsertBlocks, which
 *  mints fresh ids for genuinely new incoming blocks) so reloading a document is idempotent. */
function normalizeStoredBlock(value: unknown): PlanBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const body = cleanParagraph(record.body, MAX_BLOCK_BODY);
  if (!body) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("plan_block"),
    kind: normalizeBlockKind(record.kind),
    label: cleanText(record.label, MAX_BLOCK_LABEL) || undefined,
    body,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
  };
}

function normalizeBlockList(value: unknown): PlanBlock[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeStoredBlock).filter((block): block is PlanBlock => block !== null).slice(0, MAX_BLOCKS);
}

function normalizeTaskPlanStep(value: unknown): TaskPlanStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = cleanText(record.title, 160);
  const status = normalizeStepStatus(record.status) ?? "pending";
  if (!title) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("plan_step"),
    title,
    detail: cleanParagraph(record.detail, 500) || undefined,
    acceptanceCriteria: cleanParagraph(record.acceptanceCriteria, 500) || undefined,
    maxIterations: normalizeMaxIterations(record.maxIterations),
    status,
    notes: normalizeNotes(record.notes),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
  };
}

function normalizeTaskPlanPhase(value: unknown): TaskPlanPhase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = cleanText(record.title, 160);
  if (!title) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("plan_phase"),
    title,
    objective: cleanParagraph(record.objective, 500) || undefined,
    rationale: cleanParagraph(record.rationale, 500) || undefined,
    risks: cleanParagraph(record.risks, 500) || undefined,
    dependsOn: normalizeShortList(record.dependsOn, 20, 120),
    acceptanceCriteria: normalizeShortList(record.acceptanceCriteria, 20, 300),
    complexity: normalizeComplexity(record.complexity) || undefined,
    blocks: normalizeBlockList(record.blocks),
    docs: normalizeDocMetaList(record.docs),
    status: normalizePhaseStatus(record.status) ?? "pending",
    steps: Array.isArray(record.steps)
      ? record.steps.map(normalizeTaskPlanStep).filter((step): step is TaskPlanStep => step !== null)
      : [],
    notes: normalizeNotes(record.notes),
    linkedTodoIds: Array.isArray(record.linkedTodoIds)
      ? record.linkedTodoIds.map((entry) => cleanText(entry, 120)).filter(Boolean)
      : [],
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : undefined,
  };
}

function normalizeTaskPlan(value: unknown): TaskPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = cleanText(record.title, 180);
  if (!title) return null;
  const phases = Array.isArray(record.phases)
    ? record.phases.map(normalizeTaskPlanPhase).filter((phase): phase is TaskPlanPhase => phase !== null)
    : [];
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("plan"),
    title,
    summary: cleanParagraph(record.summary, 1_000) || undefined,
    status: normalizePlanStatus(record.status) ?? "draft",
    phases,
    blocks: normalizeBlockList(record.blocks),
    docs: normalizeDocMetaList(record.docs),
    agentCanArchive: record.agentCanArchive === true,
    notes: normalizeNotes(record.notes),
    activePhaseId: cleanText(record.activePhaseId, 120) || undefined,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : undefined,
    sessionId: cleanText(record.sessionId, 120) || undefined,
    lastRequestId: cleanText(record.lastRequestId, 120) || undefined,
  };
}

function normalizeTodoStep(value: unknown): TodoStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = cleanText(record.label, 180);
  const status = normalizeTodoStatus(record.status);
  if (!label || !status) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("todo_step"),
    label,
    status,
    result: cleanParagraph(record.result, 500) || undefined,
  };
}

function normalizeTodoRun(value: unknown): TodoRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = cleanText(record.name, 180);
  if (!name) return null;
  const steps = Array.isArray(record.steps)
    ? record.steps.map(normalizeTodoStep).filter((step): step is TodoStep => step !== null)
    : [];
  if (steps.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("todo"),
    name,
    steps,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : undefined,
    sessionId: cleanText(record.sessionId, 120) || undefined,
    requestId: cleanText(record.requestId, 120) || undefined,
    lastRequestId: cleanText(record.lastRequestId, 120) || undefined,
    planId: cleanText(record.planId, 120) || undefined,
    phaseId: cleanText(record.phaseId, 120) || undefined,
  };
}

function normalizeDocument(value: unknown): PlanningDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDocument();
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : PLANNING_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    plans: Array.isArray(record.plans)
      ? record.plans.map(normalizeTaskPlan).filter((plan): plan is TaskPlan => plan !== null)
      : [],
    todoRuns: Array.isArray(record.todoRuns)
      ? record.todoRuns.map(normalizeTodoRun).filter((run): run is TodoRun => run !== null)
      : [],
  };
}

function cloneTodoStep(step: TodoStep): TodoStep {
  return { ...step };
}

function todoProgress(doneCount: number, failedCount: number, total: number): string {
  return `${doneCount}/${total} done${failedCount ? `, ${failedCount} failed` : ""}`;
}

function summarizeTodoRun(run: TodoRun): TodoRunSummary {
  const steps = run.steps.map(cloneTodoStep);
  const pendingSteps = steps.filter((step) => step.status === "pending");
  const runningSteps = steps.filter((step) => step.status === "running");
  const completedSteps = steps.filter((step) => step.status === "done");
  const failedSteps = steps.filter((step) => step.status === "failed");
  const total = steps.length;

  let status: TodoRunStatus = "pending";
  if (run.completedAt) {
    status = failedSteps.length > 0 ? "failed" : "completed";
  } else if (runningSteps.length > 0) {
    status = "running";
  } else if (completedSteps.length > 0 || failedSteps.length > 0) {
    status = "in_progress";
  }

  return {
    id: run.id,
    name: run.name,
    status,
    isActive: !run.completedAt,
    progress: todoProgress(completedSteps.length, failedSteps.length, total),
    counts: {
      total,
      pending: pendingSteps.length,
      running: runningSteps.length,
      done: completedSteps.length,
      failed: failedSteps.length,
    },
    currentStep: runningSteps[0] ?? pendingSteps[0],
    nextStep: pendingSteps[0],
    completedSteps,
    runningSteps,
    pendingSteps,
    failedSteps,
    steps,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    planId: run.planId,
    phaseId: run.phaseId,
  };
}

function summarizePlan(plan: TaskPlan): PlanSummary {
  const phases = plan.phases.map((phase) => {
    const counts = {
      total: phase.steps.length,
      pending: phase.steps.filter((step) => step.status === "pending").length,
      inProgress: phase.steps.filter((step) => step.status === "in_progress").length,
      completed: phase.steps.filter((step) => step.status === "completed").length,
      blocked: phase.steps.filter((step) => step.status === "blocked").length,
    };
    const currentStep = phase.steps.find((step) => step.status === "in_progress")
      ?? phase.steps.find((step) => step.status === "pending");
    return {
      id: phase.id,
      title: phase.title,
      objective: phase.objective,
      rationale: phase.rationale,
      risks: phase.risks,
      dependsOn: phase.dependsOn?.length ? [...phase.dependsOn] : undefined,
      acceptanceCriteria: phase.acceptanceCriteria?.length ? [...phase.acceptanceCriteria] : undefined,
      complexity: phase.complexity,
      blocks: [...phase.blocks],
      docs: [...phase.docs],
      status: phase.status,
      counts,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : undefined,
      steps: phase.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        detail: step.detail,
        acceptanceCriteria: step.acceptanceCriteria,
        maxIterations: step.maxIterations,
      })),
      linkedTodoIds: [...phase.linkedTodoIds],
    } satisfies PlanPhaseSummary;
  });

  const activePhase = plan.phases.find((phase) => phase.id === plan.activePhaseId)
    ?? plan.phases.find((phase) => phase.status === "in_progress")
    ?? plan.phases.find((phase) => phase.status === "pending");

  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    activePhaseId: activePhase?.id,
    activePhaseTitle: activePhase?.title,
    phaseCount: plan.phases.length,
    completedPhaseCount: plan.phases.filter((phase) => phase.status === "completed").length,
    phases,
    blocks: [...plan.blocks],
    docs: [...plan.docs],
    agentCanArchive: plan.agentCanArchive,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    completedAt: plan.completedAt,
  };
}

function appendNote(notes: string[], note: unknown): string[] {
  const clean = cleanParagraph(note, 500);
  if (!clean) return notes;
  return [clean, ...notes].slice(0, MAX_NOTES);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readPlanningDocument(workspaceRoot: string): PlanningDocument {
  const document = normalizeDocument(readJsonFile(path.join(workspaceRoot, BLACKSITE_DIR, PLANNING_FILE)));
  for (const plan of document.plans) reconcilePlan(plan);
  return document;
}

function sortByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return items.slice().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function resolveTodoStep(run: TodoRun, rawStepRef: string): TodoStep | null {
  const stepRef = rawStepRef.trim();
  if (!stepRef) return null;

  const exact = run.steps.find((step) => step.id === stepRef);
  if (exact) return exact;

  const lower = stepRef.toLowerCase();
  const byLabel = run.steps.find((step) => step.label.toLowerCase() === lower);
  if (byLabel) return byLabel;

  const numeric = Number(stepRef.replace(/^step-/i, ""));
  if (Number.isInteger(numeric) && numeric >= 0) {
    return run.steps[numeric] ?? run.steps[numeric - 1] ?? null;
  }

  return null;
}

function reconcilePhaseStatus(phase: TaskPlanPhase): void {
  const total = phase.steps.length;
  const completed = phase.steps.filter((step) => step.status === "completed").length;
  const inProgress = phase.steps.filter((step) => step.status === "in_progress").length;
  const blocked = phase.steps.filter((step) => step.status === "blocked").length;

  if (total === 0) return;
  if (completed === total) {
    phase.status = "completed";
    phase.completedAt = phase.completedAt ?? nowIso();
    return;
  }
  delete phase.completedAt;
  if (inProgress > 0) {
    phase.status = "in_progress";
    return;
  }
  if (blocked > 0 && completed + blocked === total) {
    phase.status = "blocked";
    return;
  }
  if (completed > 0 || blocked > 0) {
    phase.status = "in_progress";
    return;
  }
  if (phase.status !== "blocked") phase.status = "pending";
}

function reconcilePlan(plan: TaskPlan): void {
  // On-hold and cancelled are user-controlled terminal-ish states: never auto-flip
  // them back to active based on step progress. The agent is told not to touch them.
  if (isManualHoldStatus(plan.status)) return;
  const preserveDraft = plan.status === "draft";

  for (const phase of plan.phases) {
    reconcilePhaseStatus(phase);
  }

  const completedCount = plan.phases.filter((phase) => phase.status === "completed").length;
  const inProgressPhase = plan.phases.find((phase) => phase.status === "in_progress");
  const pendingPhase = plan.phases.find((phase) => phase.status === "pending");
  const blockedPhase = plan.phases.find((phase) => phase.status === "blocked");

  plan.activePhaseId = inProgressPhase?.id ?? pendingPhase?.id ?? blockedPhase?.id ?? plan.phases.at(-1)?.id;

  if (plan.phases.length > 0 && completedCount === plan.phases.length) {
    plan.status = "completed";
    plan.completedAt = plan.completedAt ?? nowIso();
    return;
  }

  delete plan.completedAt;
  if (inProgressPhase) {
    plan.status = "active";
    return;
  }
  if (blockedPhase && !pendingPhase) {
    plan.status = "blocked";
    return;
  }
  if (preserveDraft && !inProgressPhase && !blockedPhase && completedCount === 0) {
    plan.status = "draft";
    return;
  }
  plan.status = "active";
}

function linkTodoToPlan(plan: TaskPlan | undefined, phaseId: string | undefined, todoId: string): void {
  if (!plan || !phaseId) return;
  const phase = plan.phases.find((entry) => entry.id === phaseId);
  if (!phase) return;
  if (!phase.linkedTodoIds.includes(todoId)) phase.linkedTodoIds.push(todoId);
  phase.updatedAt = nowIso();
  if (phase.status === "pending") phase.status = "in_progress";
  plan.activePhaseId = phase.id;
  if (plan.status === "draft") plan.status = "active";
  plan.updatedAt = nowIso();
  reconcilePlan(plan);
}

function applyTodoStateToPlan(plan: TaskPlan | undefined, run: TodoRun): void {
  if (!plan || !run.phaseId) return;
  const phase = plan.phases.find((entry) => entry.id === run.phaseId);
  if (!phase) return;

  const summary = summarizeTodoRun(run);
  if (summary.status === "running" || summary.status === "in_progress") {
    phase.status = "in_progress";
  } else if (summary.status === "completed") {
    phase.status = "completed";
    phase.completedAt = phase.completedAt ?? nowIso();
  } else if (summary.status === "failed") {
    phase.status = "blocked";
  }
  phase.updatedAt = nowIso();
  plan.updatedAt = nowIso();
  reconcilePlan(plan);
}

/** Display label for a block — its label override, or the kind title-cased. */
function blockDisplayLabel(block: PlanBlock): string {
  return block.label || block.kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPlanForPrompt(plan: TaskPlan): string {
  const summary = summarizePlan(plan);
  const lines = [
    `- ${summary.title} (${summary.id}) [${summary.status}]`,
  ];
  if (summary.summary) lines.push(`  Summary: ${summary.summary}`);
  if (summary.activePhaseTitle) lines.push(`  Current phase: ${summary.activePhaseTitle}`);
  if (summary.blocks.length) lines.push(`  Blocks: ${summary.blocks.map(blockDisplayLabel).join(", ")}`);
  for (const phase of summary.phases.slice(0, 4)) {
    lines.push(`  - Phase ${phase.title} [${phase.status}]${phase.complexity ? ` (${phase.complexity})` : ""}`);
    if (phase.objective) lines.push(`    Objective: ${phase.objective}`);
    if (phase.rationale) lines.push(`    Rationale: ${phase.rationale}`);
    if (phase.risks) lines.push(`    Risks: ${phase.risks}`);
    if (phase.blocks.length) lines.push(`    Blocks: ${phase.blocks.map(blockDisplayLabel).join(", ")}`);
    if (phase.currentStep) lines.push(`    Current/next: ${phase.currentStep.id} [${phase.currentStep.status}] ${phase.currentStep.title}`);
  }
  return lines.join("\n");
}

function formatTodoForPrompt(run: TodoRun): string {
  const summary = summarizeTodoRun(run);
  const lines = [`- ${summary.name} (${summary.id}) [${summary.status}] ${summary.progress}`];
  if (summary.currentStep) {
    lines.push(`  Current/next: ${summary.currentStep.id} [${summary.currentStep.status}] ${summary.currentStep.label}`);
  }
  return lines.join("\n");
}

export function summarizePlanningStateForPrompt(workspaceRoot: string, maxChars = MAX_PROMPT_CHARS): string {
  const document = readPlanningDocument(workspaceRoot);
  const sortedPlans = sortByUpdatedAt(document.plans);
  const activePlans = sortedPlans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled" && plan.status !== "on_hold" && plan.status !== "archived");
  const heldPlans = sortedPlans.filter((plan) => plan.status === "on_hold");
  const activeTodos = sortByUpdatedAt(document.todoRuns).filter((run) => !run.completedAt);
  if (activePlans.length === 0 && heldPlans.length === 0 && activeTodos.length === 0) return "";

  const blocks: string[] = [];
  if (activePlans.length > 0) {
    blocks.push(
      "Active plans — keep these in mind and current. As you make progress, call plan_update to advance step/phase status; add or remove steps and phases with plan_update when scope changes rather than recreating the plan:",
    );
    for (const plan of activePlans.slice(0, 3)) blocks.push(formatPlanForPrompt(plan));
  }
  if (heldPlans.length > 0) {
    blocks.push(
      "Plans ON HOLD — the user paused these. Do NOT act on, advance, or modify them unless the user explicitly resumes them:",
    );
    for (const plan of heldPlans.slice(0, 5)) blocks.push(`- ${plan.title} (${plan.id}) [on_hold]`);
  }
  if (activeTodos.length > 0) {
    blocks.push("Active task items:");
    for (const run of activeTodos.slice(0, 3)) blocks.push(formatTodoForPrompt(run));
  }

  return blocks.join("\n").slice(0, maxChars);
}

export class PlanningStore implements PlanningProvider, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<PlanningDocument>();
  private readonly _docs: PlanDocStore;

  readonly onDidChange = this._emitter.event;

  constructor(private readonly _workspaceRoot: string) {
    this._docs = new PlanDocStore(_workspaceRoot);
  }

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
    return path.join(this._workspaceRoot, BLACKSITE_DIR, PLANNING_FILE);
  }

  read(): PlanningDocument {
    const document = normalizeDocument(readJsonFile(this.filePath()));
    for (const plan of document.plans) reconcilePlan(plan);
    return document;
  }

  async dispatch(op: string, payload: Record<string, unknown>, ctx: PlanningProviderContext): Promise<Record<string, unknown>> {
    switch (op) {
      case "create":
        return this.createPlan(payload, ctx);
      case "update":
        return this.updatePlan(payload, ctx);
      case "list":
        return this.listPlans(payload);
      case "todoCreate":
        return this.createTodoRun(payload, ctx);
      case "todoUpdate":
        return this.updateTodoRun(payload, ctx);
      case "todoStatus":
        return this.todoStatus(payload);
      case "todoList":
        return this.todoList(payload);
      case "docWrite":
        return this.docWrite(payload);
      case "docRead":
        return this.docRead(payload);
      case "docList":
        return this.docList(payload);
      default:
        return { ok: false, error: `Unknown planning operation: ${op}` };
    }
  }

  clearCompleted(): PlanningDocument {
    const document = this.read();
    const removed = document.plans.filter((plan) => plan.status === "completed" || plan.status === "cancelled");
    this._preserveRationale(removed);
    document.plans = document.plans.filter((plan) => plan.status !== "completed" && plan.status !== "cancelled");
    document.todoRuns = document.todoRuns.filter((run) => !run.completedAt);
    const activeTodoIds = new Set(document.todoRuns.map((run) => run.id));
    for (const plan of document.plans) {
      for (const phase of plan.phases) {
        phase.linkedTodoIds = phase.linkedTodoIds.filter((entry) => activeTodoIds.has(entry));
      }
    }
    this.write(document);
    return document;
  }

  /**
   * Plan phase rationale is otherwise only durable as long as the plan exists — clearing
   * completed plans or archiving one otherwise deletes it with no trace. Fold any recorded
   * rationale into `.blacksite/memory.md` (already read back into every prompt) before the
   * plan is gone, so a design decision survives its plan the same way it would if the agent
   * had called memory_append itself. Best-effort: a memory-write failure must not block the
   * deletion the user actually asked for.
   */
  private _preserveRationale(plans: TaskPlan[]): void {
    for (const plan of plans) {
      const lines = plan.phases
        .filter((phase) => phase.rationale && phase.rationale.trim())
        .map((phase) => `- ${phase.title}: ${phase.rationale}`);
      if (lines.length === 0) continue;
      appendProjectMemory(
        this._workspaceRoot,
        `Design rationale carried over from the plan "${plan.title}" (now removed):\n${lines.join("\n")}`,
      );
    }
  }

  /**
   * Permanently deletes a plan — its metadata and everything under its doc/attachment folder
   * on disk (`PlanDocStore.deletePlanDir`). Phase rationale is folded into `.blacksite/memory.md`
   * first (via `_preserveRationale`) so a design decision survives even this. This is the ONLY
   * destructive plan operation: "Archive" (`setPlanStatus(planId, "archived")`) never deletes
   * anything — it just freezes the plan out of the active view, same as on_hold — so a user who
   * only meant to tidy the list never loses a plan's documentation by accident.
   */
  deletePlan(planId: string): PlanningDocument {
    const document = this.read();
    this._preserveRationale(document.plans.filter((plan) => plan.id === planId));
    this._docs.deletePlanDir(planId);
    document.plans = document.plans.filter((plan) => plan.id !== planId);
    this.write(document);
    return document;
  }

  /** Copies a file the user picked (e.g. via a native file-open dialog) into permanent plan
   *  storage as a "reference" doc. Provider-only — not exposed to the agent, matching how
   *  attaching/deleting docs is always a user action, never something plan_doc_write triggers. */
  attachDocFile(planId: string, phaseId: string | undefined, sourceAbsPath: string, title?: string): Record<string, unknown> {
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return { ok: false, error: `Plan not found: ${planId}` };
    const phase = phaseId ? plan.phases.find((entry) => entry.id === phaseId) : undefined;
    if (phaseId && !phase) return { ok: false, error: `Phase not found: ${phaseId}` };
    const scopeDocs = phase ? phase.docs : plan.docs;
    if (scopeDocs.length >= MAX_DOCS) {
      return { ok: false, error: `This ${phase ? "phase" : "plan"} already has the maximum of ${MAX_DOCS} docs — remove one first.` };
    }

    const timestamp = nowIso();
    const docId = newId("plan_doc");
    let attached: { attachmentFilename: string; byteSize: number };
    try {
      attached = this._docs.attachFile(planId, docId, sourceAbsPath, title);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const doc: PlanDocMeta = {
      id: docId,
      kind: "reference",
      title: cleanText(title, MAX_DOC_TITLE) || attached.attachmentFilename,
      source: "user",
      attachmentFilename: attached.attachmentFilename,
      createdAt: timestamp,
      updatedAt: timestamp,
      byteSize: attached.byteSize,
    };
    scopeDocs.push(doc);
    plan.updatedAt = timestamp;
    this.write(document);
    return { ok: true, doc };
  }

  /** Creates a blank markdown doc (seeded with just a title heading) and opens it up for the
   *  user to fill in directly — the "New note" affordance in the Plans panel, for a user who
   *  wants to write documentation by hand rather than asking the agent to via plan_doc_write. */
  createDoc(planId: string, phaseId: string | undefined, kind: unknown, title: string): Record<string, unknown> {
    const document = this.read();
    const resolved = this._resolveDocScope(document, planId, phaseId ?? "");
    if ("error" in resolved) return { ok: false, error: resolved.error };
    const { plan, scope } = resolved;
    if (scope.docs.length >= MAX_DOCS) {
      return { ok: false, error: `Already at the maximum of ${MAX_DOCS} docs here — remove one first.` };
    }

    const timestamp = nowIso();
    const docId = newId("plan_doc");
    const cleanTitle = cleanText(title, MAX_DOC_TITLE) || "Untitled doc";
    const byteSize = this._docs.writeMarkdown(planId, docId, `# ${cleanTitle}\n\n`);
    const doc: PlanDocMeta = {
      id: docId, kind: normalizeDocKind(kind), title: cleanTitle, source: "user",
      createdAt: timestamp, updatedAt: timestamp, byteSize,
    };
    scope.docs.push(doc);
    plan.updatedAt = timestamp;
    this.write(document);
    return { ok: true, doc };
  }

  /** Resolves the absolute on-disk path for a doc — the underlying .md file for a markdown
   *  doc, or the copied file for an attachment — so a provider can open/reveal the real thing. */
  resolveDocPath(planId: string, docId: string): { path: string; isAttachment: boolean } | undefined {
    const plan = this.read().plans.find((entry) => entry.id === planId);
    if (!plan) return undefined;
    const doc = [...plan.docs, ...plan.phases.flatMap((phase) => phase.docs)].find((entry) => entry.id === docId);
    if (!doc) return undefined;
    if (doc.attachmentFilename) {
      const abs = this._docs.attachmentAbsPath(planId, doc.attachmentFilename);
      return abs ? { path: abs, isAttachment: true } : undefined;
    }
    return { path: this._docs.markdownAbsPath(planId, docId), isAttachment: false };
  }

  /** Removes a doc's metadata and its on-disk content (markdown body or attached file). */
  deleteDoc(planId: string, docId: string): PlanningDocument {
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return document;
    for (const scope of [plan, ...plan.phases]) {
      const index = scope.docs.findIndex((doc) => doc.id === docId);
      if (index === -1) continue;
      const [removed] = scope.docs.splice(index, 1);
      if (removed!.attachmentFilename) this._docs.deleteAttachment(planId, removed!.attachmentFilename);
      else this._docs.deleteMarkdown(planId, docId);
      plan.updatedAt = nowIso();
      break;
    }
    this.write(document);
    return document;
  }

  /**
   * User-driven plan status override (hold / resume / cancel / reopen). Unlike the
   * agent's plan_update, this respects the user's intent verbatim: holding or
   * cancelling sticks (reconcilePlan leaves manual-hold states alone), while resuming
   * to "active" lets reconciliation re-derive the real state from step progress.
   */
  setPlanStatus(planId: string, status: PlanStatus): PlanningDocument {
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return document;

    const timestamp = nowIso();
    plan.status = status;
    if (status === "completed" || status === "cancelled") {
      plan.completedAt = plan.completedAt ?? timestamp;
    } else if (status !== "archived") {
      // Archiving is a pure visibility change, not a completion state — leave whatever
      // completedAt a plan already had (set or unset) alone rather than clearing it.
      delete plan.completedAt;
    }
    plan.updatedAt = timestamp;
    reconcilePlan(plan);
    this.write(document);
    return document;
  }

  /** User-driven grant/revoke of this plan's agentCanArchive permission — the Plans panel
   *  toggle, so a user can take back "archive this yourself" permission without going
   *  through the agent at all. */
  setAgentCanArchive(planId: string, allow: boolean): PlanningDocument {
    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return document;
    plan.agentCanArchive = allow;
    plan.updatedAt = nowIso();
    this.write(document);
    return document;
  }

  archiveTodoRun(todoId: string): PlanningDocument {
    const document = this.read();
    document.todoRuns = document.todoRuns.filter((run) => run.id !== todoId);
    for (const plan of document.plans) {
      for (const phase of plan.phases) {
        phase.linkedTodoIds = phase.linkedTodoIds.filter((entry) => entry !== todoId);
      }
    }
    this.write(document);
    return document;
  }

  private createPlan(payload: Record<string, unknown>, ctx: PlanningProviderContext): Record<string, unknown> {
    const title = cleanText(payload.title, 180);
    const rawPhases = Array.isArray(payload.phases) ? payload.phases : [];
    const phases: TaskPlanPhase[] = [];
    for (const [phaseIndex, phaseValue] of rawPhases.entries()) {
      const phaseRecord = phaseValue && typeof phaseValue === "object" ? phaseValue as Record<string, unknown> : {};
      const phaseTitle = cleanText(phaseRecord.title, 160) || `Phase ${phaseIndex + 1}`;
      const rawSteps = Array.isArray(phaseRecord.steps) ? phaseRecord.steps : [];
      const steps: TaskPlanStep[] = [];
      for (const [stepIndex, stepValue] of rawSteps.entries()) {
        const stepRecord = stepValue && typeof stepValue === "object" ? stepValue as Record<string, unknown> : {};
        const stepTitle = cleanText(stepRecord.title, 160);
        if (!stepTitle) continue;
        steps.push({
          id: `step-${stepIndex + 1}`,
          title: stepTitle,
          detail: cleanParagraph(stepRecord.detail, 500) || undefined,
          acceptanceCriteria: cleanParagraph(stepRecord.acceptanceCriteria, 500) || undefined,
          maxIterations: normalizeMaxIterations(stepRecord.maxIterations),
          status: "pending",
          notes: [],
          updatedAt: nowIso(),
        });
      }
      const rawPhaseBlocks = Array.isArray(phaseRecord.blocks) ? phaseRecord.blocks : [];
      phases.push({
        id: `phase-${phaseIndex + 1}`,
        title: phaseTitle,
        objective: cleanParagraph(phaseRecord.objective, 500) || undefined,
        rationale: cleanParagraph(phaseRecord.rationale, 500) || undefined,
        risks: cleanParagraph(phaseRecord.risks, 500) || undefined,
        dependsOn: normalizeShortList(phaseRecord.dependsOn, 20, 120),
        acceptanceCriteria: normalizeShortList(phaseRecord.acceptanceCriteria, 20, 300),
        complexity: normalizeComplexity(phaseRecord.complexity) || undefined,
        blocks: upsertBlocks([], rawPhaseBlocks, { next: 1 }, nowIso()),
        docs: [],
        status: "pending",
        steps,
        notes: [],
        linkedTodoIds: [],
        updatedAt: nowIso(),
      });
    }

    if (!title) return { ok: false, error: "title is required." };
    if (phases.length === 0) return { ok: false, error: "At least one phase is required." };

    const timestamp = nowIso();
    const rawPlanBlocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    const plan: TaskPlan = {
      id: newId("plan"),
      title,
      summary: cleanParagraph(payload.summary, 1_000) || undefined,
      status: normalizePlanStatus(payload.status) ?? "active",
      phases,
      blocks: upsertBlocks([], rawPlanBlocks, { next: 1 }, timestamp),
      docs: [],
      agentCanArchive: payload.agentCanArchive === true,
      notes: [],
      activePhaseId: phases[0]?.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      sessionId: ctx.sessionId,
      lastRequestId: ctx.requestId,
    };
    reconcilePlan(plan);

    const document = this.read();
    document.plans.unshift(plan);
    this.write(document);

    return {
      ok: true,
      planId: plan.id,
      phaseIds: plan.phases.map((phase) => phase.id),
      plan: summarizePlan(plan),
    };
  }

  private updatePlan(payload: Record<string, unknown>, ctx: PlanningProviderContext): Record<string, unknown> {
    const planId = cleanText(payload.planId, 120);
    if (!planId) return { ok: false, error: "planId is required." };

    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return { ok: false, error: `Plan not found: ${planId}` };

    const timestamp = nowIso();
    if (typeof payload.title === "string") {
      const title = cleanText(payload.title, 180);
      if (title) plan.title = title;
    }
    if (typeof payload.summary === "string") {
      plan.summary = cleanParagraph(payload.summary, 1_000) || undefined;
    }
    if (typeof payload.agentCanArchive === "boolean") plan.agentCanArchive = payload.agentCanArchive;

    const status = normalizePlanStatus(payload.status);
    if (status === "archived" && !plan.agentCanArchive) {
      // Archiving defaults to a user action taken from the Plans panel — plan_update may only
      // set status to archived when the user has explicitly granted this plan agentCanArchive
      // (at plan_create, or via a later plan_update), e.g. because they said "archive it
      // yourself when you're done." Without that grant, this must error, not silently no-op.
      return { ok: false, error: "This plan doesn't have agentCanArchive permission, so plan_update can't archive it — that's a user action from the Plans panel unless the user explicitly said you may archive it yourself, in which case set agentCanArchive:true first (or the user can grant it from the panel)." };
    }
    if (status) {
      plan.status = status;
      if (status === "completed" || status === "cancelled") {
        plan.completedAt = plan.completedAt ?? timestamp;
      } else if (status !== "archived") {
        delete plan.completedAt;
      }
    }
    if (payload.note != null) plan.notes = appendNote(plan.notes, payload.note);

    if (Array.isArray(payload.blocks) && payload.blocks.length > 0) {
      plan.blocks = upsertBlocks(plan.blocks, payload.blocks, { next: nextSeq(plan.blocks.map((b) => b.id), "block") }, timestamp);
    }
    const removeBlockRef = cleanText(payload.removeBlockId, 120);
    if (removeBlockRef) {
      plan.blocks = plan.blocks.filter((block) => block.id !== removeBlockRef);
    }

    const activePhaseId = cleanText(payload.activePhaseId, 120);
    if (activePhaseId && plan.phases.some((phase) => phase.id === activePhaseId)) {
      plan.activePhaseId = activePhaseId;
    }

    const phaseId = cleanText(payload.phaseId, 120);
    const phase = phaseId ? plan.phases.find((entry) => entry.id === phaseId) : undefined;
    if (phaseId && !phase) {
      return { ok: false, error: `Phase '${phaseId}' not found in plan '${planId}'. Use plan_list to see valid phase IDs.` };
    }
    if (phase) {
      if (typeof payload.phaseTitle === "string") {
        const phaseTitle = cleanText(payload.phaseTitle, 160);
        if (phaseTitle) phase.title = phaseTitle;
      }
      if (typeof payload.phaseObjective === "string") {
        phase.objective = cleanParagraph(payload.phaseObjective, 500) || undefined;
      }
      if (typeof payload.phaseRationale === "string") {
        phase.rationale = cleanParagraph(payload.phaseRationale, 500) || undefined;
      }
      if (typeof payload.phaseRisks === "string") {
        phase.risks = cleanParagraph(payload.phaseRisks, 500) || undefined;
      }
      if (Array.isArray(payload.phaseDependsOn)) {
        phase.dependsOn = normalizeShortList(payload.phaseDependsOn, 20, 120);
      }
      if (Array.isArray(payload.phaseAcceptanceCriteria)) {
        phase.acceptanceCriteria = normalizeShortList(payload.phaseAcceptanceCriteria, 20, 300);
      }
      if (typeof payload.phaseComplexity === "string") {
        // Empty string explicitly clears the field, matching how phaseObjective/phaseRisks
        // clear on empty string — an unparseable non-empty value is ignored (leaves the
        // prior value in place), matching the tolerant convention phaseStatus/stepStatus use.
        if (!payload.phaseComplexity.trim()) phase.complexity = undefined;
        else {
          const complexity = normalizeComplexity(payload.phaseComplexity);
          if (complexity) phase.complexity = complexity;
        }
      }
      if (Array.isArray(payload.phaseBlocks) && payload.phaseBlocks.length > 0) {
        phase.blocks = upsertBlocks(phase.blocks, payload.phaseBlocks, { next: nextSeq(phase.blocks.map((b) => b.id), "block") }, timestamp);
      }
      const removePhaseBlockRef = cleanText(payload.removePhaseBlockId, 120);
      if (removePhaseBlockRef) {
        phase.blocks = phase.blocks.filter((block) => block.id !== removePhaseBlockRef);
      }
      const phaseStatus = normalizePhaseStatus(payload.phaseStatus);
      if (phaseStatus) {
        phase.status = phaseStatus;
        if (phaseStatus === "completed") phase.completedAt = phase.completedAt ?? timestamp;
        else delete phase.completedAt;
      }
      if (payload.phaseNote != null) phase.notes = appendNote(phase.notes, payload.phaseNote);

      const stepId = cleanText(payload.stepId, 120);
      const step = stepId
        ? phase.steps.find((entry) => entry.id === stepId || entry.title === stepId || entry.title.toLowerCase() === stepId.toLowerCase())
        : undefined;
      // A stepId that matches nothing must error, not silently no-op. Previously the
      // status change was dropped while still returning {updated:true}, so the agent
      // believed the step was updated when it never persisted (seen in the logs).
      if (stepId && !step) {
        return { ok: false, error: `Step '${stepId}' not found in phase '${phaseId}'. Use plan_list to see valid step IDs.` };
      }
      if (step) {
        if (typeof payload.stepTitle === "string") {
          const stepTitle = cleanText(payload.stepTitle, 160);
          if (stepTitle) step.title = stepTitle;
        }
        if (typeof payload.stepDetail === "string") {
          step.detail = cleanParagraph(payload.stepDetail, 500) || undefined;
        }
        if (typeof payload.stepAcceptanceCriteria === "string") {
          step.acceptanceCriteria = cleanParagraph(payload.stepAcceptanceCriteria, 500) || undefined;
        }
        if (typeof payload.stepMaxIterations === "number") {
          // 0 (or anything <= 0, via normalizeMaxIterations) explicitly clears it — same
          // "falsy value clears the field" convention phaseComplexity uses.
          step.maxIterations = normalizeMaxIterations(payload.stepMaxIterations);
        }
        const stepStatus = normalizeStepStatus(payload.stepStatus);
        if (stepStatus) step.status = stepStatus;
        if (payload.stepNote != null) step.notes = appendNote(step.notes, payload.stepNote);
        step.updatedAt = timestamp;
      }

      // Append new steps to the target phase.
      if (Array.isArray(payload.addSteps) && payload.addSteps.length > 0) {
        let seq = nextSeq(phase.steps.map((entry) => entry.id), "step");
        for (const raw of payload.addSteps) {
          const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const built = buildPlanStep(record, `step-${seq}`, timestamp);
          if (built) { phase.steps.push(built); seq += 1; }
        }
      }

      // Remove a step from the target phase (by id or exact title).
      const removeStepRef = cleanText(payload.removeStepId, 120);
      if (removeStepRef) {
        const lower = removeStepRef.toLowerCase();
        phase.steps = phase.steps.filter((entry) => entry.id !== removeStepRef && entry.title.toLowerCase() !== lower);
      }

      // Full reorder of this phase's steps — must be an exact permutation of existing IDs.
      if (Array.isArray(payload.reorderStepIds) && payload.reorderStepIds.length > 0) {
        const order = payload.reorderStepIds.map((entry) => cleanText(entry, 120)).filter(Boolean);
        const currentIds = phase.steps.map((entry) => entry.id);
        if (!isExactPermutation(order, currentIds)) {
          return { ok: false, error: "reorderStepIds must include every existing step ID in the target phase exactly once. Use plan_list for valid step IDs." };
        }
        const byId = new Map(phase.steps.map((entry) => [entry.id, entry]));
        phase.steps = order.map((id) => byId.get(id)!);
      }

      // Move a step from this phase to a different phase (by id).
      const moveStepRef = cleanText(payload.moveStepId, 120);
      if (moveStepRef) {
        const moveTargetPhaseId = cleanText(payload.moveStepToPhaseId, 120);
        const destPhase = moveTargetPhaseId ? plan.phases.find((entry) => entry.id === moveTargetPhaseId) : undefined;
        if (!moveTargetPhaseId || !destPhase) {
          return { ok: false, error: "moveStepId requires a valid moveStepToPhaseId. Use plan_list for valid phase IDs." };
        }
        const lower = moveStepRef.toLowerCase();
        const moveIndex = phase.steps.findIndex((entry) => entry.id === moveStepRef || entry.title.toLowerCase() === lower);
        if (moveIndex === -1) {
          return { ok: false, error: `Step '${moveStepRef}' not found in phase '${phaseId}'. Use plan_list to see valid step IDs.` };
        }
        const [moved] = phase.steps.splice(moveIndex, 1);
        // Step IDs are only unique within a phase — reassign if the destination phase
        // already has a step with the same ID, to avoid a silent collision there.
        if (destPhase.steps.some((entry) => entry.id === moved!.id)) {
          moved!.id = `step-${nextSeq(destPhase.steps.map((entry) => entry.id), "step")}`;
        }
        moved!.updatedAt = timestamp;
        destPhase.steps.push(moved!);
        destPhase.updatedAt = timestamp;
      }

      phase.updatedAt = timestamp;
    } else if (Array.isArray(payload.addSteps) && payload.addSteps.length > 0) {
      return { ok: false, error: "addSteps requires a phaseId identifying which phase to extend. Use plan_list for valid phase IDs." };
    }

    // Append (or insert-before an existing phase) new phases to the plan.
    if (Array.isArray(payload.addPhases) && payload.addPhases.length > 0) {
      let phaseSeq = nextSeq(plan.phases.map((entry) => entry.id), "phase");
      const newPhases: TaskPlanPhase[] = [];
      for (const rawPhase of payload.addPhases) {
        const phaseRecord = rawPhase && typeof rawPhase === "object" ? rawPhase as Record<string, unknown> : {};
        const phaseTitle = cleanText(phaseRecord.title, 160);
        if (!phaseTitle) continue;
        const steps: TaskPlanStep[] = [];
        const rawSteps = Array.isArray(phaseRecord.steps) ? phaseRecord.steps : [];
        let stepSeq = 1;
        for (const rawStep of rawSteps) {
          const stepRecord = rawStep && typeof rawStep === "object" ? rawStep as Record<string, unknown> : {};
          const built = buildPlanStep(stepRecord, `step-${stepSeq}`, timestamp);
          if (built) { steps.push(built); stepSeq += 1; }
        }
        const rawNewPhaseBlocks = Array.isArray(phaseRecord.blocks) ? phaseRecord.blocks : [];
        newPhases.push({
          id: `phase-${phaseSeq}`,
          title: phaseTitle,
          objective: cleanParagraph(phaseRecord.objective, 500) || undefined,
          rationale: cleanParagraph(phaseRecord.rationale, 500) || undefined,
          risks: cleanParagraph(phaseRecord.risks, 500) || undefined,
          dependsOn: normalizeShortList(phaseRecord.dependsOn, 20, 120),
          acceptanceCriteria: normalizeShortList(phaseRecord.acceptanceCriteria, 20, 300),
          complexity: normalizeComplexity(phaseRecord.complexity) || undefined,
          blocks: upsertBlocks([], rawNewPhaseBlocks, { next: 1 }, timestamp),
          docs: [],
          status: "pending",
          steps,
          notes: [],
          linkedTodoIds: [],
          updatedAt: timestamp,
        });
        phaseSeq += 1;
      }
      const insertBeforeId = cleanText(payload.insertPhaseBeforeId, 120);
      if (insertBeforeId) {
        const insertIndex = plan.phases.findIndex((entry) => entry.id === insertBeforeId);
        // An invalid id must error, not silently fall back to append — otherwise a typo'd
        // insertPhaseBeforeId looks like it worked while actually landing at the end.
        if (insertIndex === -1) {
          return { ok: false, error: `Phase '${insertBeforeId}' not found for insertPhaseBeforeId. Use plan_list for valid phase IDs.` };
        }
        plan.phases.splice(insertIndex, 0, ...newPhases);
      } else {
        plan.phases.push(...newPhases);
      }
    }

    // Remove a phase from the plan (by id).
    const removePhaseRef = cleanText(payload.removePhaseId, 120);
    if (removePhaseRef) {
      plan.phases = plan.phases.filter((entry) => entry.id !== removePhaseRef);
      if (plan.activePhaseId === removePhaseRef) plan.activePhaseId = undefined;
    }

    // Full reorder of this plan's phases — must be an exact permutation of existing IDs.
    if (Array.isArray(payload.reorderPhaseIds) && payload.reorderPhaseIds.length > 0) {
      const order = payload.reorderPhaseIds.map((entry) => cleanText(entry, 120)).filter(Boolean);
      const currentIds = plan.phases.map((entry) => entry.id);
      if (!isExactPermutation(order, currentIds)) {
        return { ok: false, error: "reorderPhaseIds must include every existing phase ID exactly once. Use plan_list for valid phase IDs." };
      }
      const byId = new Map(plan.phases.map((entry) => [entry.id, entry]));
      plan.phases = order.map((id) => byId.get(id)!);
    }

    plan.updatedAt = timestamp;
    plan.lastRequestId = ctx.requestId ?? plan.lastRequestId;
    reconcilePlan(plan);
    this.write(document);

    return {
      ok: true,
      updated: true,
      plan: summarizePlan(plan),
    };
  }

  private listPlans(payload: Record<string, unknown>): Record<string, unknown> {
    const activeOnly = payload.activeOnly !== false;
    const plans = sortByUpdatedAt(this.read().plans)
      .filter((plan) => !activeOnly || (plan.status !== "completed" && plan.status !== "cancelled" && plan.status !== "archived"))
      .map(summarizePlan);
    return {
      ok: true,
      planCount: plans.length,
      plans,
    };
  }

  private createTodoRun(payload: Record<string, unknown>, ctx: PlanningProviderContext): Record<string, unknown> {
    const stepsInput = Array.isArray(payload.steps) ? payload.steps : [];
    if (stepsInput.length === 0) return { ok: false, error: "At least one step is required." };

    const steps: TodoStep[] = [];
    for (const [index, stepValue] of stepsInput.entries()) {
      const record = stepValue && typeof stepValue === "object" ? stepValue as Record<string, unknown> : {};
      const label = cleanText(record.label, 180);
      if (!label) continue;
      steps.push({
        id: `step-${index + 1}`,
        label,
        status: "pending",
      });
    }
    if (steps.length === 0) return { ok: false, error: "Each task item step requires a label." };

    const todoId = newId("todo");
    const createdAt = nowIso();
    const run: TodoRun = {
      id: todoId,
      name: cleanText(payload.name, 180) || `Task Items ${new Date().toLocaleTimeString()}`,
      steps,
      createdAt,
      updatedAt: createdAt,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      lastRequestId: ctx.requestId,
      planId: cleanText(payload.planId, 120) || undefined,
      phaseId: cleanText(payload.phaseId, 120) || undefined,
    };

    const document = this.read();
    if (run.phaseId) {
      for (const existing of document.todoRuns) {
        if (!existing.completedAt && existing.phaseId === run.phaseId) {
          existing.completedAt = createdAt;
          existing.updatedAt = createdAt;
          for (const step of existing.steps) {
            if (step.status === "pending" || step.status === "running") {
              step.status = "done";
              step.result = step.result || "Superseded by a newer task-items run.";
            }
          }
        }
      }
    }

    const plan = run.planId ? document.plans.find((entry) => entry.id === run.planId) : undefined;
    linkTodoToPlan(plan, run.phaseId, run.id);

    document.todoRuns.unshift(run);
    this.write(document);

    return {
      ok: true,
      todoId,
      stepCount: run.steps.length,
      steps: run.steps.map(({ id, label }) => ({ id, label })),
      run: summarizeTodoRun(run),
    };
  }

  private updateTodoRun(payload: Record<string, unknown>, ctx: PlanningProviderContext): Record<string, unknown> {
    const todoId = cleanText(payload.todoId, 120);
    if (!todoId) return { ok: false, error: "todoId is required." };
    const status = normalizeTodoStatus(payload.status);
    if (!status || (status !== "running" && status !== "done" && status !== "failed")) {
      return { ok: false, error: "status must be running, done, or failed." };
    }

    const document = this.read();
    const run = document.todoRuns.find((entry) => entry.id === todoId);
    if (!run) return { ok: false, error: `Task-items run not found: ${todoId}` };

    const stepRef = cleanText(payload.stepId, 120);
    const step = resolveTodoStep(run, stepRef);
    if (!step) {
      return { ok: false, error: `Step not found: ${stepRef}` };
    }

    step.status = status;
    step.result = cleanParagraph(payload.result, 500) || step.result;
    run.updatedAt = nowIso();
    run.lastRequestId = ctx.requestId ?? run.lastRequestId;
    run.sessionId = run.sessionId ?? ctx.sessionId;

    const doneCount = run.steps.filter((entry) => entry.status === "done").length;
    const failedCount = run.steps.filter((entry) => entry.status === "failed").length;
    if (doneCount + failedCount === run.steps.length) {
      run.completedAt = run.completedAt ?? nowIso();
    } else {
      delete run.completedAt;
    }

    const linkedPlan = run.planId ? document.plans.find((entry) => entry.id === run.planId) : undefined;
    applyTodoStateToPlan(linkedPlan, run);
    this.write(document);

    return {
      ok: true,
      updated: true,
      progress: todoProgress(doneCount, failedCount, run.steps.length),
      updatedStep: cloneTodoStep(step),
      run: summarizeTodoRun(run),
    };
  }

  private todoStatus(payload: Record<string, unknown>): Record<string, unknown> {
    const todoId = cleanText(payload.todoId, 120);
    const runs = sortByUpdatedAt(this.read().todoRuns);
    const run = todoId
      ? runs.find((entry) => entry.id === todoId)
      : runs.find((entry) => !entry.completedAt) ?? runs[0];
    if (!run) return { ok: false, error: "No task-items runs found." };
    return {
      ok: true,
      run: summarizeTodoRun(run),
    };
  }

  private todoList(payload: Record<string, unknown>): Record<string, unknown> {
    const activeOnly = payload.activeOnly !== false;
    const planId = cleanText(payload.planId, 120) || undefined;
    const runs = sortByUpdatedAt(this.read().todoRuns)
      .filter((run) => !activeOnly || !run.completedAt)
      .filter((run) => !planId || run.planId === planId)
      .map(summarizeTodoRun);
    return {
      ok: true,
      runCount: runs.length,
      runs,
    };
  }

  /** Resolves a plan and, if phaseId is given, one of its phases — the shared lookup
   *  plan_doc_write/read/list all need before touching the right `docs[]` array. */
  private _resolveDocScope(
    document: PlanningDocument, planId: string, phaseId: string,
  ): { plan: TaskPlan; scope: TaskPlan | TaskPlanPhase } | { error: string } {
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return { error: `Plan not found: ${planId}` };
    if (!phaseId) return { plan, scope: plan };
    const phase = plan.phases.find((entry) => entry.id === phaseId);
    if (!phase) return { error: `Phase '${phaseId}' not found in plan '${planId}'. Use plan_list to see valid phase IDs.` };
    return { plan, scope: phase };
  }

  private docWrite(payload: Record<string, unknown>): Record<string, unknown> {
    const planId = cleanText(payload.planId, 120);
    if (!planId) return { ok: false, error: "planId is required." };
    const title = cleanText(payload.title, MAX_DOC_TITLE);
    if (!title) return { ok: false, error: "title is required." };
    const body = cleanParagraph(payload.body, MAX_DOC_BODY);
    if (!body) return { ok: false, error: "body is required." };

    const document = this.read();
    const resolved = this._resolveDocScope(document, planId, cleanText(payload.phaseId, 120));
    if ("error" in resolved) return { ok: false, error: resolved.error };
    const { plan, scope } = resolved;

    const timestamp = nowIso();
    const docId = cleanText(payload.docId, 120);
    const existing = docId ? scope.docs.find((doc) => doc.id === docId) : undefined;
    if (docId && !existing) {
      return { ok: false, error: `Doc '${docId}' not found. Omit docId to create a new doc instead.` };
    }
    if (!existing && scope.docs.length >= MAX_DOCS) {
      return { ok: false, error: `This ${scope === plan ? "plan" : "phase"} already has the maximum of ${MAX_DOCS} docs — remove one first (the user can delete docs from the Plans panel).` };
    }
    if (existing?.attachmentFilename) {
      return { ok: false, error: `'${existing.title}' is a file attachment, not a text doc — it has no markdown body to overwrite.` };
    }

    const newDocId = existing?.id ?? newId("plan_doc");
    const byteSize = this._docs.writeMarkdown(planId, newDocId, body);
    let meta: PlanDocMeta;
    if (existing) {
      existing.kind = normalizeDocKind(payload.kind ?? existing.kind);
      existing.title = title;
      existing.updatedAt = timestamp;
      existing.byteSize = byteSize;
      meta = existing;
    } else {
      meta = {
        id: newDocId, kind: normalizeDocKind(payload.kind), title, source: "agent",
        createdAt: timestamp, updatedAt: timestamp, byteSize,
      };
      scope.docs.push(meta);
    }
    plan.updatedAt = timestamp;
    this.write(document);

    return { ok: true, docId: newDocId, doc: meta };
  }

  private docRead(payload: Record<string, unknown>): Record<string, unknown> {
    const planId = cleanText(payload.planId, 120);
    const docId = cleanText(payload.docId, 120);
    if (!planId || !docId) return { ok: false, error: "planId and docId are required." };

    const document = this.read();
    const plan = document.plans.find((entry) => entry.id === planId);
    if (!plan) return { ok: false, error: `Plan not found: ${planId}` };
    const doc = [...plan.docs, ...plan.phases.flatMap((phase) => phase.docs)].find((entry) => entry.id === docId);
    if (!doc) return { ok: false, error: `Doc not found: ${docId}. Use plan_doc_list to see valid doc IDs.` };
    if (doc.attachmentFilename) {
      return { ok: false, error: `'${doc.title}' is a file attachment (${doc.attachmentFilename}), not a text doc — there's no markdown body to read.` };
    }
    return { ok: true, doc, body: this._docs.readMarkdown(planId, docId) };
  }

  private docList(payload: Record<string, unknown>): Record<string, unknown> {
    const planId = cleanText(payload.planId, 120);
    if (!planId) return { ok: false, error: "planId is required." };
    const document = this.read();
    const resolved = this._resolveDocScope(document, planId, cleanText(payload.phaseId, 120));
    if ("error" in resolved) return { ok: false, error: resolved.error };
    const { plan, scope } = resolved;

    if (scope !== plan) return { ok: true, docs: scope.docs };
    return {
      ok: true,
      docs: plan.docs,
      phaseDocs: plan.phases.map((phase) => ({ phaseId: phase.id, phaseTitle: phase.title, docs: phase.docs })),
    };
  }

  private write(document: PlanningDocument): void {
    const normalized = normalizeDocument({
      ...document,
      schemaVersion: PLANNING_SCHEMA_VERSION,
      updatedAt: nowIso(),
    });
    fs.writeFileSync(this.filePath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    this._emitter.fire(normalized);
  }
}
