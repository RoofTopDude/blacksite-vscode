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

export interface CappedToolResult {
  /** What to actually send to the model — the original content, or a capped prefix + a paging notice. */
  content: string;
  /** True when `content` was capped and the original should be retained for later paging. */
  overflowed: boolean;
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
 * Caps `content` to `ceiling` characters for the model-facing tool_result. Content
 * within the ceiling passes through unchanged. Content over the ceiling is cut at a
 * boundary and gets a notice telling the model exactly how to read the rest — the id
 * it already has (its own tool_use id) and the offset to resume from.
 */
export function capToolResult(content: string, toolCallId: string, ceiling = DEFAULT_PAGE_CHAR_LIMIT, boundary = "\n"): CappedToolResult {
  if (content.length <= ceiling) return { content, overflowed: false };
  const end = snapToLineEnd(content, 0, ceiling, boundary);
  const remaining = content.length - end;
  const notice = `\n\n[Output truncated at ${end.toLocaleString()} of ${content.length.toLocaleString()} characters — `
    + `${remaining.toLocaleString()} remain. Call tool_output_page with toolCallId "${toolCallId}" and offset ${end} to continue reading.]`;
  return { content: content.slice(0, end) + notice, overflowed: true };
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
