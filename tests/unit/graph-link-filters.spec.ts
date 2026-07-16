/* Color-coded link-type filters (file lens): the shared edgeKindVisible
   predicate must gate each relationship family independently, and the chip
   counts must reflect the actual edge set. */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_OPTIONS,
  edgeKindVisible,
  linkKindCounts,
  type GraphDisplayOptions,
} from "@/lib/graph/view-model";
import type { GraphEdge } from "@/lib/graph/protocol";

const edge = (id: string, kind: GraphEdge["kind"]): GraphEdge => ({ id, from: "a.ts", to: "b.ts", kind });

describe("edgeKindVisible", () => {
  it("shows every kind under the defaults", () => {
    const kinds: GraphEdge["kind"][] = ["import", "call", "reference", "supertype", "api", "event", "data", "config", "ai", "user"];
    for (const kind of kinds) {
      expect(edgeKindVisible(kind, DEFAULT_DISPLAY_OPTIONS)).toBe(true);
    }
  });

  it("gates each symbol-sweep family independently instead of riding showImports", () => {
    const display: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showImports: false };
    expect(edgeKindVisible("import", display)).toBe(false);
    expect(edgeKindVisible("call", display)).toBe(true);
    expect(edgeKindVisible("reference", display)).toBe(true);
    expect(edgeKindVisible("supertype", display)).toBe(true);

    const callsOff: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showCalls: false };
    expect(edgeKindVisible("call", callsOff)).toBe(false);
    expect(edgeKindVisible("import", callsOff)).toBe(true);

    const refsOff: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showRefs: false };
    expect(edgeKindVisible("reference", refsOff)).toBe(false);
    expect(edgeKindVisible("supertype", refsOff)).toBe(true);

    const inheritanceOff: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showInheritance: false };
    expect(edgeKindVisible("supertype", inheritanceOff)).toBe(false);
  });

  it("maps note kinds (ai/user) onto showAnnotations and service kinds onto their toggles", () => {
    const notesOff: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showAnnotations: false };
    expect(edgeKindVisible("ai", notesOff)).toBe(false);
    expect(edgeKindVisible("user", notesOff)).toBe(false);

    const apiOff: GraphDisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS, showApi: false };
    expect(edgeKindVisible("api", apiOff)).toBe(false);
    expect(edgeKindVisible("event", apiOff)).toBe(true);
  });
});

describe("linkKindCounts", () => {
  it("tallies edges per kind for the filter chips", () => {
    const counts = linkKindCounts([
      edge("1", "import"),
      edge("2", "import"),
      edge("3", "call"),
      edge("4", "reference"),
      edge("5", "supertype"),
      edge("6", "reference"),
    ]);
    expect(counts.import).toBe(2);
    expect(counts.call).toBe(1);
    expect(counts.reference).toBe(2);
    expect(counts.supertype).toBe(1);
    expect(counts.api).toBeUndefined();
  });

  it("returns an empty record for no edges", () => {
    expect(linkKindCounts([])).toEqual({});
  });
});
