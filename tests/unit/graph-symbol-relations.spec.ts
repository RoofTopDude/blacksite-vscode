import { describe, expect, it } from "vitest";
import { relationsForKind, symbolEdgeKey } from "../../src/graph/symbol-relations.js";

describe("relationsForKind", () => {
  it("gives callables a call relation", () => {
    expect(relationsForKind("function")).toEqual(["call"]);
    expect(relationsForKind("method")).toEqual(["call"]);
    expect(relationsForKind("constructor")).toEqual(["call"]);
  });

  it("gives types an inheritance relation", () => {
    expect(relationsForKind("class")).toEqual(["extends"]);
    expect(relationsForKind("interface")).toEqual(["extends"]);
    expect(relationsForKind("struct")).toEqual(["extends"]);
    expect(relationsForKind("enum")).toEqual(["extends"]);
  });

  it("is case-insensitive and empty for other kinds", () => {
    expect(relationsForKind("Function")).toEqual(["call"]);
    expect(relationsForKind("variable")).toEqual([]);
    expect(relationsForKind("property")).toEqual([]);
  });
});

describe("symbolEdgeKey", () => {
  it("is stable and distinguishes relation and target", () => {
    const a = symbolEdgeKey("a.ts#f@1", "b.ts", "call", "g");
    expect(a).toBe(symbolEdgeKey("a.ts#f@1", "b.ts", "call", "g"));
    expect(a).not.toBe(symbolEdgeKey("a.ts#f@1", "b.ts", "reference", "g"));
    expect(a).not.toBe(symbolEdgeKey("a.ts#f@1", "c.ts", "call", "g"));
  });

  it("treats a missing target symbol as empty", () => {
    expect(symbolEdgeKey("a.ts#f@1", "b.ts", "reference")).toBe("a.ts#f@1|reference|b.ts|");
  });
});
