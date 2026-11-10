/**
 * The context model: what one request is made of, in terms every other part of src/context reads.
 *
 * Types and a few pure constants only. This file is frozen ahead of the modules written against
 * it (docs/context-economy-implementation-plan.md §4, step 1.1): a new context feature adds a
 * class or a policy, never a parallel bookkeeping path. Pure — no VS Code imports, so the
 * webview and the eval harness can share it.
 */

/** What kind of thing an item is. Decides where it sits in a request and what may be done with it. */
export type ContextClass =
  /** The static system prompt. */
  | "system"
  /** One tool definition the request declares in context (deferred tools are not counted). */
  | "tool-definition"
  /** Attached state that holds for a whole turn or session: instructions, project shape, skills. */
  | "attached-stable"
  /** Attached state that can change between tool rounds: open editors, diagnostics, git, checklist. */
  | "attached-live"
  | "user-message"
  | "assistant-message"
  | "tool-result"
  /** The compaction summary of older history. */
  | "summary";

export const CONTEXT_CLASSES: readonly ContextClass[] = [
  "system",
  "tool-definition",
  "attached-stable",
  "attached-live",
  "user-message",
  "assistant-message",
  "tool-result",
  "summary",
];

/**
 * How often an item's bytes change. Decides which cache boundary it belongs behind: an item that
 * changes on every call cannot sit before a breakpoint without defeating the cache.
 */
export type ContextStability = "session" | "turn" | "call";

/** How to get an item back once it has been set aside. Rule 3 of the design stance: nothing is
 *  set aside without one of these, except what was never recoverable to begin with. */
export type ContextRecall =
  | { kind: "archive"; id: string }
  | { kind: "re-read"; path: string }
  | { kind: "none" };

/** One unit of a request. */
export interface ContextItem {
  /** Stable for the item's life: a tool call id for a tool result, `system`, `tools.<name>`, … */
  id: string;
  class: ContextClass;
  /** Characters on the wire, as sent. */
  chars: number;
  /** Estimated from `chars`. Corrected against provider usage by the ledger's calibration. */
  tokens: number;
  stability: ContextStability;
  recall: ContextRecall;
  /** Never set aside: the user's own words, an unanswered question, an unsheddable tool's result. */
  pinned: boolean;
  /** A later item that makes this one redundant: a newer read of the same file. */
  supersededBy?: string;
  /** Human label for reports: the tool name, the section, the role. */
  label?: string;
  /** Position of the containing message in history, for age. Absent outside history. */
  messageIndex?: number;
}

/** What a request may hold. */
export interface ContextBudget {
  /** The model's context window in tokens. */
  window: number;
  /** An absolute ceiling on history, below the window. 0 or absent means none. */
  historyBudgetTokens?: number;
}

/** Characters per token for the estimator. Rough, and differs by tokenizer; the ledger corrects it
 *  from what providers report. Kept in one place so every estimate in src/context agrees. */
export const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Classes that are part of the conversation history rather than the frame around it. */
export const HISTORY_CLASSES: ReadonlySet<ContextClass> = new Set<ContextClass>([
  "user-message",
  "assistant-message",
  "tool-result",
  "summary",
]);
