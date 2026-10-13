import { describe, expect, it } from "vitest";
import {
  checkRegression,
  checkRepeatedFailure,
  checkSpendPace,
  checkStepChanges,
  failureSignature,
  MASS_DELETE_FILES,
  OUT_OF_TERRITORY_FILES,
  territoryAreas,
  type StepChange,
} from "../../src/plans/run-tripwires.js";

const many = (count: number, make: (index: number) => StepChange): StepChange[] => Array.from({ length: count }, (_, index) => make(index));

describe("territoryAreas", () => {
  it("takes a declared file's folder and the one above it, and a declared folder as itself", () => {
    expect(territoryAreas(["src/plans/run-envelope.ts"]).sort()).toEqual(["src", "src/plans"]);
    expect(territoryAreas(["docs/"])).toEqual(["docs"]);
    expect(territoryAreas(["README.md"])).toEqual([""]);
    expect(territoryAreas(["../elsewhere/x.ts", "C:/abs/y.ts"])).toEqual([]);
  });
});

describe("checkStepChanges", () => {
  it("trips on a mass deletion", () => {
    const hits = checkStepChanges(many(MASS_DELETE_FILES, (i) => ({ status: "D", path: `src/f${i}.ts` })), ["src/x.ts"]);
    expect(hits.map((hit) => hit.kind)).toEqual(["mass_delete"]);
    expect(hits[0]!.examples).toHaveLength(5);
  });

  it("stays quiet for a normal step", () => {
    const changes: StepChange[] = [{ status: "M", path: "src/plans/a.ts" }, { status: "D", path: "src/plans/old.ts" }, { status: "A", path: "tests/unit/a.spec.ts" }];
    expect(checkStepChanges(changes, ["src/plans/a.ts", "tests/unit/"])).toEqual([]);
  });

  it("trips when many files change outside the plan's folders, ignoring lockfiles", () => {
    const outside = many(OUT_OF_TERRITORY_FILES, (i) => ({ status: "M", path: `vendor/lib/f${i}.js` }));
    const hits = checkStepChanges([...outside, { status: "M", path: "package-lock.json" }], ["src/plans/a.ts"]);
    expect(hits.map((hit) => hit.kind)).toEqual(["out_of_territory"]);
    const lockfilesOnly = many(OUT_OF_TERRITORY_FILES + 2, (i) => ({ status: "M", path: `pkg${i}/package-lock.json` }));
    expect(checkStepChanges(lockfilesOnly, ["src/plans/a.ts"])).toEqual([]);
  });

  it("does not judge territory when the plan names no files", () => {
    expect(checkStepChanges(many(40, (i) => ({ status: "M", path: `x/f${i}.ts` })), [])).toEqual([]);
  });
});

describe("checkSpendPace", () => {
  const start = 0;
  const minute = 60_000;

  it("trips when the last ten minutes cost far more than the usual pace", () => {
    const samples = [
      ...Array.from({ length: 30 }, (_, i) => ({ at: start + i * minute, usd: 0.05 })),
      ...Array.from({ length: 10 }, (_, i) => ({ at: start + (31 + i) * minute, usd: 0.5 })),
    ];
    const hit = checkSpendPace(samples, start + 40 * minute, start, 40 * minute);
    expect(hit?.kind).toBe("spend_spike");
  });

  it("stays quiet early in a run, at a steady pace, or under the floor", () => {
    const steady = Array.from({ length: 40 }, (_, i) => ({ at: start + i * minute, usd: 0.2 }));
    expect(checkSpendPace(steady, start + 40 * minute, start, 40 * minute)).toBeUndefined();
    expect(checkSpendPace([{ at: 10 * minute, usd: 50 }], 15 * minute, start, 15 * minute)).toBeUndefined();
    const cheap = [{ at: 1 * minute, usd: 0.001 }, { at: 35 * minute, usd: 1 }];
    expect(checkSpendPace(cheap, 40 * minute, start, 40 * minute)).toBeUndefined();
  });
});

describe("failure tripwires", () => {
  it("treats failures that differ only in numbers as the same failure", () => {
    expect(failureSignature("shell_run", "Error: exit code 1 after 1234ms\nmore")).toBe(failureSignature("shell_run", "Error: exit code 1 after 98ms"));
    expect(failureSignature("shell_run", "Error A")).not.toBe(failureSignature("file_write", "Error A"));
  });

  it("trips at the repeat threshold", () => {
    expect(checkRepeatedFailure(5, "shell_run", "boom")).toBeUndefined();
    expect(checkRepeatedFailure(6, "shell_run", "boom")?.kind).toBe("repeated_failure");
  });

  it("trips only on a check that passed earlier in the run", () => {
    expect(checkRegression(new Set(["npm test"]), "npm test", "Step 2")?.kind).toBe("check_regressed");
    expect(checkRegression(new Set(["npm test"]), "npm run lint", "Step 2")).toBeUndefined();
    expect(checkRegression(new Set(), undefined, "Step 2")).toBeUndefined();
  });
});
