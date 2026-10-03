/* Editing a saved diagram in place.
 *
 * A diagram past a few dozen nodes costs more to rewrite than to change: the agent spends its
 * output re-typing every unchanged line, and every retyped line is a chance to drop or garble
 * one. These are the operations that let it touch only what changes — an exact-text
 * replacement, a line range, an insertion — applied together or not at all.
 *
 * Pure text, no filesystem and no vscode, so the rules are testable on their own.
 */

export const MAX_EDITS_PER_CALL = 60;
/** Lines returned by one diagram_read, so a large diagram is paged rather than dumped. */
export const READ_PAGE_LINES = 400;

/** One change. Which fields are present says which kind it is:
 *   - `find` + `replace`: replace the exact text (once, or every occurrence with `all`);
 *   - `fromLine` (+ `toLine`) + `replace`: replace those lines, inclusive; "" deletes them;
 *   - `afterLine` + `insert`: add lines after that line (0 puts them first). */
export interface DiagramEdit {
  find?: string;
  replace?: string;
  all?: boolean;
  fromLine?: number;
  toLine?: number;
  afterLine?: number;
  insert?: string;
}

export type EditOutcome =
  | { ok: true; source: string; summary: string[] }
  | { ok: false; error: string };

/** `\r\n` and lone `\r` folded to `\n`. */
function foldLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Source with line endings folded and no trailing blank lines. */
export function normalizeSource(text: string): string {
  return foldLineEndings(text).replace(/\n+$/, "");
}

/** Lines to splice in: one trailing newline is the end of the last line, not a blank one. */
function spliceLines(text: string): string[] {
  const folded = foldLineEndings(text);
  return (folded.endsWith("\n") ? folded.slice(0, -1) : folded).split("\n");
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index; at = source.indexOf("\n", at + 1)) line += 1;
  return line;
}

function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Apply `edits` in order, each against the result of the one before it (so line numbers refer
 *  to the diagram as the previous edit left it). Any failing edit fails the whole call and
 *  nothing is applied. */
export function applyDiagramEdits(original: string, edits: readonly DiagramEdit[]): EditOutcome {
  if (edits.length === 0) return { ok: false, error: "No edits were given." };
  if (edits.length > MAX_EDITS_PER_CALL) {
    return { ok: false, error: `At most ${MAX_EDITS_PER_CALL} edits per call; split this into more than one call.` };
  }

  let source = normalizeSource(original);
  const summary: string[] = [];

  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    const fail = (message: string): EditOutcome => ({ ok: false, error: `${label}: ${message} Nothing was changed.` });

    if (typeof edit.find === "string") {
      if (edit.find.length === 0) return fail("`find` is empty.");
      if (typeof edit.replace !== "string") return fail("`replace` is required with `find` (use \"\" to delete the text).");
      const find = foldLineEndings(edit.find);
      const at = occurrences(source, find);
      if (at.length === 0) {
        return fail("`find` text was not found. It must match the diagram exactly, including indentation; read the current lines with diagram_read.");
      }
      if (at.length > 1 && !edit.all) {
        const lines = at.slice(0, 8).map((position) => lineOf(source, position)).join(", ");
        return fail(`\`find\` matches ${at.length} places (lines ${lines}${at.length > 8 ? ", …" : ""}). Include more surrounding text to make it unique, or set \`all\` to replace every one.`);
      }
      const replacement = foldLineEndings(edit.replace);
      const firstLine = lineOf(source, at[0]!);
      source = at.length === 1
        ? source.slice(0, at[0]!) + replacement + source.slice(at[0]! + find.length)
        : source.split(find).join(replacement);
      summary.push(`${label}: replaced ${plural(at.length, "occurrence")}${at.length === 1 ? ` at line ${firstLine}` : ""}.`);
      continue;
    }

    const lines = source.split("\n");

    if (edit.fromLine !== undefined) {
      const from = wholeNumber(edit.fromLine);
      const to = wholeNumber(edit.toLine ?? edit.fromLine);
      if (from === undefined || to === undefined) return fail("`fromLine` and `toLine` must be whole numbers.");
      if (from < 1 || to < from || to > lines.length) {
        return fail(`lines ${from}–${to} are outside the diagram, which has ${plural(lines.length, "line")}.`);
      }
      if (typeof edit.replace !== "string") return fail("`replace` is required with `fromLine` (use \"\" to delete the lines).");
      const replacement = edit.replace === "" ? [] : spliceLines(edit.replace);
      lines.splice(from - 1, to - from + 1, ...replacement);
      source = lines.join("\n");
      summary.push(`${label}: replaced lines ${from}–${to} with ${plural(replacement.length, "line")}.`);
      continue;
    }

    if (edit.afterLine !== undefined) {
      const after = wholeNumber(edit.afterLine);
      if (after === undefined || after < 0 || after > lines.length) {
        return fail(`\`afterLine\` must be between 0 and ${lines.length}.`);
      }
      if (typeof edit.insert !== "string" || edit.insert === "") return fail("`insert` is required with `afterLine`.");
      const added = spliceLines(edit.insert);
      lines.splice(after, 0, ...added);
      source = lines.join("\n");
      summary.push(`${label}: inserted ${plural(added.length, "line")} after line ${after}.`);
      continue;
    }

    return fail("give `find` + `replace`, or `fromLine` + `replace`, or `afterLine` + `insert`.");
  }

  return { ok: true, source, summary };
}

/** Lines `from`..`to` (one-based, inclusive) of `source`, each prefixed with its number. */
export function numberedLines(source: string, from = 1, to?: number): { text: string; from: number; to: number; total: number } {
  const lines = normalizeSource(source).split("\n");
  const start = Math.max(1, Math.min(from, lines.length));
  const end = Math.min(lines.length, to ?? start + READ_PAGE_LINES - 1, start + READ_PAGE_LINES - 1);
  const width = String(end).length;
  const text = lines.slice(start - 1, end).map((line, at) => `${String(start + at).padStart(width)}  ${line}`).join("\n");
  return { text, from: start, to: end, total: lines.length };
}

/** A few numbered lines around `line`, for showing where an error is. */
export function excerptAround(source: string, line: number, radius = 2): string {
  return numberedLines(source, Math.max(1, line - radius), line + radius).text;
}

/** A file stem a diagram can be saved under: lowercase, dashed, no path separators. */
export function diagramFileName(name: string): string | undefined {
  const stem = name
    .trim()
    .replace(/\.(?:mmd|mermaid)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64)
    .replace(/[-._]+$/g, "");
  return stem ? `${stem}.mmd` : undefined;
}
