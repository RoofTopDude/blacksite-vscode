import { analyzeTrace, normalizeTrace, getProfile, getContextHogs } from "pau-profiler";
import type { CategorySummary, TokenAccountingGrade } from "pau-profiler";

/**
 * Read-only context-utilization instrumentation, built on the companion open-source library
 * pau-profiler (github.com/RoofTopDude/pau-profiler). This module has no knowledge of
 * AgentMessage/ContentBlock — the caller (agent-session.ts) already owns the per-provider wire
 * conversion, so it hands over an already-shaped trace input plus a format label. Nothing here
 * can affect what gets sent to a model: it only ever runs against a message array that has
 * already been dispatched, and every entry point is wrapped so a failure here can't reach the
 * agent loop (mirrors the resilience compressor.ts already documents for background compaction).
 */

const TOP_HOG_COUNT = 10;

export interface PauCaptureInput {
  /** `{ system, messages }` for the Anthropic-shaped path (Anthropic-direct, Bedrock Mantle), or
   *  an OpenAI-shaped messages array (system already folded in as the first message) for OpenAI/
   *  OpenRouter. Bedrock Converse has no supported format — callers must not reach this function
   *  for it (see `pauTraceFormatFor`). */
  traceInput: unknown;
  format: "anthropic" | "openai";
  runId: string;
  model: string;
  provider: string;
  contextWindow?: number;
  /** Aggregate input tokens actually reported by the provider for this turn (inputTokens +
   *  cacheReadTokens + cacheWriteTokens) — reconciled against the heuristic per-segment estimate
   *  to grade accounting fidelity. */
  providerTokenTotal?: number;
}

export interface PauReceiptTopHog {
  id: string;
  type: string;
  source?: string;
  tokens: number;
  pau: number;
  pauShare: number;
  duplicateRatio: number;
  replayCount: number;
  effectiveHogScore: number;
  hogSeverity: string;
  recommendations: string[];
}

export interface PauReceiptSummary {
  capturedAt: number;
  runId?: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
  totalTokens: number;
  totalPAU: number;
  tokenAccountingGrade: TokenAccountingGrade;
  tokenAccountingNote: string;
  rawUtilization: number | null;
  pauUtilization: number | null;
  duplicateTokenRatio: number;
  replayTokens: number;
  replayOverheadRatio: number;
  maxHogScore: number;
  contextHealthScore: number;
  categories: CategorySummary[];
  warnings: string[];
  /** Ranked by getContextHogs, capped — the full per-segment array (one entry per message/tool
   *  block) is not retained, so a long session can't grow this receipt unbounded. */
  topHogs: PauReceiptTopHog[];
}

export type PauReceipt =
  | { skipped: true; reason: string }
  | ({ skipped: false } & PauReceiptSummary);

/** Maps this session's provider/API choice onto a pau-profiler trace format, or null when
 *  there's no supported shape yet. Bedrock Converse's ContentBlock shape (toolUse/toolResult)
 *  doesn't match pau-profiler's Anthropic adapter (tool_use/tool_result) or its OpenAI one —
 *  scoped out of v1 rather than risk a silently-wrong analysis; a small custom adapter is the
 *  natural fast-follow once the rest of this feature is validated against real sessions. */
export function pauTraceFormatFor(provider: string, useResponsesApi?: boolean, bedrockApi?: string): "anthropic" | "openai" | null {
  void useResponsesApi; // Responses API bodies are approximated via the same Chat-Completions-shaped conversion — see agent-session.ts.
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai" || provider === "openrouter") return "openai";
  if (provider === "bedrock") return bedrockApi === "mantle" ? "anthropic" : null;
  return null;
}

export function capturePauReceipt(input: PauCaptureInput): PauReceipt {
  try {
    const trace = normalizeTrace(input.traceInput, {
      format: input.format,
      runId: input.runId,
      model: input.model,
      provider: input.provider,
      contextWindow: input.contextWindow,
      providerTokenTotal: input.providerTokenTotal,
      // Blacksite only has an aggregate per-turn token count (usage_update), never exact
      // per-segment counts — heuristic mode is exactly the scenario pau-profiler's
      // providerTokenTotal reconciliation and accounting-grade system were designed for.
      analysisMode: "heuristic",
    });
    const receipt = analyzeTrace(trace, { profile: getProfile("coding") });
    const topHogs = getContextHogs(receipt)
      .slice(0, TOP_HOG_COUNT)
      .map((segment): PauReceiptTopHog => ({
        id: segment.id,
        type: segment.type,
        source: segment.source,
        tokens: segment.tokens,
        pau: segment.pau,
        pauShare: segment.pauShare,
        duplicateRatio: segment.duplicateRatio,
        replayCount: segment.replayCount,
        effectiveHogScore: segment.effectiveHogScore,
        hogSeverity: segment.hogSeverity,
        recommendations: segment.recommendations,
      }));
    return {
      skipped: false,
      capturedAt: Date.now(),
      runId: receipt.runId,
      model: receipt.model,
      provider: receipt.provider,
      contextWindow: receipt.contextWindow,
      totalTokens: receipt.totalTokens,
      totalPAU: receipt.totalPAU,
      tokenAccountingGrade: receipt.tokenAccountingGrade,
      tokenAccountingNote: receipt.tokenAccountingNote,
      rawUtilization: receipt.rawUtilization,
      pauUtilization: receipt.pauUtilization,
      duplicateTokenRatio: receipt.duplicateTokenRatio,
      replayTokens: receipt.replayTokens,
      replayOverheadRatio: receipt.replayOverheadRatio,
      maxHogScore: receipt.maxHogScore,
      contextHealthScore: receipt.contextHealthScore,
      categories: receipt.categories,
      warnings: receipt.warnings,
      topHogs,
    };
  } catch (err) {
    return { skipped: true, reason: `analysis-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
