import { describe, expect, it } from "vitest";
import { compactDiff } from "../../src/diff-preview.js";

const lines = (count: number, prefix = "line"): string => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("compactDiff", () => {
  it("shows a one-line change with its neighbours and says how much it skipped", () => {
    const before = lines(40);
    const after = before.replace("line 20", "line twenty");
    const diff = compactDiff("a.ts", before, after);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    const shown = diff.lines.map((entry) => `${entry.kind}:${entry.text}`);
    expect(shown).toEqual([
      "skip:17 unchanged lines",
      "context:line 18", "context:line 19",
      "del:line 20", "add:line twenty",
      "context:line 21", "context:line 22",
      "skip:18 unchanged lines",
    ]);
    expect(diff.lines.find((entry) => entry.kind === "add")?.line).toBe(20);
    expect(diff.truncated).toBe(false);
  });

  it("interleaves changes that are close together, and collapses the long run between distant ones", () => {
    const before = lines(60);
    const after = before.replace("line 5\n", "line five\n").replace("line 50\n", "line fifty\n");
    const diff = compactDiff("a.ts", before, after);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
    expect(diff.lines.some((entry) => entry.kind === "skip" && /unchanged lines/.test(entry.text))).toBe(true);
    // The unchanged middle is not printed.
    expect(diff.lines.some((entry) => entry.text === "line 25")).toBe(false);
  });

  it("describes a new file as additions only", () => {
    const diff = compactDiff("new.ts", "", "export const a = 1;\nexport const b = 2;\n");
    expect(diff.created).toBe(true);
    expect(diff.deletions).toBe(0);
    expect(diff.additions).toBe(3);
    expect(diff.lines.every((entry) => entry.kind === "add")).toBe(true);
  });

  it("describes a removed file as deletions only", () => {
    const diff = compactDiff("gone.ts", "a\nb\n", "");
    expect(diff.deleted).toBe(true);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(3);
  });

  it("caps what it shows and says how many more lines the change has", () => {
    const diff = compactDiff("big.ts", lines(5), lines(400, "new"), { maxLines: 20 });
    expect(diff.truncated).toBe(true);
    expect(diff.lines).toHaveLength(21);
    expect(diff.lines.at(-1)!.kind).toBe("skip");
    expect(diff.lines.at(-1)!.text).toMatch(/more lines in this change/);
  });

  it("treats a change in line endings only as no change", () => {
    const diff = compactDiff("eol.ts", "a\r\nb\r\n", "a\nb\n");
    expect(diff.additions + diff.deletions).toBe(0);
    expect(diff.lines).toEqual([]);
  });

  it("clips very long lines instead of filling the card", () => {
    const diff = compactDiff("long.ts", "x", "y".repeat(5000));
    const added = diff.lines.find((entry) => entry.kind === "add")!;
    expect(added.text.length).toBeLessThanOrEqual(200);
  });

  it("copes with a large rewrite by showing removed lines then added ones, not stalling", () => {
    const started = Date.now();
    const diff = compactDiff("rewrite.ts", lines(2000, "old"), lines(2000, "new"), { maxLines: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff.additions).toBe(2000);
    expect(diff.deletions).toBe(2000);
  });
});
