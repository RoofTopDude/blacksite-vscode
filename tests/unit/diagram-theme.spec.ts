import { describe, expect, it } from "vitest";
import {
  CATEGORICAL, INK, categorical, contrast, mermaidThemeCss, mermaidThemeVariables, mix, readableInk,
} from "../../src/shared/diagram-theme.js";

describe("colour arithmetic", () => {
  it("mixes between two colours", () => {
    expect(mix("#ffffff", "#000000", 0)).toBe("#000000");
    expect(mix("#ffffff", "#000000", 1)).toBe("#ffffff");
    expect(mix("#ff0000", "#000000", 0.5)).toBe("#800000");
  });

  it("measures WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#777777")).toBe(1);
  });

  it("picks the ink that reads better on a fill", () => {
    expect(readableInk("#ffffff")).toBe("#0d0d0f");
    expect(readableInk("#10101a")).toBe("#ffffff");
  });
});

describe("the categorical palette", () => {
  it("has eight slots in each theme, in the validated order", () => {
    expect(CATEGORICAL.dark).toHaveLength(8);
    expect(CATEGORICAL.light).toHaveLength(8);
    expect(CATEGORICAL.dark[0]).toBe("#3987e5");
    expect(CATEGORICAL.light[1]).toBe("#eb6834");
  });

  it("wraps only beyond the eighth slot", () => {
    expect(categorical("dark", 7)).toBe(CATEGORICAL.dark[7]);
    expect(categorical("dark", 8)).toBe(CATEGORICAL.dark[0]);
    expect(categorical("dark", -1)).toBe(CATEGORICAL.dark[7]);
  });

  it("separates every adjacent pair of series on its surface", () => {
    // The regression this guards: category colours derived from near-black tints came out
    // indistinguishable from each other and from the panel.
    for (const theme of ["dark", "light"] as const) {
      for (const colour of CATEGORICAL[theme]) expect(contrast(colour, INK[theme].surface)).toBeGreaterThan(2);
    }
  });
});

describe("mermaidThemeVariables", () => {
  it("names the category colours Mermaid would otherwise derive from near-black tints", () => {
    const dark = mermaidThemeVariables("dark");
    for (let i = 1; i <= 8; i += 1) expect(dark[`pie${i}`]).toBe(CATEGORICAL.dark[i - 1]);
    for (let i = 0; i < 8; i += 1) expect(dark[`cScale${i}`]).toBe(CATEGORICAL.dark[i]);
    expect(dark["venn1"]).toBe(CATEGORICAL.dark[0]);
    expect(dark["git2"]).toBe(CATEGORICAL.dark[2]);
    expect((dark["xyChart"] as { plotColorPalette: string }).plotColorPalette).toBe(CATEGORICAL.dark.join(","));
  });

  it("keeps the base flowchart colours, per theme", () => {
    expect(mermaidThemeVariables("dark")).toMatchObject({ darkMode: true, background: "#0d0d0f", primaryColor: "#1c1830" });
    expect(mermaidThemeVariables("light")).toMatchObject({ darkMode: false, background: "#ffffff" });
  });

  it("gives every label a readable ink on its slice", () => {
    for (const theme of ["dark", "light"] as const) {
      const variables = mermaidThemeVariables(theme);
      for (let i = 0; i < 8; i += 1) {
        expect(contrast(String(variables[`cScale${i}`]), String(variables[`cScaleLabel${i}`]))).toBeGreaterThan(3);
      }
    }
  });

  it("uses only literal hex or rgb colours, which is all Mermaid's colour maths parses", () => {
    const literal = (value: unknown): boolean => typeof value !== "string" || /^(#[0-9a-f]{3,8}|rgba?\(.+\)|\d+(\.\d+)?(px)?|[a-z0-9,#]+)$/i.test(value);
    const walk = (value: unknown): void => {
      if (value && typeof value === "object") for (const inner of Object.values(value)) walk(inner);
      else expect(literal(value), String(value)).toBe(true);
    };
    for (const theme of ["dark", "light"] as const) walk(mermaidThemeVariables(theme));
  });

  it("lifts Sankey's multiply blend on dark, where it would draw black ribbons", () => {
    expect(mermaidThemeCss("dark")).toContain("mix-blend-mode: normal");
    expect(mermaidThemeCss("light")).not.toContain("mix-blend-mode");
  });
});
