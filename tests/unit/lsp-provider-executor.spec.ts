import { describe, expect, it, vi } from "vitest";
import { ProviderExecutor, type ProviderCommandRunner } from "../../src/lsp/provider-executor.js";

describe("ProviderExecutor", () => {
  it("keeps a successful empty result distinct from provider failure", async () => {
    const runner: ProviderCommandRunner = async <T>() => [] as T;
    const outcome = await new ProviderExecutor(runner).execute<unknown[]>("symbols");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.value).toEqual([]);
  });

  it("preserves provider rejection messages", async () => {
    const runner: ProviderCommandRunner = async () => { throw new Error("server crashed"); };
    const outcome = await new ProviderExecutor(runner).execute("hover");
    expect(outcome).toMatchObject({ status: "error", message: "server crashed", attempts: 1 });
  });

  it("distinguishes an unavailable provider from a valid empty collection", async () => {
    const runner: ProviderCommandRunner = async <T>() => undefined as T;
    await expect(new ProviderExecutor(runner).execute("symbols")).resolves.toMatchObject({ status: "unavailable" });
    await expect(new ProviderExecutor(runner).execute("side-effect", [], { allowUndefined: true })).resolves.toMatchObject({ status: "ok" });
  });

  it("warms up only successful empty results", async () => {
    let calls = 0;
    const runner: ProviderCommandRunner = async <T>() => (++calls < 3 ? [] : ["ready"]) as T;
    const outcome = await new ProviderExecutor(runner).execute<string[]>("symbols", [], {
      maxAttempts: 4,
      delayMs: 0,
      isEmpty: (value) => value.length === 0,
    });
    expect(outcome).toMatchObject({ status: "ok", value: ["ready"], attempts: 3, warmedUp: true });
  });

  it("uses one total deadline and reports timeout", async () => {
    vi.useFakeTimers();
    try {
      const runner: ProviderCommandRunner = <T>() => new Promise<T>(() => {});
      const result = new ProviderExecutor(runner).execute("definition", [], { totalTimeoutMs: 50, maxAttempts: 5 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(result).resolves.toMatchObject({ status: "timeout", attempts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the deadline between empty warm-up attempts", async () => {
    vi.useFakeTimers();
    try {
      const runner: ProviderCommandRunner = async <T>() => [] as T;
      const result = new ProviderExecutor(runner).execute<unknown[]>("symbols", [], {
        totalTimeoutMs: 50,
        maxAttempts: 10,
        delayMs: 30,
        isEmpty: (value) => value.length === 0,
      });
      await vi.advanceTimersByTimeAsync(60);
      await expect(result).resolves.toMatchObject({ status: "timeout", attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops local waiting when cancelled", async () => {
    const controller = new AbortController();
    const runner: ProviderCommandRunner = <T>() => new Promise<T>(() => {});
    const result = new ProviderExecutor(runner).execute("references", [], { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: "cancelled", attempts: 1 });
  });
});
