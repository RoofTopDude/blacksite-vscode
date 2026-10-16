import { describe, expect, it } from "vitest";
import {
  WORK_CONTRACT_SCHEMA,
  migrateVersioned,
  narrowContract,
  normalizeScopePath,
  pathInScope,
  readWorkContract,
  scopeWithin,
  validateWorkContract,
  type WorkContract,
} from "../../src/orchestration/work-contract.js";
import { contractFromPlanStep, contractFromSpawn, contractFromTicket } from "../../src/orchestration/contract-mapping.js";
import type { Ticket } from "../../src/ticket-store.js";

const BUDGET = { maxToolRounds: 10, maxRuntimeSeconds: 1200, idleTimeoutSeconds: 240, maxUsd: 5 };
const ISSUE = { id: "wc_1", createdAt: "2026-10-16T00:00:00.000Z", enforcement: "enforce" as const, budget: BUDGET };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "BLK-1", title: "Fix the parser", status: "backlog", statusSource: "manual", priority: "normal",
    labels: [], acceptanceCriteria: ["Parser accepts trailing commas"], territory: { files: ["src/parser.ts"], areas: ["src/lexer"] },
    references: [], runIds: [], blockedBy: ["BLK-0"], blocks: [], relatedTo: [], children: [], assignee: "agent",
    origin: "user", events: [], createdAt: "", updatedAt: "", ...overrides,
  } as Ticket;
}

function valid(): WorkContract {
  return contractFromTicket(ticket(), { ...ISSUE, loopId: "loop_1" });
}

describe("work contract validation", () => {
  it("accepts a contract issued from a ticket and round-trips it through JSON", () => {
    const contract = valid();
    expect(contract.territory).toEqual({ writable: { files: ["src/parser.ts"], areas: ["src/lexer"] }, readable: "workspace", source: "declared" });
    expect(contract.dependencies).toEqual([{ kind: "ticket", id: "BLK-0" }]);
    const read = readWorkContract(JSON.parse(JSON.stringify(contract)));
    expect(read).toEqual({ ok: true, contract });
  });

  it.each([
    ["an unknown top-level field", (c: Record<string, unknown>) => { c.permissions = "all"; }, "unknown field \"permissions\""],
    ["an unknown nested field", (c: Record<string, unknown>) => { (c.budget as Record<string, unknown>).autoApprove = true; }, "unknown field \"autoApprove\""],
    ["a missing objective", (c: Record<string, unknown>) => { c.objective = " "; }, "contract.objective"],
    ["a negative budget", (c: Record<string, unknown>) => { (c.budget as Record<string, unknown>).maxToolRounds = -1; }, "maxToolRounds"],
    ["a NaN budget", (c: Record<string, unknown>) => { (c.budget as Record<string, unknown>).maxUsd = Number.NaN; }, "maxUsd"],
    ["a budget above the limit", (c: Record<string, unknown>) => { (c.budget as Record<string, unknown>).maxRuntimeSeconds = 10 ** 9; }, "above the limit"],
    ["a path climbing out", (c: Record<string, unknown>) => { ((c.territory as Record<string, unknown>).writable as Record<string, unknown>).files = ["../secrets.txt"]; }, "not a workspace-relative path"],
    ["an absolute path", (c: Record<string, unknown>) => { ((c.territory as Record<string, unknown>).writable as Record<string, unknown>).files = ["C:/Windows/x"]; }, "not a workspace-relative path"],
    ["a root area", (c: Record<string, unknown>) => { ((c.territory as Record<string, unknown>).writable as Record<string, unknown>).areas = ["/"]; }, "not a workspace-relative folder"],
    ["an unknown escalation", (c: Record<string, unknown>) => { (c.escalation as Record<string, unknown>).onGate = "approve"; }, "onGate"],
    ["a model-issued contract", (c: Record<string, unknown>) => { c.issuedBy = "agent"; }, "issuedBy"],
    ["a newer schema", (c: Record<string, unknown>) => { c.schema = WORK_CONTRACT_SCHEMA + 1; }, "newer Blacksite"],
  ])("rejects %s", (_label, mutate, message) => {
    const raw = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
    mutate(raw);
    const result = validateWorkContract(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("refuses a newer schema through the reader too, rather than guessing", () => {
    const raw = { ...valid(), schema: 7 };
    const result = readWorkContract(raw);
    expect(result.ok).toBe(false);
  });

  it("walks a migration chain and refuses one that does not advance", () => {
    // A synthetic v0 → v1 step, the shape a real v1 → v2 migration will take.
    const legacy = { id: "wc_old", task: "Do it" } as Record<string, unknown>;
    const upgraded = readWorkContract(legacy, {
      0: (raw) => ({
        ...JSON.parse(JSON.stringify(valid())),
        id: raw.id,
        objective: raw.task,
        schema: 1,
      }),
    });
    expect(upgraded.ok && upgraded.contract.objective).toBe("Do it");
    expect(migrateVersioned({ schema: 0 }, 1, { 0: (raw) => raw })).toEqual({ ok: false, error: "migration from version 0 did not advance" });
    expect(migrateVersioned({ schema: 0 }, 1, {})).toEqual({ ok: false, error: "no migration from version 0" });
  });
});

describe("paths", () => {
  it("normalizes workspace-relative paths and refuses anything else", () => {
    expect(normalizeScopePath("./src\\a.ts")).toBe("src/a.ts");
    expect(normalizeScopePath("src/./b/")).toBe("src/b");
    for (const bad of ["", "/etc/passwd", "C:\\x", "a/../../b", "https://x.y/z", ".", 3]) expect(normalizeScopePath(bad)).toBeNull();
  });

  it("matches files exactly and areas by prefix", () => {
    const scope = { files: ["src/a.ts"], areas: ["lib"] };
    expect(pathInScope("src/a.ts", scope)).toBe(true);
    expect(pathInScope("src/ab.ts", scope)).toBe(false);
    expect(pathInScope("lib/x/y.ts", scope)).toBe(true);
    expect(pathInScope("library/x.ts", scope)).toBe(false);
    expect(pathInScope("anything", "workspace")).toBe(true);
    expect(scopeWithin({ files: ["lib/a.ts"], areas: ["lib/x"] }, scope).ok).toBe(true);
    expect(scopeWithin({ files: [], areas: ["src"] }, scope)).toEqual({ ok: false, excess: ["src/"] });
    expect(scopeWithin("workspace", scope).ok).toBe(false);
  });
});

describe("narrowing a model's proposal", () => {
  const issue = { id: "wc_child", createdAt: ISSUE.createdAt };

  it("accepts a strictly narrower proposal and records the parent", () => {
    const result = narrowContract(valid(), {
      writable: { files: ["src/lexer/tokens.ts"], areas: [] },
      budget: { maxToolRounds: 4, maxUsd: 1 },
      acceptance: ["Tokens test passes"],
      outputs: [{ kind: "file_change", ref: "src/lexer/tokens.ts", description: "token table" }],
    }, issue);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.origin.parentContractId).toBe("wc_1");
    expect(result.contract.budget).toEqual({ ...BUDGET, maxToolRounds: 4, maxUsd: 1 });
    expect(result.contract.acceptance).toEqual(["Parser accepts trailing commas", "Tokens test passes"]);
  });

  it.each([
    ["writable paths outside the base", { writable: { files: ["src/other.ts"], areas: [] } }, "wider than this lane may be given"],
    ["a larger tool budget", { budget: { maxToolRounds: 11 } }, "above the 10"],
    ["a larger spend ceiling", { budget: { maxUsd: 50 } }, "above the 5"],
    ["a permissions field", { permissions: ["network"] }, "unknown field \"permissions\""],
    ["an approval bypass", { autoApprove: true }, "unknown field \"autoApprove\""],
    ["an output outside the territory", { outputs: [{ kind: "file_change", ref: "docs/x.md", description: "doc" }] }, "outside the writable territory"],
    ["a non-object", "everything", "must be an object"],
  ])("fails closed on %s", (_label, proposal, message) => {
    const result = narrowContract(valid(), proposal, issue);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("lets a lane under an undeclared territory narrow it, never widen a declared one to the workspace", () => {
    const open = contractFromSpawn("Survey", { ...ISSUE, id: "wc_open" });
    expect(narrowContract(open, { writable: { files: [], areas: ["src"] } }, issue).ok).toBe(true);
  });
});

describe("mapping existing work", () => {
  it("maps an untenanted ticket to today's behaviour: the whole workspace", () => {
    const contract = contractFromTicket(ticket({ territory: { files: [], areas: [] } }), ISSUE);
    expect(contract.territory.writable).toBe("workspace");
    expect(contract.territory.source).toBe("undeclared");
    expect(validateWorkContract(contract).ok).toBe(true);
  });

  it("maps a plan step with the tripwire territory rule and merged acceptance", () => {
    const contract = contractFromPlanStep(
      { id: "plan-1" },
      { id: "ph-1", files: ["src/graph/layout.ts"], acceptanceCriteria: ["Layout tests pass"], dependsOn: ["ph-0"] },
      { id: "st-1", title: "Rework layout", detail: "Folder first", acceptanceCriteria: "No overlaps" },
      ISSUE,
    );
    expect(contract.territory.writable).toEqual({ files: ["src/graph/layout.ts"], areas: ["src/graph", "src"] });
    expect(contract.acceptance).toEqual(["No overlaps", "Layout tests pass"]);
    expect(contract.dependencies).toEqual([{ kind: "plan_step", id: "plan-1/ph-0" }]);
    expect(validateWorkContract(contract).ok).toBe(true);
  });
});
