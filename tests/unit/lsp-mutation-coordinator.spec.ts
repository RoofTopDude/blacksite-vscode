import { describe, expect, it } from "vitest";
import { MutationCoordinator } from "../../src/lsp/mutation-coordinator.js";

describe("MutationCoordinator", () => {
  it("serializes the entire mutation callback", async () => {
    const coordinator = new MutationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = coordinator.run(async () => { events.push("first:start"); await gate; events.push("first:end"); });
    const second = coordinator.run(async () => { events.push("second:start"); events.push("second:end"); });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("shares one queue across sessions for the same workspace", () => {
    const first = MutationCoordinator.forWorkspace("C:/workspace/project");
    const second = MutationCoordinator.forWorkspace("C:/workspace/project/.");
    const other = MutationCoordinator.forWorkspace("C:/workspace/other");
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});
