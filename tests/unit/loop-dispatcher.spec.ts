import { describe, expect, it } from "vitest";
import { buildRetryContext, buildTicketTask, foldLaneStream, loopApprovalPolicy } from "../../src/loops/loop-dispatcher.js";
import type { SubagentProviderMessage } from "../../src/agent-session.js";
import type { Ticket, TicketStatus } from "../../src/ticket-store.js";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "BLK-7",
    title: "Rate limit the public API",
    status: "backlog" as TicketStatus,
    statusSource: "manual",
    priority: "normal",
    complexity: "medium",
    labels: [],
    acceptanceCriteria: [],
    territory: { files: [], areas: [] },
    references: [],
    runIds: [],
    blockedBy: [],
    blocks: [],
    relatedTo: [],
    assignee: "unassigned",
    origin: "user",
    events: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Ticket;
}

async function* streamOf(messages: SubagentProviderMessage[]): AsyncGenerator<SubagentProviderMessage> {
  for (const message of messages) yield message;
}

const laneStart = {
  type: "subagent_lane_start" as const,
  parentToolCallId: "loop:l1:BLK-7",
  laneId: "lane_1",
  subRequestId: "sub_1",
  label: "BLK-7",
  task: "…",
};

const budget = { complexity: "standard" as const, idleTimeoutSeconds: 120, maxRuntimeSeconds: 600, maxToolRounds: 6 };

function failureResult(overrides: Record<string, unknown> = {}): SubagentProviderMessage {
  return {
    type: "subagent_tool_result",
    result: {
      ok: false,
      subRequestId: "sub_1",
      error: "Tests did not pass.",
      failureKind: "error",
      budget,
      toolRounds: 4,
      elapsedMs: 1000,
      stopReason: "end_turn",
      partialAnswer: "",
      executionTrace: [],
      executionTraceTruncated: false,
      filesTouched: ["src/limiter.ts"],
      nextStep: "Read partialAnswer first.",
      ...overrides,
    },
  } as SubagentProviderMessage;
}

const NO_AUTO_APPROVE = { approvals: { autoApproveTiers: [], onGate: "park" as const, notify: true } };

describe("buildTicketTask", () => {
  it("puts acceptance criteria in verbatim as the definition of done", () => {
    const task = buildTicketTask(ticket({ acceptanceCriteria: ["429 after 100 req/min", "per-key, not per-IP"] }));
    expect(task).toContain("done when ALL of these hold");
    expect(task).toContain("429 after 100 req/min");
    expect(task).toContain("per-key, not per-IP");
  });

  it("asks the lane to state its own reading when the ticket has no criteria", () => {
    // A reviewer cannot judge "done" against criteria that do not exist, so the lane has to
    // surface the interpretation it actually used.
    const task = buildTicketTask(ticket());
    expect(task).toContain("no acceptance criteria");
    expect(task).toContain("what you took");
  });

  it("declares territory and asks the lane to flag reaching outside it", () => {
    const task = buildTicketTask(ticket({ territory: { files: ["src/limiter.ts"], areas: ["src/api"] } }));
    expect(task).toContain("src/limiter.ts");
    expect(task).toContain("src/api");
    expect(task).toContain("another lane may be running");
  });

  it("tells the lane nobody is watching and that it must not close the ticket", () => {
    const task = buildTicketTask(ticket());
    expect(task).toContain("Nobody is reading this in real time");
    expect(task).toContain("Do NOT mark the ticket done");
  });

  it("carries the description", () => {
    expect(buildTicketTask(ticket({ description: "Bucket per API key." }))).toContain("Bucket per API key.");
  });
});

describe("buildRetryContext", () => {
  it("tells the retry not to redo what worked and to change approach if that was the problem", () => {
    const context = buildRetryContext("Lane stalled — it produced nothing for 120s.");
    expect(context).toContain("Lane stalled");
    expect(context).toContain("Do not repeat the part that already worked");
    expect(context).toContain("take a different one");
  });
});

describe("foldLaneStream", () => {
  it("folds a successful lane into a success carrying its answer", async () => {
    const result = await foldLaneStream(streamOf([
      laneStart,
      {
        type: "subagent_tool_result",
        result: {
          ok: true, subRequestId: "sub_1", answer: "Added the limiter.", toolRounds: 3,
          usage: null, scratchFiles: [], budget,
        },
      } as SubagentProviderMessage,
    ]), NO_AUTO_APPROVE);

    expect(result).toMatchObject({ ok: true, laneId: "lane_1", subRequestId: "sub_1", detail: "Added the limiter." });
  });

  it("carries the lane's own retry guidance into detail rather than summarizing it", async () => {
    // detail is what the next attempt's prompt is built from; paraphrasing here would quietly
    // degrade every retry.
    const result = await foldLaneStream(streamOf([laneStart, failureResult()]), NO_AUTO_APPROVE);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Tests did not pass.");
    expect(result.detail).toContain("Read partialAnswer first.");
    expect(result.filesTouched).toEqual(["src/limiter.ts"]);
  });

  it("parks rather than fails when a gate the posture will not grant appears", async () => {
    const result = await foldLaneStream(streamOf([
      laneStart,
      {
        type: "subagent_lane_event",
        parentToolCallId: "x",
        laneId: "lane_1",
        event: { type: "approval_pending", toolCallId: "t1", description: "rm -rf build", tier: "destructive" },
      } as SubagentProviderMessage,
      failureResult(),
    ]), NO_AUTO_APPROVE);

    expect(result.parkedOnGate).toBe("destructive");
    expect(result.parkedSubRequestId).toBe("sub_1");
  });

  it("does not park on a tier the loop already auto-approves", async () => {
    const result = await foldLaneStream(streamOf([
      laneStart,
      {
        type: "subagent_lane_event",
        parentToolCallId: "x",
        laneId: "lane_1",
        event: { type: "approval_pending", toolCallId: "t1", description: "write a file", tier: "write" },
      } as SubagentProviderMessage,
      failureResult(),
    ]), { approvals: { autoApproveTiers: ["write"], onGate: "park", notify: true } });

    expect(result.parkedOnGate).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it("reports a lane that ended without a result as a failure rather than a silent success", async () => {
    const result = await foldLaneStream(streamOf([laneStart]), NO_AUTO_APPROVE);
    expect(result).toMatchObject({ ok: false, laneId: "lane_1" });
    expect(result.detail).toContain("without returning a result");
  });

  it("survives a stream that never opened a lane", async () => {
    const result = await foldLaneStream(streamOf([]), NO_AUTO_APPROVE);
    expect(result.ok).toBe(false);
    expect(result.laneId).toBeUndefined();
  });
});

describe("loopApprovalPolicy", () => {
  it("denies any tier the loop was not configured to auto-approve", () => {
    /* This is what makes the posture real. Before it existed the lane fell through to the
       interactive prompt: a modal nobody was present to answer, holding a worker until morning,
       while the configuration screen claimed writes were being auto-approved. */
    const policy = loopApprovalPolicy(["write"]);
    expect(policy("write", "file_write", "write src/a.ts")).toBe("allow");
    expect(policy("destructive", "shell_run", "rm -rf build")).toBe("deny");
    expect(policy("network", "http_get", "fetch example.com")).toBe("deny");
  });

  it("denies everything when nothing is auto-approved", () => {
    const policy = loopApprovalPolicy([]);
    for (const tier of ["write", "network", "destructive", "anything"]) {
      expect(policy(tier, "t", "d")).toBe("deny");
    }
  });

  it("never returns allow_always, which would widen standing project permissions", () => {
    // A loop running at 3am does not get to grant a permanent workspace-wide auto-approval.
    const policy = loopApprovalPolicy(["write", "network", "destructive"]);
    for (const tier of ["write", "network", "destructive"]) {
      expect(policy(tier, "t", "d")).toBe("allow");
    }
  });
});
