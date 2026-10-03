/* Version constraints as projects write them, and whether an installed version meets one.

   Each ecosystem spells "which version" differently: `requires-python = ">=3.10,<3.13"`,
   `.python-version` "3.12", `engines.node` "^20 || >=22", go.mod `go 1.22`, `<TargetFramework>`
   net8.0, a Java `release` of 17. They are all normalized into one small form here — a list of
   alternatives, each a list of comparisons — so the advisor can ask one question of any of them.

   Anything not understood is "unconstrained" rather than an error: a setup guide that refuses a
   project because of an exotic specifier helps nobody, and the verdict still cites the source. */

export type Comparison = { op: ">=" | ">" | "<=" | "<" | "=" | "~"; version: number[] };

export interface VersionSpec {
  /** As written in the source file. */
  raw: string;
  /** Any one alternative satisfies; within one, every comparison must hold. Empty: anything goes. */
  anyOf: Comparison[][];
}

export function parseVersion(value: string): number[] | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) return undefined;
  return match.slice(1).filter((part) => part !== undefined).map(Number);
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `a` begins with every part of `prefix` (3.12.4 matches 3.12). */
function hasPrefix(a: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((part, index) => a[index] === part);
}

function bump(version: readonly number[], at: number): number[] {
  const next = version.slice(0, at + 1).map((part, index) => (index === at ? part + 1 : part));
  return next;
}

/** One comparator token from the npm / PEP 440 family into comparisons. */
function parseComparator(token: string): Comparison[] | undefined {
  const text = token.trim().replace(/^v/i, "");
  if (!text || text === "*" || /^x$/i.test(text)) return [];
  const match = /^(\^|~=|~|>=|<=|>|<|==|=|!=)?\s*v?([0-9][0-9.xX*]*)/.exec(text);
  if (!match) return undefined;
  const op = match[1] ?? "";
  const digits = match[2]!.replace(/\.[xX*].*$/, "");
  const version = parseVersion(digits);
  if (!version) return undefined;
  if (op === "!=") return [];
  if (op === "^") {
    const at = version.findIndex((part) => part !== 0);
    return [{ op: ">=", version }, { op: "<", version: bump(version, at < 0 ? version.length - 1 : at) }];
  }
  if (op === "~=") return [{ op: ">=", version }, { op: "<", version: bump(version, Math.max(0, version.length - 2)) }];
  if (op === "~") return [{ op: ">=", version }, { op: "<", version: bump(version, Math.min(1, version.length - 1)) }];
  if (op === ">=" || op === "<=" || op === ">" || op === "<") return [{ op, version }];
  // A bare or "=="-prefixed version, or one with a wildcard: matches that version and its patches.
  return [{ op: "~", version }];
}

/** npm ranges (`^20 || >=22`, `18.x`), PEP 440 (`>=3.10,<3.13`, `~=3.11`), or a bare version. */
export function parseVersionSpec(raw: string): VersionSpec {
  // ">= 3.10" and ">=3.10" are the same; joining operator and version keeps the split below simple.
  const text = raw.trim().replace(/([<>=!~^]+)\s+(?=\d)/g, "$1");
  if (!text || /^(lts\/\*|lts|node|stable|latest|current|system)$/i.test(text)) return { raw, anyOf: [] };
  const anyOf: Comparison[][] = [];
  for (const alternative of text.split("||")) {
    const comparisons: Comparison[] = [];
    // npm hyphen ranges: "1.2 - 2.3".
    const hyphen = /^\s*([0-9][0-9.]*)\s+-\s+([0-9][0-9.]*)\s*$/.exec(alternative);
    if (hyphen) {
      comparisons.push({ op: ">=", version: parseVersion(hyphen[1]!)! }, { op: "~", version: parseVersion(hyphen[2]!)! });
      anyOf.push(comparisons);
      continue;
    }
    for (const token of alternative.split(/[,\s]+(?=[<>=!~^0-9v])/)) {
      const parsed = parseComparator(token);
      if (parsed) comparisons.push(...parsed);
    }
    anyOf.push(comparisons);
  }
  return { raw, anyOf: anyOf.some((alternative) => alternative.length === 0) ? [] : anyOf };
}

/** "At least this version" (go.mod `go 1.22`, a Java release, a .NET target framework). */
export function minimumSpec(raw: string, version: string): VersionSpec {
  const parsed = parseVersion(version);
  return { raw, anyOf: parsed ? [[{ op: ">=", version: parsed }]] : [] };
}

/** This version line and its patches (`.python-version` "3.12", `.nvmrc` "20"). */
export function lineSpec(raw: string, version: string): VersionSpec {
  const parsed = parseVersion(version);
  return { raw, anyOf: parsed ? [[{ op: "~", version: parsed }]] : [] };
}

function holds(version: readonly number[], comparison: Comparison): boolean {
  const cmp = compareVersions(version, comparison.version);
  switch (comparison.op) {
    case ">=": return cmp >= 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
    case "~": return hasPrefix(version, comparison.version);
  }
}

/** Whether `installed` meets `spec`. Undefined when the installed version is unknown. */
export function satisfies(installed: string | undefined, spec: VersionSpec): boolean | undefined {
  if (spec.anyOf.length === 0) return true;
  const version = installed ? parseVersion(installed) : undefined;
  if (!version) return undefined;
  return spec.anyOf.some((alternative) => alternative.every((comparison) => holds(version, comparison)));
}

export function isUnconstrained(spec: VersionSpec): boolean {
  return spec.anyOf.length === 0;
}

/**
 * The version to install for a spec: the newest line in `candidates` (newest first) that
 * satisfies it, or the spec's own lower bound when none of the candidates does.
 */
export function pickVersion(spec: VersionSpec, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) if (satisfies(candidate, spec)) return candidate;
  const bounds = spec.anyOf.flat().filter((comparison) => comparison.op === ">=" || comparison.op === "~" || comparison.op === "=");
  const lowest = bounds.sort((a, b) => compareVersions(a.version, b.version))[0];
  return lowest ? lowest.version.slice(0, 2).join(".") : undefined;
}
