/*
  Anthropic's native tool search: which models support `defer_loading` / `tool_reference`, and
  the serialization step that turns a tool_search result into tool_reference blocks.
*/

/**
 * Models the Anthropic tool search tool (and so `defer_loading` and `tool_reference`) supports:
 * Claude 4.5 and later, plus every Fable and Mythos model. Anything unrecognized uses the
 * client-side mechanism, which works everywhere.
 */
export function supportsNativeToolSearch(model: string): boolean {
  const id = model.toLowerCase();
  if (/claude-(fable|mythos)/.test(id)) return true;
  const match = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

type WireBlock = Record<string, unknown>;
type WireMessage = { role: string; content: unknown };

/**
 * Replace the content of tool_search results with `tool_reference` blocks, for a native request.
 *
 * Stored history keeps the plain JSON result (every other route reads that), and the references
 * are applied only at serialization. A reference to a tool this request does not send would be a
 * 400, so those are dropped; a result left with no loadable reference keeps its text.
 */
export function expandToolReferences<T extends WireMessage>(
  messages: readonly T[],
  references: ReadonlyMap<string, readonly string[]>,
  sentToolNames: ReadonlySet<string>,
): T[] {
  if (references.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = (message.content as WireBlock[]).map((block) => {
      if (block?.["type"] !== "tool_result") return block;
      const names = references.get(String(block["tool_use_id"] ?? ""));
      const loadable = names?.filter((name) => sentToolNames.has(name)) ?? [];
      if (!loadable.length) return block;
      changed = true;
      return { ...block, content: loadable.map((name) => ({ type: "tool_reference", tool_name: name })) };
    });
    return changed ? { ...message, content } : message;
  });
}
