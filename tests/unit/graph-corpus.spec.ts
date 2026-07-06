import { describe, expect, it } from "vitest";
import { rankRelationshipEdges } from "../../src/graph/corpus.js";
import type { GraphEdge } from "../../src/graph/graph-model.js";

function edge(id: string, confidence: number): GraphEdge {
  return { id, from: "a", to: "b", kind: "api", confidence };
}

describe("rankRelationshipEdges", () => {
  it("returns every edge untruncated when the set fits the cap", () => {
    const edges = [edge("e1", 0.9), edge("e2", 0.5)];
    const result = rankRelationshipEdges(edges, 5);
    expect(result.truncated).toBe(false);
    expect(result.edges).toHaveLength(2);
  });

  it("keeps the highest-confidence edges when it must truncate", () => {
    const edges = [edge("low", 0.4), edge("high", 0.95), edge("mid", 0.7)];
    const result = rankRelationshipEdges(edges, 2);
    expect(result.truncated).toBe(true);
    expect(result.edges.map((e) => e.id)).toEqual(["high", "mid"]);
  });

  it("treats an Infinity cap as uncapped (the corpus build)", () => {
    const edges = [edge("e1", 0.9), edge("e2", 0.5)];
    const result = rankRelationshipEdges(edges, Infinity);
    expect(result.truncated).toBe(false);
    expect(result.edges).toHaveLength(2);
  });

  it("drops everything at a zero cap, reporting truncation", () => {
    const result = rankRelationshipEdges([edge("e1", 0.9)], 0);
    expect(result.edges).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("does not mutate the input order", () => {
    const edges = [edge("low", 0.4), edge("high", 0.95)];
    rankRelationshipEdges(edges, 1);
    expect(edges.map((e) => e.id)).toEqual(["low", "high"]);
  });
});
