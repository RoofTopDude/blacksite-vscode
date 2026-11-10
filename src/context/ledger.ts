/**
 * The context ledger: the single answer to "what is in this request, and why".
 *
 * Built from the same inputs the wire builders read (the ModelRequest's system prompt, summary,
 * attached blocks, tool definitions and messages), so its view and the provider's cannot drift.
 * Records each tool call's file reads and writes as they happen, which is what lets it say that an
 * older read of a file is superseded by a newer one, and whether a result can be recovered by
 * re-reading the file.
 *
 * Estimates come from characters; `calibrate` folds in what the provider reported for the same
 * request, and `calibrationRatio` is the running correction (reported ÷ estimated).
 *
 * Pure: no VS Code, no I/O. The reporter, the aging policy, the compactor and the agent-facing
 * view all read snapshots from here.
 */
import type { AgentMessage, ContentBlock } from "@blacksite-agent/llm";
import {
  CONTEXT_CLASSES,
  estimateTokens,
  type ContextClass,
  type ContextItem,
  type ContextRecall,
  type ContextStability,
} from "./model.js";

/** What one request carried, in the terms the ledger needs. */
export interface RequestShape {
  system: string;
  systemSummary: string;
  /** Attached state behind a cache boundary (stable caching on). Empty or absent: none. */
  contextStable?: string;
  /** Attached state at the uncached tail. */
  contextTail: string;
  /** Definitions in context, with their wire size. Deferred definitions are not listed. */
  tools: ReadonlyArray<{ name: string; chars: number }>;
  messages: readonly AgentMessage[];
}

export interface ClassTotal {
  items: number;
  chars: number;
  tokens: number;
}

export interface LedgerSnapshot {
  items: ContextItem[];
  byClass: Record<ContextClass, ClassTotal>;
  /** Sum of item estimates. */
  estimatedTokens: number;
  /** `estimatedTokens` scaled by the calibration ratio when one is known. */
  calibratedTokens: number;
}

interface ToolCallRecord {
  id: string;
  toolName: string;
  seq: number;
  /** Paths read by a call that reads only, with the input that shapes what was read. */
  reads: Array<{ key: string; display: string; shape: string }>;
  writes: string[];
  /** Every path the call named, for reference tracking. */
  paths: string[];
}

/** Images are counted at a flat figure: their real cost depends on pixels the ledger never sees. */
export const IMAGE_TOKEN_ESTIMATE = 1_600;
const IMAGE_CHAR_EQUIVALENT = Math.round(IMAGE_TOKEN_ESTIMATE * 3.6);

/** Input keys that do not change what a read returns, so two reads differing only here read the same thing. */
const PATH_KEYS = new Set(["path", "file", "filePath", "relativePath", "uri"]);

function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/** The part of a read's input other than the path: two reads with the same shape read the same text. */
function readShape(input: Record<string, unknown> | undefined): string {
  if (!input) return "[]";
  const rest = Object.keys(input).filter((key) => !PATH_KEYS.has(key)).sort();
  return JSON.stringify(rest.map((key) => [key, input[key]]));
}

function emptyTotals(): Record<ContextClass, ClassTotal> {
  return Object.fromEntries(CONTEXT_CLASSES.map((cls) => [cls, { items: 0, chars: 0, tokens: 0 }])) as Record<ContextClass, ClassTotal>;
}

function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case "text": return block.text.length;
    case "thinking": return block.thinking.length;
    case "image": return IMAGE_CHAR_EQUIVALENT;
    case "tool_result": return block.content.length;
    default: return JSON.stringify(block).length;
  }
}

export interface ContextLedgerOptions {
  /** Tools whose results are never set aside (re-running them would re-ask the user). */
  unsheddableTools?: readonly string[];
  /** Whether the archive holds a full copy of a result. Decides the `archive:` recall. */
  isArchived?: (toolCallId: string) => boolean;
}

export class ContextLedger {
  private _seq = 0;
  private readonly _calls = new Map<string, ToolCallRecord>();
  /** Sequence of the newest call that wrote each path. */
  private readonly _lastWrite = new Map<string, number>();
  private readonly _unsheddable: ReadonlySet<string>;
  private readonly _isArchived: (toolCallId: string) => boolean;
  /** Running sums for calibration: estimated and provider-reported tokens over the same requests. */
  private _calibrationEstimated = 0;
  private _calibrationReported = 0;

  constructor(options: ContextLedgerOptions = {}) {
    this._unsheddable = new Set(options.unsheddableTools ?? []);
    this._isArchived = options.isArchived ?? (() => false);
  }

  /**
   * Record a tool call as it is dispatched. `touched` is the call's file reads and writes, from
   * the freshness ledger's classification, so the two agree about what a call touched.
   */
  recordToolCall(
    id: string,
    toolName: string,
    input: Record<string, unknown> | undefined,
    touched: { reads: readonly string[]; writes: readonly string[] },
    ok = true,
  ): void {
    const seq = ++this._seq;
    // A failed read returned no file text, so it supersedes nothing and cannot be re-read from.
    const readOnly = ok && touched.writes.length === 0;
    for (const raw of touched.writes) this._lastWrite.set(normalizePath(raw), seq);
    this._calls.set(id, {
      id,
      toolName,
      seq,
      reads: readOnly ? touched.reads.map((raw) => ({ key: normalizePath(raw), display: raw, shape: readShape(input) })) : [],
      writes: touched.writes.map(normalizePath),
      paths: [...touched.reads, ...touched.writes].map(normalizePath),
    });
  }

  /** Fold one request's estimate and the provider's count for it into the calibration. */
  calibrate(estimatedTokens: number, reportedTokens: number): void {
    if (!(estimatedTokens > 0) || !(reportedTokens > 0)) return;
    this._calibrationEstimated += estimatedTokens;
    this._calibrationReported += reportedTokens;
  }

  /** Reported ÷ estimated over every calibrated request, or null before the first. */
  get calibrationRatio(): number | null {
    return this._calibrationEstimated > 0 ? this._calibrationReported / this._calibrationEstimated : null;
  }

  clear(): void {
    this.forgetToolCalls();
    this._calibrationEstimated = 0;
    this._calibrationReported = 0;
  }

  /** Drop the tool-call records and keep the calibration: for a rewind, where history changes
   *  but the estimator's error does not. */
  forgetToolCalls(): void {
    this._seq = 0;
    this._calls.clear();
    this._lastWrite.clear();
  }

  /** Item ids of results superseded by a later call, each mapped to the call that superseded it. */
  supersession(): Map<string, string> {
    const out = new Map<string, string>();
    const calls = [...this._calls.values()].sort((a, b) => a.seq - b.seq);
    // For each path, the newest read-only call that read it with a given shape, or whole.
    const latest = new Map<string, ToolCallRecord>();
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]!;
      for (const read of call.reads) {
        const sameShape = latest.get(`${read.key}\u0000${read.shape}`);
        const whole = latest.get(`${read.key}\u0000[]`);
        // A newer read of the same range, or of the whole file, makes this one redundant. A single
        // call reading several paths is superseded only when every path it read is.
        const by = sameShape ?? whole;
        if (by && call.reads.length === 1) out.set(call.id, by.id);
      }
      for (const read of call.reads) {
        const key = `${read.key}\u0000${read.shape}`;
        if (!latest.has(key)) latest.set(key, call);
      }
    }
    return out;
  }

  /** How a result can be brought back if set aside. */
  recallFor(toolCallId: string): ContextRecall {
    if (this._isArchived(toolCallId)) return { kind: "archive", id: toolCallId };
    const call = this._calls.get(toolCallId);
    if (call && call.reads.length === 1) {
      const read = call.reads[0]!;
      const writtenSince = (this._lastWrite.get(read.key) ?? 0) > call.seq;
      if (!writtenSince) return { kind: "re-read", path: read.display };
    }
    return { kind: "none" };
  }

  /** Paths a call named, normalized. Empty for an unknown call. */
  pathsOf(toolCallId: string): readonly string[] {
    return this._calls.get(toolCallId)?.paths ?? [];
  }

  /** Paths a read-only call read, as given. */
  readsOf(toolCallId: string): readonly string[] {
    return this._calls.get(toolCallId)?.reads.map((read) => read.display) ?? [];
  }

  /** Every item in `shape`, classified, sized, and marked. */
  snapshot(shape: RequestShape): LedgerSnapshot {
    const items: ContextItem[] = [];
    const add = (item: Omit<ContextItem, "tokens" | "recall" | "pinned"> & Partial<Pick<ContextItem, "recall" | "pinned">>): void => {
      if (item.chars <= 0) return;
      items.push({ recall: { kind: "none" }, pinned: false, ...item, tokens: estimateTokens(item.chars) });
    };
    const frame = (id: string, cls: ContextClass, chars: number, stability: ContextStability, label?: string): void =>
      add({ id, class: cls, chars, stability, label });

    frame("system", "system", shape.system.length, "session");
    for (const tool of shape.tools) frame(`tools.${tool.name}`, "tool-definition", tool.chars, "session", tool.name);
    frame("attached.stable", "attached-stable", shape.contextStable?.length ?? 0, "session");
    frame("summary", "summary", shape.systemSummary.length, "session");

    const superseded = this.supersession();
    const toolNames = new Map<string, string>();
    shape.messages.forEach((message, index) => {
      if (typeof message.content === "string") {
        add({
          id: `msg.${index}`, class: message.role === "user" ? "user-message" : "assistant-message",
          chars: message.content.length, stability: "session", messageIndex: index, label: message.role,
          pinned: message.role === "user",
        });
        return;
      }
      let ownChars = 0;
      for (const block of message.content) {
        if (block.type === "tool_use") toolNames.set(block.id, block.name);
        if (block.type === "tool_result") {
          const toolName = toolNames.get(block.tool_use_id);
          add({
            id: block.tool_use_id, class: "tool-result", chars: block.content.length, stability: "session",
            messageIndex: index, label: toolName,
            recall: this.recallFor(block.tool_use_id),
            pinned: toolName !== undefined && this._unsheddable.has(toolName),
            ...(superseded.has(block.tool_use_id) ? { supersededBy: superseded.get(block.tool_use_id) } : {}),
          });
        } else {
          ownChars += blockChars(block);
        }
      }
      add({
        id: `msg.${index}`, class: message.role === "user" ? "user-message" : "assistant-message",
        chars: ownChars, stability: "session", messageIndex: index, label: message.role,
        pinned: message.role === "user",
      });
    });
    frame("attached.live", "attached-live", shape.contextTail.length, "call");

    const byClass = emptyTotals();
    let estimatedTokens = 0;
    for (const item of items) {
      const total = byClass[item.class];
      total.items += 1;
      total.chars += item.chars;
      total.tokens += item.tokens;
      estimatedTokens += item.tokens;
    }
    const ratio = this.calibrationRatio;
    return { items, byClass, estimatedTokens, calibratedTokens: Math.round(estimatedTokens * (ratio ?? 1)) };
  }
}
