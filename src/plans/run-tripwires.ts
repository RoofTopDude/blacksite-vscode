/**
 * Tripwires: what the harness watches for while nobody else is.
 *
 * Approvals judge what the agent says it is about to do. These judge what actually happened, from
 * facts the harness measured itself — the files a step changed on disk (shell commands included),
 * how fast money is going, the same failure coming back, a check that used to pass. None of them
 * reads the agent's account of its own work.
 *
 * A tripwire pauses the run with an explanation; it never undoes anything and never stops it for
 * good. The thresholds are deliberately loose: a false alarm costs the user a click on Resume, and
 * the point is to catch the run that has gone badly wrong, not to second-guess a large refactor.
 *
 * Pure. The service feeds the facts in and acts on what comes back.
 */

export type TripwireKind = "mass_delete" | "out_of_territory" | "spend_spike" | "repeated_failure" | "check_regressed";

export interface TripwireHit {
  kind: TripwireKind;
  /** One sentence for the user, saying what was seen. */
  detail: string;
  /** A few concrete examples (paths, the failing check), for the report. */
  examples?: string[];
}

export const TRIPWIRE_TITLES: Record<TripwireKind, string> = {
  mass_delete: "Many files were deleted",
  out_of_territory: "Work spread outside the plan",
  spend_spike: "Spending sped up sharply",
  repeated_failure: "The same failure keeps coming back",
  check_regressed: "A check that passed now fails",
};

export const MASS_DELETE_FILES = 25;
export const OUT_OF_TERRITORY_FILES = 15;
export const REPEATED_FAILURES = 6;
export const SPEND_WINDOW_MS = 10 * 60_000;
export const SPEND_MIN_RUN_MS = 20 * 60_000;
export const SPEND_SPIKE_FACTOR = 4;
export const SPEND_SPIKE_MIN_USD = 2;

/** A file a step changed, as the snapshot comparison saw it. `status` is git's: A, M, D, T. */
export interface StepChange {
  status: string;
  /** Workspace-relative, forward slashes. */
  path: string;
}

/** Files nobody would call "outside the plan" when they change: lockfiles and the like. */
const ALWAYS_IN_BOUNDS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|CHANGELOG\.md)$/i;

/** Lockfiles and the changelog: changing them is never "outside the plan". */
export function isAlwaysInBounds(file: string): boolean {
  return ALWAYS_IN_BOUNDS.test(normalize(file));
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Where the plan said it would work, as path prefixes. A declared file stands for its folder and
 * the folder above it, so tests beside the code and siblings of a named file are in bounds; a
 * declared folder stands for itself.
 */
export function territoryAreas(declared: readonly string[]): string[] {
  const areas = new Set<string>();
  for (const raw of declared) {
    const file = normalize(raw.trim());
    if (!file || file.startsWith("../") || /^[a-zA-Z]:\//.test(file) || file.startsWith("/")) continue;
    const parts = file.split("/");
    const looksLikeFolder = raw.trim().endsWith("/") || !/\.[^/.]+$/.test(parts.at(-1) ?? "");
    const folder = looksLikeFolder ? parts : parts.slice(0, -1);
    areas.add(folder.join("/"));
    if (folder.length > 1) areas.add(folder.slice(0, -1).join("/"));
  }
  return [...areas];
}

function inArea(file: string, areas: readonly string[]): boolean {
  return areas.some((area) => area === "" ? !file.includes("/") : file === area || file.startsWith(`${area}/`));
}

/** Check what one finished step changed on disk. */
export function checkStepChanges(changes: readonly StepChange[], declaredFiles: readonly string[]): TripwireHit[] {
  const hits: TripwireHit[] = [];
  const deleted = changes.filter((change) => change.status === "D").map((change) => normalize(change.path));
  if (deleted.length >= MASS_DELETE_FILES) {
    hits.push({
      kind: "mass_delete",
      detail: `The last step deleted ${deleted.length} files.`,
      examples: deleted.slice(0, 5),
    });
  }
  const areas = territoryAreas(declaredFiles);
  if (areas.length > 0) {
    const outside = changes
      .map((change) => normalize(change.path))
      .filter((file) => !ALWAYS_IN_BOUNDS.test(file) && !inArea(file, areas));
    if (outside.length >= OUT_OF_TERRITORY_FILES) {
      hits.push({
        kind: "out_of_territory",
        detail: `The last step changed ${outside.length} files outside the folders the plan names.`,
        examples: outside.slice(0, 5),
      });
    }
  }
  return hits;
}

export interface SpendSample {
  at: number;
  usd: number;
}

/**
 * Spending in the last ten minutes against the run's own average pace. Quiet for the first twenty
 * minutes, when there is no pace to compare against, and below a small absolute floor.
 */
export function checkSpendPace(samples: readonly SpendSample[], now: number, runStartedAt: number, activeMs: number): TripwireHit | undefined {
  if (now - runStartedAt < SPEND_MIN_RUN_MS || activeMs < SPEND_MIN_RUN_MS) return undefined;
  const total = samples.reduce((sum, sample) => sum + Math.max(0, sample.usd), 0);
  const recent = samples.filter((sample) => sample.at > now - SPEND_WINDOW_MS).reduce((sum, sample) => sum + Math.max(0, sample.usd), 0);
  const earlier = total - recent;
  const earlierMs = Math.max(activeMs - SPEND_WINDOW_MS, SPEND_WINDOW_MS);
  const usualPerWindow = earlier / (earlierMs / SPEND_WINDOW_MS);
  if (recent < SPEND_SPIKE_MIN_USD || recent < usualPerWindow * SPEND_SPIKE_FACTOR) return undefined;
  return {
    kind: "spend_spike",
    detail: `$${recent.toFixed(2)} went in the last ten minutes, against about $${usualPerWindow.toFixed(2)} per ten minutes before that.`,
  };
}

/** A stable key for "the same failure": the tool and the first line of what it said. */
export function failureSignature(toolName: string, message: string): string {
  const firstLine = message.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  // Numbers vary between otherwise identical failures (timings, line counts, ids).
  return `${toolName}\u0000${firstLine.replace(/\d+/g, "#").slice(0, 200)}`;
}

export function checkRepeatedFailure(count: number, toolName: string, message: string): TripwireHit | undefined {
  if (count < REPEATED_FAILURES) return undefined;
  const firstLine = message.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return {
    kind: "repeated_failure",
    detail: `${toolName} has failed the same way ${count} times during this step.`,
    examples: firstLine ? [firstLine.slice(0, 200)] : undefined,
  };
}

/** A step was marked done while a check that passed earlier in the run was failing. */
export function checkRegression(passedEarlier: ReadonlySet<string>, failingNow: string | undefined, stepTitle: string): TripwireHit | undefined {
  if (!failingNow || !passedEarlier.has(failingNow)) return undefined;
  return {
    kind: "check_regressed",
    detail: `"${stepTitle}" was marked done while ${failingNow}, which passed earlier in the run, was failing.`,
    examples: [failingNow],
  };
}
