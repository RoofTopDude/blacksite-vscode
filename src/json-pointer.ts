/* Pure JSON structural-edit engine backing the json_edit tool. No vscode dependency —
   parses, mutates via RFC 6901 JSON Pointers, and reserializes, so it's independent of
   exact text: reformatting, key reordering, or a stray whitespace difference in the file
   can never make an operation fail the way file_edit's exact-string match can. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonEditOp = "set" | "merge" | "remove";

export interface JsonOperation {
  op: JsonEditOp;
  /** RFC 6901 JSON Pointer, e.g. "/scripts/build" or "" for the document root. */
  pointer: string;
  /** Required for set/merge; ignored for remove. */
  value?: JsonValue;
}

export type OpResult = { ok: true } | { ok: false; error: string };

/** Decode one RFC 6901 JSON Pointer into its unescaped path segments ("" decodes to the
 *  document root, an empty segment list). Throws on a pointer that doesn't start with "/". */
export function decodePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer '${pointer}' — must start with "/", or be empty for the document root.`);
  }
  return pointer.slice(1).split("/").map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Walk to the parent of the pointer's final segment. With `createIntermediate`, missing
 *  intermediate object keys are created as empty objects rather than failing (used by set/merge
 *  so a nested path can be written in one operation without a separate scaffolding step). */
function resolveParent(
  root: JsonValue,
  segments: string[],
  createIntermediate: boolean,
): { ok: true; parent: JsonValue; key: string } | { ok: false; error: string } {
  if (segments.length === 0) return { ok: false, error: "This operation needs a pointer to a location inside the document, not the root." };
  let cur: JsonValue = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        return { ok: false, error: `Array index '${seg}' is out of range (length ${cur.length}) in the pointer.` };
      }
      cur = cur[idx]!;
    } else if (isPlainObject(cur)) {
      if (!(seg in cur)) {
        if (!createIntermediate) return { ok: false, error: `No property '${seg}' found in the document at that pointer.` };
        cur[seg] = {};
      }
      cur = cur[seg]!;
    } else {
      return { ok: false, error: `Cannot descend into a non-object/array value at '${seg}'.` };
    }
  }
  return { ok: true, parent: cur, key: segments[segments.length - 1]! };
}

function setAt(root: JsonValue, segments: string[], value: JsonValue): OpResult {
  if (segments.length === 0) return { ok: false, error: "Setting the document root is not supported — target individual top-level keys instead." };
  const resolved = resolveParent(root, segments, true);
  if (!resolved.ok) return resolved;
  const { parent, key } = resolved;
  if (Array.isArray(parent)) {
    if (key === "-") { parent.push(value); return { ok: true }; }
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
      return { ok: false, error: `Array index '${key}' is out of range (length ${parent.length}). Use '-' to append.` };
    }
    parent[idx] = value;
    return { ok: true };
  }
  if (isPlainObject(parent)) {
    parent[key] = value;
    return { ok: true };
  }
  return { ok: false, error: `Cannot set '${key}' on a non-object/array value.` };
}

function removeAt(root: JsonValue, segments: string[]): OpResult {
  if (segments.length === 0) return { ok: false, error: "Removing the document root is not supported." };
  const resolved = resolveParent(root, segments, false);
  if (!resolved.ok) return resolved;
  const { parent, key } = resolved;
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
      return { ok: false, error: `Array index '${key}' not found (length ${parent.length}).` };
    }
    parent.splice(idx, 1);
    return { ok: true };
  }
  if (isPlainObject(parent)) {
    if (!(key in parent)) return { ok: false, error: `No property '${key}' found to remove.` };
    delete parent[key];
    return { ok: true };
  }
  return { ok: false, error: `Cannot remove '${key}' from a non-object/array value.` };
}

function mergeAt(root: JsonValue, segments: string[], value: JsonValue): OpResult {
  if (!isPlainObject(value)) return { ok: false, error: "merge requires an object value." };

  let target: JsonValue;
  if (segments.length === 0) {
    target = root;
  } else {
    const resolved = resolveParent(root, segments, true);
    if (!resolved.ok) return resolved;
    const { parent, key } = resolved;
    if (Array.isArray(parent)) return { ok: false, error: "merge cannot target an array element — use set instead." };
    if (!isPlainObject(parent)) return { ok: false, error: `Cannot descend through a scalar value to merge at '${key}'.` };
    if (!isPlainObject(parent[key]!)) parent[key] = {};
    target = parent[key]!;
  }
  if (!isPlainObject(target)) return { ok: false, error: "merge target is not an object." };
  Object.assign(target, value);
  return { ok: true };
}

/** Apply one structural operation to `root` in place. Mutates only on success; on failure
 *  `root` may be partially unrelated to the failure (earlier ops in a batch already landed)
 *  but the failing op itself never partially applies. Callers should only persist `root`
 *  after every operation in a batch has returned ok. */
export function applyJsonOperation(root: JsonValue, operation: JsonOperation): OpResult {
  let segments: string[];
  try {
    segments = decodePointer(operation.pointer);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  switch (operation.op) {
    case "set":
      if (operation.value === undefined) return { ok: false, error: "set requires `value`." };
      return setAt(root, segments, operation.value);
    case "remove":
      return removeAt(root, segments);
    case "merge":
      if (operation.value === undefined) return { ok: false, error: "merge requires `value`." };
      return mergeAt(root, segments, operation.value);
    default:
      return { ok: false, error: `Unknown operation '${String(operation.op)}' — use set, merge, or remove.` };
  }
}

/** Guess the file's indent unit from its first indented line, so a rewritten document keeps
 *  the project's existing style (2 spaces, 4 spaces, or a tab) instead of imposing one. */
export function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  return match ? match[1]! : "  ";
}

/** Reserialize a mutated document, preserving the original's indent style and whether it
 *  ended in a trailing newline. */
export function serializeJson(value: JsonValue, indent: string, trailingNewline: boolean): string {
  const body = JSON.stringify(value, null, indent);
  return trailingNewline ? `${body}\n` : body;
}
