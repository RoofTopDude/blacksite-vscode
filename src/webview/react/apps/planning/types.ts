/** Message and entity shapes for the Plans surface.
 *
 * These are deliberately mirrored from planning-store.ts instead of importing host code into
 * the webview bundle. The reader keeps additive fields intact while supplying safe collection
 * defaults for documents created by older extension versions.
 */

export interface Step {
  id: string;
  title?: string;
  label?: string;
  status: string;
  detail?: string;
  result?: string;
  acceptanceCriteria?: string;
  maxIterations?: number;
  notes?: string[];
}

export interface Block {
  id: string;
  kind: string;
  label?: string;
  body: string;
}

export interface Doc {
  id: string;
  kind: string;
  title: string;
  source: "agent" | "user";
  attachmentFilename?: string;
  createdAt: string;
  updatedAt: string;
  byteSize: number;
}

export interface PhaseRunEvidence {
  runIds: string[];
  latestRunId?: string;
  baselineRunId?: string;
  latestSuccessfulRunId?: string;
  acceptedObservationIds: string[];
  unresolvedAnomalyIds: string[];
}

export interface Phase {
  id: string;
  title: string;
  objective?: string;
  status: string;
  steps: Step[];
  rationale?: string;
  risks?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  complexity?: string;
  files?: string[];
  blocks?: Block[];
  docs?: Doc[];
  notes?: string[];
  runEvidence?: PhaseRunEvidence;
}

export interface Plan {
  id: string;
  title: string;
  summary?: string;
  status: string;
  activePhaseId?: string;
  phases: Phase[];
  blocks?: Block[];
  docs?: Doc[];
  notes?: string[];
  agentCanArchive?: boolean;
  executionApproved?: boolean;
}

export interface TodoRun {
  id: string;
  name: string;
  completedAt?: string;
  steps: Step[];
  planId?: string;
  phaseId?: string;
}

export interface PlanningDocument {
  plans: Plan[];
  todoRuns: TodoRun[];
}

export interface PlanningCounts {
  activePlans: number;
  activeTodos: number;
  totalPlans: number;
  totalTodos: number;
}

export const EMPTY_PLANNING_DOCUMENT: PlanningDocument = { plans: [], todoRuns: [] };

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readRunEvidence(value: unknown): PhaseRunEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Record<string, unknown>;
  const optionalId = (entry: unknown): string | undefined => (
    typeof entry === "string" && entry.length > 0 ? entry : undefined
  );
  return {
    runIds: stringArray(evidence.runIds),
    latestRunId: optionalId(evidence.latestRunId),
    baselineRunId: optionalId(evidence.baselineRunId),
    latestSuccessfulRunId: optionalId(evidence.latestSuccessfulRunId),
    acceptedObservationIds: stringArray(evidence.acceptedObservationIds),
    unresolvedAnomalyIds: stringArray(evidence.unresolvedAnomalyIds),
  };
}

/** Coerce the host's `planning_state.document` payload.
 *
 * The host owns validation and persistence; this boundary only makes the rendering contract
 * upgrade-tolerant. In particular, execution evidence must not disappear when older fields are
 * absent around it.
 */
export function readPlanningDocument(value: unknown): PlanningDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_PLANNING_DOCUMENT;
  }
  const record = value as Record<string, unknown>;
  const plans = Array.isArray(record.plans) ? record.plans : [];
  const todoRuns = Array.isArray(record.todoRuns) ? record.todoRuns : [];

  return {
    plans: plans
      .filter((plan): plan is Record<string, unknown> => Boolean(plan && typeof plan === "object" && !Array.isArray(plan)))
      .map((plan) => {
        const phases = Array.isArray(plan.phases) ? plan.phases : [];
        return {
          ...plan,
          phases: phases
            .filter((phase): phase is Record<string, unknown> => Boolean(phase && typeof phase === "object" && !Array.isArray(phase)))
            .map((phase) => ({
              ...phase,
              steps: Array.isArray(phase.steps) ? phase.steps : [],
              runEvidence: readRunEvidence(phase.runEvidence),
            })),
        } as unknown as Plan;
      }),
    todoRuns: todoRuns
      .filter((run): run is Record<string, unknown> => Boolean(run && typeof run === "object" && !Array.isArray(run)))
      .map((run) => ({
        ...run,
        steps: Array.isArray(run.steps) ? run.steps : [],
      } as unknown as TodoRun)),
  };
}
