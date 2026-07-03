import { describe, expect, it } from "vitest";
import {
  HEAT_CAP,
  PULSE_MS,
  deriveTraceEdges,
  dominantKind,
  hasActiveAnimation,
  heatAt,
  pruneTraces,
  pulseAt,
  traceEdgeAlpha,
  twinkleFactor,
} from "../../src/webview/react/lib/graph/traces.js";
import type { TraceEvent } from "../../src/webview/react/lib/graph/protocol.js";

const FADE = 10_000;

function ev(path: string, at: number, kind: TraceEvent["kind"] = "read", laneId?: string): TraceEvent {
  return { id: `${path}@${at}`, path, kind, at, laneId };
}

describe("heatAt", () => {
  it("decays monotonically with age", () => {
    const events = [ev("a.ts", 0)];
    const early = heatAt(events, "a.ts", 1000, FADE);
    const late = heatAt(events, "a.ts", 8000, FADE);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });

  it("stacks additively and caps at HEAT_CAP", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev("a.ts", i));
    expect(heatAt(events, "a.ts", 10, FADE)).toBe(HEAT_CAP);
  });

  it("ignores other paths and future events", () => {
    expect(heatAt([ev("b.ts", 0)], "a.ts", 100, FADE)).toBe(0);
    expect(heatAt([ev("a.ts", 5000)], "a.ts", 100, FADE)).toBe(0);
  });
});

describe("pulseAt", () => {
  it("is 1 at the event instant and 0 after PULSE_MS", () => {
    const events = [ev("a.ts", 1000)];
    expect(pulseAt(events, "a.ts", 1000)).toBe(1);
    expect(pulseAt(events, "a.ts", 1000 + PULSE_MS)).toBe(0);
    expect(pulseAt(events, "a.ts", 1000 + PULSE_MS / 2)).toBeCloseTo(0.5, 5);
  });
});

describe("dominantKind", () => {
  it("picks the highest decayed weight", () => {
    const events = [ev("a.ts", 0, "read"), ev("a.ts", 0, "read"), ev("a.ts", 0, "write")];
    expect(dominantKind(events, "a.ts", 100, FADE)).toBe("read");
  });
  it("prefers recent activity via decay", () => {
    const events = [ev("a.ts", 0, "read"), ev("a.ts", 9500, "write")];
    expect(dominantKind(events, "a.ts", 10_000, 2000)).toBe("write");
  });
  it("returns null with no events", () => {
    expect(dominantKind([], "a.ts", 0, FADE)).toBeNull();
  });
});

describe("deriveTraceEdges", () => {
  it("links consecutive distinct paths in order", () => {
    const events = [ev("a.ts", 1, "read"), ev("b.ts", 2, "write"), ev("b.ts", 3, "edit"), ev("c.ts", 4, "read")];
    const edges = deriveTraceEdges(events);
    expect(edges).toEqual([
      { from: "a.ts", to: "b.ts", kind: "write", at: 2 },
      { from: "b.ts", to: "c.ts", kind: "read", at: 4 },
    ]);
  });

  it("never links across interleaved lanes", () => {
    const events = [
      ev("a.ts", 1, "read", "lane1"),
      ev("x.ts", 2, "read", "lane2"),
      ev("b.ts", 3, "write", "lane1"),
      ev("y.ts", 4, "write", "lane2"),
    ];
    const edges = deriveTraceEdges(events);
    expect(edges).toEqual([
      { from: "a.ts", to: "b.ts", kind: "write", at: 3 },
      { from: "x.ts", to: "y.ts", kind: "write", at: 4 },
    ]);
  });
});

describe("traceEdgeAlpha / pruneTraces / hasActiveAnimation", () => {
  it("edge alpha fades to zero within the cap", () => {
    const edge = { from: "a.ts", to: "b.ts", kind: "read" as const, at: 0 };
    expect(traceEdgeAlpha(edge, 0, FADE)).toBeGreaterThan(0.9);
    expect(traceEdgeAlpha(edge, 60_000, FADE)).toBe(0);
  });

  it("prunes stale events and enforces the cap", () => {
    const events = [ev("a.ts", 0), ev("b.ts", 99_000)];
    const kept = pruneTraces(events, 100_000, 1000);
    expect(kept.map((e) => e.path)).toEqual(["b.ts"]);
    const many = Array.from({ length: 3000 }, (_, i) => ev("a.ts", 99_000 + i));
    expect(pruneTraces(many, 100_000, FADE, 2000).length).toBe(2000);
  });

  it("reports animation only while something is visible", () => {
    expect(hasActiveAnimation([ev("a.ts", 0)], 100, FADE)).toBe(true);
    expect(hasActiveAnimation([ev("a.ts", 0)], 500_000, FADE)).toBe(false);
  });
});

describe("twinkleFactor", () => {
  it("stays within its stated bounds for any seed and time", () => {
    for (const seed of [0, 1, 12345, 0xffffffff]) {
      for (let t = 0; t < 10_000; t += 137) {
        const factor = twinkleFactor(seed, t);
        expect(factor).toBeGreaterThanOrEqual(0.86 - 1e-9);
        expect(factor).toBeLessThanOrEqual(1.14 + 1e-9);
      }
    }
  });

  it("gives different seeds different phases", () => {
    const a = twinkleFactor(101, 500);
    const b = twinkleFactor(77777, 500);
    expect(a).not.toBeCloseTo(b, 5);
  });

  it("is pure: same (seed, now) always yields the same factor", () => {
    expect(twinkleFactor(42, 1234)).toBe(twinkleFactor(42, 1234));
  });
});
