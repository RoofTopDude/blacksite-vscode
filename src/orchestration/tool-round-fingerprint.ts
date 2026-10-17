import { createHash } from "node:crypto";
import type { ToolResultBlock, ToolUseBlock } from "@blacksite-agent/llm";

// Metadata keys only: do not erase timestamps embedded in source text, diagnostics or inputs.
// Explicit names avoid treating semantic fields such as expiresAt or sourceRevision as noise.
const VOLATILE = /^(?:(?:duration|elapsed)(?:ms|seconds|s)?|(?:created|updated|started|finished|completed|observed|recorded|checked|generated)(?:at|time|timestamp)|timestamp)$/i;

/**
 * Log-like result fields: a test runner's or command's own output. A runner stamps every run with
 * its start time and duration ("Start at 20:33:30", "Duration 1.43s"), so two runs that failed
 * identically never printed the same bytes, and the detector never saw them repeat. Only timing is
 * scrubbed from these fields; every other word of the output still counts.
 */
const LOG_FIELD = /^(?:rawoutput|output|stdout|stderr|log)$/i;
// eslint-disable-next-line no-control-regex -- ANSI escapes are exactly what is being removed.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds)\b/gi;

/** A log's text with its timing removed. Exported for the progress monitor, which reads logs too. */
export function scrubLogTiming(text: string): string {
  return text.replace(ANSI, "").replace(ISO_TIMESTAMP, "<time>").replace(CLOCK, "<time>").replace(DURATION, "<duration>");
}

function canonical(value: unknown, stripMetadata: boolean, key = ""): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, stripMetadata)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([name, item]) => item !== undefined && typeof item !== "function"
        && !(stripMetadata && VOLATILE.test(name.replace(/[_-]/g, ""))))
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item, stripMetadata, name)}`).join(",")}}`;
  }
  if (stripMetadata && typeof value === "string" && LOG_FIELD.test(key.replace(/[_-]/g, ""))) {
    return JSON.stringify(scrubLogTiming(value));
  }
  return JSON.stringify(value) ?? "null";
}

/** The model-facing result, parsed from its JSON envelope when it has one. */
export function resultContent(content: ToolResultBlock["content"]): unknown {
  // The model-facing result is serialized JSON. Parse that envelope once, never strings inside
  // it: a file's contents or stdout are evidence even if they happen to contain JSON timestamps.
  if (typeof content !== "string") return content;
  const first = content.trimStart()[0];
  if (first !== "{" && first !== "[") return content;
  try { return JSON.parse(content); } catch { return content; }
}

/** A tool call's arguments, every field kept. */
export function inputFingerprint(name: string, input: unknown): string {
  return createHash("sha256").update(canonical([name, input], false)).digest("hex");
}

/** A result with timing metadata, and timing inside its logs, removed. */
export function resultFingerprint(content: ToolResultBlock["content"]): string {
  return createHash("sha256").update(canonical(resultContent(content ?? ""), true)).digest("hex");
}

/** One parse/walk per result, no mutation or retained payload. Arguments retain every field. */
export function toolRoundFingerprint(calls: ToolUseBlock[], results: ToolResultBlock[]): string {
  const hash = createHash("sha256");
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    hash.update(canonical([call.name, call.input], false));
    hash.update(canonical(resultContent(results[index]?.content ?? ""), true));
  }
  return hash.digest("hex");
}
