import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  HttpError,
  StreamIdleTimeoutError,
  computeBackoffMs,
  isAbortError,
  isRetryableError,
  isRetryableStatus,
  isContextOverflowErrorMessage,
  extractContextOverflowLimit,
  isOutputTokenLimitErrorMessage,
  extractOutputTokenLimit,
  parseRetryAfter,
  retryAsync,
} from "../../src/provider-retry.js";

describe("isRetryableStatus", () => {
  it("retries rate limits, overload (529), request timeout, and transient 5xx", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504, 529]) expect(isRetryableStatus(s)).toBe(true);
  });
  it("does not retry client errors that signal a broken request", () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("output-limit correction", () => {
  it("extracts provider/model response ceilings from common rejection shapes", () => {
    const bedrock = "The maximum tokens you requested exceeds the model limit of 64000";
    expect(isOutputTokenLimitErrorMessage(bedrock)).toBe(true);
    expect(extractOutputTokenLimit(bedrock)).toBe(64_000);

    const openai = "max_output_tokens must be less than or equal to 128,000 tokens";
    expect(extractOutputTokenLimit(openai)).toBe(128_000);
  });

  it("does not confuse context or account throughput limits with an output ceiling", () => {
    expect(extractOutputTokenLimit("maximum context length is 128000 tokens")).toBeNull();
    expect(extractOutputTokenLimit("tokens per minute limit exceeded")).toBeNull();
  });
});

describe("isAbortError", () => {
  it("recognizes DOMException-style and errno abort shapes", () => {
    expect(isAbortError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbortError({ code: "ABORT_ERR" })).toBe(true);
    expect(isAbortError({ code: 20 })).toBe(true);
    expect(isAbortError(new Error("nope"))).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("never retries a user cancel, even wrapped as an HttpError-shaped thing", () => {
    expect(isRetryableError(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe(false);
  });
  it("delegates HttpError to its status", () => {
    expect(isRetryableError(new HttpError(429, "rate limited"))).toBe(true);
    expect(isRetryableError(new HttpError(400, "bad request"))).toBe(false);
  });
  it("retries stream idle timeouts and connection-drop shapes", () => {
    expect(isRetryableError(new StreamIdleTimeoutError())).toBe(true);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("boom"), { cause: { code: "ECONNRESET" } }))).toBe(true);
  });
  it("does not retry a plain non-network error", () => {
    expect(isRetryableError(new Error("schema validation failed"))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
  });
  it("parses an HTTP-date relative to now", () => {
    const now = 1_000_000;
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBeCloseTo(5, 0);
  });
  it("returns null for missing or garbage values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  const policy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 20_000 };
  it("honours Retry-After, capped at maxDelayMs", () => {
    expect(computeBackoffMs(0, policy, 3)).toBe(3000);
    expect(computeBackoffMs(0, policy, 999)).toBe(20_000);
  });
  it("grows exponentially with full jitter and never exceeds the ceiling", () => {
    // rand=1 yields the ceiling (base * 2^attempt), clamped to maxDelayMs.
    expect(computeBackoffMs(0, policy, null, () => 1)).toBe(1000);
    expect(computeBackoffMs(2, policy, null, () => 1)).toBe(4000);
    expect(computeBackoffMs(10, policy, null, () => 1)).toBe(20_000);
    // rand=0 yields no wait (pure jitter floor).
    expect(computeBackoffMs(3, policy, null, () => 0)).toBe(0);
  });
});

describe("retryAsync", () => {
  const noSleep = vi.fn(async () => undefined);

  it("retries transient failures and returns the eventual success", async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError(503, "overloaded");
        return "ok";
      },
      { sleep: noSleep, rand: () => 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("stops immediately on a non-retryable error", async () => {
    let calls = 0;
    await expect(retryAsync(
      async () => { calls += 1; throw new HttpError(400, "bad request"); },
      { sleep: noSleep },
    )).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(retryAsync(
      async () => { calls += 1; throw new HttpError(429, "slow down"); },
      { sleep: noSleep, policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }, rand: () => 0 },
    )).rejects.toThrow("slow down");
    expect(calls).toBe(3);
  });

  it("reports each retry via onRetry", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await retryAsync(
      async () => { calls += 1; if (calls < 2) throw new HttpError(500, "boom"); return 1; },
      { sleep: noSleep, onRetry, rand: () => 0 },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });

  it("does not retry once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(retryAsync(
      async () => { calls += 1; return "x"; },
      { sleep: noSleep, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  it("exposes a sane default policy", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs);
  });
});

describe("isContextOverflowErrorMessage", () => {
  it("recognizes the observed real-world provider phrasings", () => {
    expect(isContextOverflowErrorMessage("openrouter 402: Prompt tokens limit exceeded: 256772 > 229126")).toBe(true);
    expect(isContextOverflowErrorMessage("openai 400: This model's maximum context length is 128000 tokens.")).toBe(true);
    expect(isContextOverflowErrorMessage('{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(isContextOverflowErrorMessage("anthropic 400: prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
    expect(isContextOverflowErrorMessage("Input is too long for the requested model.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isContextOverflowErrorMessage("PROMPT TOKENS LIMIT EXCEEDED: 5 > 3")).toBe(true);
  });

  // A false positive here would mean a 402 that shrinking-and-retrying can never actually fix
  // (e.g. a genuinely empty account) still burns a wasted compaction pass before failing anyway
  // — annoying but bounded (MAX_INTERNAL_AUTO_CONTINUE_TURNS caps it), not a hang. Still worth
  // keeping these excluded since they're common and unrelated to prompt size.
  it("does not match unrelated 402/429 failures", () => {
    expect(isContextOverflowErrorMessage("This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 8733.")).toBe(false);
    expect(isContextOverflowErrorMessage("Rate limit reached for requests per minute.")).toBe(false);
    expect(isContextOverflowErrorMessage("Incorrect API key provided.")).toBe(false);
  });
});

describe("extractContextOverflowLimit", () => {
  it("extracts the real limit from an 'X > Y' shaped message", () => {
    expect(extractContextOverflowLimit("Prompt tokens limit exceeded: 256772 > 229126")).toBe(229126);
  });

  it("extracts the real limit from OpenAI's 'maximum context length is N tokens' phrasing", () => {
    expect(extractContextOverflowLimit("This model's maximum context length is 128000 tokens.")).toBe(128000);
  });

  it("handles thousands separators", () => {
    expect(extractContextOverflowLimit("limit exceeded: 256,772 > 229,126")).toBe(229126);
  });

  it("returns null when no limit can be parsed", () => {
    expect(extractContextOverflowLimit("context_length_exceeded")).toBeNull();
    expect(extractContextOverflowLimit("Incorrect API key provided.")).toBeNull();
  });
});
