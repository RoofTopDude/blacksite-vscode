import type { AgentEvent } from "./agent-session.js";
import { sanitizeForLogging } from "../../../src/shared/redaction.js";

export interface TurnLogMetadata {
  inputChars: number;
  promptPreview: string;
  mentionCount?: number;
  contextLabel?: string;
}

export interface StructuredLogContext {
  ts: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  turnId?: string;
  turnCount?: number;
}

export interface StructuredLogEntry {
  ts: string;
  kind: "session_start" | "turn_start" | "turn_end" | "event";
  sessionId?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  turnId?: string;
  turnCount?: number;
  lane?: string;
  eventType?: AgentEvent["type"];
  ok?: boolean;
  elapsedMs?: number;
  error?: string;
  data?: unknown;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

export function buildPromptPreview(text: string, limit = 160): string {
  const collapsed = redactPromptPreview(text).replace(/\s+/g, " ").trim();
  if (!collapsed) return "(empty)";
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit)).trimEnd()}...`;
}

export function createSessionStartEntry(
  ctx: StructuredLogContext,
): StructuredLogEntry {
  return {
    ts: ctx.ts,
    kind: "session_start",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
  };
}

export function createTurnStartEntry(
  ctx: StructuredLogContext,
  meta: TurnLogMetadata,
): StructuredLogEntry {
  return {
    ts: ctx.ts,
    kind: "turn_start",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    data: {
      inputChars: meta.inputChars,
      promptPreview: buildPromptPreview(meta.promptPreview),
      mentionCount: meta.mentionCount ?? 0,
      contextLabel: meta.contextLabel,
    },
  };
}

export function createTurnEndEntry(
  ctx: StructuredLogContext,
  ok: boolean,
  elapsedMs: number,
  error?: string,
): StructuredLogEntry {
  return {
    ts: ctx.ts,
    kind: "turn_end",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    ok,
    elapsedMs,
    error: error ? buildPromptPreview(error, 200) : undefined,
  };
}

export function createStructuredEventEntry(
  ctx: StructuredLogContext,
  event: AgentEvent,
  lane?: string,
): StructuredLogEntry {
  return {
    ts: ctx.ts,
    kind: "event",
    sessionId: ctx.sessionId,
    provider: ctx.provider,
    model: ctx.model,
    workspaceRoot: ctx.workspaceRoot,
    turnId: ctx.turnId,
    turnCount: ctx.turnCount,
    lane,
    eventType: event.type,
    data: sanitizeEvent(event),
  };
}

function redactPromptPreview(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, redactMatch);
  }
  return output;
}

function redactMatch(match: string): string {
  if (/^Bearer\s+/i.test(match)) return "Bearer [redacted]";
  const separatorIndex = match.search(/[:=]/);
  if (separatorIndex >= 0) {
    const prefix = match.slice(0, separatorIndex + 1);
    return `${prefix} [redacted]`;
  }
  return "[redacted]";
}

function sanitizeEvent(event: AgentEvent): unknown {
  switch (event.type) {
    case "tool_call_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputPreview: buildPromptPreview(event.inputPreview, 200),
        input: sanitizeUnknown(event.input, {
          maxDepth: 4,
          maxStringChars: 300,
          maxArrayItems: 10,
          maxObjectKeys: 24,
        }),
      };

    case "tool_call_result":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok: event.ok,
        summary: buildPromptPreview(event.summary, 200),
        elapsedMs: event.elapsedMs,
        result: sanitizeUnknown(event.result, {
          maxDepth: 4,
          maxStringChars: 400,
          maxArrayItems: 10,
          maxObjectKeys: 24,
        }),
      };

    default:
      return sanitizeUnknown(event, {
        maxDepth: 4,
        maxStringChars: 300,
        maxArrayItems: 12,
        maxObjectKeys: 24,
      });
  }
}

function sanitizeUnknown(
  value: unknown,
  options: Parameters<typeof sanitizeForLogging>[1],
): unknown {
  return redactSanitizedStrings(sanitizeForLogging(value, options));
}

function redactSanitizedStrings(value: unknown): unknown {
  if (typeof value === "string") return redactPromptPreview(value);
  if (Array.isArray(value)) return value.map((entry) => redactSanitizedStrings(entry));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactSanitizedStrings(entry);
  }
  return output;
}
