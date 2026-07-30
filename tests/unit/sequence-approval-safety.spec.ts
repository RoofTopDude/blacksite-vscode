import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntime } from "@blacksite/local-runtime";
import { RunStore } from "../../src/runs/run-store";
import { SequenceService } from "../../src/sequences/sequence-service";

function runtime(handleMessage: LocalRuntime["handleMessage"]): LocalRuntime {
  return { handleMessage } as unknown as LocalRuntime;
}

function rpc(result: Record<string, unknown>) {
  return { id: "test", result };
}

function mixedPayload(command: string, args: string[]): Record<string, unknown> {
  return {
    title: "Approval attribution",
    target: { adapter: "workspace", workspace: "current" },
    steps: [
      { id: "read-first", action: "read_file", params: { path: "README.md" } },
      {
        id: "command-second",
        adapter: "process",
        action: "start",
        params: { command, args },
      },
      { id: "read-last", action: "read_file", params: { path: "package.json" } },
    ],
    capture_profile: "minimal",
    failure_policy: { mode: "stop_and_capture", retain_partial: true },
    limits: { max_steps: 10, max_duration_ms: 10_000, max_artifact_bytes: 1_000_000 },
  };
}

function runId(result: Record<string, unknown>): string {
  return String(result["runId"] ?? result["run_id"] ?? "");
}

describe("SequenceService process approval safety", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-approval-safety-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("attributes approval rejection to the gated command and terminalizes every other step", async () => {
    const handleMessage = vi.fn(async () => rpc({ ok: true }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(handleMessage),
    });
    const request = mixedPayload("npm", ["install"]);
    const pending = await service.dispatch("execute", request, {
      sessionId: "approval-reject",
    });
    expect(pending).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      tier: "network",
    });
    expect(store.getSteps(runId(pending))).toMatchObject([
      { id: "read-first", status: "pending" },
      { id: "command-second", status: "awaiting_approval" },
      { id: "read-last", status: "pending" },
    ]);

    service.rejectPendingApproval(request, { sessionId: "approval-reject" }, "Operator denied install.");

    expect(store.getRun(runId(pending))?.status).toBe("failed");
    expect(store.getSteps(runId(pending))).toMatchObject([
      { id: "read-first", status: "skipped" },
      {
        id: "command-second",
        status: "failed",
        failure: {
          category: "approval_denied",
          message: "Operator denied install.",
        },
      },
      { id: "read-last", status: "skipped" },
    ]);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("descopes external mutations before they can share a batch approval", async () => {
    const handleMessage = vi.fn(async () => rpc({ ok: true }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(handleMessage),
    });

    const result = await service.dispatch("execute", mixedPayload("git", ["push", "origin", "main"]), {
      sessionId: "external-mutation",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: expect.stringMatching(/external mutation.*outside retained sequence scope/i),
    });
    expect(store.getSteps(runId(result))).toMatchObject([
      { id: "read-first", status: "skipped" },
      { id: "command-second", status: "failed" },
      { id: "read-last", status: "skipped" },
    ]);
    const preflight = store.readEvents(runId(result), { limit: 50 })
      .find((event) => event.type === "preflight_completed");
    expect(preflight?.inlinePayload).toMatchObject({
      externalEffects: [{ stepId: "command-second", action: "start" }],
      deniedOperations: [{
        stepId: "command-second",
        reason: expect.stringMatching(/external mutation/i),
      }],
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });
});
