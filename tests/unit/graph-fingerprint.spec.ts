import { describe, expect, it } from "vitest";
import { Fingerprint, fingerprintOf } from "../../src/graph/fingerprint.js";
import { relationshipFingerprint } from "../../src/graph/relationship-job.js";

describe("Fingerprint", () => {
  it("is stable for the same input and 28 hex characters long", () => {
    expect(fingerprintOf("src/a.ts\u00001\u00002\n")).toBe(fingerprintOf("src/a.ts\u00001\u00002\n"));
    expect(fingerprintOf("anything")).toMatch(/^[0-9a-f]{28}$/);
    expect(fingerprintOf("")).toMatch(/^[0-9a-f]{28}$/);
  });

  it("streams: several updates equal one update of the concatenation", () => {
    const streamed = new Fingerprint().update("src/a.ts").update("\u0000").update("17\n").digest();
    expect(streamed).toBe(fingerprintOf("src/a.ts\u000017\n"));
  });

  it("can be read more than once", () => {
    const hash = new Fingerprint().update("x");
    expect(hash.digest()).toBe(hash.digest());
  });

  it("tells near-identical inputs apart", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(fingerprintOf(`src/file${i}.ts\u0000${1_700_000_000_000 + i}\u0000${i % 97}\n`));
    expect(seen.size).toBe(5000);
    expect(fingerprintOf("ab")).not.toBe(fingerprintOf("ba"));
  });
});

describe("relationshipFingerprint", () => {
  it("changes when a file's mtime, size, or the topology changes", () => {
    const base = relationshipFingerprint([["a.ts", 1, 10], ["b.ts", 2, 20]], null);
    expect(relationshipFingerprint([["a.ts", 1, 10], ["b.ts", 2, 20]], null)).toBe(base);
    expect(relationshipFingerprint([["a.ts", 1, 10], ["b.ts", 3, 20]], null)).not.toBe(base);
    expect(relationshipFingerprint([["a.ts", 1, 11], ["b.ts", 2, 20]], null)).not.toBe(base);
    expect(relationshipFingerprint([["a.ts", 1, 10], ["b.ts", 2, 20]], {
      projects: [{ id: "web", root: "apps/web", name: "web", kind: "npm", manifestFiles: ["apps/web/package.json"] }],
      references: [],
    })).not.toBe(base);
  });
});
