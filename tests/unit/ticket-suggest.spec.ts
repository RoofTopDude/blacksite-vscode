import { describe, expect, it } from "vitest";
import { deriveAreas, scoreCandidate, suggest, type SuggestSources } from "../../src/ticket-suggest.js";
import type { Ticket } from "../../src/ticket-store.js";

const FILES = [
  "src/graph/layout.ts",
  "src/graph/renderer.ts",
  "src/webview/react/apps/tickets/TicketsApp.tsx",
  "src/ticket-store.ts",
  "docs/ticket-entity-design.md",
];

function ticket(id: string, title: string, status = "backlog"): Ticket {
  return {
    id, title, status: status as Ticket["status"], statusSource: "manual", priority: "normal",
    labels: [], acceptanceCriteria: [], territory: { files: [], areas: [] }, references: [],
    blockedBy: [], blocks: [], relatedTo: [], assignee: "unassigned", origin: "agent",
    events: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const sources: SuggestSources = {
  indexedFiles: () => FILES,
  tickets: () => [ticket("BLK-1", "Retry backoff drifts"), ticket("BLK-2", "Graph layout jitters", "in_progress")],
  labels: () => [{ label: "graph", count: 4 }, { label: "retry", count: 1 }],
  plans: () => [{ id: "plan_1", title: "Retire the legacy gateway", status: "active" }],
};

describe("scoreCandidate", () => {
  it("ranks match kind above match length", () => {
    // A basename prefix must beat a mid-token substring no matter how the paths compare.
    const prefix = scoreCandidate("src/graph/layout.ts", "layout");
    const midToken = scoreCandidate("a/relayout.ts", "layout");
    expect(prefix).toBeGreaterThan(midToken);
  });

  it("puts an exact match first, then basename, then path prefix", () => {
    expect(scoreCandidate("graph", "graph")).toBeGreaterThan(scoreCandidate("src/graph.ts", "graph"));
    expect(scoreCandidate("src/graph.ts", "graph")).toBeGreaterThan(scoreCandidate("src/graph/layout.ts", "src/graph/l"));
  });

  it("accepts a scattered subsequence but scores it below any real match", () => {
    const scattered = scoreCandidate("src/graph/layout.ts", "grla");
    expect(scattered).toBeGreaterThan(0);
    expect(scattered).toBeLessThan(scoreCandidate("src/graph/layout.ts", "graph"));
  });

  it("rejects characters that are not there in order", () => {
    expect(scoreCandidate("src/graph/layout.ts", "zzz")).toBe(-1);
    expect(scoreCandidate("layout", "tuoyal")).toBe(-1);
  });

  it("treats an empty query as a match so an unfiltered field still offers rows", () => {
    expect(scoreCandidate("anything", "")).toBeGreaterThan(0);
  });
});

describe("deriveAreas", () => {
  it("counts every prefix, deepest and shallowest alike", () => {
    const areas = new Map(deriveAreas(FILES).map((entry) => [entry.area, entry.files]));
    expect(areas.get("src")).toBe(4);
    expect(areas.get("src/graph")).toBe(2);
    expect(areas.get("docs")).toBe(1);
  });

  it("orders by size so an unqueried field offers the areas worth scoping to", () => {
    expect(deriveAreas(FILES)[0]?.area).toBe("src");
  });

  it("never emits a file as an area", () => {
    expect(deriveAreas(FILES).some((entry) => entry.area.endsWith(".ts"))).toBe(false);
  });
});

describe("suggest", () => {
  it("offers files by basename with their directory as context", () => {
    const [first] = suggest("file", "layout", sources);
    expect(first?.value).toBe("src/graph/layout.ts");
    expect(first?.label).toBe("layout.ts");
    expect(first?.hint).toBe("src/graph");
  });

  it("never re-offers a value the field already holds", () => {
    const values = suggest("file", "graph", sources, ["src/graph/layout.ts"]).map((item) => item.value);
    expect(values).not.toContain("src/graph/layout.ts");
    expect(values).toContain("src/graph/renderer.ts");
  });

  it("matches a ticket by its title as well as its id", () => {
    expect(suggest("ticket", "jitter", sources)[0]?.value).toBe("BLK-2");
    expect(suggest("ticket", "blk-1", sources)[0]?.value).toBe("BLK-1");
  });

  it("carries a ticket's status through so the row can show it", () => {
    expect(suggest("ticket", "jitter", sources)[0]?.kind).toBe("in_progress");
  });

  it("offers labels with their usage count", () => {
    expect(suggest("label", "gr", sources)[0]).toMatchObject({ value: "graph", hint: "4" });
  });

  it("offers plans by title, keeping the id as the value", () => {
    expect(suggest("plan", "gateway", sources)[0]).toMatchObject({ value: "plan_1", hint: "plan_1" });
  });

  it("caps the answer so a keystroke never returns the whole index", () => {
    const many = Array.from({ length: 500 }, (_, index) => `src/module${index}/file.ts`);
    expect(suggest("file", "file", { ...sources, indexedFiles: () => many })).toHaveLength(12);
  });
});
