import { describe, expect, it } from "vitest";
import { selectNonOverlappingLabels } from "../../src/webview/react/lib/graph/labels.js";

describe("screen-space graph label allocation", () => {
  const bounds = { width: 400, height: 260 };

  it("keeps the higher-priority label when projected rectangles collide", () => {
    const selected = selectNonOverlappingLabels([
      { value: "subgroup", x: 100, y: 80, width: 100, height: 24, priority: 1 },
      { value: "territory", x: 110, y: 84, width: 120, height: 30, priority: 10 },
    ], bounds);
    expect(selected.map((label) => label.value)).toEqual(["territory"]);
  });

  it("honors reserved UI regions and viewport bounds", () => {
    const selected = selectNonOverlappingLabels([
      { value: "under-controls", x: 10, y: 10, width: 80, height: 20, priority: 3 },
      { value: "outside", x: 390, y: 40, width: 30, height: 20, priority: 3 },
      { value: "clear", x: 180, y: 120, width: 70, height: 20, priority: 3 },
    ], bounds, [{ x: 0, y: 0, width: 120, height: 100 }]);
    expect(selected.map((label) => label.value)).toEqual(["clear"]);
  });

  it("is deterministic for equal priorities and returns input order", () => {
    const candidates = [
      { value: "first", x: 60, y: 80, width: 80, height: 20, priority: 2 },
      { value: "blocked", x: 70, y: 80, width: 80, height: 20, priority: 2 },
      { value: "third", x: 250, y: 160, width: 80, height: 20, priority: 2 },
    ];
    const first = selectNonOverlappingLabels(candidates, bounds);
    const second = selectNonOverlappingLabels(candidates, bounds);
    expect(first.map((label) => label.value)).toEqual(["first", "third"]);
    expect(second).toEqual(first);
  });
});
