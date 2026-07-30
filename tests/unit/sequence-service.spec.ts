import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalRuntime } from "@blacksite/local-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRunner } from "../../src/chromium-runner";
import { RunStore } from "../../src/runs/run-store";
import { SequenceService } from "../../src/sequences/sequence-service";

type RuntimeMessage = {
  type: string;
  payload?: Record<string, unknown>;
};

function rpc(result: unknown): {
  jsonrpc: "2.0";
  id: 1;
  result: unknown;
} {
  return { jsonrpc: "2.0", id: 1, result };
}

function fakeRuntime(
  handleMessage: (
    message: RuntimeMessage,
    signal?: AbortSignal,
  ) => Promise<ReturnType<typeof rpc>>,
): LocalRuntime {
  return { handleMessage } as unknown as LocalRuntime;
}

function sequence(
  title: string,
  adapter: string,
  steps: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    title,
    target: {
      adapter,
      ...(adapter === "browser" ? { entrypoint: "http://localhost:4173/" } : { workspace: "current" }),
    },
    steps,
    failure_policy: { mode: "stop_and_capture", retain_partial: true },
    limits: {
      max_steps: 20,
      max_duration_ms: 10_000,
      max_artifact_bytes: 10 * 1024 * 1024,
    },
  };
}

function runId(result: Record<string, unknown>): string {
  const value = result["runId"];
  if (typeof value !== "string") throw new Error(`Expected runId, received ${String(value)}`);
  return value;
}

describe("SequenceService", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-sequence-service-"));
    store = new RunStore(root, { metadataMode: "json" }).open();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("executes workspace reads and test detection through the local runtime", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "a searchable needle\n");
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {};\n");
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: new LocalRuntime(root),
    });

    const result = await service.dispatch("execute", sequence(
      "Workspace evidence",
      "workspace",
      [
        {
          id: "read-notes",
          action: "read_file",
          params: { path: "notes.txt" },
          assertions: [{ type: "result_ok" }],
          entity_refs: [{
            scheme: "workspace-file",
            id: "notes.txt",
            workspacePath: "notes.txt",
          }],
        },
        {
          id: "search-notes",
          action: "search_files",
          params: { path: ".", pattern: "needle" },
          depends_on: ["read-notes"],
        },
        {
          id: "detect-tests",
          adapter: "test",
          action: "detect",
          params: { root },
          depends_on: ["search-notes"],
        },
      ],
    ), { sessionId: "session-workspace" });

    expect(result).toMatchObject({ ok: true, status: "succeeded" });
    const id = runId(result);
    expect(store.getRun(id)).toMatchObject({
      title: "Workspace evidence",
      summary: { title: "Workspace evidence" },
    });
    expect(store.getSteps(id)).toMatchObject([
      { id: "read-notes", status: "succeeded" },
      { id: "search-notes", status: "succeeded" },
      { id: "detect-tests", status: "succeeded" },
    ]);
    expect(store.readEvents(id, { limit: 100 }).map((event) => event.type))
      .toEqual(expect.arrayContaining([
        "workspace_read_file_result",
        "workspace_search_files_result",
        "test_detect_result",
        "assertion_passed",
      ]));

    const inspection = await service.dispatch("inspect", {
      run_id: id,
      seek: { query: "needle" },
      window: { before_events: 2, after_events: 2 },
    }, { sessionId: "session-workspace" });
    expect(inspection).toMatchObject({
      ok: true,
      step: { id: "search-notes" },
      window: { requestedBefore: 2, requestedAfter: 2 },
    });
    expect(inspection["events"]).toHaveLength(5);

    const search = await service.dispatch("search", {
      query: "Workspace evidence",
      scope: { status: "succeeded", file: "notes.txt" },
    }, { sessionId: "session-workspace" });
    expect(search).toMatchObject({
      ok: true,
      matched: 1,
      runs: [{ id, status: "succeeded" }],
    });
  });

  it("runs tests through the cancellable process adapter instead of the blocking harness", async () => {
    const handleMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === "test.detect") return rpc({ ok: true, framework: "vitest" });
      if (message.type === "system.process.start") {
        return rpc({
          ok: true,
          process: { handleId: "tests-1", status: "running" },
        });
      }
      if (message.type === "system.process.read_output") {
        return rpc({
          ok: true,
          process: { handleId: "tests-1", status: "completed", exitCode: 0 },
          output: {
            entries: [{ stream: "stdout", text: "Tests  2 passed | 1 skipped\n" }],
            nextCursor: 1,
          },
        });
      }
      return rpc({ ok: false, error: `Unexpected message ${message.type}` });
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(handleMessage),
    });

    const result = await service.dispatch("execute", sequence(
      "Focused tests",
      "test",
      [{ id: "run-tests", action: "run", params: { filter: "sequence" } }],
    ), { sessionId: "session-tests" });

    expect(result).toMatchObject({ ok: true, status: "succeeded" });
    expect(handleMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "test.detect",
      "system.process.start",
      "system.process.read_output",
    ]);
    expect(handleMessage.mock.calls[1]?.[0]).toMatchObject({
      type: "system.process.start",
      payload: {
        command: "npx",
        args: ["vitest", "run", "--reporter=default", "sequence"],
        confirmed: true,
      },
    });
    const event = store.readEvents(runId(result), {
      channels: ["log"],
      limit: 20,
    }).find((candidate) => candidate.type === "test_run_result");
    expect(event?.inlinePayload).toMatchObject({
      ok: true,
      framework: "vitest",
      passed: 2,
      skipped: 1,
      exitCode: 0,
    });
  });

  it("retains browser screenshots, structural state, and sanitized telemetry", async () => {
    const png = Buffer.from("fake png").toString("base64");
    const dispatch = vi.fn(async (toolType: string) => {
      if (toolType === "navigate") return { ok: true, url: "http://localhost:4173/home" };
      if (toolType === "screenshot") return { ok: true, dataUrl: `data:image/png;base64,${png}` };
      if (toolType === "capture_state") {
        return {
          ok: true,
          url: "http://localhost:4173/home?session=private",
          title: "Home",
          dom: "<main><h1>Home</h1></main>",
          accessibility: [{ role: "heading", name: "Home" }],
          viewport: { width: 1280, height: 720 },
          telemetrySequence: 1,
          telemetry: [{
            kind: "request",
            data: {
              method: "GET",
              url: "http://localhost:4173/api?token=private",
            },
          }],
        };
      }
      return { ok: false, error: `Unexpected browser action ${toolType}` };
    });
    const browser: BrowserRunner = {
      dispatch,
      async dispose() {},
    };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: false, error: "not used" })),
      browser,
    });

    const result = await service.dispatch("execute", sequence(
      "Captured browser route",
      "browser",
      [{
        id: "open-home",
        action: "navigate",
        params: { url: "http://localhost:4173/home" },
        capture: true,
        entity_refs: [{ scheme: "route", id: "/home" }],
      }],
    ), { sessionId: "session-browser" });

    expect(result).toMatchObject({ ok: true, status: "succeeded" });
    const id = runId(result);
    expect(dispatch.mock.calls.filter(([type]) => type === "capture_state")).toHaveLength(2);
    const observations = store.listObservations(id);
    expect(observations).toHaveLength(2);
    expect(observations.every((observation) => (
      observation.visualArtifactIds.length === 1
      && observation.structuralArtifactIds.length === 2
      && observation.stateArtifactIds.length === 1
    ))).toBe(true);
    expect(store.listArtifacts(id).map((artifact) => artifact.kind))
      .toEqual(expect.arrayContaining([
        "screenshot",
        "dom-snapshot",
        "accessibility-snapshot",
        "browser-state",
      ]));
    const networkEvents = store.readEvents(id, { channels: ["network"], limit: 20 });
    expect(networkEvents).toHaveLength(2);
    expect(JSON.stringify(networkEvents)).not.toContain("private");
    expect(networkEvents[0]?.entityRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scheme: "browser-request",
        id: expect.stringContaining("%5Bredacted%5D"),
      }),
    ]));

    const inspected = await service.dispatch("inspect", {
      run_id: id,
      seek: { observation_id: observations[0]?.id },
      include_artifact_data: true,
    }, { sessionId: "session-browser" });
    expect(inspected).toMatchObject({
      ok: true,
      mediaType: "image/png",
      mediaDataUrl: `data:image/png;base64,${png}`,
    });

    const capturedStep = store.getSteps(id)[0]!;
    const beforeInspection = await service.dispatch("inspect", {
      run_id: id,
      seek: { step_id: capturedStep.id, phase: "before" },
    }, { sessionId: "session-browser-before" });
    const afterInspection = await service.dispatch("inspect", {
      run_id: id,
      seek: { step_id: capturedStep.id, phase: "after" },
    }, { sessionId: "session-browser-after" });
    expect(beforeInspection).toMatchObject({
      observation: { id: capturedStep.beforeObservationId },
    });
    expect(afterInspection).toMatchObject({
      observation: { id: capturedStep.afterObservationId },
    });
    expect((afterInspection["artifacts"] as Array<{ observationId?: string }>).every((artifact) =>
      artifact.observationId === capturedStep.afterObservationId || artifact.observationId === undefined,
    )).toBe(true);
  });

  it("keeps dense count and time windows centered on their resolved event", async () => {
    const id = "dense-run";
    store.createRun({
      id,
      sequenceId: "dense-sequence",
      sequenceVersion: 1,
      status: "running",
      target: { adapterId: "workspace", type: "workspace" },
      adapterIds: ["workspace"],
      ticketIds: [],
      workspaceFingerprint: "workspace",
      environmentFingerprint: "environment",
      stepIds: [],
      checkpointIds: [],
      keyObservationIds: [],
      retentionClass: "temporary",
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: true, content: "done" })),
    });
    const denseEvents = store.appendEvents(
      id,
      Array.from({ length: 1_001 }, (_, index) => ({
        channel: "log" as const,
        type: `dense-${index}`,
        source: { adapterId: "workspace", producer: "unit-test" },
        entityRefs: [],
      })),
    );
    const anchor = denseEvents[500]!;

    for (const window of [
      { before_events: 500, after_events: 500 },
      { before_ms: 600_000, after_ms: 600_000 },
    ]) {
      const inspection = await service.dispatch("inspect", {
        run_id: id,
        seek: { event_id: anchor.id },
        window,
      }, { sessionId: "session-dense-inspect" });
      const events = inspection["events"] as Array<{ id: string }>;
      expect(events).toHaveLength(500);
      expect(events.some((event) => event.id === anchor.id)).toBe(true);
      expect(inspection["window"]).toMatchObject({
        effectiveBefore: 249,
        effectiveAfter: 250,
        truncated: true,
      });
    }
  });

  it("retains a completed mutation when after-action evidence capture throws", async () => {
    let screenshots = 0;
    const browser: BrowserRunner = {
      dispatch: vi.fn(async (toolType: string) => {
        if (toolType === "screenshot") {
          screenshots += 1;
          if (screenshots > 1) throw new Error("after capture failed");
          return {
            ok: true,
            dataUrl: `data:image/png;base64,${Buffer.from("before").toString("base64")}`,
          };
        }
        if (toolType === "capture_state") {
          return {
            ok: true,
            url: "http://localhost:4173/form",
            title: "Form",
            dom: "<main>Form</main>",
            accessibility: [],
            viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
            telemetry: [],
            telemetrySequence: 0,
          };
        }
        if (toolType === "click") return { ok: true };
        return { ok: false, error: `Unexpected browser action ${toolType}` };
      }),
      async dispose() {},
    };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: false, error: "not used" })),
      browser,
    });

    const result = await service.dispatch("execute", sequence(
      "Mutation capture failure",
      "browser",
      [{
        id: "submit",
        action: "click",
        params: { selector: "button[type=submit]" },
        capture: true,
      }],
    ), { sessionId: "mutation-capture-failure" });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      resume_capability: "none",
    });
    const step = store.getSteps(runId(result))[0];
    expect(step).toMatchObject({
      status: "failed",
      sideEffects: [{
        class: "network_write",
        reversible: false,
      }],
      failure: {
        recoverability: "manual_intervention",
        completedSideEffects: [{
          class: "network_write",
          reversible: false,
        }],
      },
    });
  });

  it("externalizes oversized adapter results and links the artifact from the event", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({
      index,
      diagnostic: `row-${index}-${"x".repeat(200)}`,
    }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: true, rows })),
    });

    const result = await service.dispatch("execute", sequence(
      "Large diagnostic",
      "workspace",
      [{ id: "large-read", action: "read_file", params: { path: "large.json" } }],
    ), { sessionId: "session-large-result" });

    expect(result["status"]).toBe("succeeded");
    const event = store.readEvents(runId(result), {
      channels: ["filesystem"],
      limit: 20,
    }).find((candidate) => candidate.type === "workspace_read_file_result");
    expect(event?.payloadArtifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(event?.inlinePayload).toMatchObject({
      ok: true,
      artifactId: event?.payloadArtifactId,
      resultKeys: ["ok", "rows"],
    });
    expect(JSON.stringify(event?.inlinePayload).length).toBeLessThan(1_000);
    const retained = JSON.parse(
      store.readArtifact(event?.payloadArtifactId ?? "").toString("utf8"),
    ) as { rows: Array<{ diagnostic: string }> };
    expect(retained.rows).toHaveLength(300);
    expect(retained.rows[299]?.diagnostic).toContain("row-299-");
  });

  it("creates one awaiting-approval run and resumes it only after confirmation", async () => {
    const handleMessage = vi.fn(async () => rpc({
      ok: true,
      process: { handleId: "process-1", status: "running" },
    }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(handleMessage),
    });
    const payload = sequence("Install dependencies", "process", [{
      id: "install",
      action: "start",
      params: { command: "npm", args: ["install"] },
    }]);

    const preflight = await service.dispatch("execute", payload, {
      sessionId: "session-approval",
    });
    expect(preflight).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      tier: "network",
    });
    const id = runId(preflight);
    expect(store.getRun(id)?.status).toBe("awaiting_approval");
    expect(store.getSteps(id)[0]?.status).toBe("awaiting_approval");
    expect(handleMessage).not.toHaveBeenCalled();

    const repeated = await service.dispatch("execute", payload, {
      sessionId: "session-approval",
    });
    expect(runId(repeated)).toBe(id);
    expect(store.listRuns({ limit: 10 }).runs).toHaveLength(1);

    const approved = await service.dispatch("execute", payload, {
      sessionId: "session-approval",
      confirmed: true,
    });
    expect(approved).toMatchObject({ ok: true, runId: id, status: "succeeded" });
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "system.process.start",
      payload: {
        command: "npm",
        args: ["install"],
        confirmed: true,
      },
    });

    const deniedHandle = vi.fn(async () => rpc({ ok: true }));
    const deniedService = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(deniedHandle),
      commandPolicy: () => ({ deniedCommands: ["npm"] }),
    });
    const denied = await deniedService.dispatch("execute", payload, {
      sessionId: "session-denied",
      confirmed: true,
    });
    expect(denied).toMatchObject({
      ok: false,
      status: "failed",
      error: expect.stringMatching(/explicitly denied by policy/i),
    });
    expect(deniedHandle).not.toHaveBeenCalled();
  });

  it("descopes destructive process commands instead of batch-approving them", async () => {
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: true })),
    });
    const result = await service.dispatch("execute", sequence(
      "Mixed command effects",
      "process",
      [
        {
          id: "destructive",
          action: "start",
          params: { command: "git", args: ["reset", "--hard"] },
        },
        {
          id: "network",
          action: "start",
          params: { command: "npm", args: ["install"] },
        },
      ],
    ), { sessionId: "highest-tier" });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: expect.stringMatching(/destructive command.*outside retained sequence scope/i),
    });
    expect(store.getSteps(runId(result))).toMatchObject([
      { id: "destructive", status: "failed" },
      { id: "network", status: "skipped" },
    ]);
  });

  it("re-evaluates command policy after a queued approval", async () => {
    let denyNpm = false;
    const handleMessage = vi.fn(async () => rpc({ ok: true }));
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(handleMessage),
      commandPolicy: () => ({ deniedCommands: denyNpm ? ["npm"] : [] }),
    });
    const payload = sequence("Policy changes", "process", [{
      id: "install",
      action: "start",
      params: { command: "npm", args: ["install"] },
    }]);

    const pending = await service.dispatch("execute", payload, {
      sessionId: "policy-revalidation",
    });
    expect(pending["requiresConfirmation"]).toBe(true);
    denyNpm = true;

    const result = await service.dispatch("execute", payload, {
      sessionId: "policy-revalidation",
      confirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      runId: runId(pending),
      status: "failed",
      error: expect.stringMatching(/explicitly denied by policy/i),
    });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(store.readEvents(runId(pending), { limit: 100 }).map((event) => event.type))
      .toContain("preflight_revalidated");
  });

  it("redacts sensitive action input from durable step metadata", async () => {
    const browser: BrowserRunner = {
      dispatch: vi.fn(async (toolType: string) => {
        if (toolType === "type_text") return { ok: true };
        if (toolType === "screenshot") {
          return {
            ok: true,
            dataUrl: `data:image/png;base64,${Buffer.from("shot").toString("base64")}`,
          };
        }
        if (toolType === "capture_state") {
          return {
            ok: true,
            dom: "<main />",
            accessibility: [],
            viewport: {},
            telemetry: [],
            telemetrySequence: 0,
          };
        }
        return { ok: false, error: "unexpected" };
      }),
      async dispose() {},
    };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: false })),
      browser,
    });

    const result = await service.dispatch("execute", sequence(
      "Sensitive form",
      "browser",
      [{
        id: "enter-token",
        action: "type_text",
        params: { selector: "#token", text: "do-not-persist" },
      }],
    ), { sessionId: "redacted-action" });

    expect(result["status"]).toBe("succeeded");
    expect(store.getSteps(runId(result))[0]?.declaredAction.input).toEqual({
      selector: "#token",
      text: "[redacted 14 chars]",
    });
  });

  it("blocks plan-linked execution before touching an adapter when approval is absent", async () => {
    const handleMessage = vi.fn(async () => rpc({ ok: true }));
    const planning = {
      isExecutionApproved: vi.fn(() => false),
      attachRunEvidence: vi.fn(),
    };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(handleMessage),
      planning,
    });
    const payload = {
      ...sequence("Planned read", "workspace", [{
        id: "read",
        action: "read_file",
        params: { path: "notes.txt" },
      }]),
      plan_id: "plan-1",
      phase_id: "phase-1",
    };

    const result = await service.dispatch("execute", payload, {
      sessionId: "session-plan",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: expect.stringMatching(/has not approved execution/i),
    });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(planning.isExecutionApproved).toHaveBeenCalledWith("plan-1");
    expect(planning.attachRunEvidence).toHaveBeenCalledWith(
      "plan-1",
      "phase-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not falsify a completed run when an evidence link cannot be updated", async () => {
    const planning = {
      isExecutionApproved: vi.fn(() => true),
      attachRunEvidence: vi.fn(() => {
        throw new Error("phase no longer exists");
      }),
    };
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: true, content: "done" })),
      planning,
    });
    const payload = {
      ...sequence("Linked read", "workspace", [{
        id: "read",
        action: "read_file",
        params: { path: "notes.txt" },
      }]),
      plan_id: "plan-1",
      phase_id: "removed-phase",
    };

    const result = await service.dispatch("execute", payload, {
      sessionId: "session-stale-link",
    });

    expect(result).toMatchObject({ ok: true, status: "succeeded" });
    expect(store.getRun(runId(result))?.status).toBe("succeeded");
    expect(planning.attachRunEvidence).toHaveBeenCalledOnce();
  });

  it("inspects, searches, and compares retained success and failure runs", async () => {
    let invocation = 0;
    const runtime = fakeRuntime(async () => {
      invocation += 1;
      return rpc(invocation === 1
        ? { ok: true, content: "before" }
        : { ok: false, error: "simulated read failure" });
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime,
    });
    const payload = sequence("Read stable file", "workspace", [{
      id: "read-stable",
      action: "read_file",
      params: { path: "stable.txt" },
    }]);

    const left = await service.dispatch("execute", payload, { sessionId: "left" });
    const right = await service.dispatch("execute", payload, { sessionId: "right" });
    expect(left["status"]).toBe("succeeded");
    expect(right["status"]).toBe("failed");

    const comparison = await service.dispatch("compare", {
      left_run_id: runId(left),
      right_run_id: runId(right),
      alignment: "semantic",
    }, { sessionId: "compare" });
    expect(comparison).toMatchObject({
      ok: true,
      comparison: {
        summary: { changed: 1, added: 0, removed: 0 },
        alignments: [{
          left: { step: { status: "succeeded" } },
          right: { step: { status: "failed" } },
          changes: expect.arrayContaining([
            expect.objectContaining({
              channel: "behavior",
              kind: "changed",
            }),
          ]),
        }],
      },
    });

    const inspection = await service.dispatch("inspect", {
      run_id: runId(right),
      seek: { step_id: "read-stable", phase: "failure" },
      channels: ["diagnostic"],
      window: { before_events: 10, after_events: 10 },
    }, { sessionId: "inspect" });
    expect(inspection).toMatchObject({
      ok: true,
      step: {
        id: "read-stable",
        status: "failed",
        failure: { category: "adapter_error" },
      },
    });
    expect(inspection["events"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "step_failed" }),
    ]));

    const search = await service.dispatch("search", {
      scope: { status: "failed" },
      limit: 10,
    }, { sessionId: "search" });
    expect(search).toMatchObject({
      ok: true,
      matched: 1,
      runs: [{ id: runId(right), status: "failed" }],
    });
  });

  it("continues only independent read-only steps under continue_safe", async () => {
    const handleMessage = vi.fn(async (message: RuntimeMessage) => {
      const requestedPath = String(message.payload?.["path"] ?? "");
      if (message.type === "system.read_file" && requestedPath === "bad.txt") {
        return rpc({ ok: false, error: "unreadable" });
      }
      if (message.type === "system.read_file" && requestedPath === "independent.txt") {
        return rpc({ ok: true, content: "retained evidence" });
      }
      throw new Error(`Unsafe or dependent step was dispatched: ${message.type}`);
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(handleMessage),
    });
    const payload = {
      ...sequence(
        "Continue safely",
        "workspace",
        [
          { id: "failed-read", action: "read_file", params: { path: "bad.txt" } },
          {
            id: "dependent-read",
            action: "read_file",
            params: { path: "dependent.txt" },
            depends_on: ["failed-read"],
          },
          {
            id: "unsafe-test-run",
            adapter: "test",
            action: "run",
            params: {},
          },
          {
            id: "independent-read",
            action: "read_file",
            params: { path: "independent.txt" },
          },
        ],
      ),
      failure_policy: { mode: "continue_safe", retain_partial: true },
    };

    const result = await service.dispatch("execute", payload, {
      sessionId: "session-continue-safe",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "partial",
      coverage: { completed: 1, failed: 1, skipped: 2, total: 4 },
    });
    expect(store.getSteps(runId(result))).toMatchObject([
      { id: "failed-read", status: "failed" },
      { id: "dependent-read", status: "skipped" },
      { id: "unsafe-test-run", status: "skipped" },
      { id: "independent-read", status: "succeeded" },
    ]);
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(store.readEvents(runId(result), { limit: 100 }).filter((event) => event.type === "step_skipped"))
      .toHaveLength(2);
  });

  it("filters anomalies before paginating run search results", async () => {
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: true, content: "ok" })),
    });
    const ids: string[] = [];
    for (const title of ["Matching older run", "Newer run", "Newest run"]) {
      const result = await service.dispatch("execute", sequence(
        title,
        "workspace",
        [{ id: "read", action: "read_file", params: { path: `${title}.txt` } }],
      ), { sessionId: title });
      ids.push(runId(result));
    }
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      const run = store.getRun(id)!;
      store.updateRun(id, {
        startedAt: `2026-07-30T00:0${index}:00.000Z`,
        summary: {
          ...run.summary!,
          anomalyTypes: index === 0 ? ["target-anomaly"] : ["other-anomaly"],
        },
      });
    }

    const result = await service.dispatch("search", {
      scope: { anomaly: "target-anomaly" },
      limit: 1,
    }, { sessionId: "anomaly-search" });
    expect(result).toMatchObject({
      ok: true,
      matched: 1,
      runs: [{ id: ids[0] }],
    });
    expect(result["nextCursor"]).toBeUndefined();
  });

  it("resumes a repeatable failed tail as a linked run and rejects unsafe browser effects", async () => {
    let reads = 0;
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => {
        reads += 1;
        return rpc(reads === 1
          ? { ok: false, error: "transient read failure" }
          : { ok: true, content: "recovered" });
      }),
    });
    const failed = await service.dispatch("execute", sequence(
      "Retryable read",
      "workspace",
      [{ id: "read-again", action: "read_file", params: { path: "retry.txt" } }],
    ), { sessionId: "resume-original" });
    expect(failed).toMatchObject({
      status: "failed",
      resume_capability: "logical",
    });

    const resumed = await service.dispatch("resume", {
      run_id: runId(failed),
    }, { sessionId: "resume-tail" });
    expect(resumed).toMatchObject({ ok: true, status: "succeeded" });
    expect(store.getRun(runId(resumed))).toMatchObject({
      parentRunId: runId(failed),
      title: "Retryable read (resumed)",
    });

    const browser: BrowserRunner = {
      dispatch: vi.fn(async () => ({ ok: false, error: "click failed after dispatch" })),
      async dispose() {},
    };
    const browserService = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => rpc({ ok: false, error: "not used" })),
      browser,
    });
    const unsafe = await browserService.dispatch("execute", sequence(
      "Unsafe click",
      "browser",
      [{
        id: "submit",
        action: "click",
        params: { selector: "button[type=submit]" },
      }],
    ), { sessionId: "unsafe-original" });
    expect(unsafe["status"]).toBe("failed");

    const rejected = await browserService.dispatch("resume", {
      run_id: runId(unsafe),
    }, { sessionId: "unsafe-resume" });
    expect(rejected).toMatchObject({
      ok: false,
      recoverability: "manual_intervention",
      error: expect.stringMatching(/non-reversible effects/i),
    });
    expect(store.listRuns({ parentRunId: runId(unsafe) }).matched).toBe(0);
  });

  it("cancels an active run and durably marks unfinished steps", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const runtime = fakeRuntime(async (_message, signal) => {
      enteredResolve?.();
      return await new Promise<ReturnType<typeof rpc>>((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(rpc({ ok: false, error: "cancelled by test" }));
        }, { once: true });
      });
    });
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime,
    });

    const execution = service.dispatch("execute", sequence(
      "Cancellable read",
      "workspace",
      [{ id: "blocking-read", action: "read_file", params: { path: "slow.txt" } }],
    ), { sessionId: "session-cancel" });
    await entered;
    const activeRun = store.listRuns({ limit: 1 }).runs[0];
    expect(activeRun?.status).toBe("running");
    expect(service.cancelRun(activeRun?.id ?? "")).toBe(true);

    const result = await execution;
    expect(result).toMatchObject({
      ok: false,
      runId: activeRun?.id,
      status: "cancelled",
    });
    expect(store.getRun(activeRun?.id ?? "")?.status).toBe("cancelled");
    expect(store.getSteps(activeRun?.id ?? "")[0]?.status).toBe("cancelled");
    expect(store.readEvents(activeRun?.id ?? "", { limit: 100 }).map((event) => event.type))
      .toContain("run_cancelled");
    expect(service.cancelRun(activeRun?.id ?? "")).toBe(false);
  });

  it("turns thrown adapter exceptions into a terminal failed step", async () => {
    const service = new SequenceService({
      workspaceRoot: root,
      runStore: store,
      runtime: fakeRuntime(async () => {
        throw new Error("adapter transport exploded");
      }),
    });

    const result = await service.dispatch("execute", sequence(
      "Throwing adapter",
      "workspace",
      [{ id: "throwing-read", action: "read_file", params: { path: "x.txt" } }],
    ), { sessionId: "session-throw" });

    expect(result).toMatchObject({ ok: false, status: "failed" });
    const step = store.getSteps(runId(result))[0];
    expect(step).toMatchObject({
      id: "throwing-read",
      status: "failed",
      failure: {
        message: expect.stringMatching(/adapter transport exploded/i),
        diagnosticObservationId: expect.any(String),
      },
    });
    expect(store.getObservation(step?.failure?.diagnosticObservationId ?? "")).toBeDefined();
    expect(store.readEvents(runId(result), { channels: ["diagnostic"], limit: 20 }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "coordinator_error", severity: "fatal" }),
      ]));
  });
});
