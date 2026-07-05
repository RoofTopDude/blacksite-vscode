/* Pure trace decay model. Heat, pulse, and derived trace edges are all
   functions of (events, now, config) — no mutable accumulators — so rendering
   is resumable after the view was hidden and every rule is unit-testable. */

import type { TraceEvent, TraceKind } from "./protocol";

export const HEAT_CAP = 3;
export const PULSE_MS = 1200;
/** Trace streak edges stop rendering after this long regardless of fade. */
export const TRACE_EDGE_MAX_MS = 8000;

/* Write-ish activity outranks reads when tinting a node. */
const KIND_PRIORITY: Record<TraceKind, number> = { write: 5, edit: 4, shell: 3, read: 2, nav: 1 };

export interface TraceEdge {
  from: string;
  to: string;
  kind: TraceKind;
  at: number;
  laneId?: string;
}

/** Accumulated session heat for a node: sum of exponentially-decayed events. */
export function heatAt(events: readonly TraceEvent[], path: string, now: number, fadeMs: number): number {
  if (fadeMs <= 0) return 0;
  let heat = 0;
  for (const event of events) {
    if (event.path !== path) continue;
    const age = now - event.at;
    if (age < 0) continue;
    heat += Math.exp(-age / fadeMs);
    if (heat >= HEAT_CAP) return HEAT_CAP;
  }
  return Math.min(HEAT_CAP, heat);
}

/** Bright flash right after an event; linear falloff over PULSE_MS. */
export function pulseAt(events: readonly TraceEvent[], path: string, now: number): number {
  let pulse = 0;
  for (const event of events) {
    if (event.path !== path) continue;
    const age = now - event.at;
    if (age < 0 || age >= PULSE_MS) continue;
    pulse = Math.max(pulse, 1 - age / PULSE_MS);
  }
  return pulse;
}

/** Which activity kind tints the node: highest decayed weight, priority tiebreak. */
export function dominantKind(events: readonly TraceEvent[], path: string, now: number, fadeMs: number): TraceKind | null {
  if (fadeMs <= 0) return null;
  const weights = new Map<TraceKind, number>();
  for (const event of events) {
    if (event.path !== path) continue;
    const age = now - event.at;
    if (age < 0) continue;
    weights.set(event.kind, (weights.get(event.kind) ?? 0) + Math.exp(-age / fadeMs));
  }
  let best: TraceKind | null = null;
  let bestWeight = 0;
  for (const [kind, weight] of weights) {
    if (weight > bestWeight + 1e-9 || (Math.abs(weight - bestWeight) <= 1e-9 && best !== null && KIND_PRIORITY[kind] > KIND_PRIORITY[best])) {
      best = kind;
      bestWeight = weight;
    }
  }
  return best;
}

/** Directional streaks between consecutively-touched files, per lane — the
    "agent read A then wrote B" signature. Interleaved lanes never cross-link. */
export function deriveTraceEdges(events: readonly TraceEvent[]): TraceEdge[] {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const lastByLane = new Map<string, TraceEvent>();
  const edges: TraceEdge[] = [];
  for (const event of ordered) {
    const lane = event.laneId ?? "";
    const prev = lastByLane.get(lane);
    if (prev && prev.path !== event.path) {
      edges.push({
        from: prev.path,
        to: event.path,
        kind: event.kind,
        at: event.at,
        ...(event.laneId ? { laneId: event.laneId } : {}),
      });
    }
    lastByLane.set(lane, event);
  }
  return edges;
}

/** Which delegated lane currently owns a node's trace color. Parent-agent
    events have no lane id and fall back to kind color in the renderer. */
export function dominantLaneId(events: readonly TraceEvent[], path: string, now: number, fadeMs: number): string | null {
  if (fadeMs <= 0) return null;
  const weights = new Map<string, number>();
  for (const event of events) {
    if (event.path !== path || !event.laneId) continue;
    const age = now - event.at;
    if (age < 0) continue;
    weights.set(event.laneId, (weights.get(event.laneId) ?? 0) + Math.exp(-age / fadeMs));
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [laneId, weight] of weights) {
    if (weight > bestWeight + 1e-9 || (Math.abs(weight - bestWeight) <= 1e-9 && best !== null && laneId < best)) {
      best = laneId;
      bestWeight = weight;
    }
  }
  return best;
}

/** Streak opacity in [0,1] for a derived trace edge. */
export function traceEdgeAlpha(edge: TraceEdge, now: number, fadeMs: number): number {
  const age = now - edge.at;
  if (age < 0 || age >= Math.min(TRACE_EDGE_MAX_MS, fadeMs * 3)) return 0;
  return Math.exp(-age / Math.max(1, Math.min(fadeMs, TRACE_EDGE_MAX_MS / 2)));
}

/** Drop events too old to affect anything; enforce the ring-buffer cap. */
export function pruneTraces(events: readonly TraceEvent[], now: number, fadeMs: number, cap = 2000): TraceEvent[] {
  const horizon = Math.max(PULSE_MS, fadeMs * 3);
  const kept = events.filter((event) => now - event.at <= horizon);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/** True while any visual is still animating (pulses or live streaks). */
export function hasActiveAnimation(events: readonly TraceEvent[], now: number, fadeMs: number): boolean {
  const streakHorizon = Math.min(TRACE_EDGE_MAX_MS, fadeMs * 3);
  return events.some((event) => now - event.at < Math.max(PULSE_MS, streakHorizon));
}

/** Ambient star twinkle: a gentle per-node alpha multiplier in [0.86, 1.14].
    `seed` is a stable per-node hash so each star has its own phase and speed;
    pure in (seed, now) so it's testable and resumable. */
export function twinkleFactor(seed: number, now: number): number {
  const phase = ((seed % 9973) / 9973) * Math.PI * 2;
  const speed = 0.25 + (((seed >>> 8) % 977) / 977) * 0.5; // Hz-ish, slow
  return 1 + 0.14 * Math.sin((now / 1000) * speed * Math.PI * 2 + phase);
}
