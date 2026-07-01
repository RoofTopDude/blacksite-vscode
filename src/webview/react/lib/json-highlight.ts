/* Dependency-free JSON tokenizer for syntax-highlighted tool input/result detail
 * cards. Mirrors the codebase's existing preference for small hand-rolled renderers
 * (see markdown.ts, tokens.ts) over pulling in a highlighter library for one view.
 *
 * The tool detail cards render arbitrary text — sometimes JSON, sometimes raw stdout,
 * file content, or a plain placeholder string. tokenizeJson() only lights up genuine
 * JSON: it returns null for anything else so the caller falls back to plain text.
 */

export type JsonTokenClass = "key" | "string" | "number" | "boolean" | "null" | "punct" | "ws";

export interface JsonToken {
  text: string;
  cls: JsonTokenClass;
}

/**
 * Parses `text` as JSON and, if it succeeds, re-serializes it with 2-space indentation
 * and tokenizes that canonical form for syntax-aware rendering. Returns null when
 * `text` isn't valid JSON — including a value pre-truncated by formatDetailValue,
 * which is no longer parseable — so the caller renders it as plain text instead.
 */
export function tokenizeJson(text: string): JsonToken[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Cheap pre-filter: only objects/arrays are worth highlighting. A bare string/number
  // result already reads fine as plain text, and this keeps an arbitrary numeric-looking
  // log line from being treated as "JSON".
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return lexJson(JSON.stringify(parsed, null, 2));
}

const WHITESPACE_RE = /[ \n\t\r]/;

/** Lexes text known to be JSON.stringify(..., null, 2) output — a fixed, well-formed grammar. */
function lexJson(source: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  const n = source.length;

  const push = (text: string, cls: JsonTokenClass): void => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.cls === cls) last.text += text;
    else tokens.push({ text, cls });
  };

  while (i < n) {
    const ch = source[i]!;

    if (WHITESPACE_RE.test(ch)) {
      let j = i;
      while (j < n && WHITESPACE_RE.test(source[j]!)) j++;
      push(source.slice(i, j), "ws");
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === '"') { j++; break; }
        j++;
      }
      // A string is a key exactly when the next non-whitespace character is a colon —
      // true for every key JSON.stringify emits, never for a value string.
      let k = j;
      while (k < n && WHITESPACE_RE.test(source[k]!)) k++;
      push(source.slice(i, j), source[k] === ":" ? "key" : "string");
      i = j;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "," || ch === ":") {
      push(ch, "punct");
      i++;
      continue;
    }

    if (source.startsWith("true", i)) { push("true", "boolean"); i += 4; continue; }
    if (source.startsWith("false", i)) { push("false", "boolean"); i += 5; continue; }
    if (source.startsWith("null", i)) { push("null", "null"); i += 4; continue; }

    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (numMatch) {
      push(numMatch[0], "number");
      i += numMatch[0].length;
      continue;
    }

    // Unreachable for genuine JSON.stringify output — never spin forever if it happens.
    push(ch, "punct");
    i++;
  }

  return tokens;
}
