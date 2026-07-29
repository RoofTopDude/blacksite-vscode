/* The point of the motion vocabulary is that the kinds are *distinguishable* —
   an event must not read like an import. These tests assert the behaviours that
   carry that meaning (silence, direction, decay, arrival), not exact easing
   numbers, so the curves stay tunable without the suite going red. */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNATURE,
  MOTION_DESCRIPTIONS,
  flowParticles,
  signatureForEdgeKind,
  signatureForSymbolRelation,
  type FlowMotion,
  type FlowParticle,
  type FlowSignature,
} from "../../src/webview/react/lib/graph/flow-signature.js";

/** Sample one full cycle at fine resolution — the only honest way to test a
    motion whose meaning lives in how it changes over time. */
function sampleCycle(signature: FlowSignature, seed = 0, steps = 240): FlowParticle[][] {
  const out: FlowParticle[][] = [];
  for (let i = 0; i < steps; i += 1) {
    out.push(flowParticles(signature, seed, (i / steps) * signature.periodMs));
  }
  return out;
}

const sig = (motion: FlowMotion): FlowSignature =>
  ({ motion, periodMs: 2000, particles: 3, radius: 1.5, intensity: 0.8 });

describe("signature lookup", () => {
  it("gives each relationship kind a motion that matches what it denotes", () => {
    expect(signatureForEdgeKind("api").motion).toBe("request-response");
    expect(signatureForEdgeKind("event").motion).toBe("broadcast");
    expect(signatureForEdgeKind("data").motion).toBe("exchange");
    expect(signatureForEdgeKind("config").motion).toBe("settle");
    expect(signatureForEdgeKind("call").motion).toBe("impulse");
    expect(signatureForEdgeKind("supertype").motion).toBe("ascend");
    expect(signatureForEdgeKind("ticket_blocked").motion).toBe("gate");
    expect(signatureForEdgeKind("ticket_overlap").motion).toBe("exchange");
    expect(signatureForEdgeKind("import").motion).toBe("stream");
  });

  it("maps symbol relations onto the same vocabulary", () => {
    expect(signatureForSymbolRelation("call").motion).toBe("impulse");
    expect(signatureForSymbolRelation("extends").motion).toBe("ascend");
    expect(signatureForSymbolRelation("implements").motion).toBe("ascend");
    expect(signatureForSymbolRelation("reference").motion).toBe("stream");
  });

  it("falls back to a coherent default for an unmapped kind", () => {
    expect(signatureForEdgeKind("ai")).toBe(DEFAULT_SIGNATURE);
    expect(flowParticles(DEFAULT_SIGNATURE, 0, 500).length).toBeGreaterThan(0);
  });

  it("describes every motion, so the map key can explain each one", () => {
    const motions: FlowMotion[] = ["stream", "request-response", "broadcast", "exchange", "settle", "impulse", "ascend", "gate"];
    for (const motion of motions) expect(MOTION_DESCRIPTIONS[motion]).toBeTruthy();
  });
});

describe("shared invariants", () => {
  const motions: FlowMotion[] = ["stream", "request-response", "broadcast", "exchange", "settle", "impulse", "ascend", "gate"];

  it("keeps every particle on the edge and within its intensity budget", () => {
    for (const motion of motions) {
      const signature = sig(motion);
      for (const frame of sampleCycle(signature)) {
        for (const particle of frame) {
          expect(particle.t).toBeGreaterThanOrEqual(0);
          expect(particle.t).toBeLessThanOrEqual(1);
          expect(particle.alpha).toBeGreaterThan(0);
          expect(particle.alpha).toBeLessThanOrEqual(signature.intensity + 1e-9);
          expect(particle.radius).toBeGreaterThan(0);
        }
      }
    }
  });

  it("is deterministic in (signature, seed, now) so animation survives being hidden", () => {
    for (const motion of motions) {
      const signature = sig(motion);
      expect(flowParticles(signature, 7, 1234)).toEqual(flowParticles(signature, 7, 1234));
      /* Same point in a later cycle → same output: resumable, not stateful. */
      expect(flowParticles(signature, 7, 1234)).toEqual(flowParticles(signature, 7, 1234 + signature.periodMs * 3));
    }
  });

  it("desynchronizes edges by seed so a bundle doesn't beat in lockstep", () => {
    const signature = sig("stream");
    const a = flowParticles(signature, 0, 500);
    const b = flowParticles(signature, 613, 500);
    expect(a[0]!.t).not.toBeCloseTo(b[0]!.t, 3);
  });
});

describe("stream — a standing current", () => {
  it("always has something in flight; an import is never 'off'", () => {
    for (const frame of sampleCycle(sig("stream"))) expect(frame.length).toBeGreaterThan(0);
  });

  it("only travels from → to", () => {
    for (const frame of sampleCycle(sig("stream"))) {
      for (const particle of frame) expect(particle.reverse).toBe(false);
    }
  });
});

describe("request-response — a call and its reply", () => {
  const signature = sig("request-response");

  it("sends the request outward, then answers back the other way", () => {
    const frames = sampleCycle(signature);
    expect(frames.some((f) => f.some((p) => !p.reverse))).toBe(true);
    expect(frames.some((f) => f.some((p) => p.reverse))).toBe(true);
  });

  it("makes the reply visibly quieter than the request, so the initiator is readable", () => {
    const frames = sampleCycle(signature);
    const request = Math.max(...frames.flat().filter((p) => !p.reverse).map((p) => p.alpha));
    const reply = Math.max(...frames.flat().filter((p) => p.reverse).map((p) => p.alpha));
    expect(reply).toBeLessThan(request);
  });

  it("never runs both directions at once — a reply follows, it doesn't accompany", () => {
    for (const frame of sampleCycle(signature)) {
      const directions = new Set(frame.map((p) => p.reverse));
      expect(directions.size).toBeLessThanOrEqual(1);
    }
  });
});

describe("broadcast — fired and forgotten", () => {
  const signature = sig("broadcast");

  it("goes silent for a real part of the cycle, which is what makes it not a stream", () => {
    const frames = sampleCycle(signature);
    const silent = frames.filter((f) => f.length === 0).length;
    expect(silent).toBeGreaterThan(frames.length * 0.4);
  });

  it("dissipates instead of arriving — nothing reaches the far end", () => {
    const maxT = Math.max(...sampleCycle(signature).flat().map((p) => p.t));
    expect(maxT).toBeLessThan(0.95);
  });

  it("fades as it travels, so the packet visibly decays", () => {
    const frames = sampleCycle(signature).filter((f) => f.length > 0);
    const early = frames[Math.floor(frames.length * 0.1)]!;
    const late = frames[frames.length - 1]!;
    expect(Math.max(...late.map((p) => p.alpha))).toBeLessThan(Math.max(...early.map((p) => p.alpha)));
  });

  it("emits a staggered packet rather than one blob", () => {
    const widest = sampleCycle(signature).reduce((best, f) => (f.length > best.length ? f : best), [] as FlowParticle[]);
    expect(widest.length).toBeGreaterThan(1);
    expect(new Set(widest.map((p) => p.t.toFixed(3))).size).toBe(widest.length);
  });

  it("never travels backwards — nobody replies to an event", () => {
    for (const frame of sampleCycle(signature)) {
      for (const particle of frame) expect(particle.reverse).toBe(false);
    }
  });
});

describe("exchange — a shared store, touched from both ends", () => {
  const signature = sig("exchange");

  it("runs both directions simultaneously whenever it is visible at all", () => {
    const frames = sampleCycle(signature);
    const visible = frames.filter((f) => f.length > 0);
    /* Only the instant both particles sit exactly on the endpoints is empty —
       the exchange is otherwise continuously legible, unlike broadcast/settle. */
    expect(visible.length).toBeGreaterThan(frames.length * 0.9);
    for (const frame of visible) {
      expect(frame.filter((p) => !p.reverse)).toHaveLength(1);
      expect(frame.filter((p) => p.reverse)).toHaveLength(1);
    }
  });

  it("brightens where the two cross, marking the sharing", () => {
    const frames = sampleCycle(signature);
    const middle = frames[Math.floor(frames.length / 2)]!;
    const nearEnd = frames[4]!;
    expect(Math.max(...middle.map((p) => p.alpha))).toBeGreaterThan(Math.max(...nearEnd.map((p) => p.alpha)));
  });
});

describe("settle — read once, then simply in place", () => {
  const signature = sig("settle");

  it("is still for most of the cycle", () => {
    const frames = sampleCycle(signature);
    expect(frames.filter((f) => f.length === 0).length).toBeGreaterThan(frames.length * 0.6);
  });

  it("carries at most one faint particle when it does move", () => {
    for (const frame of sampleCycle(signature)) expect(frame.length).toBeLessThanOrEqual(1);
  });
});

describe("impulse — a discrete call", () => {
  const signature = sig("impulse");

  it("is quiet for most of the cycle, then darts", () => {
    const frames = sampleCycle(signature);
    expect(frames.filter((f) => f.length === 0).length).toBeGreaterThan(frames.length * 0.6);
  });

  it("draws a trail behind the head, dimmer the further back it is", () => {
    const withTrail = sampleCycle(signature).find((f) => f.length > 2);
    expect(withTrail).toBeDefined();
    const sorted = [...withTrail!].sort((a, b) => b.t - a.t);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.alpha).toBeLessThan(sorted[i - 1]!.alpha);
      expect(sorted[i]!.radius).toBeLessThan(sorted[i - 1]!.radius);
    }
  });
});

describe("ascend — inheritance rises and holds", () => {
  const signature = sig("ascend");

  it("only ever travels child → parent", () => {
    for (const frame of sampleCycle(signature)) {
      for (const particle of frame) expect(particle.reverse).toBe(false);
    }
  });

  it("decelerates: it covers more ground early than late", () => {
    const ts = sampleCycle(signature).flat().map((p) => p.t);
    const first = ts.slice(0, Math.floor(ts.length / 2));
    const second = ts.slice(Math.floor(ts.length / 2));
    const firstSpan = Math.max(...first) - Math.min(...first);
    const secondSpan = Math.max(...second) - Math.min(...second);
    expect(firstSpan).toBeGreaterThan(secondSpan);
  });

  it("rests before the next one departs, so it reads as arrival not circulation", () => {
    const frames = sampleCycle(signature);
    expect(frames.filter((f) => f.length === 0).length).toBeGreaterThan(0);
  });
});
