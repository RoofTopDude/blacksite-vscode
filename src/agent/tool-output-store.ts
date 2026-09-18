/*
  Overflow store for oversized tool results.

  A tool result that exceeds the per-result character budget is truncated before it goes to
  the model, and the full text is kept here so `tool_output_page` and `tool_output_search`
  can serve the rest on request. Extracted from AgentSession, where it was four methods over
  one Map that touched no other session state — the whole concern fits behind this object,
  and the session now just delegates to it.

  Bounded by insertion-order eviction: a long-running session with many truncated results
  must not grow this map without limit.
*/
import {
  capToolResult,
  pageResult,
  searchResult,
  DEFAULT_PAGE_CHAR_LIMIT,
  JSON_ESCAPED_NEWLINE,
} from "../tool-result-paging.js";

/** Oldest-truncated-result eviction cap — bounds memory on a long session. */
export const RESULT_OVERFLOW_MAX_ENTRIES = 30;

type OverflowLookup = { ok: true; fullText: string } | { ok: false; error: string };

export class ToolOutputStore {
  private readonly _overflow = new Map<string, string>();

  constructor(private readonly _maxEntries: number = RESULT_OVERFLOW_MAX_ENTRIES) {}

  /** Number of full texts currently retained. Exposed for tests and diagnostics. */
  get size(): number {
    return this._overflow.size;
  }

  /**
   * Truncate `stringified` to the model-facing budget, retaining the full text for later
   * paging when it overflowed. Returns the (possibly truncated) content to send.
   */
  cap(toolCallId: string, stringified: string): string {
    const capped = capToolResult(stringified, toolCallId, DEFAULT_PAGE_CHAR_LIMIT, JSON_ESCAPED_NEWLINE);
    if (capped.overflowed) {
      if (this._overflow.size >= this._maxEntries) {
        // Map iterates in insertion order, so the first key is the oldest retained result.
        const oldest = this._overflow.keys().next().value;
        if (oldest !== undefined) this._overflow.delete(oldest);
      }
      this._overflow.set(toolCallId, stringified);
    }
    return capped.content;
  }

  /** Shared lookup for both paging tools: a stored full text, or a uniform not-found error. */
  private _lookup(toolCallId: string): OverflowLookup {
    const fullText = this._overflow.get(toolCallId);
    if (fullText === undefined) {
      return {
        ok: false,
        error: `No stored output found for toolCallId "${toolCallId}". It may never have been truncated, `
          + `may already have been fully read, or may have been evicted — only the ${this._maxEntries} `
          + "most recently truncated results are kept.",
      };
    }
    return { ok: true, fullText };
  }

  /** Handles the tool_output_page tool: serves a requested slice of a truncated result. */
  page(payload: Record<string, unknown>): unknown {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };

    const lookup = this._lookup(toolCallId);
    if (!lookup.ok) return lookup;

    const offset = Math.max(0, Math.floor(Number(payload["offset"] ?? 0)) || 0);
    const limitRaw = Number(payload["limit"]);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_PAGE_CHAR_LIMIT;
    const page = pageResult(lookup.fullText, offset, limit, JSON_ESCAPED_NEWLINE);
    return {
      ok: true,
      toolCallId,
      offset: page.offset,
      totalLength: page.totalLength,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      content: page.content,
    };
  }

  /** Handles the tool_output_search tool: matching lines with context inside a truncated result. */
  search(payload: Record<string, unknown>): unknown {
    const toolCallId = String(payload["toolCallId"] ?? "").trim();
    if (!toolCallId) return { ok: false, error: "toolCallId is required." };
    const pattern = String(payload["pattern"] ?? "");
    if (!pattern) return { ok: false, error: "pattern is required." };

    const lookup = this._lookup(toolCallId);
    if (!lookup.ok) return lookup;

    const contextLines = Number(payload["contextLines"]);
    const maxMatches = Number(payload["maxMatches"]);
    const search = searchResult(lookup.fullText, pattern, {
      contextLines: Number.isFinite(contextLines) ? contextLines : undefined,
      maxMatches: Number.isFinite(maxMatches) ? maxMatches : undefined,
      boundary: JSON_ESCAPED_NEWLINE,
    });
    return {
      ok: true,
      toolCallId,
      pattern,
      totalMatches: search.totalMatches,
      truncated: search.truncated,
      matches: search.matches,
    };
  }
}
