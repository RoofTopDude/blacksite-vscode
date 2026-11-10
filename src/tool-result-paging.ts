/**
 * Pure logic backing the agent's ability to page back into a tool result that was too
 * large to send to the model in full.
 *
 * Before this existed, a huge tool_result (a giant file read, a verbose build log, a
 * large query result) went to the model completely unbounded, or — once context got
 * critical — was destructively elided by `_emergencyTruncateOldestToolResults` with no
 * way to recover it short of re-running the tool. This module caps a result at
 * creation time, keeps the original recoverable, and lets the agent request more of it
 * by exact character offset via the `tool_output_page` tool (see agent-session.ts).
 *
 * Improves on an earlier "increase truncateResultLength and re-fetch from the start"
 * design: instead of always re-reading from byte zero, the agent seeks directly to
 * wherever it left off, and every page boundary snaps to a line break so paged text
 * never starts or ends mid-line.
 *
 * The content this operates on is always `JSON.stringify(result)` — a real newline
 * inside that text is never a literal newline byte, it's the two-character escape
 * sequence backslash-n. Snapping on `JSON_ESCAPED_NEWLINE` rather than a literal "\n"
 * is what makes cuts land between JSON-escaped source lines instead of at an arbitrary
 * byte offset. (A capped/paged slice is not itself valid JSON — it's a deliberately
 * truncated fragment — so this is about readable cut points, not JSON well-formedness.)
 */

export const DEFAULT_PAGE_CHAR_LIMIT = 20_000;
export const JSON_ESCAPED_NEWLINE = "\\n";
export const SIGNAL_KEYWORDS = ["error", "exception", "fail", "fatal", "warning"] as const;

export interface CappedToolResult {
  /** What to actually send to the model — the original content, or a capped prefix + a paging notice. */
  content: string;
  /** True when `content` was capped and the original should be retained for later paging. */
  overflowed: boolean;
}

export interface ResultSignals {
  lineCount: number;
  /** Case-insensitive substring hit counts for SIGNAL_KEYWORDS; zero-hit keywords are omitted. */
  keywordHits: Partial<Record<typeof SIGNAL_KEYWORDS[number], number>>;
}

export interface ResultPage {
  content: string;
  /** Start offset actually used (after clamping). */
  offset: number;
  /** End offset actually used (after boundary snapping). */
  end: number;
  totalLength: number;
  hasMore: boolean;
  /** Offset to pass next to continue reading, or null once exhausted. */
  nextOffset: number | null;
}

/**
 * Chooses where to end a slice at-or-before `rawEnd`, snapping backward to the nearest
 * occurrence of `boundary` so a cut doesn't split a line (or, for JSON-escaped text, an
 * escape sequence) in half. Falls back to `rawEnd` verbatim when no boundary occurrence
 * falls within `lookback` characters (e.g. minified content or one huge line/field) or
 * when snapping wouldn't leave any forward progress past `start`.
 */
export function snapToLineEnd(text: string, start: number, rawEnd: number, boundary = "\n", lookback = 500): number {
  if (rawEnd >= text.length) return rawEnd;
  // searchFloor is already >= start, so finding a boundary at/after it guarantees forward progress.
  const searchFloor = Math.max(start, rawEnd - lookback);
  const lastBoundary = text.lastIndexOf(boundary, rawEnd - 1);
  return lastBoundary >= searchFloor ? lastBoundary + boundary.length : rawEnd;
}

/**
 * Cheap, generic orientation signal for the hidden remainder of a truncated result —
 * computed over the FULL content, not just the visible capped prefix, since the point
 * is to hint at what paging/searching further would actually find. Keyword counting
 * needs no boundary-awareness: JSON escaping only affects structural characters like
 * newlines, never alphabetic content, so "error" inside a JSON string value still
 * matches as a plain substring.
 */
export function summarizeSignals(content: string, boundary = "\n"): ResultSignals {
  let lineCount = 1;
  let searchFrom = 0;
  for (;;) {
    const idx = content.indexOf(boundary, searchFrom);
    if (idx === -1) break;
    lineCount += 1;
    searchFrom = idx + boundary.length;
  }
  const lower = content.toLowerCase();
  const keywordHits: ResultSignals["keywordHits"] = {};
  for (const keyword of SIGNAL_KEYWORDS) {
    let count = 0;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(keyword, from);
      if (idx === -1) break;
      count += 1;
      from = idx + keyword.length;
    }
    if (count > 0) keywordHits[keyword] = count;
  }
  return { lineCount, keywordHits };
}

/**
 * Caps `content` to `ceiling` characters for the model-facing tool_result. Content
 * within the ceiling passes through unchanged. Content over the ceiling is cut at a
 * boundary and gets a notice telling the model exactly how to read the rest — the id
 * it already has (its own tool_use id) and the offset to resume from — plus a cheap
 * signal about what the hidden remainder contains, so the model can decide whether to
 * page forward or search for something specific instead.
 */
export function capToolResult(content: string, toolCallId: string, ceiling = DEFAULT_PAGE_CHAR_LIMIT, boundary = "\n"): CappedToolResult {
  if (content.length <= ceiling) return { content, overflowed: false };
  const end = snapToLineEnd(content, 0, ceiling, boundary);
  const remaining = content.length - end;
  const { lineCount, keywordHits } = summarizeSignals(content, boundary);
  const hits = Object.entries(keywordHits) as [string, number][];
  const signalClause = hits.length
    ? ` ~${lineCount.toLocaleString()} lines total; contains ${hits.map(([k, n]) => `"${k}" (${n})`).join(", ")}.`
    : ` ~${lineCount.toLocaleString()} lines total.`;
  const notice = `\n\n[Output truncated at ${end.toLocaleString()} of ${content.length.toLocaleString()} characters — `
    + `${remaining.toLocaleString()} remain.${signalClause} Call tool_output_page with toolCallId "${toolCallId}" `
    + `and offset ${end} to continue reading, or tool_output_search with a pattern to jump to specific content.]`;
  return { content: content.slice(0, end) + notice, overflowed: true };
}

const FAILURE_LINE = /error|exception|fail|fatal|panic|traceback/i;

/**
 * Caps `content` keeping its start, its end, and the lines in between that mention a failure
 * (Phase 3.6 of the context-economy plan). A build log's verdict and a stack trace's cause are
 * usually at the end or scattered in the middle, which a head-only cut drops. The archive holds the
 * full text, so the notice says how to read the middle by offset.
 *
 * Shares `capToolResult`'s contract: content within the ceiling passes through unchanged, and
 * `overflowed` is true otherwise. Falls back to a head-only cut when the ceiling is too small to
 * keep both ends.
 */
export function capToolResultKeepingEnds(content: string, toolCallId: string, ceiling: number, boundary = "\n"): CappedToolResult {
  if (content.length <= ceiling) return { content, overflowed: false };
  const headEnd = snapToLineEnd(content, 0, Math.floor(ceiling * 0.6), boundary);
  const tailBudget = Math.floor(ceiling * 0.25);
  let tailStart = content.length - tailBudget;
  const nextBoundary = content.indexOf(boundary, tailStart);
  if (nextBoundary !== -1 && nextBoundary - tailStart < 500 && nextBoundary + boundary.length < content.length) {
    tailStart = nextBoundary + boundary.length;
  }
  // Below about a thousand characters the markers alone crowd out the content.
  if (ceiling < 1_000 || tailStart <= headEnd) return capToolResult(content, toolCallId, ceiling, boundary);

  const middle = content.slice(headEnd, tailStart);
  const middleLines = middle.split(boundary);
  const signalBudget = Math.max(0, ceiling - headEnd - (content.length - tailStart));
  const signalLines: string[] = [];
  let failures = 0;
  let used = 0;
  for (const line of middleLines) {
    if (!FAILURE_LINE.test(line)) continue;
    failures += 1;
    const clipped = line.length > 300 ? `${line.slice(0, 299)}…` : line;
    if (used + clipped.length + boundary.length > signalBudget) continue;
    signalLines.push(clipped);
    used += clipped.length + boundary.length;
  }
  const shownFailures = signalLines.length
    ? `${signalLines.length} of the ${failures} lines there that mention an error or failure follow.`
    : failures
      ? `${failures} lines there mention an error or failure; none fit.`
      : "No line there mentions an error or failure.";
  const omitted = `[… ${middle.length.toLocaleString()} characters (${middleLines.length.toLocaleString()} lines) omitted from the middle. ${shownFailures}]`;
  const body = [
    content.slice(0, headEnd),
    omitted,
    ...(signalLines.length ? [...signalLines, "[… end of the lines from the middle …]"] : []),
    content.slice(tailStart),
  ].join(boundary);
  const notice = `\n\n[Output shortened from ${content.length.toLocaleString()} characters: the start, the end, and lines from the middle `
    + `that mention an error. Call tool_output_page with toolCallId "${toolCallId}" and offset ${headEnd} to read the middle, `
    + "or tool_output_search with a pattern to jump to specific content.]";
  return { content: body + notice, overflowed: true };
}

/**
 * Slices `fullText` for a page request. The end always snaps to `boundary`, and
 * `nextOffset` reports that exact snapped position — so chaining page requests with
 * `nextOffset` reconstructs the original text losslessly, with no gaps or duplicated
 * content between pages.
 */
export function pageResult(fullText: string, offset: number, limit = DEFAULT_PAGE_CHAR_LIMIT, boundary = "\n"): ResultPage {
  const start = Math.max(0, Math.min(offset, fullText.length));
  const rawEnd = Math.min(fullText.length, start + Math.max(1, limit));
  const end = snapToLineEnd(fullText, start, rawEnd, boundary);
  const hasMore = end < fullText.length;
  return {
    content: fullText.slice(start, end),
    offset: start,
    end,
    totalLength: fullText.length,
    hasMore,
    nextOffset: hasMore ? end : null,
  };
}

export interface SearchMatch {
  /** 1-based index among boundary-delimited lines of the full text. */
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchResult {
  totalMatches: number;
  matches: SearchMatch[];
  /** True when totalMatches exceeds the returned matches — a tighter pattern would help. */
  truncated: boolean;
}

/**
 * Finds lines containing `pattern` (case-insensitive substring — not regex, deliberately:
 * covers "find the line with AssertionError" with zero ReDoS surface and no invalid-pattern
 * case to design around) within `fullText`, splitting on `boundary` the same way
 * `pageResult`/`capToolResult` do. Mirrors a `grep -i -C` mental model.
 */
export function searchResult(
  fullText: string,
  pattern: string,
  options?: { contextLines?: number; maxMatches?: number; boundary?: string },
): SearchResult {
  const boundary = options?.boundary ?? "\n";
  const contextLines = Math.min(Math.max(Math.floor(options?.contextLines ?? 2), 0), 10);
  const maxMatches = Math.min(Math.max(Math.floor(options?.maxMatches ?? 20), 1), 50);

  const lines = fullText.split(boundary);
  const needle = pattern.toLowerCase();
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.toLowerCase().includes(needle)) continue;
    totalMatches += 1;
    if (matches.length >= maxMatches) continue;
    matches.push({
      lineNumber: i + 1,
      line: lines[i]!,
      contextBefore: lines.slice(Math.max(0, i - contextLines), i),
      contextAfter: lines.slice(i + 1, i + 1 + contextLines),
    });
  }

  return { totalMatches, matches, truncated: totalMatches > matches.length };
}
