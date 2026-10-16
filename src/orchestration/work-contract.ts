/**
 * Work contracts: what one piece of delegated work is for, what it may change, and how much it
 * may spend.
 *
 * Every other `.blacksite` document normalizes tolerantly — a rejected ticket is a ticket not
 * filed. A contract is different: it is an authorization, so it is validated strictly and fails
 * closed. Unknown keys, wrong types, out-of-range budgets and paths that leave the workspace are
 * errors, never coerced. That is also what stops a model from smuggling `permissions: "all"` in
 * through a contract it proposes.
 *
 * Contracts are issued by the host. A model may *propose* a narrower one for a lane it spawns
 * (see {@link narrowContract}); anything wider than what it was given is rejected with the excess
 * listed, never silently clamped.
 *
 * Pure: no vscode, no filesystem. See docs/orchestration-p0-implementation-plan.md §3.
 */

export const WORK_CONTRACT_SCHEMA = 1;

export type ContractEnforcement = "observe" | "enforce";

export interface PathScope {
  /** Exact workspace-relative files, forward slashes. */
  files: string[];
  /** Workspace-relative directory prefixes. */
  areas: string[];
}

export type WorkRefKind = "ticket" | "plan_step" | "contract" | "receipt";
export interface WorkRef { kind: WorkRefKind; id: string }

export type ArtifactRefKind = "file" | "plan_doc" | "run" | "artifact" | "receipt";
export interface ArtifactRef { kind: ArtifactRefKind; id: string; sha256?: string }

export type ExpectedOutputKind = "file_change" | "artifact" | "answer" | "test";
export interface ExpectedOutput { kind: ExpectedOutputKind; ref?: string; description: string }

export interface ContractBudget {
  maxToolRounds: number;
  maxRuntimeSeconds: number;
  idleTimeoutSeconds: number;
  maxUsd?: number;
}

export type VerificationExpectation = { kind: "covering_check" } | { kind: "command"; match: string };

export interface ContractOrigin {
  kind: "ticket" | "plan_step" | "subagent";
  ticketId?: string;
  loopId?: string;
  planId?: string;
  phaseId?: string;
  stepId?: string;
  parentContractId?: string;
}

export interface WorkContract {
  schema: typeof WORK_CONTRACT_SCHEMA;
  id: string;
  issuedBy: "host";
  enforcement: ContractEnforcement;
  origin: ContractOrigin;
  objective: string;
  dependencies: WorkRef[];
  inputs: ArtifactRef[];
  outputs: ExpectedOutput[];
  territory: {
    /** "workspace" when the origin named no territory: today's behaviour, nothing is narrowed. */
    writable: PathScope | "workspace";
    readable: PathScope | "workspace";
    source: "declared" | "undeclared";
  };
  acceptance: string[];
  verification: { required: boolean; expectations: VerificationExpectation[] };
  budget: ContractBudget;
  escalation: { onOutOfScope: "gate"; onGate: "park" | "wait" | "defer"; onBudget: "stop" };
  createdAt: string;
}

export const CONTRACT_LIMITS = {
  objective: 2_000,
  acceptanceItems: 20,
  acceptanceChars: 300,
  refs: 40,
  refId: 300,
  outputs: 20,
  outputDescription: 400,
  scopeFiles: 200,
  scopeAreas: 40,
  pathChars: 400,
  maxToolRounds: 60,
  maxRuntimeSeconds: 4 * 60 * 60,
  idleTimeoutSeconds: 60 * 60,
  maxUsd: 10_000,
} as const;

export type ContractResult = { ok: true; contract: WorkContract } | { ok: false; errors: string[] };

// ── Paths ──────────────────────────────────────────────────────────────────────

/**
 * A workspace-relative path in the contract's dialect, or null when it is not one: absolute,
 * drive-lettered, a URL, empty, or climbing out with `..`. Never resolves anything on disk.
 */
export function normalizeScopePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.length > CONTRACT_LIMITS.pathChars) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return null;
  const parts = raw.replace(/^\.\/+/, "").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

export function pathInScope(file: string, scope: PathScope | "workspace"): boolean {
  if (scope === "workspace") return true;
  const normalized = normalizeScopePath(file);
  if (!normalized) return false;
  if (scope.files.includes(normalized)) return true;
  return scope.areas.some((area) => normalized === area || normalized.startsWith(`${area}/`));
}

/** True when every path `inner` can reach, `outer` can reach too. */
export function scopeWithin(inner: PathScope | "workspace", outer: PathScope | "workspace"): { ok: boolean; excess: string[] } {
  if (outer === "workspace") return { ok: true, excess: [] };
  if (inner === "workspace") return { ok: false, excess: ["the whole workspace"] };
  const excess: string[] = [];
  for (const file of inner.files) if (!pathInScope(file, outer)) excess.push(file);
  for (const area of inner.areas) {
    const covered = outer.areas.some((candidate) => area === candidate || area.startsWith(`${candidate}/`));
    if (!covered) excess.push(`${area}/`);
  }
  return { ok: excess.length === 0, excess };
}

// ── Strict validation ──────────────────────────────────────────────────────────

type Errors = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, errors: Errors): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown field "${key}"`);
  }
}

function requiredText(value: unknown, where: string, max: number, errors: Errors): string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${where}: required text`);
    return "";
  }
  if (value.length > max) errors.push(`${where}: longer than ${max} characters`);
  return value.trim();
}

function optionalText(value: unknown, where: string, max: number, errors: Errors): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    errors.push(`${where}: must be text`);
    return undefined;
  }
  if (value.length > max) errors.push(`${where}: longer than ${max} characters`);
  return value.trim() || undefined;
}

function list(value: unknown, where: string, max: number, errors: Errors): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${where}: must be a list`);
    return [];
  }
  if (value.length > max) errors.push(`${where}: more than ${max} entries`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, errors: Errors): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${where}: must be one of ${allowed.join(", ")}`);
    return allowed[0]!;
  }
  return value as T;
}

function validateScope(value: unknown, where: string, errors: Errors, allowWorkspace: boolean): PathScope | "workspace" {
  if (value === "workspace" && allowWorkspace) return "workspace";
  if (!isRecord(value)) {
    errors.push(`${where}: must be { files, areas }${allowWorkspace ? ' or "workspace"' : ""}`);
    return { files: [], areas: [] };
  }
  onlyKeys(value, ["files", "areas"], where, errors);
  const files: string[] = [];
  for (const [index, entry] of list(value.files, `${where}.files`, CONTRACT_LIMITS.scopeFiles, errors).entries()) {
    const normalized = normalizeScopePath(entry);
    if (!normalized) errors.push(`${where}.files[${index}]: not a workspace-relative path`);
    else if (!files.includes(normalized)) files.push(normalized);
  }
  const areas: string[] = [];
  for (const [index, entry] of list(value.areas, `${where}.areas`, CONTRACT_LIMITS.scopeAreas, errors).entries()) {
    const normalized = normalizeScopePath(entry);
    // "", "." and "/" normalize to null: an area that is the whole workspace is spelled "workspace".
    if (!normalized) errors.push(`${where}.areas[${index}]: not a workspace-relative folder`);
    else if (!areas.includes(normalized)) areas.push(normalized);
  }
  return { files, areas };
}

function positive(value: unknown, where: string, max: number, errors: Errors, integer = true): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    errors.push(`${where}: must be a positive ${integer ? "whole " : ""}number`);
    return 1;
  }
  if (n > max) errors.push(`${where}: above the limit of ${max}`);
  return n;
}

function validateBudget(value: unknown, where: string, errors: Errors): ContractBudget {
  if (!isRecord(value)) {
    errors.push(`${where}: required`);
    return { maxToolRounds: 1, maxRuntimeSeconds: 1, idleTimeoutSeconds: 1 };
  }
  onlyKeys(value, ["maxToolRounds", "maxRuntimeSeconds", "idleTimeoutSeconds", "maxUsd"], where, errors);
  return {
    maxToolRounds: positive(value.maxToolRounds, `${where}.maxToolRounds`, CONTRACT_LIMITS.maxToolRounds, errors),
    maxRuntimeSeconds: positive(value.maxRuntimeSeconds, `${where}.maxRuntimeSeconds`, CONTRACT_LIMITS.maxRuntimeSeconds, errors),
    idleTimeoutSeconds: positive(value.idleTimeoutSeconds, `${where}.idleTimeoutSeconds`, CONTRACT_LIMITS.idleTimeoutSeconds, errors),
    ...(value.maxUsd !== undefined ? { maxUsd: positive(value.maxUsd, `${where}.maxUsd`, CONTRACT_LIMITS.maxUsd, errors, false) } : {}),
  };
}

const REF_KINDS: readonly WorkRefKind[] = ["ticket", "plan_step", "contract", "receipt"];
const ARTIFACT_KINDS: readonly ArtifactRefKind[] = ["file", "plan_doc", "run", "artifact", "receipt"];
const OUTPUT_KINDS: readonly ExpectedOutputKind[] = ["file_change", "artifact", "answer", "test"];

function validateRefs(value: unknown, where: string, errors: Errors): WorkRef[] {
  return list(value, where, CONTRACT_LIMITS.refs, errors).map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${at}: must be { kind, id }`); return { kind: "ticket", id: "" }; }
    onlyKeys(entry, ["kind", "id"], at, errors);
    return { kind: oneOf(entry.kind, REF_KINDS, `${at}.kind`, errors), id: requiredText(entry.id, `${at}.id`, CONTRACT_LIMITS.refId, errors) };
  });
}

function validateInputs(value: unknown, where: string, errors: Errors): ArtifactRef[] {
  return list(value, where, CONTRACT_LIMITS.refs, errors).map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${at}: must be { kind, id }`); return { kind: "file", id: "" }; }
    onlyKeys(entry, ["kind", "id", "sha256"], at, errors);
    const sha = optionalText(entry.sha256, `${at}.sha256`, 64, errors);
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) errors.push(`${at}.sha256: must be 64 lowercase hex characters`);
    return {
      kind: oneOf(entry.kind, ARTIFACT_KINDS, `${at}.kind`, errors),
      id: requiredText(entry.id, `${at}.id`, CONTRACT_LIMITS.refId, errors),
      ...(sha ? { sha256: sha } : {}),
    };
  });
}

function validateOutputs(value: unknown, where: string, errors: Errors): ExpectedOutput[] {
  return list(value, where, CONTRACT_LIMITS.outputs, errors).map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${at}: must be { kind, description }`); return { kind: "answer", description: "" }; }
    onlyKeys(entry, ["kind", "ref", "description"], at, errors);
    const kind = oneOf(entry.kind, OUTPUT_KINDS, `${at}.kind`, errors);
    let ref = optionalText(entry.ref, `${at}.ref`, CONTRACT_LIMITS.pathChars, errors);
    if (ref && kind === "file_change") {
      const normalized = normalizeScopePath(ref);
      if (!normalized) errors.push(`${at}.ref: not a workspace-relative path`);
      else ref = normalized;
    }
    return { kind, ...(ref ? { ref } : {}), description: requiredText(entry.description, `${at}.description`, CONTRACT_LIMITS.outputDescription, errors) };
  });
}

function validateAcceptance(value: unknown, where: string, errors: Errors): string[] {
  return list(value, where, CONTRACT_LIMITS.acceptanceItems, errors)
    .map((entry, index) => requiredText(entry, `${where}[${index}]`, CONTRACT_LIMITS.acceptanceChars, errors));
}

function validateExpectations(value: unknown, where: string, errors: Errors): VerificationExpectation[] {
  return list(value, where, 10, errors).map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) { errors.push(`${at}: must be an object`); return { kind: "covering_check" }; }
    const kind = oneOf(entry.kind, ["covering_check", "command"] as const, `${at}.kind`, errors);
    if (kind === "command") {
      onlyKeys(entry, ["kind", "match"], at, errors);
      return { kind, match: requiredText(entry.match, `${at}.match`, 200, errors) };
    }
    onlyKeys(entry, ["kind"], at, errors);
    return { kind };
  });
}

const CONTRACT_KEYS = [
  "schema", "id", "issuedBy", "enforcement", "origin", "objective", "dependencies", "inputs", "outputs",
  "territory", "acceptance", "verification", "budget", "escalation", "createdAt",
] as const;

/** Validate a complete, already-migrated contract. Strict: see the module comment. */
export function validateWorkContract(raw: unknown): ContractResult {
  const errors: Errors = [];
  if (!isRecord(raw)) return { ok: false, errors: ["contract: must be an object"] };
  onlyKeys(raw, CONTRACT_KEYS, "contract", errors);
  if (raw.schema !== WORK_CONTRACT_SCHEMA) {
    errors.push(typeof raw.schema === "number" && raw.schema > WORK_CONTRACT_SCHEMA
      ? `contract.schema: ${raw.schema} was written by a newer Blacksite; this version understands ${WORK_CONTRACT_SCHEMA}`
      : `contract.schema: must be ${WORK_CONTRACT_SCHEMA}`);
  }
  const id = requiredText(raw.id, "contract.id", 120, errors);
  if (raw.issuedBy !== "host") errors.push('contract.issuedBy: must be "host"');
  const enforcement = oneOf(raw.enforcement, ["observe", "enforce"] as const, "contract.enforcement", errors);

  const origin: ContractOrigin = { kind: "subagent" };
  if (!isRecord(raw.origin)) errors.push("contract.origin: required");
  else {
    onlyKeys(raw.origin, ["kind", "ticketId", "loopId", "planId", "phaseId", "stepId", "parentContractId"], "contract.origin", errors);
    origin.kind = oneOf(raw.origin.kind, ["ticket", "plan_step", "subagent"] as const, "contract.origin.kind", errors);
    for (const key of ["ticketId", "loopId", "planId", "phaseId", "stepId", "parentContractId"] as const) {
      const value = optionalText(raw.origin[key], `contract.origin.${key}`, 160, errors);
      if (value) origin[key] = value;
    }
  }

  const objective = requiredText(raw.objective, "contract.objective", CONTRACT_LIMITS.objective, errors);

  let territory: WorkContract["territory"] = { writable: "workspace", readable: "workspace", source: "undeclared" };
  if (!isRecord(raw.territory)) errors.push("contract.territory: required");
  else {
    onlyKeys(raw.territory, ["writable", "readable", "source"], "contract.territory", errors);
    territory = {
      writable: validateScope(raw.territory.writable, "contract.territory.writable", errors, true),
      readable: validateScope(raw.territory.readable ?? "workspace", "contract.territory.readable", errors, true),
      source: oneOf(raw.territory.source, ["declared", "undeclared"] as const, "contract.territory.source", errors),
    };
  }

  let verification: WorkContract["verification"] = { required: false, expectations: [] };
  if (!isRecord(raw.verification)) errors.push("contract.verification: required");
  else {
    onlyKeys(raw.verification, ["required", "expectations"], "contract.verification", errors);
    if (typeof raw.verification.required !== "boolean") errors.push("contract.verification.required: must be true or false");
    verification = {
      required: raw.verification.required === true,
      expectations: validateExpectations(raw.verification.expectations, "contract.verification.expectations", errors),
    };
  }

  let escalation: WorkContract["escalation"] = { onOutOfScope: "gate", onGate: "park", onBudget: "stop" };
  if (!isRecord(raw.escalation)) errors.push("contract.escalation: required");
  else {
    onlyKeys(raw.escalation, ["onOutOfScope", "onGate", "onBudget"], "contract.escalation", errors);
    escalation = {
      onOutOfScope: oneOf(raw.escalation.onOutOfScope, ["gate"] as const, "contract.escalation.onOutOfScope", errors),
      onGate: oneOf(raw.escalation.onGate, ["park", "wait", "defer"] as const, "contract.escalation.onGate", errors),
      onBudget: oneOf(raw.escalation.onBudget, ["stop"] as const, "contract.escalation.onBudget", errors),
    };
  }

  const createdAt = requiredText(raw.createdAt, "contract.createdAt", 40, errors);
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) errors.push("contract.createdAt: must be an ISO time");

  const contract: WorkContract = {
    schema: WORK_CONTRACT_SCHEMA,
    id,
    issuedBy: "host",
    enforcement,
    origin,
    objective,
    dependencies: validateRefs(raw.dependencies, "contract.dependencies", errors),
    inputs: validateInputs(raw.inputs, "contract.inputs", errors),
    outputs: validateOutputs(raw.outputs, "contract.outputs", errors),
    territory,
    acceptance: validateAcceptance(raw.acceptance, "contract.acceptance", errors),
    verification,
    budget: validateBudget(raw.budget, "contract.budget", errors),
    escalation,
    createdAt,
  };
  return errors.length ? { ok: false, errors } : { ok: true, contract };
}

// ── Versions ───────────────────────────────────────────────────────────────────

export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Walk a document up a `{ fromVersion: step }` chain to `current`. A version above `current` is
 * returned as an error rather than guessed at: a contract written by a newer build may carry a
 * restriction this build does not know how to honour.
 */
export function migrateVersioned(
  raw: unknown,
  current: number,
  migrations: Readonly<Record<number, Migration>>,
  versionKey = "schema",
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "not an object" };
  let value = raw;
  let version = typeof value[versionKey] === "number" ? value[versionKey] as number : 0;
  if (version > current) return { ok: false, error: `version ${version} is newer than ${current}` };
  while (version < current) {
    const step = migrations[version];
    if (!step) return { ok: false, error: `no migration from version ${version}` };
    value = step({ ...value });
    const next = typeof value[versionKey] === "number" ? value[versionKey] as number : version;
    if (next <= version) return { ok: false, error: `migration from version ${version} did not advance` };
    version = next;
  }
  return { ok: true, value };
}

/** No earlier contract schema has shipped, so the chain is empty; v2 adds `1: (raw) => …`. */
export const CONTRACT_MIGRATIONS: Readonly<Record<number, Migration>> = {};

export function readWorkContract(raw: unknown, migrations: Readonly<Record<number, Migration>> = CONTRACT_MIGRATIONS): ContractResult {
  const migrated = migrateVersioned(raw, WORK_CONTRACT_SCHEMA, migrations);
  if (!migrated.ok) return { ok: false, errors: [`contract: ${migrated.error}`] };
  return validateWorkContract(migrated.value);
}

// ── Narrowing a model's proposal ───────────────────────────────────────────────

/** What a model may say about a lane it spawns. Everything is optional; nothing may widen. */
export interface ContractProposal {
  writable?: PathScope;
  outputs?: ExpectedOutput[];
  acceptance?: string[];
  dependencies?: WorkRef[];
  inputs?: ArtifactRef[];
  budget?: Partial<ContractBudget>;
}

const PROPOSAL_KEYS = ["writable", "outputs", "acceptance", "dependencies", "inputs", "budget"] as const;

/**
 * Validate a model-proposed narrowing of `base`. Strict like {@link validateWorkContract}: any
 * unknown key (`permissions`, `allow`, `autoApprove`, …) is an error, and so is anything wider
 * than the base — writable paths outside it, a larger budget, a dropped USD ceiling. Additions
 * that only constrain the lane further (more outputs, more acceptance criteria) are accepted.
 */
export function narrowContract(
  base: WorkContract,
  proposal: unknown,
  issue: { id: string; createdAt: string },
): ContractResult {
  const errors: Errors = [];
  if (!isRecord(proposal)) return { ok: false, errors: ["contract: must be an object"] };
  onlyKeys(proposal, PROPOSAL_KEYS, "contract", errors);

  let writable = base.territory.writable;
  if (proposal.writable !== undefined) {
    const proposed = validateScope(proposal.writable, "contract.writable", errors, false);
    const within = scopeWithin(proposed, base.territory.writable);
    if (!within.ok) errors.push(`contract.writable: wider than this lane may be given — ${within.excess.slice(0, 8).join(", ")}`);
    writable = proposed;
  }

  const budget: ContractBudget = { ...base.budget };
  if (proposal.budget !== undefined) {
    if (!isRecord(proposal.budget)) errors.push("contract.budget: must be an object");
    else {
      onlyKeys(proposal.budget, ["maxToolRounds", "maxRuntimeSeconds", "idleTimeoutSeconds", "maxUsd"], "contract.budget", errors);
      for (const key of ["maxToolRounds", "maxRuntimeSeconds", "idleTimeoutSeconds", "maxUsd"] as const) {
        if (proposal.budget[key] === undefined) continue;
        const value = positive(proposal.budget[key], `contract.budget.${key}`, Number.MAX_SAFE_INTEGER, errors, key !== "maxUsd");
        const ceiling = base.budget[key];
        if (ceiling !== undefined && value > ceiling) errors.push(`contract.budget.${key}: ${value} is above the ${ceiling} this lane may be given`);
        budget[key] = value;
      }
    }
  }

  const outputs = [...base.outputs, ...validateOutputs(proposal.outputs, "contract.outputs", errors)];
  if (outputs.length > CONTRACT_LIMITS.outputs) errors.push(`contract.outputs: more than ${CONTRACT_LIMITS.outputs} in total`);
  for (const output of outputs) {
    if (output.kind === "file_change" && output.ref && !pathInScope(output.ref, writable)) {
      errors.push(`contract.outputs: ${output.ref} is outside the writable territory`);
    }
  }
  const acceptance = [...base.acceptance, ...validateAcceptance(proposal.acceptance, "contract.acceptance", errors)];
  if (acceptance.length > CONTRACT_LIMITS.acceptanceItems) errors.push(`contract.acceptance: more than ${CONTRACT_LIMITS.acceptanceItems} in total`);

  if (errors.length) return { ok: false, errors };
  return validateWorkContract({
    ...base,
    id: issue.id,
    createdAt: issue.createdAt,
    origin: { ...base.origin, kind: "subagent", parentContractId: base.id },
    territory: { ...base.territory, writable, source: writable === "workspace" ? base.territory.source : "declared" },
    outputs,
    acceptance,
    dependencies: [...base.dependencies, ...validateRefs(proposal.dependencies, "contract.dependencies", errors)],
    inputs: [...base.inputs, ...validateInputs(proposal.inputs, "contract.inputs", errors)],
    budget,
  });
}
