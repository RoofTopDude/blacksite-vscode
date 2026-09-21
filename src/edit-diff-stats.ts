/* Pure helpers behind the reviewable-diff journal (src/edit-diff-journal.ts).

   Kept vscode-free on purpose: the journal itself can only be exercised inside a real
   extension host, but the two decisions that actually carry risk — which files a tool call
   is about to change, and where in a file the change starts — are plain string work and are
   unit-tested directly. */

import { activityToTraces } from "./graph/trace-extract.js";

export type ToolDiffKind = "created" | "modified" | "deleted";

/** One reviewable file change produced by a single tool call. Travels on the tool-result
 *  event so the transcript row can offer "open the diff" without asking the host first. */
export interface ToolDiffSummary {
  /** Workspace-relative path, as the journal keyed it. */
  path: string;
  additions: number;
  deletions: number;
  kind: ToolDiffKind;
  /** 1-based line where the change starts, so opening the diff can land on it instead of
   *  line 1 of a 4000-line file. 0 when there is no line to point at (a whole-file create
   *  or delete). */
  line: number;
}

export interface LineDiffStats {
  additions: number;
  deletions: number;
  /** 1-based first line that differs, or 0 when the two texts are identical. */
  firstChangedLine: number;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Line impact of one text becoming another, by trimming the common prefix and suffix.
 *
 * This is deliberately not a real LCS diff: the number it produces feeds a "+12 −3" badge
 * and a jump-to-line, neither of which is worth a quadratic pass over a multi-megabyte file.
 * A scattered multi-hunk edit therefore reports the span between its outermost hunks rather
 * than the sum of the hunks — an overstatement, never an understatement, and the diff editor
 * the badge links to shows the exact truth.
 */
export function lineDiffStats(before: string, after: string): LineDiffStats {
  if (before === after) return { additions: 0, deletions: 0, firstChangedLine: 0 };
  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const additions = Math.max(newEnd - start + 1, 0);
  const deletions = Math.max(oldEnd - start + 1, 0);
  // Both zero means the texts differ only in line endings — the prefix scan consumed every
  // line, so `start` sits past the end and would point at a line nobody changed.
  if (additions === 0 && deletions === 0) return { additions: 0, deletions: 0, firstChangedLine: 0 };
  return {
    additions,
    deletions,
    // `start` is a 0-based index into the *new* text; +1 makes it the line the editor shows.
    // Clamped into the new file so a pure deletion at EOF can't point past its end.
    firstChangedLine: Math.min(start, Math.max(newLines.length - 1, 0)) + 1,
  };
}

/**
 * Workspace paths a tool call is about to write to, derived from its input alone.
 *
 * Input rather than result, because the journal has to read the "before" bytes *before* the
 * tool runs — by the time a result names the files it changed, the old content is gone. The
 * tool → path mapping is shared with the Codebase Map's activity traces so a new file tool
 * only has to be taught about paths in one place.
 *
 * A tool whose edits land in files its input never names (code_rename rewriting importers,
 * a code action fixing a sibling file) yields only the paths it does name. Those extra files
 * still appear in the transcript's change list; they just carry no diff, which is the honest
 * outcome — inventing a "before" for a file that was never snapshotted would be worse.
 */
export function diffTargetPaths(toolName: string, input: Record<string, unknown> | undefined): string[] {
  const seen = new Set<string>();
  for (const trace of activityToTraces(toolName, input)) {
    if (trace.kind !== "write" && trace.kind !== "edit") continue;
    seen.add(trace.path);
  }
  return [...seen];
}

/** Text the diff editor can render. A NUL byte means binary (an image, a compiled artifact),
 *  which VS Code's text diff cannot show and which no agent edit produces anyway. */
export function isDiffableText(content: string): boolean {
  return content.indexOf(String.fromCharCode(0)) === -1;
}

/** The change a before/after snapshot pair represents, or null when nothing changed —
 *  which is the common case for the read-adjacent paths a mutating tool also touches
 *  (a failed edit, a batch where only one of three files actually moved). */
export function summarizeSnapshotPair(
  path: string,
  before: string | null,
  after: string | null,
): ToolDiffSummary | null {
  if (before === null && after === null) return null;
  if (before === null) {
    return { path, additions: splitLines(after!).length, deletions: 0, kind: "created", line: 0 };
  }
  if (after === null) {
    return { path, additions: 0, deletions: splitLines(before).length, kind: "deleted", line: 0 };
  }
  if (before === after) return null;
  const stats = lineDiffStats(before, after);
  // A change only VS Code's diff would render as identical (line endings, a trailing-newline
  // normalization) is not worth offering as a review surface.
  if (stats.additions === 0 && stats.deletions === 0) return null;
  return { path, additions: stats.additions, deletions: stats.deletions, kind: "modified", line: stats.firstChangedLine };
}
