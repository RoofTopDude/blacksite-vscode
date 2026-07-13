/* Detects and strips a line-number "gutter" from a block of text.
 *
 * Models routinely reconstruct a snippet from a numbered source — a `file_read` with
 * lineNumbers on, a `file_search` hit ("src/a.ts:42: const x = 1"), a paged tool_output dump,
 * or an editor gutter in something the user pasted — and then send it back as `file_edit`'s
 * `oldString`. That string can never match the file, because the numbers aren't in the file.
 * The result is a "oldString was not found" failure that costs a turn and, worse, tempts the
 * model into re-reading and retrying the same doomed edit.
 *
 * This module is deliberately pure and conservative. It never guesses: a caller is expected to
 * verify the stripped candidate against real file content before acting on it (see
 * resolveOldString in diff-edit-service.ts), so a false positive is inert rather than
 * destructive. That verification is what makes it safe to accept the `:` separator at all —
 * on its own, `1: 'one',` is indistinguishable from an object literal with numeric keys.
 */

/** Separator forms a line-number gutter actually takes in the wild. Ordered most- to
 *  least-specific. Notably absent: `.` (would swallow "1. First" in a Markdown list) and bare
 *  whitespace (far too common in ordinary code to be a safe signal). */
const GUTTER_PATTERNS: RegExp[] = [
  /^[ \t]*(\d+)\t(.*)$/,            // cat -n, and file_read's own lineNumbers format
  /^[ \t]*(\d+)[ \t]*[:|│┃][ \t]?(.*)$/, // grep-style "42: text", editor gutters "42 | text"
];

/**
 * Strip a line-number gutter from `text`, or return null when `text` doesn't uniformly look
 * like one. Requires every line to carry the same separator form and the numbers to run
 * consecutively (n, n+1, n+2 …) — a real gutter always counts, whereas incidental content that
 * happens to start with a digit does not.
 */
export function stripLineNumberGutter(text: string): string | null {
  if (!text) return null;

  const hadTrailingNewline = text.endsWith("\n");
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length === 0) return null;

  // Lock onto whichever form the first line uses, then require every other line to match it.
  // A mix of separators means this is ordinary content, not a machine-emitted gutter.
  const pattern = GUTTER_PATTERNS.find((candidate) => candidate.test(lines[0]!));
  if (!pattern) return null;

  const stripped: string[] = [];
  let previous: number | null = null;
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) return null;
    const lineNo = Number(match[1]);
    if (!Number.isSafeInteger(lineNo)) return null;
    if (previous !== null && lineNo !== previous + 1) return null;
    previous = lineNo;
    stripped.push(match[2]!);
  }

  // Refuse to "strip" a block into nothing — that's a sign the match was spurious, and an empty
  // oldString is meaningless to the caller anyway.
  if (stripped.every((line) => line.trim() === "")) return null;

  const result = stripped.join("\n");
  return hadTrailingNewline ? `${result}\n` : result;
}
