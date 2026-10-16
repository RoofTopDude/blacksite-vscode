/**
 * What a replay (or a live run) achieved, measured the same way for every arm.
 *
 * Verified success comes from the independent verifier only (plan D6). What the system marked
 * done is counted separately as self-reported success, and the gap between them — completions
 * the verifier rejected — is reported on its own line rather than folded into either.
 */

export type Arm = "baseline" | "observe" | "enforce";

export interface Scorecard {
  scenario: string;
  subject: "loop" | "plan_run";
  arm: Arm;
  /** Tickets or plan steps in scope. */
  subjects: number;
  verifiedSuccess: number;
  selfReportedSuccess: number;
  /** Marked done by the system, rejected by the verifier. */
  falseCompletions: number;
  elapsedMs: number;
  costUsd: number;
  /** null when nothing was verified: cost per success is undefined, not zero and not infinite. */
  costPerVerifiedSuccess: number | null;
  /** Things a person had to do: resume, release, answer, stop. */
  interventions: number;
  /** Distinct failures seen more than once. */
  repeatedFailures: number;
  conflicts: { occurred: number };
  retries: number;
  parks: number;
  abandoned: number;
  halts: number;
  budgetStops: number;
  /** With work contracts on: how often the receipt agreed with the verifier. */
  receipts?: { agree: number; disagree: number; unknown: number };
}

export function costPer(costUsd: number, verified: number): number | null {
  return verified > 0 ? Math.round((costUsd / verified) * 10_000) / 10_000 : null;
}

/** Receipt statuses that claim the work is done. */
export function receiptClaimsSuccess(status: string): boolean {
  return status === "verified" || status === "succeeded_unverified";
}

/**
 * A receipt disagrees with the verifier when it says "verified" and the verifier failed the work,
 * or when it says the work failed and the verifier passed it. "Not verified" never disagrees: it
 * makes no claim either way.
 */
export function receiptAgreement(status: string | undefined, verdict: "pass" | "fail" | undefined): "agree" | "disagree" | "unknown" {
  if (!status || !verdict) return "unknown";
  if (status === "verified") return verdict === "pass" ? "agree" : "disagree";
  if (status === "failed") return verdict === "fail" ? "agree" : "disagree";
  return "unknown";
}

export interface ScorecardDelta {
  field: string;
  baseline: number | null;
  candidate: number | null;
  regression: boolean;
}

export interface CompareOptions {
  /** How much cost per verified success may rise, as a fraction (0.1 = 10%). */
  costTolerance?: number;
}

/**
 * Candidate against baseline, field by field. A regression is: fewer verified successes, more
 * false completions, more interventions, or cost per success up beyond the tolerance.
 */
export function compareScorecards(baseline: Scorecard, candidate: Scorecard, options: CompareOptions = {}): { deltas: ScorecardDelta[]; regressed: boolean } {
  const tolerance = options.costTolerance ?? 0.1;
  const fields: Array<[keyof Scorecard, (b: number | null, c: number | null) => boolean]> = [
    ["verifiedSuccess", (b, c) => (c ?? 0) < (b ?? 0)],
    ["falseCompletions", (b, c) => (c ?? 0) > (b ?? 0)],
    ["interventions", (b, c) => (c ?? 0) > (b ?? 0)],
    ["costPerVerifiedSuccess", (b, c) => b !== null && (c === null || c > b * (1 + tolerance))],
    ["selfReportedSuccess", () => false],
    ["costUsd", () => false],
    ["elapsedMs", () => false],
    ["retries", () => false],
    ["parks", () => false],
    ["repeatedFailures", () => false],
  ];
  const deltas = fields.map(([field, regressed]) => {
    const b = baseline[field] as number | null;
    const c = candidate[field] as number | null;
    return { field, baseline: b, candidate: c, regression: regressed(b, c) };
  });
  return { deltas, regressed: deltas.some((delta) => delta.regression) };
}

export function formatComparison(scenario: string, deltas: ScorecardDelta[]): string {
  const rows = deltas.map((delta) => `| ${delta.field} | ${delta.baseline ?? "—"} | ${delta.candidate ?? "—"} | ${delta.regression ? "**regressed**" : ""} |`);
  return [`### ${scenario}`, "", "| Metric | Baseline | Candidate | |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}
