/**
 * A small, readable diff for an approval card.
 *
 * An edit approval used to be a sentence ("Apply changes to 3 files") and a row of editor tabs
 * opening behind the chat. This is what the card itself shows instead: for each file, the lines
 * that change with a little context, capped so a rewrite of a large file does not turn the card
 * into the file. It is a preview, not the review: the editor diff stays one click away.
 *
 * Pure and bounded. The changed region is found by trimming the common head and tail, and only
 * that region is compared line by line (a longest-common-subsequence over at most a few hundred
 * lines); a region too large for that is shown as the removed lines followed by the added ones.
 */

export type DiffPreviewKind = "context" | "add" | "del" | "skip";

export interface DiffPreviewLine {
  kind: DiffPreviewKind;
  text: string;
  /** 1-based line number in the new file for context and added lines. */
  line?: number;
}

export interface DiffPreview {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffPreviewLine[];
  /** More changed lines exist than are shown. */
  truncated: boolean;
  /** The file is new or empty before, or removed after. */
  created?: boolean;
  deleted?: boolean;
}

export interface DiffPreviewOptions {
  /** Unchanged lines kept around a change. */
  context?: number;
  /** Most lines shown in the preview, skip markers included. */
  maxLines?: number;
}

const MAX_LCS_LINES = 300;
const MAX_LINE_CHARS = 200;

function split(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

type Op = { kind: "context" | "add" | "del"; text: string; newLine?: number };

/** Edit script between two short line lists, by longest common subsequence. */
function lcsScript(a: string[], b: string[], firstNewLine: number): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: b[j]!, newLine: firstNewLine + j });
      i += 1; j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j]!, newLine: firstNewLine + j });
      j += 1;
    }
  }
  while (i < n) { ops.push({ kind: "del", text: a[i]! }); i += 1; }
  while (j < m) { ops.push({ kind: "add", text: b[j]!, newLine: firstNewLine + j }); j += 1; }
  return ops;
}

export function compactDiff(path: string, before: string, after: string, options: DiffPreviewOptions = {}): DiffPreview {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 36;
  const oldLines = split(before);
  const newLines = split(after);

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > head && newEnd > head && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }

  const oldMid = oldLines.slice(head, oldEnd);
  const newMid = newLines.slice(head, newEnd);
  const small = oldMid.length <= MAX_LCS_LINES && newMid.length <= MAX_LCS_LINES;
  const middle: Op[] = small
    ? lcsScript(oldMid, newMid, head + 1)
    : [
      ...oldMid.map((text): Op => ({ kind: "del", text })),
      ...newMid.map((text, index): Op => ({ kind: "add", text, newLine: head + 1 + index })),
    ];

  const additions = middle.filter((op) => op.kind === "add").length;
  const deletions = middle.filter((op) => op.kind === "del").length;
  const created = oldLines.length === 0 && newLines.length > 0;
  const deleted = newLines.length === 0 && oldLines.length > 0;
  if (additions === 0 && deletions === 0) return { path, additions: 0, deletions: 0, lines: [], truncated: false };

  // Context before and after the changed region, then collapse long unchanged runs inside it.
  const lead = oldLines.slice(Math.max(head - context, 0), head).map((text, index, all): Op => ({ kind: "context", text, newLine: head - all.length + index + 1 }));
  const trail = newLines.slice(newEnd, Math.min(newEnd + context, newLines.length)).map((text, index): Op => ({ kind: "context", text, newLine: newEnd + index + 1 }));
  const ops: Op[] = [...lead, ...middle, ...trail];

  const lines: DiffPreviewLine[] = [];
  let index = 0;
  if (head - lead.length > 0) lines.push({ kind: "skip", text: `${head - lead.length} unchanged line${head - lead.length === 1 ? "" : "s"}` });
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.kind === "context") {
      let end = index;
      while (end < ops.length && ops[end]!.kind === "context") end += 1;
      const run = ops.slice(index, end);
      // Only a run inside the change can be long: the context before and after it is at most
      // `context` lines, so it never reaches this size.
      if (run.length > context * 2 + 1) {
        for (const kept of run.slice(0, context)) lines.push({ kind: "context", text: clip(kept.text), line: kept.newLine });
        lines.push({ kind: "skip", text: `${run.length - context * 2} unchanged lines` });
        for (const kept of run.slice(run.length - context)) lines.push({ kind: "context", text: clip(kept.text), line: kept.newLine });
      } else {
        for (const kept of run) lines.push({ kind: "context", text: clip(kept.text), line: kept.newLine });
      }
      index = end;
    } else {
      lines.push({ kind: op.kind, text: clip(op.text), ...(op.newLine ? { line: op.newLine } : {}) });
      index += 1;
    }
  }
  const trailing = newLines.length - (newEnd + trail.length);
  if (trailing > 0) lines.push({ kind: "skip", text: `${trailing} unchanged line${trailing === 1 ? "" : "s"}` });

  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  if (truncated) shown.push({ kind: "skip", text: `${lines.length - maxLines} more lines in this change` });
  return { path, additions, deletions, lines: shown, truncated, ...(created ? { created } : {}), ...(deleted ? { deleted } : {}) };
}
