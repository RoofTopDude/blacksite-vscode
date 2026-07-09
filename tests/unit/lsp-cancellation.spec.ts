import { describe, expect, it, vi } from "vitest";
import { withAbort, withDeadline } from "../../src/lsp-cancellation.js";

describe("withAbort", () => {
  it("passes the promise through unchanged when no signal is given", async () => {
    await expect(withAbort(Promise.resolve(42), undefined)).resolves.toBe(42);
    await expect(withAbort(Promise.reject(new Error("boom")), undefined)).rejects.toThrow("boom");
  });

  it("resolves normally when never aborted", async () => {
    const controller = new AbortController();
    await expect(withAbort(Promise.resolve("ok"), controller.signal)).resolves.toBe("ok");
  });

  it("rejects 'Cancelled.' immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const never = new Promise<number>(() => {}); // never settles
    await expect(withAbort(never, controller.signal)).rejects.toThrow("Cancelled.");
  });

  it("rejects 'Cancelled.' when aborted mid-flight, before the original promise settles", async () => {
    const controller = new AbortController();
    const never = new Promise<number>(() => {});
    const result = withAbort(never, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("Cancelled.");
  });

  it("preserves a genuine rejection from the original promise when not aborted", async () => {
    const controller = new AbortController();
    await expect(withAbort(Promise.reject(new Error("real failure")), controller.signal)).rejects.toThrow("real failure");
  });

  it("removes its abort listener once the promise settles normally", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await withAbort(Promise.resolve(1), controller.signal);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("withDeadline", () => {
  it("resolves the original value when it settles before the deadline", async () => {
    await expect(withDeadline(Promise.resolve("fast"), 1000)).resolves.toBe("fast");
  });

  it("resolves undefined (silently) on timeout", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<number>(() => {});
      const result = withDeadline(never, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a genuine rejection from the underlying promise unchanged", async () => {
    await expect(withDeadline(Promise.reject(new Error("provider error")), 1000)).rejects.toThrow("provider error");
  });

  it("rejects 'Cancelled.' when the signal aborts before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const never = new Promise<number>(() => {});
      const result = withDeadline(never, 1000, controller.signal);
      controller.abort();
      await expect(result).rejects.toThrow("Cancelled.");
    } finally {
      vi.useRealTimers();
    }
  });
});
