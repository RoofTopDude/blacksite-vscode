import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const BLACKSITE_DIR = ".blacksite";
const PLANNING_FILE = "planning.json";
const PLANNING_SCHEMA_VERSION = 1;
const MAX_TEXT = 2_000;
const MAX_NOTES = 12;
const MAX_PROMPT_CHARS = 5_500;

export type PlanStatus = "draft" | "active" | "completed" | "blocked" | "cancelled";
export type PlanPhaseStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TodoStepStatus = "pending" | "running" | "done" | "failed";

export interface TaskPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
  notes: string[];
  updatedAt: string;
}

export interface TaskPlanPhase {
  id: string;
  title: string;
  objective?: string;
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

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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

function normalizePlanStatus(value: unknown): PlanStatus | null {
  return value === "draft" || value === "active" || value === "completed" || value === "blocked" || value === "cancelled"
    ? value
    : null;
}

function normalizePhaseStatus(value: unknown): PlanPhaseStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked"
    ? value
    : null;
}

function normalizeStepStatus(value: unknown): PlanStepStatus | null {
  return normalizePhaseStatus(value);
}

function normalizeTodoStatus(value: unknown): TodoStepStatus | null {
  return value === "pending" || value === "running" || value === "done" || value === "failed"
    ? value
    : null;
}

function normalizeNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((note) => cleanParagraph(note, 400))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
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
      status: phase.status,
      counts,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : undefined,
      steps: phase.steps.map((step) => ({
        id: step.id,
        title: step.title,
        status: step.status,
        detail: step.detail,
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
  if (plan.status === "cancelled") return;
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

function formatPlanForPrompt(plan: TaskPlan): string {
  const summary = summarizePlan(plan);
  const lines = [
    `- ${summary.title} (${summary.id}) [${summary.status}]`,
  ];
  if (summary.summary) lines.push(`  Summary: ${summary.summary}`);
  if (summary.activePhaseTitle) lines.push(`  Current phase: ${summary.activePhaseTitle}`);
  for (const phase of summary.phases.slice(0, 4)) {
    lines.push(`  - Phase ${phase.title} [${phase.status}]`);
    if (phase.objective) lines.push(`    Objective: ${phase.objective}`);
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
  const activePlans = sortByUpdatedAt(document.plans).filter((plan) => plan.status !== "completed" && plan.status !== "cancelled");
  const activeTodos = sortByUpdatedAt(document.todoRuns).filter((run) => !run.completedAt);
  if (activePlans.length === 0 && activeTodos.length === 0) return "";

  const blocks: string[] = [];
  if (activePlans.length > 0) {
    blocks.push("Active plans:");
    for (const plan of activePlans.slice(0, 3)) blocks.push(formatPlanForPrompt(plan));
  }
  if (activeTodos.length > 0) {
    blocks.push("Active task items:");
    for (const run of activeTodos.slice(0, 3)) blocks.push(formatTodoForPrompt(run));
  }

  return blocks.join("\n").slice(0, maxChars);
}

export class PlanningStore implements PlanningProvider, vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<PlanningDocument>();

  readonly onDidChange = this._emitter.event;

  constructor(private readonly _workspaceRoot: string) {}

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
      default:
        return { ok: false, error: `Unknown planning operation: ${op}` };
    }
  }

  clearCompleted(): PlanningDocument {
    const document = this.read();
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

  archivePlan(planId: string): PlanningDocument {
    const document = this.read();
    document.plans = document.plans.filter((plan) => plan.id !== planId);
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
          status: "pending",
          notes: [],
          updatedAt: nowIso(),
        });
      }
      phases.push({
        id: `phase-${phaseIndex + 1}`,
        title: phaseTitle,
        objective: cleanParagraph(phaseRecord.objective, 500) || undefined,
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
    const plan: TaskPlan = {
      id: newId("plan"),
      title,
      summary: cleanParagraph(payload.summary, 1_000) || undefined,
      status: normalizePlanStatus(payload.status) ?? "active",
      phases,
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
    const status = normalizePlanStatus(payload.status);
    if (status) {
      plan.status = status;
      if (status === "completed" || status === "cancelled") {
        plan.completedAt = plan.completedAt ?? timestamp;
      } else {
        delete plan.completedAt;
      }
    }
    if (payload.note != null) plan.notes = appendNote(plan.notes, payload.note);

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
      if (step) {
        if (typeof payload.stepTitle === "string") {
          const stepTitle = cleanText(payload.stepTitle, 160);
          if (stepTitle) step.title = stepTitle;
        }
        if (typeof payload.stepDetail === "string") {
          step.detail = cleanParagraph(payload.stepDetail, 500) || undefined;
        }
        const stepStatus = normalizeStepStatus(payload.stepStatus);
        if (stepStatus) step.status = stepStatus;
        if (payload.stepNote != null) step.notes = appendNote(step.notes, payload.stepNote);
        step.updatedAt = timestamp;
      }
      phase.updatedAt = timestamp;
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
      .filter((plan) => !activeOnly || (plan.status !== "completed" && plan.status !== "cancelled"))
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
