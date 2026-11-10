/**
 * Context reports: what each request carried and what a session paid for, from ledger snapshots.
 *
 * Phase 0 of the context-economy plan. Nothing is tuned until these numbers exist, so the report
 * answers the questions the later phases are judged by:
 *  - tokens by class, and how much of the input was read from cache;
 *  - peak context, the size a history budget would have to bound;
 *  - which items cost the most over the session: an item's size times the number of requests that
 *    carried it, which is what a long turn actually pays for;
 *  - tool results that were superseded by a later read, or never referred to again.
 *
 * Pure. The session feeds it one snapshot per request and asks for a report at the end of a turn.
 */
import type { AgentMessage } from "@blacksite-agent/llm";
import { CONTEXT_CLASSES, HISTORY_CLASSES, type ContextClass } from "./model.js";
import type { LedgerSnapshot } from "./ledger.js";

export interface ReportedUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface UsageTotals extends ReportedUsage {
  requests: number;
  /** Sum of ledger estimates over the same requests. */
  estimatedTokens: number;
  /** Largest single request, from provider usage where reported, else the estimate. */
  peakContextTokens: number;
  /** Share of input tokens billed at the full price: input ÷ (input + cacheRead + cacheWrite). */
  uncachedShare: number | null;
}

export interface ClassStats {
  /** Tokens of this class summed over every request. */
  carriedTokens: number;
  peakTokens: number;
  avgTokens: number;
}

export interface CostlyItem {
  id: string;
  class: ContextClass;
  label?: string;
  tokens: number;
  /** Requests that carried it. */
  carried: number;
  /** tokens × carried. */
  carriedTokens: number;
}

export interface ToolResultStats {
  count: number;
  tokens: number;
  superseded: { count: number; tokens: number };
  /** Read results whose file was never named again, by the agent or by a later call. */
  unreferenced: { count: number; tokens: number };
  /** Paths read more than once with the same range. */
  repeatedReads: Array<{ path: string; reads: number }>;
}

export interface ContextReport {
  version: 1;
  turn: UsageTotals;
  session: UsageTotals;
  /** Session-wide, per class. */
  byClass: Record<ContextClass, ClassStats>;
  /** Of the latest request. */
  latest: {
    estimatedTokens: number;
    calibratedTokens: number;
    byClassTokens: Record<ContextClass, number>;
    historyTokens: number;
  } | null;
  costliest: CostlyItem[];
  toolResults: ToolResultStats | null;
  /** Reported ÷ estimated tokens. Null before any provider reported usage. */
  calibrationRatio: number | null;
  /** Calls to tool_output_page / tool_output_search this session: what recovering set-aside
   *  output costs. */
  recoveryCalls: number;
  /** Phase 3 and 4: what was set aside this session, and by whom. */
  aging: AgingStats;
}

export interface AgingStats {
  /** Aging passes that found candidates, applied or not. */
  passes: number;
  /** Set aside by the harness (`aging: on`) or the emergency path. */
  setAside: { count: number; tokens: number };
  /** What `aging: observe` would have set aside. */
  wouldSetAside: { count: number; tokens: number };
  /** Passes that found candidates and held off because the cache rewrite cost more. */
  notWorthTheRewrite: number;
  /** Set aside by the agent with the context tool. */
  byAgent: { count: number; tokens: number };
  /** Of the recovery calls, those that read back a result that had been set aside. */
  recoveredSetAside: number;
}

/** What the reporter needs from the ledger for the tool-result section. */
export interface ReportLedgerView {
  readsOf(toolCallId: string): readonly string[];
  pathsOf(toolCallId: string): readonly string[];
}

const MAX_TRACKED_ITEMS = 5_000;
const COSTLIEST_COUNT = 10;
const REPEATED_READS_COUNT = 10;
export const RECOVERY_TOOLS: ReadonlySet<string> = new Set(["tool_output_page", "tool_output_search"]);

function emptyAging(): AgingStats {
  return { passes: 0, setAside: { count: 0, tokens: 0 }, wouldSetAside: { count: 0, tokens: 0 }, notWorthTheRewrite: 0, byAgent: { count: 0, tokens: 0 }, recoveredSetAside: 0 };
}

function emptyTotals(): UsageTotals {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, estimatedTokens: 0, peakContextTokens: 0, uncachedShare: null };
}

function addUsage(totals: UsageTotals, snapshot: LedgerSnapshot, usage: ReportedUsage | undefined): void {
  totals.requests += 1;
  totals.estimatedTokens += snapshot.estimatedTokens;
  const reportedContext = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
  if (usage) {
    totals.input += usage.input;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.output += usage.output;
  }
  totals.peakContextTokens = Math.max(totals.peakContextTokens, reportedContext > 0 ? reportedContext : snapshot.calibratedTokens);
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
  totals.uncachedShare = denominator > 0 ? totals.input / denominator : null;
}

function basename(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  return (normalized.slice(normalized.lastIndexOf("/") + 1) || normalized).toLowerCase();
}

/** Text the agent produced at or after `fromIndex`: what a later reference would appear in. */
function laterAgentText(messages: readonly AgentMessage[], fromIndex: number): string {
  const parts: string[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "tool_use") parts.push(JSON.stringify(block.input));
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * The tool-result section, from the latest snapshot. "Unreferenced" is a proxy: a read whose file's
 * name never appears again in anything the agent wrote or called. The newest two messages are
 * excluded, since nothing has had a chance to refer to them yet.
 */
export function toolResultStats(snapshot: LedgerSnapshot, messages: readonly AgentMessage[], ledger: ReportLedgerView): ToolResultStats {
  const stats: ToolResultStats = { count: 0, tokens: 0, superseded: { count: 0, tokens: 0 }, unreferenced: { count: 0, tokens: 0 }, repeatedReads: [] };
  const readCounts = new Map<string, number>();
  const settled = messages.length - 2;
  const textCache = new Map<number, string>();
  for (const item of snapshot.items) {
    if (item.class !== "tool-result") continue;
    stats.count += 1;
    stats.tokens += item.tokens;
    if (item.supersededBy) {
      stats.superseded.count += 1;
      stats.superseded.tokens += item.tokens;
    }
    const reads = ledger.readsOf(item.id);
    for (const read of reads) readCounts.set(read, (readCounts.get(read) ?? 0) + 1);
    if (reads.length === 0 || item.messageIndex === undefined || item.messageIndex >= settled) continue;
    const from = item.messageIndex + 1;
    let later = textCache.get(from);
    if (later === undefined) {
      later = laterAgentText(messages, from);
      textCache.set(from, later);
    }
    const names = reads.map(basename);
    if (!names.some((name) => name && later!.includes(name))) {
      stats.unreferenced.count += 1;
      stats.unreferenced.tokens += item.tokens;
    }
  }
  stats.repeatedReads = [...readCounts.entries()]
    .filter(([, reads]) => reads > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, REPEATED_READS_COUNT)
    .map(([path, reads]) => ({ path, reads }));
  return stats;
}

export class ContextReportAccumulator {
  private _turn = emptyTotals();
  private _session = emptyTotals();
  private readonly _byClass = new Map<ContextClass, { carried: number; peak: number }>();
  private readonly _items = new Map<string, CostlyItem>();
  private _latest: LedgerSnapshot | null = null;
  private _recoveryCalls = 0;
  private _aging: AgingStats = emptyAging();

  /** Fold in one request. `usage` is what the provider reported for it, when it did. */
  addRequest(snapshot: LedgerSnapshot, usage?: ReportedUsage): void {
    addUsage(this._turn, snapshot, usage);
    addUsage(this._session, snapshot, usage);
    this._latest = snapshot;
    for (const cls of CONTEXT_CLASSES) {
      const tokens = snapshot.byClass[cls].tokens;
      const entry = this._byClass.get(cls) ?? { carried: 0, peak: 0 };
      entry.carried += tokens;
      entry.peak = Math.max(entry.peak, tokens);
      this._byClass.set(cls, entry);
    }
    for (const item of snapshot.items) {
      const tracked = this._items.get(item.id);
      if (tracked) {
        tracked.tokens = item.tokens;
        tracked.carried += 1;
        tracked.carriedTokens += item.tokens;
      } else if (this._items.size < MAX_TRACKED_ITEMS) {
        this._items.set(item.id, { id: item.id, class: item.class, label: item.label, tokens: item.tokens, carried: 1, carriedTokens: item.tokens });
      }
    }
  }

  noteToolCall(toolName: string): void {
    if (RECOVERY_TOOLS.has(toolName)) this._recoveryCalls += 1;
  }

  /** One aging pass that found candidates. */
  noteAgingPass(outcome: "applied" | "observed" | "not-worth-it", count: number, tokens: number): void {
    this._aging.passes += 1;
    if (outcome === "applied") {
      this._aging.setAside.count += count;
      this._aging.setAside.tokens += tokens;
    } else if (outcome === "observed") {
      this._aging.wouldSetAside.count += count;
      this._aging.wouldSetAside.tokens += tokens;
    } else {
      this._aging.notWorthTheRewrite += 1;
    }
  }

  /** Results set aside outside a policy pass: by the agent, or by the emergency path. */
  noteSetAside(by: "agent" | "emergency", count: number, tokens: number): void {
    const bucket = by === "agent" ? this._aging.byAgent : this._aging.setAside;
    bucket.count += count;
    bucket.tokens += tokens;
  }

  noteRecoveredSetAside(): void {
    this._aging.recoveredSetAside += 1;
  }

  /** The report so far. `endTurn` starts the next turn's totals from zero. */
  report(options: { calibrationRatio: number | null; toolResults?: ToolResultStats | null; endTurn?: boolean }): ContextReport {
    const requests = Math.max(1, this._session.requests);
    const byClass = Object.fromEntries(CONTEXT_CLASSES.map((cls) => {
      const entry = this._byClass.get(cls) ?? { carried: 0, peak: 0 };
      return [cls, { carriedTokens: entry.carried, peakTokens: entry.peak, avgTokens: Math.round(entry.carried / requests) }];
    })) as Record<ContextClass, ClassStats>;
    const latest = this._latest;
    const report: ContextReport = {
      version: 1,
      turn: { ...this._turn },
      session: { ...this._session },
      byClass,
      latest: latest
        ? {
            estimatedTokens: latest.estimatedTokens,
            calibratedTokens: latest.calibratedTokens,
            byClassTokens: Object.fromEntries(CONTEXT_CLASSES.map((cls) => [cls, latest.byClass[cls].tokens])) as Record<ContextClass, number>,
            historyTokens: CONTEXT_CLASSES.filter((cls) => HISTORY_CLASSES.has(cls)).reduce((sum, cls) => sum + latest.byClass[cls].tokens, 0),
          }
        : null,
      costliest: [...this._items.values()]
        .sort((a, b) => b.carriedTokens - a.carriedTokens || a.id.localeCompare(b.id))
        .slice(0, COSTLIEST_COUNT)
        .map((item) => ({ ...item })),
      toolResults: options.toolResults ?? null,
      calibrationRatio: options.calibrationRatio,
      recoveryCalls: this._recoveryCalls,
      aging: structuredClone(this._aging),
    };
    if (options.endTurn) this._turn = emptyTotals();
    return report;
  }

  /** Whether anything was recorded this turn. */
  get turnRequests(): number {
    return this._turn.requests;
  }

  reset(): void {
    this._turn = emptyTotals();
    this._session = emptyTotals();
    this._byClass.clear();
    this._items.clear();
    this._latest = null;
    this._recoveryCalls = 0;
    this._aging = emptyAging();
  }
}

/** One line for the readable log. */
export function formatContextReportLine(report: ContextReport): string {
  const k = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));
  const pct = (n: number | null): string => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  const latest = report.latest;
  const parts = [
    `requests=${report.turn.requests}`,
    `in=${k(report.turn.input)}`,
    `cacheR=${k(report.turn.cacheRead)}`,
    `cacheW=${k(report.turn.cacheWrite)}`,
    `uncached=${pct(report.turn.uncachedShare)}`,
    `peak=${k(report.session.peakContextTokens)}`,
  ];
  if (latest) {
    parts.push(
      `history=${k(latest.historyTokens)}`,
      `attached=${k(latest.byClassTokens["attached-stable"] + latest.byClassTokens["attached-live"])}`,
      `tools=${k(latest.byClassTokens["tool-definition"])}`,
    );
  }
  if (report.toolResults) parts.push(`superseded=${k(report.toolResults.superseded.tokens)}`, `unreferenced=${k(report.toolResults.unreferenced.tokens)}`);
  if (report.aging.passes || report.aging.byAgent.count) {
    parts.push(`setAside=${report.aging.setAside.count}/${k(report.aging.setAside.tokens)}`);
    if (report.aging.wouldSetAside.count) parts.push(`wouldSetAside=${report.aging.wouldSetAside.count}/${k(report.aging.wouldSetAside.tokens)}`);
    if (report.aging.byAgent.count) parts.push(`byAgent=${report.aging.byAgent.count}/${k(report.aging.byAgent.tokens)}`);
  }
  if (report.calibrationRatio != null) parts.push(`calib=${report.calibrationRatio.toFixed(2)}`);
  return parts.join("  ");
}
