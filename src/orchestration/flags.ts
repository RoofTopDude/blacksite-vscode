/**
 * Feature flags for Orchestration 2.0 additions.
 *
 * Every orchestrator addition registers here with the value that reproduces today's behaviour
 * (its `baseline`). The replay suite (tests/eval) iterates this registry: each flag must be
 * declared in package.json with the baseline as its default, documented, and — at baseline —
 * leave every replayed scenario byte-identical to the recorded golden output. That is what makes
 * "turn it off" a real rollback rather than a hope.
 *
 * Pure: the host passes in a getter over its configuration, and tests pass a map.
 */

export type WorkContractsMode = "off" | "observe" | "enforce";

export interface OrchestrationFlags {
  /** #11. `observe` records contracts and receipts without changing behaviour; `enforce` adds
   *  scope gates and lets receipts decide loop outcomes. */
  workContracts: WorkContractsMode;
  /** #12. Builds the derived work graph and exposes its read-only queries. */
  workGraph: boolean;
}

export interface OrchestrationFlagSpec {
  id: keyof OrchestrationFlags;
  setting: string;
  /** Allowed values; booleans are listed as true/false. */
  values: readonly (string | boolean)[];
  /** The value that reproduces the behaviour before this addition existed. */
  baseline: string | boolean;
  /** A value that records more but must not change any outcome (shadow mode), when one exists. */
  shadow?: string | boolean;
  issue: number;
  rollback: string;
}

export const ORCHESTRATION_FLAGS: readonly OrchestrationFlagSpec[] = [
  {
    id: "workContracts",
    setting: "blacksite.orchestration.workContracts",
    values: ["off", "observe", "enforce"],
    baseline: "off",
    shadow: "observe",
    issue: 11,
    rollback: "Set to off. Contracts and receipts already written stay under .blacksite/orchestration and are not read.",
  },
  {
    id: "workGraph",
    setting: "blacksite.orchestration.workGraph",
    values: [true, false],
    baseline: false,
    issue: 12,
    rollback: "Set to false. The graph is derived and never written back, so nothing needs undoing.",
  },
];

export const BASELINE_ORCHESTRATION_FLAGS: OrchestrationFlags = Object.freeze({
  workContracts: "off",
  workGraph: false,
});

/** Read every flag, falling back to the baseline for anything missing or invalid. A mistyped
 *  setting must leave the product behaving as it did, never in a half-enabled state. */
export function readOrchestrationFlags(get: (setting: string) => unknown): OrchestrationFlags {
  const flags: Record<string, unknown> = { ...BASELINE_ORCHESTRATION_FLAGS };
  for (const spec of ORCHESTRATION_FLAGS) {
    let value: unknown;
    try {
      value = get(spec.setting);
    } catch {
      value = undefined;
    }
    flags[spec.id] = spec.values.includes(value as string | boolean) ? value : spec.baseline;
  }
  return flags as unknown as OrchestrationFlags;
}
