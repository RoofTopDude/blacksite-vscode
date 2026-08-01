/**
 * Publishing the design system's vocabulary to the agent.
 *
 * Bridging the stylesheet into previews only helps if the agent knows which classes and tokens
 * exist. Guessing produces markup that renders unstyled — indistinguishable from a low-effort
 * preview — so without a reliable inventory the safe move is hand-written CSS, which is the
 * behaviour this is meant to eliminate.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DIGEST_LIMITS, buildDesignDigest } from "../../src/preview-design-digest.js";

const SHEET = `
:root {
  --background: #0b0b0f;
  --foreground: #e6e6e6;
  --muted-foreground: #9a9a9a;
  --font-sans: 'Lexend', system-ui, sans-serif;
  --font-mono: 'Cascadia Code', monospace;
  --radius: 8px;
}
.board-card { border-radius: var(--radius); }
.board-card-title { font-weight: 600; }
.board-column-head { display: flex; }
.chat-surface { background: var(--background); }
.chat-interactive { cursor: pointer; }
.flex { display: flex; }
.hidden { display: none; }
.px-2 { padding-inline: 0.5rem; }
.text-sm { font-size: 11px; }
.text-muted-foreground { color: var(--muted-foreground); }
`;

const digest = () => buildDesignDigest(SHEET, "workspace");

describe("buildDesignDigest", () => {
  it("carries the origin through, so the agent knows whose design system it is using", () => {
    expect(digest().origin).toBe("workspace");
  });

  it("extracts tokens with their resolved values", () => {
    const colors = digest().tokens.flatMap((group) => group.tokens);
    expect(colors).toContainEqual({ name: "background", value: "#0b0b0f" });
    expect(colors).toContainEqual({ name: "radius", value: "8px" });
  });

  it("groups tokens by their leading segment so related ones arrive together", () => {
    const fontGroup = digest().tokens.find((group) => group.group === "font");
    expect(fontGroup?.tokens.map((t) => t.name).sort()).toEqual(["font-mono", "font-sans"]);
  });

  /** These are the names a preview must use verbatim; a component missing from this list is a
   *  preview that renders unstyled. */
  it("lists project component classes, grouped by prefix", () => {
    const board = digest().components.find((group) => group.prefix === "board");
    expect(board?.classes).toEqual(expect.arrayContaining(["board-card", "board-card-title", "board-column-head"]));
  });

  it("separates utilities from components rather than drowning the list in them", () => {
    const componentClasses = digest().components.flatMap((group) => group.classes);
    expect(componentClasses).toContain("chat-surface");
    expect(componentClasses).not.toContain("flex");
    expect(componentClasses).not.toContain("px-2");
    expect(componentClasses).not.toContain("text-sm");
  });

  /** Erring toward "component" is deliberate: a stray utility in the list is noise, a missing
   *  component is a broken preview. But a two-segment token utility is unambiguous. */
  it("treats token-bound utilities like text-muted-foreground as utilities", () => {
    expect(digest().components.flatMap((g) => g.classes)).not.toContain("text-muted-foreground");
  });

  it("summarises utility families instead of enumerating an open-ended vocabulary", () => {
    expect(digest().utilityFamilies).toEqual(expect.arrayContaining(["px", "text"]));
  });

  it("surfaces the font stacks, so a preview inherits the product's typography", () => {
    expect(digest().fontStacks.join(" ")).toContain("Lexend");
  });

  it("reports totals covering the whole sheet, not just what was returned", () => {
    const { totals } = digest();
    expect(totals.tokens).toBe(6);
    expect(totals.components).toBeGreaterThan(0);
    expect(totals.utilities).toBeGreaterThan(0);
    expect(totals.bytes).toBe(SHEET.length);
  });

  it("flags nothing as truncated when everything fits", () => {
    expect(digest().truncated).toBe(false);
  });

  /** Silently truncating would make the agent conclude a class does not exist and hand-roll it. */
  it("flags truncation when the component list is capped", () => {
    const many = Array.from({ length: 50 }, (_, i) => `.widget-part-${i} { color: red; }`).join("\n");
    const result = buildDesignDigest(many, "workspace", { ...DEFAULT_DIGEST_LIMITS, maxComponents: 10 });
    expect(result.truncated).toBe(true);
    expect(result.components.flatMap((g) => g.classes).length).toBeLessThanOrEqual(10);
    expect(result.totals.components).toBe(50);
  });

  it("caps each group so one large family cannot crowd out every other", () => {
    const many = Array.from({ length: 30 }, (_, i) => `.big-thing-${i}{}`).join("\n")
      + "\n.small-thing{}";
    const result = buildDesignDigest(many, "workspace", { ...DEFAULT_DIGEST_LIMITS, maxPerGroup: 5 });
    expect(result.components.find((g) => g.prefix === "big")?.classes).toHaveLength(5);
    expect(result.components.find((g) => g.prefix === "small")).toBeDefined();
  });

  /**
   * Spending the budget group-by-group made the ten largest families consume every slot on the
   * real stylesheet, so whole families disappeared and an agent looking one up would conclude it
   * did not exist and hand-roll CSS instead.
   */
  it("lists every family even when the budget forces a thin sample of each", () => {
    const css = Array.from({ length: 40 }, (_, group) =>
      Array.from({ length: 20 }, (_, member) => `.fam${group}-part-${member}{}`).join("\n")).join("\n");
    const result = buildDesignDigest(css, "workspace", { ...DEFAULT_DIGEST_LIMITS, maxComponents: 100 });
    expect(result.components).toHaveLength(40);
    for (const group of result.components) expect(group.classes.length).toBeGreaterThan(0);
  });

  it("reports each group's true size, so a sample never reads as the whole family", () => {
    const css = Array.from({ length: 30 }, (_, i) => `.widget-part-${i}{}`).join("\n");
    const result = buildDesignDigest(css, "workspace", { ...DEFAULT_DIGEST_LIMITS, maxPerGroup: 4 });
    const group = result.components.find((g) => g.prefix === "widget");
    expect(group?.classes).toHaveLength(4);
    expect(group?.total).toBe(30);
  });

  it("flags truncation when a group was sampled, not only when the global cap bit", () => {
    const css = Array.from({ length: 30 }, (_, i) => `.widget-part-${i}{}`).join("\n");
    expect(buildDesignDigest(css, "workspace", { ...DEFAULT_DIGEST_LIMITS, maxPerGroup: 4 }).truncated).toBe(true);
  });

  it("ranks the largest families first, where the reusable vocabulary tends to be", () => {
    const groups = digest().components.map((g) => g.prefix);
    expect(groups.indexOf("board")).toBeLessThan(groups.indexOf("chat"));
  });

  it("keeps the last declaration of a redeclared token, mirroring the cascade", () => {
    const result = buildDesignDigest(":root{--x:1px}\n.dark{--x:2px}", "workspace");
    expect(result.tokens.flatMap((g) => g.tokens)).toContainEqual({ name: "x", value: "2px" });
  });

  it("truncates a pathologically long token value rather than returning the whole sheet inline", () => {
    const long = `:root{--gradient:${"a".repeat(400)}}`;
    const value = buildDesignDigest(long, "workspace").tokens.flatMap((g) => g.tokens)[0]?.value ?? "";
    expect(value.length).toBeLessThanOrEqual(120);
    expect(value.endsWith("...")).toBe(true);
  });

  it("survives an empty stylesheet without inventing an inventory", () => {
    const result = buildDesignDigest("", "none");
    expect(result.components).toEqual([]);
    expect(result.tokens).toEqual([]);
    expect(result.totals.tokens).toBe(0);
  });
});
