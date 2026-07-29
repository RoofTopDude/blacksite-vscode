import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_OPTIONS, deriveWorkGraph, edgePresentation } from "@/lib/graph/view-model";
import type { GraphNode, MapTicket } from "@/lib/graph/protocol";

const file = (id: string, x: number, y: number): GraphNode => ({
  id, dir: "src", lang: "ts", sizeBytes: 100, inDegree: 0, outDegree: 0, x, y, z: 1,
});

describe("Work lens projection", () => {
  it("keeps semantic work edges visible even when the saved edge preference is Bundles", () => {
    expect(edgePresentation("clusters", "work", 100, 200, 0.5).strategy).toBe("raw");
    expect(edgePresentation("all", "work", 100, 200, 0.5).strategy).toBe("raw");
    expect(DEFAULT_DISPLAY_OPTIONS.lens).toBe("files");
  });

  it("places a ticket at the centroid of its territory and draws scope edges", () => {
    const tickets: MapTicket[] = [{ id: "BLK-1", title: "Repair retry", status: "backlog", priority: "high", files: ["src/a.ts", "src/b.ts"], blockedBy: [] }];
    const graph = deriveWorkGraph([file("src/a.ts", 0, 20), file("src/b.ts", 100, 60)], tickets);
    expect(graph.displayNodes.find((node) => node.id === "ticket:BLK-1")).toMatchObject({ x: 50, y: 40, kind: "ticket", ticketPriority: "high" });
    expect(graph.displayEdges.filter((edge) => edge.kind === "ticket_scope")).toHaveLength(2);
  });

  it("draws explicit blocking and derived overlap edges exactly once", () => {
    const tickets: MapTicket[] = [
      { id: "BLK-1", title: "A", status: "backlog", priority: "normal", files: ["src/a.ts"], blockedBy: [] },
      { id: "BLK-2", title: "B", status: "blocked", priority: "high", files: ["src/a.ts"], blockedBy: ["BLK-1"] },
    ];
    const graph = deriveWorkGraph([file("src/a.ts", 0, 0)], tickets);
    expect(graph.displayEdges.filter((edge) => edge.kind === "ticket_blocked")).toHaveLength(1);
    expect(graph.displayEdges.filter((edge) => edge.kind === "ticket_overlap")).toHaveLength(1);
  });

  it("keeps unlocated work visible in the gutter and excludes closed tickets", () => {
    const graph = deriveWorkGraph([file("src/a.ts", 10, 20)], [
      { id: "BLK-1", title: "Unlocated", status: "triage", priority: "low", files: [], blockedBy: [] },
      { id: "BLK-2", title: "Done", status: "done", priority: "high", files: ["src/a.ts"], blockedBy: [] },
    ]);
    expect(graph.displayNodes.find((node) => node.id === "ticket:BLK-1")?.x).toBeGreaterThan(10);
    expect(graph.displayNodes.some((node) => node.id === "ticket:BLK-2")).toBe(false);
  });
});
