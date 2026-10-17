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
export type SignalsMode = "off" | "observe" | "act";
export type ClaimsMode = "off" | "observe" | "enforce";
export type SchedulerMode = "legacy" | "shadow" | "graph";
export type VerificationLaneMode = "off" | "observe" | "enforce";
export type ProgressSignalsMode = "off" | "observe" | "nudge";

export interface OrchestrationFlags {
  /** #20. Watch for false progress: the same failure despite edits, edits undone and redone,
   *  reads that bring nothing new. `observe` reports; `nudge` also asks the agent to change tack. */
  progressSignals: ProgressSignalsMode;
  /** #18. The verification lane for loop tickets with a receipt. `observe` records a verdict on each
   *  iteration; `enforce` lets it send work back, park it, or label it unverified for review. */
  verificationLane: VerificationLaneMode;
  /** #18. An independent no-tools model review inside the verification lane. Metered. */
  verificationReviewer: boolean;
  /** #21. In graph scheduling, hold a ticket whose contract consumes what other open work has said
   *  it will produce, until that work is verified or closed and its output matches the pin. */
  integrationGate: boolean;
  /** #15 follow-up. Release review/closed tickets from explicit-ID loop queues. */
  explicitQueueStatusGuard: boolean;
  /** #16. The conductor may propose replans, delegation, verification or a block at milestones.
   *  Proposals are shown and deferred or rejected by the host; none is applied by the model. */
  strategicConductor: boolean;
  /** #17. Explicit read/write access to typed artifact exchange records. */
  artifactExchange: boolean;
  /** #20. Ignore volatile timing metadata when detecting duplicate tool rounds. */
  normalizeToolRounds: boolean;
  /** #11. `observe` records contracts and receipts without changing behaviour; `enforce` adds
   *  scope gates and lets receipts decide loop outcomes. */
  workContracts: WorkContractsMode;
  /** #12. Builds the derived work graph and exposes its read-only queries. */
  workGraph: boolean;
  /** #14. Typed signals from what the host observes, and consumers that reconcile loops and runs
   *  with them. `observe` journals signals and what consumers would do; `act` lets them do it. */
  signals: SignalsMode;
  /** #19. Short-lived claims on the files a delegated lane writes. `observe` records collisions;
   *  `enforce` refuses a write into a file another lane holds. */
  claims: ClaimsMode;
  /** #15. How a ticket loop orders and admits work. `shadow` records what the graph-aware
   *  scheduler would have chosen; `graph` uses it. Needs the work graph; legacy without it. */
  scheduler: SchedulerMode;
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
    id: "progressSignals",
    setting: "blacksite.orchestration.progressSignals",
    values: ["off", "observe", "nudge"],
    baseline: "off",
    shadow: "observe",
    issue: 20,
    rollback: "Set to off. Sessions stop watching for false progress; signals already reported stay in transcripts and run ledgers as history.",
  },
  {
    id: "verificationLane",
    setting: "blacksite.orchestration.verificationLane",
    values: ["off", "observe", "enforce"],
    baseline: "off",
    shadow: "observe",
    issue: 18,
    rollback: "Set to off. Verdicts already recorded stay on loop iterations as history; tickets are never closed by the lane, so nothing needs undoing.",
  },
  {
    id: "verificationReviewer",
    setting: "blacksite.orchestration.verificationReviewer",
    values: [true, false],
    baseline: false,
    issue: 18,
    rollback: "Set to false. The verification lane decides from host evidence only and makes no model calls.",
  },
  {
    id: "integrationGate",
    setting: "blacksite.orchestration.integrationGate",
    values: [true, false],
    baseline: false,
    issue: 21,
    rollback: "Set to false. Graph scheduling stops holding tickets on inputs other work produces; nothing is stored.",
  },
  {
    id: "strategicConductor",
    setting: "blacksite.orchestration.strategicConductor",
    values: [true, false],
    baseline: false,
    issue: 16,
    rollback: "Set to false. The conductor returns to continue, halt and ask only; proposals already shown stay in the transcript and are not acted on.",
  },
  {
    id: "explicitQueueStatusGuard",
    setting: "blacksite.orchestration.explicitQueueStatusGuard",
    values: [true, false],
    baseline: false,
    issue: 15,
    rollback: "Set to false. Explicit-ID queues return to their original status-blind membership; no ticket state is rewritten.",
  },
  {
    id: "artifactExchange",
    setting: "blacksite.orchestration.artifactExchange",
    values: [true, false],
    baseline: false,
    issue: 17,
    rollback: "Set to false. Exchange reads and writes stop; immutable records stay under .blacksite/orchestration/artifact-exchange.",
  },
  {
    id: "normalizeToolRounds",
    setting: "blacksite.orchestration.normalizeToolRounds",
    values: [true, false],
    baseline: false,
    issue: 20,
    rollback: "Set to false. Duplicate-round detection uses the original unnormalized results again; no durable state changes.",
  },
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
  {
    id: "signals",
    setting: "blacksite.orchestration.signals",
    values: ["off", "observe", "act"],
    baseline: "off",
    shadow: "observe",
    issue: 14,
    rollback: "Set to off. The journal under .blacksite/orchestration/signals is no longer written or read, and loops and runs behave as before.",
  },
  {
    id: "claims",
    setting: "blacksite.orchestration.claims",
    values: ["off", "observe", "enforce"],
    baseline: "off",
    shadow: "observe",
    issue: 19,
    rollback: "Set to off. Claims live in memory only, so nothing is left behind.",
  },
  {
    id: "scheduler",
    setting: "blacksite.orchestration.scheduler",
    values: ["legacy", "shadow", "graph"],
    baseline: "legacy",
    shadow: "shadow",
    issue: 15,
    rollback: "Set to legacy. Scheduling decisions already recorded stay on the loop as history and are not read.",
  },
];

export const BASELINE_ORCHESTRATION_FLAGS: OrchestrationFlags = Object.freeze({
  progressSignals: "off",
  verificationLane: "off",
  verificationReviewer: false,
  integrationGate: false,
  strategicConductor: false,
  explicitQueueStatusGuard: false,
  artifactExchange: false,
  normalizeToolRounds: false,
  workContracts: "off",
  workGraph: false,
  signals: "off",
  claims: "off",
  scheduler: "legacy",
});

/** Every flag at its shadow value where it has one: records everything, changes nothing. */
export const SHADOW_ORCHESTRATION_FLAGS: OrchestrationFlags = Object.freeze(Object.fromEntries(
  ORCHESTRATION_FLAGS.map((spec) => [spec.id, spec.shadow ?? spec.baseline]),
) as unknown as OrchestrationFlags);

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
