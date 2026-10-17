/** Shared sanitization helpers for diagnostic and runtime logging. */

export const DEFAULT_SENSITIVE_KEY_RE = /(authorization|app-token|token|jwt|secret|password|api[-_]?key|access[-_]?key|session)/i;

export interface SanitizationOptions {
  maxDepth?: number;
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  sensitiveKeyPattern?: RegExp;
}

const DEFAULT_MAX_DEPTH = 6;

export function sanitizeForLogging(
  value: unknown,
  options: SanitizationOptions = {},
): unknown {
  return sanitizeValue(value, {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStringChars: options.maxStringChars,
    maxArrayItems: options.maxArrayItems,
    maxObjectKeys: options.maxObjectKeys,
    sensitiveKeyPattern: options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_RE,
  }, 0, new WeakSet<object>());
}

function sanitizeValue(
  value: unknown,
  options: Required<Pick<SanitizationOptions, "maxDepth" | "sensitiveKeyPattern">> & Omit<SanitizationOptions, "maxDepth" | "sensitiveKeyPattern">,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return truncateString(value, options.maxStringChars);
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, options.maxStringChars),
      stack: truncateString(value.stack || "", options.maxStringChars),
    };
  }
  if (depth >= options.maxDepth) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const maxItems = options.maxArrayItems ?? value.length;
    const output = value
      .slice(0, Math.max(0, maxItems))
      .map((entry) => sanitizeValue(entry, options, depth + 1, seen));
    if (value.length > maxItems) output.push(`[${value.length - maxItems} item(s) omitted]`);
    return output;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const maxKeys = options.maxObjectKeys ?? entries.length;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, Math.max(0, maxKeys))) {
    redacted[key] = options.sensitiveKeyPattern.test(key)
      ? "[redacted]"
      : sanitizeValue(entry, options, depth + 1, seen);
  }
  if (entries.length > maxKeys) redacted.__omittedKeys = entries.length - maxKeys;
  return redacted;
}

function truncateString(value: string, limit?: number): string {
  if (!limit || limit <= 0 || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit)).trimEnd()}\n...[truncated ${value.length - limit} chars]`;
}

/** Credential-looking text: bearer tokens, sk- keys, and key/token/password/secret assignments. */
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

/**
 * Mask credential-looking text in free-form strings: prompt previews, and summaries that leave the
 * process boundary they were written in (exchange packets handed to another lane).
 */
export function redactSecretsInText(text: string): string {
  let output = text;
  for (const pattern of SECRET_TEXT_PATTERNS) {
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
