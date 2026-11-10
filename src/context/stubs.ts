/**
 * The record that takes a tool result's place when it is set aside (Phase 3.3).
 *
 * Honest by construction: it says what the call was, how it went, how big it was, why it was set
 * aside, and exactly how to get it back. It replaces the emergency path's old "re-run the tool if
 * you still need this", which sent the agent to repeat work whose output was already archived. The
 * agent's own note, when it set the result aside itself, is kept here, in its words.
 *
 * Pure. The record is JSON, like every tool result's content.
 */
import type { ContextRecall } from "./model.js";

export const SET_ASIDE_KEY = "_setAside";
/** The marker the emergency path wrote before this existed. */
export const LEGACY_ELIDED_KEY = "_elided";

export type SetAsideWhy = "superseded" | "aged" | "agent" | "emergency";

export interface SetAsideRecord {
  tool: string;
  input: Record<string, unknown> | undefined;
  /** The result as sent. */
  content: string;
  why: SetAsideWhy;
  recall: ContextRecall;
  supersededBy?: string;
  note?: string;
}

const WHY_TEXT: Record<SetAsideWhy, string> = {
  superseded: "a later call read the same thing",
  aged: "older tool output, set aside to keep the context under its budget",
  agent: "you set it aside",
  emergency: "set aside to fit the context window after compaction could not free enough",
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line on how the call went, from the result text as sent. */
export function outcomeLine(content: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = undefined; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (record["ok"] === false) return `failed: ${clip(String(record["error"] ?? record["message"] ?? "no error text"), 160)}`;
    if (typeof record["summary"] === "string") return `ok: ${clip(record["summary"], 160)}`;
    return "ok";
  }
  return /"ok"\s*:\s*false/.test(content.slice(0, 400)) ? "failed" : "ok";
}

export function recoverInstruction(recall: ContextRecall, toolCallId: string): string {
  switch (recall.kind) {
    case "archive": return `tool_output_page with toolCallId "${toolCallId}" returns the full text (tool_output_search finds lines in it)`;
    case "re-read": return `re-read ${recall.path}; it has not changed since`;
    case "none": return "not recoverable; run the call again if you need it";
  }
}

export function buildSetAsideStub(toolCallId: string, record: SetAsideRecord): string {
  const input = record.input ? clip(JSON.stringify(record.input), 240) : "";
  return JSON.stringify({
    [SET_ASIDE_KEY]: {
      tool: record.tool,
      ...(input ? { input } : {}),
      outcome: outcomeLine(record.content),
      chars: record.content.length,
      why: record.supersededBy ? `${WHY_TEXT[record.why]} (${record.supersededBy})` : WHY_TEXT[record.why],
      ...(record.note ? { note: record.note } : {}),
      recover: recoverInstruction(record.recall, toolCallId),
    },
  });
}

/** True when `content` is already a set-aside record or the emergency path's older stub. */
export function isSetAside(content: string): boolean {
  return content.startsWith(`{"${SET_ASIDE_KEY}":`) || content.includes(`"${LEGACY_ELIDED_KEY}"`);
}
