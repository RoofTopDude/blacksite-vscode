import { describe, expect, it } from "vitest";
import { autoEscalatedProfile, renderedImportProjection } from "../../src/graph/graph-indexer.js";
import { PROFILE_CAPS } from "../../src/graph/config.js";

/**
 * A workspace with several sub-project folders under one parent (a monorepo)
 * can easily clear 15k+ indexable files. The "balanced" default profile
 * (12k indexed / 4k rendered) would otherwise silently truncate most of it
 * with no obvious way for the user to discover a bigger tier exists —
 * autoEscalatedProfile() is what upgrades the implicit default in that case.
 */
describe("autoEscalatedProfile", () => {
  it("does not escalate a workspace that fits comfortably in balanced", () => {
    expect(autoEscalatedProfile(500)).toBeNull();
    expect(autoEscalatedProfile(PROFILE_CAPS.balanced.maxIndexedFiles)).toBeNull();
  });

  it("escalates to large once the true file count exceeds balanced's cap", () => {
    expect(autoEscalatedProfile(PROFILE_CAPS.balanced.maxIndexedFiles + 1)).toBe("large");
    expect(autoEscalatedProfile(15_000)).toBe("large");
    expect(autoEscalatedProfile(PROFILE_CAPS.large.maxIndexedFiles)).toBe("large");
  });

  it("escalates to extreme once the true file count exceeds large's cap too", () => {
    expect(autoEscalatedProfile(PROFILE_CAPS.large.maxIndexedFiles + 1)).toBe("extreme");
    expect(autoEscalatedProfile(80_000)).toBe("extreme");
  });
});

describe("renderedImportProjection", () => {
  it("keeps off-map import facts intact while returning only drawable endpoints", () => {
    const indexed = new Map<string, string[]>([
      ["apps/web/api.ts", ["services/orders/routes.ts", "services/users/routes.ts"]],
      ["services/orders/routes.ts", ["services/users/routes.ts"]],
    ]);
    const rendered = new Set(["apps/web/api.ts", "services/orders/routes.ts"]);
    expect([...renderedImportProjection(indexed, rendered)]).toEqual([
      ["apps/web/api.ts", ["services/orders/routes.ts"]],
    ]);
    expect(indexed.get("apps/web/api.ts")).toEqual(["services/orders/routes.ts", "services/users/routes.ts"]);
  });
});
