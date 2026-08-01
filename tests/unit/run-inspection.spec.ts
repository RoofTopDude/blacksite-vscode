/**
 * The post-run report.
 *
 * The trace already held everything needed to answer "what did this run touch, and did it match
 * what it promised" — what was missing was the question. A raw event list tells you what happened
 * in order; it does not tell you whether your workspace is dirty right now, or which file got
 * written that nobody declared.
 */
import { describe, expect, it } from "vitest";
import {
  blastRadius,
  buildInspectionReport,
  buildVerdict,
  comparePromise,
  evidenceLedger,
  irreversibleResidue,
  perspectiveSets,
  type PreflightPromise,
} from "../../src/runs/run-inspection.js";
import type {
  ExecutionRun,
  ObservationBundle,
  RunEvent,
  RunStep,
  SideEffectRecord,
} from "../../src/runs/run-model.js";

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: "run-1", sequenceId: "s1", sequenceVersion: 1, status: "succeeded",
    target: { adapterId: "browser", type: "route", id: "/" },
    adapterIds: ["browser"], ticketIds: [],
    workspaceFingerprint: "w", environmentFingerprint: "e",
    stepIds: [], checkpointIds: [], keyObservationIds: [], retentionClass: "standard",
    ...over,
  } as ExecutionRun;
}

function effect(over: Partial<SideEffectRecord> = {}): SideEffectRecord {
  return {
    id: `eff-${Math.random().toString(36).slice(2)}`,
    class: "workspace_write", description: "workspace:write",
    entityRefs: [], reversible: true, ...over,
  } as SideEffectRecord;
}

function step(ordinal: number, over: Partial<RunStep> = {}): RunStep {
  return {
    id: `step-${ordinal}`, runId: "run-1", ordinal, status: "succeeded",
    targetEntityRefs: [], assertionResults: [], sideEffects: [], ...over,
  } as RunStep;
}

function event(sequenceNumber: number, over: Partial<RunEvent> = {}): RunEvent {
  return {
    id: `e${sequenceNumber}`, runId: "run-1", sequenceNumber,
    monotonicTimestampNs: String(sequenceNumber * 1000),
    wallClockTimestamp: "2026-07-31T00:00:00.000Z",
    channel: "log", type: "console",
    source: { adapterId: "browser", producer: "t" }, entityRefs: [], ...over,
  } as RunEvent;
}

describe("blastRadius", () => {
  it("orders groups by consequence, not by encounter", () => {
    const steps = [
      step(0, { sideEffects: [effect({ class: "workspace_read" })] }),
      step(1, { sideEffects: [effect({ class: "destructive", reversible: false })] }),
      step(2, { sideEffects: [effect({ class: "workspace_write" })] }),
    ];
    expect(blastRadius(steps).map((g) => g.class))
      .toEqual(["destructive", "workspace_write", "workspace_read"]);
  });

  it("counts irreversible effects separately from the total", () => {
    const steps = [step(0, {
      sideEffects: [
        effect({ class: "workspace_write", reversible: true }),
        effect({ class: "workspace_write", reversible: false }),
      ],
    })];
    expect(blastRadius(steps)[0]).toMatchObject({ count: 2, irreversibleCount: 1 });
  });

  it("deduplicates entities touched by more than one effect", () => {
    const ref = { scheme: "workspace-file", id: "src/a.ts", workspacePath: "src/a.ts" };
    const steps = [
      step(0, { sideEffects: [effect({ entityRefs: [ref] as never })] }),
      step(1, { sideEffects: [effect({ entityRefs: [ref] as never })] }),
    ];
    expect(blastRadius(steps)[0]?.entities).toHaveLength(1);
  });

  it("ignores no-op effects, which would otherwise pad every report", () => {
    expect(blastRadius([step(0, { sideEffects: [effect({ class: "none" })] })])).toEqual([]);
  });
});

describe("irreversibleResidue and the verdict", () => {
  /** The concrete answer to "is my workspace dirty right now?" — nothing else in the product
   *  says this. */
  it("names irreversible effects in the verdict when a run fails partway", () => {
    const steps = [
      step(0, { sideEffects: [effect({ class: "workspace_write", reversible: false })] }),
      step(1, { status: "failed" }),
    ];
    const failure = { category: "assertion_failure", message: "x", failedStepId: "step-1" } as never;
    const residue = irreversibleResidue(steps, failure);
    expect(residue).toHaveLength(1);

    const verdict = buildVerdict(run({ status: "failed" }), steps, failure, residue);
    expect(verdict).toContain("Failed at step 2 of 2");
    expect(verdict).toContain("assertion_failure");
    expect(verdict).toContain("cannot be undone");
  });

  it("stays quiet about residue when everything was reversible", () => {
    const steps = [step(0, { sideEffects: [effect({ reversible: true })] })];
    const verdict = buildVerdict(run(), steps, undefined, irreversibleResidue(steps, undefined));
    expect(verdict).toContain("Succeeded");
    expect(verdict).not.toContain("cannot be undone");
  });

  it("does not double-count an effect reported by both the step and the failure envelope", () => {
    const shared = effect({ reversible: false });
    const steps = [step(0, { sideEffects: [shared] })];
    const failure = { completedSideEffects: [shared] } as never;
    expect(irreversibleResidue(steps, failure)).toHaveLength(1);
  });

  it("reports partial and cancelled runs distinctly, since they are not successes", () => {
    const steps = [step(0), step(1, { status: "pending" })];
    expect(buildVerdict(run({ status: "partial" }), steps, undefined, [])).toContain("Partial");
    expect(buildVerdict(run({ status: "cancelled" }), steps, undefined, [])).toContain("Cancelled");
  });
});

describe("comparePromise", () => {
  const promise: PreflightPromise = {
    filesystemEffects: [{ stepId: "step-0", action: "write", target: "src/declared.ts" }],
    commandEffects: [{ stepId: "step-1", command: "npm", args: ["test"] }],
    browserOrigins: ["http://localhost:3000"],
    requiredApprovals: [], deniedOperations: [],
    unresolvedDynamicStepCount: 0, maxDurationMs: 60_000,
  };

  /** The bucket people actually read: something happened that the manifest never mentioned. */
  it("flags an undeclared file write", () => {
    const steps = [step(0, {
      sideEffects: [effect({
        class: "workspace_write",
        entityRefs: [{ scheme: "workspace-file", id: "src/surprise.ts", workspacePath: "src/surprise.ts" }] as never,
      })],
    })];
    const result = comparePromise(promise, steps, []);
    expect(result.beyondDeclaration).toContain("wrote src/surprise.ts");
    expect(result.neverHappened).toContain("declared a write to src/declared.ts");
  });

  it("counts a declared write that happened as declared", () => {
    const steps = [step(0, {
      sideEffects: [effect({
        class: "workspace_write",
        entityRefs: [{ scheme: "workspace-file", id: "src/declared.ts", workspacePath: "src/declared.ts" }] as never,
      })],
    })];
    const result = comparePromise(promise, steps, []);
    expect(result.asDeclared).toContain("wrote src/declared.ts");
    expect(result.beyondDeclaration).toEqual([]);
  });

  it("flags an origin the run contacted that was never declared", () => {
    const events = [
      event(1, { entityRefs: [{ scheme: "browser-request", id: "https://api.stripe.com/v1/x" }] as never }),
      event(2, { entityRefs: [{ scheme: "browser-request", id: "http://localhost:3000/api" }] as never }),
    ];
    const result = comparePromise(promise, [], events);
    expect(result.beyondDeclaration).toContain("contacted https://api.stripe.com");
    expect(result.asDeclared).toContain("contacted http://localhost:3000");
  });

  it("surfaces refused operations, which explain a run that did less than expected", () => {
    const result = comparePromise(
      { ...promise, deniedOperations: [{ stepId: "step-2", reason: "destructive command blocked" }] },
      [], [],
    );
    expect(result.neverHappened).toContain("refused: destructive command blocked");
  });

  it("notes steps that resolved their target at runtime", () => {
    const result = comparePromise({ ...promise, unresolvedDynamicStepCount: 2 }, [], []);
    expect(result.asDeclared).toContain("2 steps chose a target at runtime");
  });
});

describe("evidenceLedger", () => {
  it("collects failed assertions and severe events, ordered by when they happened", () => {
    const steps = [step(0, {
      assertionResults: [
        { assertionType: "text_contains", passed: false, message: "missing", severity: "error" },
        { assertionType: "status_ok", passed: true },
      ] as never,
    })];
    const events = [
      event(5, { channel: "diagnostic", type: "uncaught_exception", severity: "error" }),
      event(2, { severity: "warning", type: "slow_response" }),
      event(3, { type: "console" }),
    ];
    const rows = evidenceLedger(steps, events);
    expect(rows.some((row) => row.kind === "assertion" && row.label === "text_contains")).toBe(true);
    // A passing assertion is not evidence of anything.
    expect(rows.some((row) => row.label === "status_ok")).toBe(false);
    // A plain info-level console line is noise here.
    expect(rows.some((row) => row.sequenceNumber === 3)).toBe(false);
    const sequenced = rows.filter((row) => row.sequenceNumber !== undefined).map((row) => row.sequenceNumber);
    expect(sequenced).toEqual([...sequenced].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe("perspectiveSets", () => {
  const observation = (id: string, sequenceNumber: number, visuals: string[]): ObservationBundle => ({
    id, runId: "run-1", cursor: { sequenceNumber },
    visualArtifactIds: visuals, structuralArtifactIds: [], stateArtifactIds: [],
    eventRange: { firstSequenceNumber: sequenceNumber, lastSequenceNumber: sequenceNumber },
    entityRefs: [], captureProfile: "diagnostic",
  } as ObservationBundle);

  /** A sweep is only meaningful as a set; a lone screenshot is just a screenshot. */
  it("reports only observations holding more than one visual", () => {
    const sets = perspectiveSets([
      observation("o1", 1, ["a"]),
      observation("o2", 2, ["a", "b", "c"]),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ observationId: "o2", frameCount: 3 });
  });
});

describe("buildInspectionReport", () => {
  it("assembles the whole report and marks a dirty workspace", () => {
    const steps = [step(0, { sideEffects: [effect({ class: "workspace_write", reversible: false })] })];
    const report = buildInspectionReport({
      run: run({ status: "partial" }),
      steps,
      events: [event(1, { severity: "error", channel: "diagnostic", type: "boom" })],
      observations: [],
    });
    expect(report.dirty).toBe(true);
    expect(report.verdict).toContain("Partial");
    expect(report.blastRadius[0]?.class).toBe("workspace_write");
    expect(report.evidence).toHaveLength(1);
    // No manifest supplied, so there is nothing honest to compare against.
    expect(report.promise).toBeUndefined();
  });
});
