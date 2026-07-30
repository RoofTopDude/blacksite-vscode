import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntime } from "@blacksite/local-runtime";
import type { BrowserRunner } from "../../src/chromium-runner";
import { RunStore } from "../../src/runs/run-store";
import { SequenceService } from "../../src/sequences/sequence-service";

type RuntimeMessage = Parameters<LocalRuntime["handleMessage"]>[0];
type RuntimeHandler = (
  message: RuntimeMessage,
  signal?: AbortSignal,
) => Promise<Awaited<ReturnType<LocalRuntime["handleMessage"]>>>;

function runtime(handler: RuntimeHandler): LocalRuntime {
  return { handleMessage: handler } as unknown as LocalRuntime;
}

function rpc(result: Record<string, unknown>) {
  return { id: "test", result };
}

function payload(
  title: string,
  adapter: string,
  steps: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title,
    target: { adapter, workspace: "current" },
    steps,
    capture_profile: "minimal",
    failure_policy: { mode: "stop_and_capture", retain_partial: true },
    limits: {
      max_steps: 20,
      max_duration_ms: 10_000,
      max_artifact_bytes: 1_000_000,
    },
    ...extra,
  };
}

function resultRunId(result: Record<string, unknown>): string {
  return String(result["runId"] ?? result["run_id"] ?? "");
}

describe("SequenceService conservative resume", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-resume-safety-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("treats an empty replacement tail as fallback and preserves assertions and dependencies", async () => {
    const handleMessage = vi.fn(async (message: RuntimeMessage) => {
      const requestedPath = String(message.payload?.["path"] ?? "");
      if (requestedPath === "gate.txt") return rpc({ ok: true, value: "wrong" });
      throw new Error(`Dependent action unexpectedly ran: ${requestedPath}`);
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(handleMessage),
    });
    const original = await service.dispatch("execute", payload(
      "Assertion contract",
      "workspace",
      [
        {
          id: "gate",
          action: "read_file",
          params: { path: "gate.txt" },
          assertions: [{ type: "equals", expected: "right" }],
        },
        {
          id: "dependent",
          action: "read_file",
          params: { path: "dependent.txt" },
          depends_on: ["gate"],
        },
      ],
    ), { sessionId: "resume-assertion-original" });
    expect(original).toMatchObject({ status: "failed", resume_capability: "logical" });
    expect(store.getSteps(resultRunId(original))).toMatchObject([
      {
        id: "gate",
        declaredAssertions: [{ type: "equals", input: { expected: "right" } }],
      },
      { id: "dependent", dependsOnStepIds: ["gate"] },
    ]);

    const resumed = await service.dispatch("resume", {
      run_id: resultRunId(original),
      replacement_steps: [],
    }, { sessionId: "resume-assertion-child" });

    expect(resumed).toMatchObject({ ok: false, status: "failed" });
    expect(String(resumed["error"] ?? "")).not.toMatch(/no unfinished steps/i);
    expect(store.getSteps(resultRunId(resumed))).toMatchObject([
      {
        id: "gate",
        status: "failed",
        assertionResults: [{ assertionType: "equals", passed: false }],
      },
      {
        id: "dependent",
        status: "skipped",
        dependsOnStepIds: ["gate"],
      },
    ]);
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects a skipped non-repeatable test run instead of executing it on resume", async () => {
    const handleMessage = vi.fn(async () => rpc({ ok: false, error: "read failed" }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(handleMessage),
    });
    const original = await service.dispatch("execute", payload(
      "Unsafe test tail",
      "workspace",
      [
        { id: "read", action: "read_file", params: { path: "bad.txt" } },
        { id: "tests", adapter: "test", action: "run", params: {} },
      ],
    ), { sessionId: "resume-test-original" });

    const resumed = await service.dispatch("resume", {
      run_id: resultRunId(original),
    }, { sessionId: "resume-test-child" });

    expect(resumed).toMatchObject({
      ok: false,
      recoverability: "manual_intervention",
      error: expect.stringMatching(/test:run/i),
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(store.listRuns({ parentRunId: resultRunId(original) }).matched).toBe(0);
  });

  it("rejects marker-only checkpoint restoration and a changed runtime fingerprint", async () => {
    const handleMessage = vi.fn(async (message: RuntimeMessage) => (
      String(message.payload?.["path"] ?? "") === "setup.txt"
        ? rpc({ ok: true, content: "ready" })
        : rpc({ ok: false, error: "failure" })
    ));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(handleMessage),
    });
    const original = await service.dispatch("execute", payload(
      "Checkpoint marker",
      "workspace",
      [
        { id: "setup", action: "read_file", params: { path: "setup.txt" }, checkpoint: true },
        { id: "failure", action: "read_file", params: { path: "failure.txt" } },
      ],
    ), { sessionId: "resume-checkpoint-original" });
    expect(original).toMatchObject({ last_checkpoint_id: "checkpoint-setup" });

    const checkpointed = await service.dispatch("resume", {
      run_id: resultRunId(original),
      from_checkpoint_id: "checkpoint-setup",
    }, { sessionId: "resume-checkpoint-child" });
    expect(checkpointed).toMatchObject({
      ok: false,
      checkpoint_capability: "marker_only",
      error: expect.stringMatching(/inspection markers/i),
    });

    store.updateRun(resultRunId(original), { environmentFingerprint: "different-runtime" });
    const changedEnvironment = await service.dispatch("resume", {
      run_id: resultRunId(original),
    }, { sessionId: "resume-environment-child" });
    expect(changedEnvironment).toMatchObject({
      ok: false,
      recoverability: "restart_required",
      environment_revalidation: { changed: true },
      error: expect.stringMatching(/runtime environment changed/i),
    });
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("replays the last successful local navigation before a browser observation tail", async () => {
    let textCalls = 0;
    const dispatch = vi.fn(async (action: string) => {
      if (action === "navigate") return { ok: true, url: "http://localhost:4173/account" };
      if (action === "get_text") {
        textCalls += 1;
        return textCalls === 1
          ? { ok: false, error: "transient browser failure" }
          : { ok: true, text: "Account" };
      }
      return { ok: false, error: `Unexpected action: ${action}` };
    });
    const browser: BrowserRunner = { dispatch, async dispose() {} };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: runtime(async () => rpc({ ok: false, error: "unused" })),
      browser,
    });
    const original = await service.dispatch("execute", payload(
      "Browser logical replay",
      "browser",
      [
        {
          id: "navigate-account",
          action: "navigate",
          params: { url: "http://localhost:4173/account" },
        },
        {
          id: "read-account",
          action: "get_text",
          params: { selector: "main" },
        },
      ],
    ), { sessionId: "resume-browser-original" });
    expect(original["status"]).toBe("partial");

    const resumed = await service.dispatch("resume", {
      run_id: resultRunId(original),
      replacement_steps: [],
    }, { sessionId: "resume-browser-child" });

    expect(resumed).toMatchObject({
      ok: true,
      status: "succeeded",
      resume_revalidation: {
        environmentChanged: false,
        workspaceChanged: false,
      },
    });
    expect(dispatch.mock.calls.map((call) => call[0])
      .filter((action) => action === "navigate" || action === "get_text")).toEqual([
      "navigate",
      "get_text",
      "navigate",
      "get_text",
    ]);
    expect(store.getSteps(resultRunId(resumed))).toMatchObject([
      { id: "navigate-account", status: "succeeded" },
      { id: "read-account", status: "succeeded" },
    ]);
  });
});
