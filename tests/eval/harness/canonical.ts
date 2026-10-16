/** Deterministic JSON: sorted keys, undefined dropped, two-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = sortDeep(entry);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

/** A deterministic id source for injected stores and services. */
export function sequentialIds(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

export const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

/** Virtual time: everything a replay sees goes through this, nothing reads the wall clock. */
export class VirtualClock {
  now = EPOCH;
  readonly read = (): number => this.now;
  /** Milliseconds since the replay began, which is all a golden file records about time. */
  elapsed(at: number | string | undefined): number | undefined {
    if (at === undefined) return undefined;
    const ms = typeof at === "number" ? at : Date.parse(at);
    return Number.isFinite(ms) ? ms - EPOCH : undefined;
  }
}

/** Let promise chains and zero-delay timers settle. */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
