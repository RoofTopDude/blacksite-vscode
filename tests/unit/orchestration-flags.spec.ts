import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_ORCHESTRATION_FLAGS,
  ORCHESTRATION_FLAGS,
  readOrchestrationFlags,
} from "../../src/orchestration/flags.js";
import { LoopStore } from "../../src/loops/loop-store.js";

describe("orchestration flags", () => {
  it("reads every flag at its baseline when nothing is configured", () => {
    expect(readOrchestrationFlags(() => undefined)).toEqual(BASELINE_ORCHESTRATION_FLAGS);
  });

  it("accepts declared values and falls back to the baseline for anything else", () => {
    // Driven by the registry, so a new flag is covered the moment it is registered.
    const chosen: Record<string, unknown> = Object.fromEntries(
      ORCHESTRATION_FLAGS.map((spec) => [spec.setting, spec.values.find((value) => value !== spec.baseline)]),
    );
    const expected = Object.fromEntries(ORCHESTRATION_FLAGS.map((spec) => [spec.id, chosen[spec.setting]]));
    expect(readOrchestrationFlags((key) => chosen[key])).toEqual(expected);

    // The right value in the wrong type, or the wrong spelling, falls back to the baseline.
    const bad: Record<string, unknown> = Object.fromEntries(ORCHESTRATION_FLAGS.map((spec) => [
      spec.setting,
      typeof spec.baseline === "boolean" ? String(!spec.baseline) : `${String(spec.values.find((value) => value !== spec.baseline)).toUpperCase()}`,
    ]));
    bad["blacksite.orchestration.signals"] = true;
    bad["blacksite.orchestration.scheduler"] = "smart";
    expect(readOrchestrationFlags((key) => bad[key])).toEqual(BASELINE_ORCHESTRATION_FLAGS);
  });

  it("treats a throwing configuration getter as unset", () => {
    expect(readOrchestrationFlags(() => { throw new Error("no config"); })).toEqual(BASELINE_ORCHESTRATION_FLAGS);
  });

  it("registers each flag with a baseline among its own values and a rollback note", () => {
    const ids = new Set<string>();
    for (const spec of ORCHESTRATION_FLAGS) {
      expect(ids.has(spec.id)).toBe(false);
      ids.add(spec.id);
      expect(spec.values).toContain(spec.baseline);
      if (spec.shadow !== undefined) expect(spec.values).toContain(spec.shadow);
      expect(spec.rollback.length).toBeGreaterThan(10);
      expect(BASELINE_ORCHESTRATION_FLAGS[spec.id]).toBe(spec.baseline);
    }
  });
});

describe("loop store determinism seam", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the injected clock and id generator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-seam-"));
    dirs.push(dir);
    let n = 0;
    const store = new LoopStore(dir, { now: () => Date.UTC(2030, 0, 1), newId: (prefix) => `${prefix}_${++n}` });
    const record = store.create({ title: "Seam" });
    expect(record.definition.id).toBe("loop_1");
    expect(record.definition.createdAt).toBe("2030-01-01T00:00:00.000Z");
    const execution = store.beginExecution(record.definition.id);
    expect(execution?.id).toBe("execution_2");
    expect(store.get("loop_1")?.definition.startedAt).toBe("2030-01-01T00:00:00.000Z");
  });
});
