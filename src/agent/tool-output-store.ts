/*
  Model-facing capping of tool results, and the paging tools that read them back.

  Every tool result's full text goes to the context archive (src/context/archive.ts) when it is
  produced, whether or not it fit. A result over the inline limit is truncated before it goes to
  the model, with a notice saying how to read the rest. `tool_output_page` and
  `tool_output_search` serve any archived result, so a result that was later stubbed (by the
  emergency path, or by aging) can be read back the same way as one that was truncated.

  Before the archive, only overflowing results were kept, and only the newest 30 of them.
*/
import {
  capToolResult,
  capToolResultKeepingEnds,
  pageResult,
  searchResult,
  DEFAULT_PAGE_CHAR_LIMIT,
  JSON_ESCAPED_NEWLINE,
} from "../tool-result-paging.js";
import { ContextArchive } from "../context/archive.js";
import { browserTool } from "../browser/privacy.js";

type OverflowLookup = { ok: true; fullText: string } | { ok: false; error: string };

export class ToolOutputStore {
  readonly archive: ContextArchive;

  private readonly _inlineLimit: () => number;

  /** `inlineLimit` may be a getter, read on every cap, so a settings change applies to the next
   *  result. At the default limit results are cut as they always were (the head); at any other
   *  limit the cut keeps the head, the tail and the error lines between. */
  constructor(archive: ContextArchive = new ContextArchive(), inlineLimit: number | (() => number) = DEFAULT_PAGE_CHAR_LIMIT) {
    this.archive = archive;
    this._inlineLimit = typeof inlineLimit === "function" ? inlineLimit : () => inlineLimit;
  }

  /** Number of full texts currently retained. Exposed for tests and diagnostics. */
  get size(): number {
    return this.archive.size;
  }

  /** The inline limit results are capped at. */
  get inlineLimit(): number {
    const limit = this._inlineLimit();
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PAGE_CHAR_LIMIT;
  }

  /**
   * Archive the full text of `stringified` and return what goes to the model: the text itself, or
   * a capped prefix with a paging notice when it is over the inline limit.
   */
  cap(toolCallId: string, stringified: string, toolName?: string): string {
    // Browser and web results are redacted before anything else persists them (see
    // browser/privacy.ts), so their raw text stays in memory. So does a result whose tool is not
    // known, since nothing then says it is safe to write.
    const persist = toolName !== undefined && !browserTool(toolName);
    this.archive.put(toolCallId, stringified, toolName, { persist });
    const limit = this.inlineLimit;
    return limit === DEFAULT_PAGE_CHAR_LIMIT
      ? capToolResult(stringified, toolCallId, limit, JSON_ESCAPED_NEWLINE).content
      : capToolResultKeepingEnds(stringified, toolCallId, limit, JSON_ESCAPED_NEWLINE).content;
  }

  /** Shared lookup for both paging tools: a stored full text, or a uniform not-found error. */
  private _lookup(toolCallId: string): OverflowLookup {
    const fullText = this.archive.get(toolCallId);
    if (fullText === undefined) {
      return {
        ok: false,
        error: `No stored output found for toolCallId "${toolCallId}". Use the id of a tool call from this conversation. `
          + (this.archive.persistent
            ? `The archive keeps up to ${this.archive.maxEntries.toLocaleString()} results; the oldest may have been removed.`
            : `This session keeps results in memory only, and the oldest may have been released.`),
      };
    }
    return { ok: true, fullText };
  }

  /** Handles the tool_output_page tool: serves a requested slice of an archived result. */
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

  /** Handles the tool_output_search tool: matching lines with context inside an archived result. */
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
