/**
 * Settings for the context-economy work (docs/context-economy-implementation-plan.md §7).
 *
 * Same shape as the orchestration flags (src/orchestration/flags.ts): every setting registers here
 * with the value that reproduces the behaviour before it existed, and a mistyped value falls back to
 * that baseline, never to a half-enabled state. Only settings that do something are registered; a
 * phase adds its setting when it is built.
 *
 * Pure: the host passes a getter over its configuration, tests pass a map.
 */

export type AgingMode = "off" | "observe" | "on";
export type AwarenessMode = "off" | "status" | "status+tool";

export interface ContextFlags {
  /** Phase 0. Per-request ledger snapshots, aggregated into a context report at the end of each
   *  turn and written to the execution log. Measurement only. */
  report: boolean;
  /** Phase 2. Send the stable part of the attached context behind a cache boundary instead of
   *  re-sending it uncached at the tail on every call. Changes cost, not what the agent sees. */
  stableCaching: boolean;
  /** Phase 3.1. An absolute ceiling, in tokens, at which history is aged and compacted, whatever
   *  the window. 0: none, and only the percentage of the window applies. */
  historyBudgetTokens: number;
  /** Phase 3.2. `observe` records what aging would set aside and changes nothing; `on` sets older
   *  tool output aside into the archive, behind a record that says how to read it back. */
  aging: AgingMode;
  /** Phase 3.6. Characters of one tool result sent inline. At the baseline, truncation keeps the
   *  head, as it always has; any other value keeps the head, the tail and the error lines. */
  inlineResultChars: number;
  /** Phase 4. `status`: a line of fact about the context in the live block. `status+tool`: also the
   *  `context` tool, to review the context, set results aside and leave a note for compaction. */
  awareness: AwarenessMode;
}

export interface ContextFlagSpec {
  id: keyof ContextFlags;
  setting: string;
  /** Allowed values, for an enumerated or boolean setting. */
  values?: readonly (string | boolean)[];
  /** Allowed range, for a numeric setting. A value outside it falls back to the baseline. */
  range?: { min: number; max: number };
  baseline: string | boolean | number;
  /** A value that records more but changes nothing, when one exists. */
  shadow?: string | boolean | number;
  rollback: string;
}

export const DEFAULT_INLINE_RESULT_CHARS = 20_000;

export const CONTEXT_FLAGS: readonly ContextFlagSpec[] = [
  {
    id: "report",
    setting: "blacksite.context.report",
    values: [true, false],
    baseline: false,
    rollback: "Set to false. Reports already written stay in the execution log; nothing reads them back.",
  },
  {
    id: "stableCaching",
    setting: "blacksite.context.stableCaching",
    values: [true, false],
    baseline: false,
    rollback: "Set to false. The next request carries the whole attached block at the tail again; the cache entry for the split layout simply expires.",
  },
  {
    id: "historyBudgetTokens",
    setting: "blacksite.context.historyBudgetTokens",
    range: { min: 0, max: 10_000_000 },
    baseline: 0,
    rollback: "Set to 0. Compaction and aging go back to the percentage of the window only.",
  },
  {
    id: "aging",
    setting: "blacksite.context.aging",
    values: ["off", "observe", "on"],
    baseline: "off",
    shadow: "observe",
    rollback: "Set to off. Results already set aside stay as records in history and can still be read back with tool_output_page.",
  },
  {
    id: "inlineResultChars",
    setting: "blacksite.context.inlineResultChars",
    range: { min: 2_000, max: 200_000 },
    baseline: DEFAULT_INLINE_RESULT_CHARS,
    rollback: "Set to 20000. Results already sent keep the shape they were sent in.",
  },
  {
    id: "awareness",
    setting: "blacksite.context.awareness",
    values: ["off", "status", "status+tool"],
    baseline: "off",
    rollback: "Set to off. The status line and the context tool go away on the next request; results the agent set aside stay readable with tool_output_page.",
  },
];

export const BASELINE_CONTEXT_FLAGS: ContextFlags = Object.freeze({
  report: false,
  stableCaching: false,
  historyBudgetTokens: 0,
  aging: "off",
  inlineResultChars: DEFAULT_INLINE_RESULT_CHARS,
  awareness: "off",
});

function accepts(spec: ContextFlagSpec, value: unknown): boolean {
  if (spec.range) return typeof value === "number" && Number.isFinite(value) && value >= spec.range.min && value <= spec.range.max;
  return (spec.values ?? []).includes(value as string | boolean);
}

export function readContextFlags(get: (setting: string) => unknown): ContextFlags {
  const flags: Record<string, unknown> = { ...BASELINE_CONTEXT_FLAGS };
  for (const spec of CONTEXT_FLAGS) {
    let value: unknown;
    try {
      value = get(spec.setting);
    } catch {
      value = undefined;
    }
    flags[spec.id] = accepts(spec, value) ? (spec.range ? Math.floor(value as number) : value) : spec.baseline;
  }
  return flags as unknown as ContextFlags;
}

/** What the static system prompt says about these settings. Fixed when a chat starts, so it is
 *  worded to stay true if a setting changes mid-chat. */
export function staticPromptOptions(flags: ContextFlags): { stableContext: boolean; contextAwareness: AwarenessMode; aging: boolean } {
  return { stableContext: flags.stableCaching, contextAwareness: flags.awareness, aging: flags.aging === "on" };
}

/** Whether any setting that needs the ledger's per-request view is on. */
export function contextLedgerActive(flags: ContextFlags): boolean {
  return flags.report || flags.aging !== "off" || flags.awareness !== "off" || flags.historyBudgetTokens > 0;
}
