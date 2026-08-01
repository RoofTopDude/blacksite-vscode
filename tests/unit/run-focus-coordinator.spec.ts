import { describe, expect, it, vi } from "vitest";
import { RunFocusCoordinator } from "../../src/runs/run-focus-coordinator.js";

describe("RunFocusCoordinator", () => {
  it("publishes an independent agent ghost cursor without trace payloads", () => {
    const coordinator = new RunFocusCoordinator();
    const listener = vi.fn();
    coordinator.onDidChange(listener);
    coordinator.publish({ runId: "run-1", source: "agent", reason: "Inspecting assertion", sequenceNumber: 42 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", sequenceNumber: 42 }));
    expect(coordinator.get("run-1")).toEqual(expect.objectContaining({ reason: "Inspecting assertion" }));
    expect(coordinator.get("run-1")).not.toHaveProperty("events");
  });
});
