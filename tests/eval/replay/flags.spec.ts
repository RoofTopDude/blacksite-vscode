/* Every orchestrator addition is behind a flag whose default reproduces the previous behaviour,
   and turning it back is the rollback. These checks hold each entry of the registry to that: the
   setting is declared with the baseline as its default, it is documented, and its shadow value (if
   it has one) is covered by the shadow-parity replay in replay.spec.ts. */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATION_FLAGS } from "../../../src/orchestration/flags.js";
import { ARMS, EVAL_ROOT } from "../harness/run-scenarios.js";

const REPO = path.resolve(EVAL_ROOT, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
  contributes: { configuration: Array<{ properties?: Record<string, { default?: unknown; enum?: unknown[]; type?: string }> }> | { properties?: Record<string, { default?: unknown; enum?: unknown[]; type?: string }> } };
};
const configurations = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
const properties = Object.assign({}, ...configurations.map((entry) => entry.properties ?? {})) as Record<string, { default?: unknown; enum?: unknown[]; type?: string }>;
const settingsDoc = fs.readFileSync(path.join(REPO, "docs", "guide", "settings-and-commands.md"), "utf8");

describe.each(ORCHESTRATION_FLAGS)("flag $setting", (spec) => {
  it("is declared with the baseline as its default", () => {
    const declared = properties[spec.setting];
    expect(declared, `${spec.setting} is not declared in package.json`).toBeDefined();
    expect(declared!.default).toBe(spec.baseline);
    if (declared!.enum) expect([...declared!.enum].sort()).toEqual([...spec.values].sort());
    else expect(declared!.type).toBe(typeof spec.baseline);
  });

  it("is documented with its rollback", () => {
    expect(settingsDoc).toContain(`\`${spec.setting}\``);
    expect(spec.rollback.length).toBeGreaterThan(0);
  });

  it("has its shadow value replayed against the baseline", () => {
    if (spec.shadow === undefined) return;
    // The replay arms are keyed to work contracts today; a new flag with a shadow mode needs an arm.
    expect(spec.id).toBe("workContracts");
    expect(ARMS.map((arm) => arm.workContracts)).toContain(spec.shadow);
    expect(ARMS[0]!.workContracts).toBe(spec.baseline);
  });
});
