import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalFingerprint, armGateDeferral } from "../../src/gate-deferral.js";
import { settleRunGate, untrustedNetworkFloor, type RunGateRequest } from "../../src/plans/run-gate.js";

const push: RunGateRequest = {
  toolName: "shell_run",
  category: "command",
  tier: "network",
  description: "Run `git push origin main` (network operation)",
  input: { command: "git", args: ["push", "origin", "main"] },
};

describe("settleRunGate", () => {
  it("lets one repeat of a call the user approved from the queue through, and only one", () => {
    const approved = new Map([[approvalFingerprint(push.toolName, push.description), "D3"]]);
    const rules = { allow: [], takePreapproval: (fingerprint: string) => { const id = approved.get(fingerprint); approved.delete(fingerprint); return id; } };
    expect(settleRunGate(push, rules)).toMatchObject({ action: "allow", by: "earlier_answer", reason: "You approved this earlier (D3)." });
    expect(settleRunGate(push, rules)).toBeUndefined();
  });

  it("does not let an approval for one call cover a different one", () => {
    const approved = new Map([[approvalFingerprint(push.toolName, push.description), "D3"]]);
    const rules = { allow: [], takePreapproval: (fingerprint: string) => approved.get(fingerprint) };
    expect(settleRunGate({ ...push, description: "Run `git push --force origin main` (destructive operation)" }, rules)).toBeUndefined();
  });

  it("applies the run's charter, and nothing when the charter does not cover the call", () => {
    const rules = { allow: ["project_scripts" as const], takePreapproval: () => undefined };
    expect(settleRunGate({ ...push, tier: "write", description: "Run `npm test`", input: { command: "npm", args: ["test"] } }, rules))
      .toMatchObject({ action: "allow", by: "charter" });
    expect(settleRunGate(push, rules)).toBeUndefined();
  });
});

describe("untrustedNetworkFloor", () => {
  it("sends network operations and MCP calls to the user once untrusted content has been read", () => {
    expect(untrustedNetworkFloor({ ...push, untrustedSources: ["web"] })).toMatchObject({ action: "escalate", reason: expect.stringContaining("web pages") });
    expect(untrustedNetworkFloor({ tier: "write", category: "mcp", untrustedSources: ["mcp"] })?.action).toBe("escalate");
  });

  it("leaves local work and clean sessions to the usual rules", () => {
    expect(untrustedNetworkFloor({ tier: "write", category: "command", untrustedSources: ["web"] })).toBeUndefined();
    expect(untrustedNetworkFloor({ ...push, untrustedSources: [] })).toBeUndefined();
    expect(untrustedNetworkFloor(push)).toBeUndefined();
  });
});

describe("armGateDeferral", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("queues a gate still open when the grace period runs out", () => {
    const deferred = vi.fn();
    armGateDeferral(120_000, { stillOpen: () => true, queue: () => ({ id: "D1" }), deferred });
    vi.advanceTimersByTime(119_000);
    expect(deferred).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(deferred).toHaveBeenCalledWith("D1");
  });

  it("does nothing for an answered gate, a stopped clock, a run that stopped queueing, or no run", () => {
    const deferred = vi.fn();
    armGateDeferral(10, { stillOpen: () => false, queue: () => ({ id: "D1" }), deferred });
    const stop = armGateDeferral(10, { stillOpen: () => true, queue: () => ({ id: "D2" }), deferred });
    stop();
    armGateDeferral(10, { stillOpen: () => true, queue: () => undefined, deferred });
    const queue = vi.fn(() => ({ id: "D4" }));
    armGateDeferral(undefined, { stillOpen: () => true, queue, deferred });
    vi.advanceTimersByTime(1_000);
    expect(deferred).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
});
