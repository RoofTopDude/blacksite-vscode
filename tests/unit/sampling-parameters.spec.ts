import { describe, expect, it } from "vitest";
import {
  SAMPLING_PARAMETERS, buildSamplingBody, normalizeSamplingValue, supportedSamplingParameters,
} from "../../src/sampling-parameters.js";

/* A representative OpenRouter `supported_parameters` row for a model that exposes the full
   sampling surface — the case that motivated this: the panel previously offered only
   temperature for these, regardless of what the catalog said they accept. */
const RICH_MODEL = [
  "max_tokens", "temperature", "top_p", "top_k", "min_p", "repetition_penalty",
  "frequency_penalty", "presence_penalty", "seed", "tools", "tool_choice",
];

describe("supportedSamplingParameters", () => {
  it("offers every control a richly-parameterised model reports", () => {
    expect(supportedSamplingParameters(RICH_MODEL).map((p) => p.key)).toEqual([
      "topP", "topK", "minP", "frequencyPenalty", "presencePenalty", "repetitionPenalty", "seed",
    ]);
  });

  it("offers only what a narrower model reports", () => {
    const keys = supportedSamplingParameters(["temperature", "top_p", "tools"]).map((p) => p.key);
    expect(keys).toEqual(["topP"]);
  });

  it("falls back to the OpenAI-compatible core when the catalog publishes no list", () => {
    // Guessing everything here would send top_k/min_p to endpoints that 400 on them.
    for (const supported of [undefined, []]) {
      expect(supportedSamplingParameters(supported).map((p) => p.key))
        .toEqual(["topP", "frequencyPenalty", "presencePenalty", "seed"]);
    }
  });

  it("ignores case and padding in catalog names", () => {
    expect(supportedSamplingParameters([" TOP_K "]).map((p) => p.key)).toEqual(["topK"]);
  });
});

describe("normalizeSamplingValue", () => {
  it("clamps to the control's declared range", () => {
    expect(normalizeSamplingValue("topP", 5)).toBe(1);
    expect(normalizeSamplingValue("topP", -1)).toBe(0);
    expect(normalizeSamplingValue("frequencyPenalty", -9)).toBe(-2);
  });

  it("rounds integer-valued controls", () => {
    expect(normalizeSamplingValue("topK", 40.6)).toBe(41);
    expect(normalizeSamplingValue("seed", 12.4)).toBe(12);
  });

  it("returns undefined for a non-numeric value rather than emitting NaN", () => {
    expect(normalizeSamplingValue("topP", "abc")).toBeUndefined();
    expect(normalizeSamplingValue("topP", undefined)).toBeUndefined();
    expect(normalizeSamplingValue("topP", NaN)).toBeUndefined();
  });

  it("accepts a numeric string, as an <input> would produce", () => {
    expect(normalizeSamplingValue("topP", "0.9")).toBeCloseTo(0.9);
  });
});

describe("buildSamplingBody", () => {
  it("maps configured values onto their wire names", () => {
    const body = buildSamplingBody({ topP: 0.9, topK: 40, seed: 7 }, RICH_MODEL);
    expect(body).toEqual({ top_p: 0.9, top_k: 40, seed: 7 });
  });

  it("omits controls the model does not accept, so they never reach the wire", () => {
    // top_k is configured but this model never advertised it.
    const body = buildSamplingBody({ topP: 0.9, topK: 40 }, ["temperature", "top_p"]);
    expect(body).toEqual({ top_p: 0.9 });
  });

  it("omits unset controls, leaving the model's own defaults in charge", () => {
    expect(buildSamplingBody({ topP: undefined, topK: 40 }, RICH_MODEL)).toEqual({ top_k: 40 });
    expect(buildSamplingBody({}, RICH_MODEL)).toEqual({});
    expect(buildSamplingBody(undefined, RICH_MODEL)).toEqual({});
  });

  it("clamps on the way out, so a persisted out-of-range value cannot 400 a request", () => {
    expect(buildSamplingBody({ topP: 99 }, RICH_MODEL)).toEqual({ top_p: 1 });
  });

  it("sends nothing at all for a model with no published parameters and no settings", () => {
    expect(buildSamplingBody({}, undefined)).toEqual({});
  });
});

describe("SAMPLING_PARAMETERS table", () => {
  it("has a unique key and wire name per control", () => {
    expect(new Set(SAMPLING_PARAMETERS.map((p) => p.key)).size).toBe(SAMPLING_PARAMETERS.length);
    expect(new Set(SAMPLING_PARAMETERS.map((p) => p.wire)).size).toBe(SAMPLING_PARAMETERS.length);
  });

  it("declares a coherent range, and a neutral value inside it where one exists", () => {
    for (const spec of SAMPLING_PARAMETERS) {
      expect(spec.min, spec.key).toBeLessThan(spec.max);
      expect(spec.step, spec.key).toBeGreaterThan(0);
      if (spec.neutral !== undefined) {
        expect(spec.neutral, spec.key).toBeGreaterThanOrEqual(spec.min);
        expect(spec.neutral, spec.key).toBeLessThanOrEqual(spec.max);
      }
    }
  });
});
