/* Motion vocabulary for the Codebase Map's relationship flows.

   Every animated edge used to look the same: one dot, constant speed, same
   period, whatever the edge actually meant. That reads as decoration. Here each
   relationship kind gets a motion that behaves like the thing it denotes, so the
   map can be read by movement before any label is examined:

     import        stream            a steady structural current, always running
     api           request-response  a pulse out, then a dimmer one back — a call and its reply
     event         broadcast         a burst fired and forgotten, dissipating before it lands
     data          exchange          two particles passing in opposite directions over a shared store
     config        settle            one slow, faint drift — read once, then it just is
     call          impulse           quiet, then a fast dart with a comet trail
     reference     stream (slow)     passive use: barely moving, low contrast
     supertype     ascend            child → parent, decelerating into place, then still

   Pure in (signature, seed, now): no DOM, no pixi, no mutable accumulators, so
   the whole vocabulary is unit-testable and resumable after the view was hidden.
   The renderer's only job is to place `t` along the arc it already computes. */

import type { EdgeKind, SymbolRelation } from "./protocol";
import { flowPhase } from "./edges";

export type FlowMotion =
  | "stream"
  | "request-response"
  | "broadcast"
  | "exchange"
  | "settle"
  | "impulse"
  | "ascend"
  /** A dependency starts to move, stalls before the blocker, then dissipates. */
  | "gate";

export interface FlowSignature {
  motion: FlowMotion;
  /** One full cycle. Slower = more structural/passive, faster = more eventful. */
  periodMs: number;
  /** Particles in flight per cycle (per burst, for broadcast). */
  particles: number;
  /** Base dot radius in world units. */
  radius: number;
  /** Peak alpha; the per-particle envelope scales this down. */
  intensity: number;
}

/** One particle to draw this frame. `t` is the fraction along the edge measured
    from its `from` end, so a reverse-travelling particle still reports where it
    is — not how far it has gone. */
export interface FlowParticle {
  t: number;
  alpha: number;
  radius: number;
  /** True when this particle is travelling to → from (a reply, or the return
      half of an exchange). Lets the renderer orient a trail or chevron. */
  reverse: boolean;
}

const EDGE_SIGNATURES: Partial<Record<EdgeKind, FlowSignature>> = {
  import:    { motion: "stream",           periodMs: 3400, particles: 2, radius: 1.4, intensity: 0.62 },
  api:       { motion: "request-response", periodMs: 2600, particles: 1, radius: 1.7, intensity: 0.82 },
  event:     { motion: "broadcast",        periodMs: 3000, particles: 3, radius: 1.5, intensity: 0.85 },
  data:      { motion: "exchange",         periodMs: 4200, particles: 1, radius: 1.5, intensity: 0.7 },
  config:    { motion: "settle",           periodMs: 6400, particles: 1, radius: 1.2, intensity: 0.45 },
  call:      { motion: "impulse",          periodMs: 2200, particles: 1, radius: 1.6, intensity: 0.88 },
  reference: { motion: "stream",           periodMs: 5200, particles: 2, radius: 1.1, intensity: 0.42 },
  supertype: { motion: "ascend",           periodMs: 3800, particles: 1, radius: 1.5, intensity: 0.72 },
  ticket_scope: { motion: "stream",        periodMs: 4200, particles: 1, radius: 1.25, intensity: 0.42 },
  ticket_blocked: { motion: "gate",        periodMs: 3600, particles: 1, radius: 1.7, intensity: 0.84 },
  ticket_overlap: { motion: "exchange",    periodMs: 4400, particles: 1, radius: 1.35, intensity: 0.68 },
};

const SYMBOL_SIGNATURES: Record<SymbolRelation, FlowSignature> = {
  reference:  EDGE_SIGNATURES.reference!,
  call:       EDGE_SIGNATURES.call!,
  implements: { motion: "ascend", periodMs: 4200, particles: 1, radius: 1.4, intensity: 0.66 },
  extends:    EDGE_SIGNATURES.supertype!,
};

/** Fallback for any edge kind without its own signature (notes, user links) —
    a plain slow current, so an unmapped kind still animates coherently rather
    than not at all. */
export const DEFAULT_SIGNATURE: FlowSignature = {
  motion: "stream", periodMs: 3600, particles: 1, radius: 1.3, intensity: 0.55,
};

export function signatureForEdgeKind(kind: EdgeKind): FlowSignature {
  return EDGE_SIGNATURES[kind] ?? DEFAULT_SIGNATURE;
}

export function signatureForSymbolRelation(relation: SymbolRelation): FlowSignature {
  return SYMBOL_SIGNATURES[relation] ?? DEFAULT_SIGNATURE;
}

/** Short human description of what a motion is saying — powers the map's
    motion key, so the vocabulary is learnable instead of merely decorative. */
export const MOTION_DESCRIPTIONS: Record<FlowMotion, string> = {
  "stream": "steady current — a standing structural dependency",
  "request-response": "a pulse out and a dimmer one back — a call and its reply",
  "broadcast": "a burst fired and forgotten, dissipating before it lands",
  "exchange": "two particles passing — both ends touch the same store",
  "settle": "one slow drift — read once, then simply in place",
  "impulse": "quiet, then a fast dart — a discrete call",
  "ascend": "rising into place and holding — inheritance, child to parent",
  "gate": "a flow that stalls before its dependency — blocked work",
};

/** Fade a particle in and out near the arc's ends so it never pops into
    existence on top of a star. */
function endFade(t: number, sharpness = 6): number {
  return Math.max(0, Math.min(1, t * sharpness, (1 - t) * sharpness));
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Deterministic [0,1) offset so edges of the same kind don't beat in lockstep. */
function seedOffset(seed: number): number {
  return ((seed % 1000) + 1000) % 1000 / 1000;
}

/**
 * The particles to draw for one edge this frame.
 *
 * Returns an empty array whenever the motion is in its quiet phase — an event
 * between bursts, an impulse between darts, an ascend that has already arrived.
 * That silence is the point: a broadcast that streams continuously is
 * indistinguishable from an import, and the map loses the distinction it was
 * drawn to make.
 */
export function flowParticles(signature: FlowSignature, seed: number, now: number): FlowParticle[] {
  /* Drop anything the eye couldn't resolve anyway. Motions that fade at the arc
     ends legitimately produce alpha-0 particles at their cycle boundaries;
     handing those to the renderer would cost a draw call per frame to paint
     nothing, and would let a caller mistake "invisible" for "in flight". */
  return computeParticles(signature, seed, now).filter((particle) => particle.alpha > 0.02);
}

function computeParticles(signature: FlowSignature, seed: number, now: number): FlowParticle[] {
  const offset = seedOffset(seed);
  const phase = (flowPhase(now, signature.periodMs) + offset) % 1;
  const { intensity, radius } = signature;

  switch (signature.motion) {
    case "request-response": {
      /* First 55% of the cycle carries the request outward, accelerating away
         from the caller; the rest carries a thinner, dimmer reply back. The
         asymmetry is the message: you can see which end initiated. */
      const SPLIT = 0.55;
      if (phase < SPLIT) {
        const local = phase / SPLIT;
        const t = easeInQuad(local);
        return [{ t, alpha: intensity * endFade(t), radius, reverse: false }];
      }
      const local = (phase - SPLIT) / (1 - SPLIT);
      const t = 1 - easeOutQuad(local);
      return [{ t, alpha: intensity * 0.55 * endFade(t), radius: radius * 0.72, reverse: true }];
    }

    case "broadcast": {
      /* A packet leaves the publisher in a short burst and dissolves partway
         across: the publisher does not wait, and nothing travels back. Most of
         the cycle is silence, which is what makes an event read as an event. */
      const BURST = 0.42;
      const REACH = 0.86;
      if (phase >= BURST) return [];
      const local = phase / BURST;
      const out: FlowParticle[] = [];
      for (let i = 0; i < signature.particles; i += 1) {
        /* Stagger the packet so it reads as several messages, not one blob. */
        const lag = (i / signature.particles) * 0.35;
        const travel = local - lag;
        if (travel <= 0) continue;
        const t = Math.min(REACH, travel * REACH * 1.6);
        /* Dissipating: alpha falls as it gets further from the publisher. */
        const decay = Math.max(0, 1 - travel * 1.35);
        const alpha = intensity * decay * endFade(t, 10);
        if (alpha <= 0.02) continue;
        out.push({ t, alpha, radius: radius * (1 - travel * 0.35), reverse: false });
      }
      return out;
    }

    case "exchange": {
      /* Both ends touch the same store, so traffic runs both ways at once.
         They brighten as they pass mid-arc — the moment the sharing is legible. */
      const forward = phase;
      const backward = 1 - phase;
      const crossing = 1 - Math.abs(0.5 - phase) * 2; // 0 at the ends, 1 mid-arc
      const alpha = intensity * (0.45 + crossing * 0.55);
      return [
        { t: forward, alpha: alpha * endFade(forward), radius, reverse: false },
        { t: backward, alpha: alpha * endFade(backward), radius, reverse: true },
      ];
    }

    case "settle": {
      /* Config is read once and then simply holds. One faint particle crosses
         slowly in the first third; the rest of the cycle is stillness. */
      const ACTIVE = 0.34;
      if (phase >= ACTIVE) return [];
      const local = phase / ACTIVE;
      const t = easeOutQuad(local);
      return [{ t, alpha: intensity * endFade(t, 4), radius, reverse: false }];
    }

    case "impulse": {
      /* Quiet, then a fast dart with a short comet trail behind it. Discrete,
         not continuous — a call happens, it isn't a standing current. */
      const DART = 0.3;
      if (phase >= DART) return [];
      const local = phase / DART;
      const head = easeOutQuad(local);
      const out: FlowParticle[] = [{ t: head, alpha: intensity * endFade(head, 8), radius, reverse: false }];
      for (let i = 1; i <= 3; i += 1) {
        const t = head - i * 0.055;
        if (t <= 0) break;
        const alpha = intensity * endFade(t, 8) * (1 - i / 4) * 0.6;
        if (alpha <= 0.02) continue;
        out.push({ t, alpha, radius: radius * (1 - i * 0.2), reverse: false });
      }
      return out;
    }

    case "ascend": {
      /* Inheritance points one way and doesn't loop: the particle rises toward
         the parent, decelerates into it, and holds there before the next one
         departs. Nothing ever travels back down. */
      const RISE = 0.62;
      if (phase >= RISE) return [];
      const local = phase / RISE;
      const t = easeOutQuad(local);
      /* Brightens as it arrives, rather than fading out at the target — the
         destination is the meaningful end of this relationship. */
      const arrival = 0.5 + easeOutQuad(local) * 0.5;
      return [{ t, alpha: intensity * arrival * endFade(t, 5), radius, reverse: false }];
    }

    case "gate": {
      /* A blocker must not look like a successful transfer: it reaches only
         partway across, pauses, and fades where it is impeded. */
      const TRAVEL = 0.46;
      const HOLD = 0.23;
      const REACH = 0.58;
      if (phase < TRAVEL) {
        const t = easeOutQuad(phase / TRAVEL) * REACH;
        return [{ t, alpha: intensity * endFade(t, 7), radius, reverse: false }];
      }
      if (phase < TRAVEL + HOLD) {
        const fade = 1 - (phase - TRAVEL) / HOLD;
        return [{ t: REACH, alpha: intensity * 0.72 * fade, radius: radius * (0.9 + fade * 0.1), reverse: false }];
      }
      return [];
    }

    case "stream":
    default: {
      const out: FlowParticle[] = [];
      const count = Math.max(1, signature.particles);
      for (let i = 0; i < count; i += 1) {
        const t = (phase + i / count) % 1;
        const alpha = intensity * endFade(t);
        if (alpha <= 0.02) continue;
        out.push({ t, alpha, radius, reverse: false });
      }
      return out;
    }
  }
}
