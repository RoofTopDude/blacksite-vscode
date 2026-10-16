/**
 * Existing work, expressed as contracts.
 *
 * Tickets, plan steps and plain subagent spawns already carry most of what a contract says —
 * acceptance criteria, territory, a complexity that sets the budget. These functions only
 * restate that; they invent no restriction the source did not already declare. In particular a
 * source with no territory produces `writable: "workspace"` (`source: "undeclared"`), which is
 * exactly today's behaviour, so contracts never make untenanted work harder.
 *
 * Pure. See docs/orchestration-p0-implementation-plan.md §3.4.
 */

import type { Ticket } from "../ticket-store.js";
import type { TaskPlan, TaskPlanPhase, TaskPlanStep } from "../planning-store.js";
import { territoryAreas } from "../plans/run-tripwires.js";
import {
  CONTRACT_LIMITS,
  WORK_CONTRACT_SCHEMA,
  normalizeScopePath,
  type ContractBudget,
  type ContractEnforcement,
  type PathScope,
  type WorkContract,
  type WorkRef,
} from "./work-contract.js";

export interface IssueOptions {
  id: string;
  createdAt: string;
  enforcement: ContractEnforcement;
  budget: ContractBudget;
  onGate?: WorkContract["escalation"]["onGate"];
}

function clip(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function scopeFrom(files: readonly string[], areas: readonly string[]): PathScope | "workspace" {
  const scope: PathScope = { files: [], areas: [] };
  for (const file of files) {
    const normalized = normalizeScopePath(file);
    if (normalized && !scope.files.includes(normalized) && scope.files.length < CONTRACT_LIMITS.scopeFiles) scope.files.push(normalized);
  }
  for (const area of areas) {
    const normalized = normalizeScopePath(area);
    if (normalized && !scope.areas.includes(normalized) && scope.areas.length < CONTRACT_LIMITS.scopeAreas) scope.areas.push(normalized);
  }
  return scope.files.length || scope.areas.length ? scope : "workspace";
}

function criteria(values: readonly string[]): string[] {
  return values
    .map((value) => clip(value, CONTRACT_LIMITS.acceptanceChars))
    .filter(Boolean)
    .slice(0, CONTRACT_LIMITS.acceptanceItems);
}

function base(options: IssueOptions): Pick<WorkContract, "schema" | "id" | "issuedBy" | "enforcement" | "budget" | "createdAt" | "inputs" | "outputs"> {
  return {
    schema: WORK_CONTRACT_SCHEMA,
    id: options.id,
    issuedBy: "host",
    enforcement: options.enforcement,
    budget: options.budget,
    createdAt: options.createdAt,
    inputs: [],
    outputs: [],
  };
}

/** A loop ticket's contract. Its territory is the ticket's declared files and areas. */
export function contractFromTicket(ticket: Ticket, options: IssueOptions & { loopId?: string }): WorkContract {
  const writable = scopeFrom(ticket.territory.files, ticket.territory.areas);
  const dependencies: WorkRef[] = ticket.blockedBy.slice(0, CONTRACT_LIMITS.refs).map((id) => ({ kind: "ticket", id }));
  if (ticket.planId && ticket.phaseId) dependencies.push({ kind: "plan_step", id: `${ticket.planId}/${ticket.phaseId}` });
  return {
    ...base(options),
    origin: { kind: "ticket", ticketId: ticket.id, ...(options.loopId ? { loopId: options.loopId } : {}) },
    objective: clip(`${ticket.id}: ${ticket.title}${ticket.description ? `\n\n${ticket.description}` : ""}`, CONTRACT_LIMITS.objective),
    dependencies: dependencies.slice(0, CONTRACT_LIMITS.refs),
    territory: { writable, readable: "workspace", source: writable === "workspace" ? "undeclared" : "declared" },
    acceptance: criteria(ticket.acceptanceCriteria),
    verification: { required: true, expectations: [{ kind: "covering_check" }] },
    escalation: { onOutOfScope: "gate", onGate: options.onGate ?? "park", onBudget: "stop" },
  };
}

/**
 * A plan step's contract. Territory follows the tripwire rule (`territoryAreas`): a declared file
 * stands for its folder and the folder above, so tests beside the code are in bounds.
 */
export function contractFromPlanStep(
  plan: Pick<TaskPlan, "id">,
  phase: Pick<TaskPlanPhase, "id" | "files" | "acceptanceCriteria" | "dependsOn">,
  step: Pick<TaskPlanStep, "id" | "title" | "detail" | "acceptanceCriteria">,
  options: IssueOptions,
): WorkContract {
  const files = phase.files ?? [];
  const writable = scopeFrom(files, territoryAreas(files));
  return {
    ...base(options),
    origin: { kind: "plan_step", planId: plan.id, phaseId: phase.id, stepId: step.id },
    objective: clip(`${step.title}${step.detail ? `\n\n${step.detail}` : ""}`, CONTRACT_LIMITS.objective) || step.id,
    dependencies: (phase.dependsOn ?? []).slice(0, CONTRACT_LIMITS.refs).map((id) => ({ kind: "plan_step" as const, id: `${plan.id}/${id}` })),
    territory: { writable, readable: "workspace", source: writable === "workspace" ? "undeclared" : "declared" },
    acceptance: criteria([...(step.acceptanceCriteria ? [step.acceptanceCriteria] : []), ...(phase.acceptanceCriteria ?? [])]),
    verification: { required: true, expectations: [{ kind: "covering_check" }] },
    escalation: { onOutOfScope: "gate", onGate: options.onGate ?? "wait", onBudget: "stop" },
  };
}

/** A plain subagent spawn with nothing more specific to inherit from. */
export function contractFromSpawn(task: string, options: IssueOptions): WorkContract {
  return {
    ...base(options),
    origin: { kind: "subagent" },
    objective: clip(task, CONTRACT_LIMITS.objective) || "Delegated lane",
    dependencies: [],
    territory: { writable: "workspace", readable: "workspace", source: "undeclared" },
    acceptance: [],
    verification: { required: true, expectations: [{ kind: "covering_check" }] },
    escalation: { onOutOfScope: "gate", onGate: options.onGate ?? "wait", onBudget: "stop" },
  };
}
