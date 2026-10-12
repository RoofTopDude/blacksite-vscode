/*
  Strict-tool-use schema conversion. Both OpenAI and Anthropic gate a "strict" tool mode on
  the same documented JSON-Schema subset, so the conversion lives here once rather than in
  either provider's wire module.

  Extracted from agent-session.ts, which re-exports these. Pure functions.
*/

/**
 * Keywords the strict-tool-use validator is documented to accept. A whitelist rather than a
 * blocklist on purpose: a schema using anything outside it (numeric/string constraints,
 * $ref, if/then, patternProperties, …) is simply sent without `strict` — the status quo —
 * whereas a blocklist that missed one rejected keyword would 400 every turn of the session.
 */
const STRICT_ALLOWED_KEYWORDS = new Set([
  "type", "description", "title", "properties", "required", "additionalProperties",
  "items", "enum", "const", "anyOf", "allOf", "format",
]);

/** String formats the strict validator supports; anything else disqualifies the schema. */
const STRICT_ALLOWED_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

/** Recursive worker for {@link toStrictToolSchema}: returns the strict-ready copy, or null. */
function toStrictSchemaNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const src = node as Record<string, unknown>;
  // A bare `{}` subschema means "anything" — free-form intent that strict cannot express.
  if (Object.keys(src).length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (!STRICT_ALLOWED_KEYWORDS.has(key)) return null;
    out[key] = value;
  }
  if ("type" in out && typeof out["type"] !== "string") return null; // type arrays (["string","null"]) unsupported
  if (typeof out["format"] === "string" && !STRICT_ALLOWED_FORMATS.has(out["format"])) return null;

  if (out["items"] !== undefined) {
    const items = toStrictSchemaNode(out["items"]);
    if (!items) return null;
    out["items"] = items;
  }
  for (const combiner of ["anyOf", "allOf"] as const) {
    const list = out[combiner];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) return null;
    const mapped: Array<Record<string, unknown>> = [];
    for (const member of list) {
      const m = toStrictSchemaNode(member);
      if (!m) return null;
      mapped.push(m);
    }
    out[combiner] = mapped;
  }

  if (out["type"] === "object" || out["properties"] !== undefined) {
    const props = out["properties"];
    // An object with no declared properties is a free-form payload — forcing
    // additionalProperties:false onto it would forbid every key, silently breaking the tool.
    if (!props || typeof props !== "object" || Array.isArray(props) || Object.keys(props).length === 0) return null;
    const mappedProps: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
      const m = toStrictSchemaNode(sub);
      if (!m) return null;
      mappedProps[name] = m;
    }
    out["properties"] = mappedProps;
    const ap = out["additionalProperties"];
    if (ap !== undefined && ap !== false) return null; // `true`/schema = free-form intent
    out["additionalProperties"] = false;
    if (out["required"] === undefined) out["required"] = [];
    else if (!Array.isArray(out["required"])) return null;
  }
  return out;
}

/**
 * Convert a tool input schema to the strict-tool-use dialect (deep copy — the session's tool
 * definitions are shared across providers and must not be mutated), or null when the schema
 * uses anything outside the documented strict subset. Strict guarantees the model's
 * `tool_use.input` validates against the schema exactly — malformed arguments stop being a
 * runtime coercion/repair problem and become impossible at the API level.
 */
export function toStrictToolSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  const out = toStrictSchemaNode(schema);
  return out && out["type"] === "object" ? out : null;
}
