import { describe, expect, it } from "vitest";
import { mergeAsyncGenerators } from "../../src/agent-session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parallel subagent lanes are merged through mergeAsyncGenerators. A lane that is abandoned
 * rather than closed keeps running its subagent — still calling tools, still spending tokens —
 * against a turn that has already ended. These cover the three ways the merge can end.
 */
describe("mergeAsyncGenerators lane cleanup", () => {
  it("closes sibling lanes when one lane throws", async () => {
    const stepsAfterFailure: number[] = [];
    let closed = false;

    async function* failing(): AsyncGenerator<string> {
      // Lanes emit progress before they fail, so the merge is mid-stream when it throws.
      yield "A-started";
      await sleep(5);
      throw new Error("lane A failed");
    }

    async function* survivor(): AsyncGenerator<string> {
      try {
        for (let i = 0; i < 8; i += 1) {
          await sleep(10);
          stepsAfterFailure.push(i);
          yield `B${i}`;
        }
      } finally {
        closed = true;
      }
    }

    await expect(async () => {
      for await (const _event of mergeAsyncGenerators([failing(), survivor()])) {
        void _event;
      }
    }).rejects.toThrow("lane A failed");

    // The survivor unwinds at its next suspension point rather than running to completion.
    const atThrow = stepsAfterFailure.length;
    await sleep(120);
    expect(closed).toBe(true);
    expect(stepsAfterFailure.length - atThrow).toBeLessThanOrEqual(1);
    expect(stepsAfterFailure.length).toBeLessThan(8);
  });

  it("closes lanes when the consumer stops iterating early", async () => {
    let closed = false;
    const steps: number[] = [];

    async function* lane(): AsyncGenerator<string> {
      try {
        for (let i = 0; i < 8; i += 1) {
          await sleep(5);
          steps.push(i);
          yield `x${i}`;
        }
      } finally {
        closed = true;
      }
    }

    for await (const _event of mergeAsyncGenerators([lane()])) {
      void _event;
      break;
    }

    await sleep(80);
    expect(closed).toBe(true);
    expect(steps.length).toBeLessThan(8);
  });

  it("still yields every value when no lane fails", async () => {
    async function* lane(prefix: string, count: number): AsyncGenerator<string> {
      for (let i = 0; i < count; i += 1) {
        await sleep(1);
        yield `${prefix}${i}`;
      }
    }

    const seen: string[] = [];
    for await (const event of mergeAsyncGenerators([lane("a", 3), lane("b", 3)])) {
      seen.push(event);
    }

    expect(seen.sort()).toEqual(["a0", "a1", "a2", "b0", "b1", "b2"]);
  });
});
