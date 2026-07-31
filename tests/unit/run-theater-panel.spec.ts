/**
 * The theater's live path.
 *
 * `RunStore.emit` runs synchronously inside the sequence execution loop, so anything the panel
 * does on arrival is on the critical path of the run itself. `_ingest` may only filter, buffer
 * and arm a timer — never read the store, never serialize.
 *
 * The panel is driven through its real store subscription with a fake webview panel, the same way
 * run-provider.spec.ts drives the sidebar.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRun, RunEventInput } from "../../src/runs/run-model.js";
import { RunStore } from "../../src/runs/run-store.js";
import { RunTheaterPanel } from "../../src/run-theater-panel.js";
import type { SequenceService } from "../../src/sequences/sequence-service.js";

function makeRun(id = "run-1"): ExecutionRun {
  return {
    id, sequenceId: "sequence-1", sequenceVersion: 1, status: "running",
    target: { adapterId: "browser", type: "route", id: "/" },
    adapterIds: ["browser"], ticketIds: [],
    workspaceFingerprint: "w", environmentFingerprint: "e",
    stepIds: [], checkpointIds: [], keyObservationIds: [], retentionClass: "standard",
  };
}

function event(index: number): RunEventInput {
  return {
    channel: "log", type: "console",
    source: { adapterId: "browser", producer: "test" },
    entityRefs: [], inlinePayload: { index },
  };
}

interface Posted extends Record<string, unknown> { type: string }

/** Installs a fake WebviewPanel and returns everything posted to it. */
function attachFakePanel(panel: RunTheaterPanel, visible = true): Posted[] {
  const messages: Posted[] = [];
  const fake = {
    visible,
    viewColumn: 1,
    title: "",
    webview: {
      postMessage(message: Posted): Promise<boolean> { messages.push(message); return Promise.resolve(true); },
      asWebviewUri(uri: { toString(): string }): { toString(): string } {
        return { toString: () => `webview:${uri.toString()}` };
      },
      html: "",
    },
    reveal() { /* no-op */ },
    dispose() { /* no-op */ },
  };
  (panel as unknown as { _panel: typeof fake })._panel = fake;
  return messages;
}

describe("RunTheaterPanel live path", () => {
  let root: string;
  let store: RunStore;
  let panel: RunTheaterPanel;

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "run-theater-"));
    store = new RunStore(root, { metadataMode: "json", maxEventsPerSegment: 1_000 }).open();
    store.createRun(makeRun());
    panel = new RunTheaterPanel(
      { extensionUri: { fsPath: root, toString: () => root } } as never,
      store,
      { cancelRun: vi.fn() } as unknown as SequenceService,
    );
  });

  afterEach(() => {
    panel.dispose();
    vi.useRealTimers();
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function follow(runId = "run-1"): Posted[] {
    const messages = attachFakePanel(panel);
    (panel as unknown as { _runId?: string })._runId = runId;
    (panel as unknown as { _generation: number })._generation = 1;
    messages.length = 0;
    return messages;
  }

  it("coalesces a burst into one delta", async () => {
    const messages = follow();
    for (let i = 0; i < 12; i += 1) {
      store.appendEvents("run-1", [event(i)]);
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(200);

    const deltas = messages.filter((m) => m.type === "theater_delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0]?.events as unknown[]).length).toBe(12);
  });

  it("ignores changes belonging to another run", async () => {
    store.createRun(makeRun("run-2"));
    const messages = follow();
    store.appendEvents("run-2", [event(1)]);
    await vi.advanceTimersByTimeAsync(200);
    expect(messages.filter((m) => m.type === "theater_delta")).toHaveLength(0);
  });

  /**
   * recordBrowserTelemetry slices at 5000 and appends in a single call, so one emit really can
   * carry thousands. Posting the whole burst would stall the tab exactly when the run is most
   * active; the cap keeps it responsive and says so with droppedBefore.
   */
  it("caps an oversized burst and declares the truncation", async () => {
    const messages = follow();
    store.appendEvents("run-1", Array.from({ length: 1200 }, (_, i) => event(i)));
    await vi.advanceTimersByTimeAsync(200);

    const delta = messages.find((m) => m.type === "theater_delta");
    const events = delta?.events as Array<{ sequenceNumber: number }>;
    expect(events.length).toBeLessThanOrEqual(400);
    expect(delta?.droppedBefore).toBe(events[0]?.sequenceNumber);
    // The newest events are the ones kept — a live view that lags is worse than one that skips.
    expect(events.at(-1)?.sequenceNumber).toBe(1200);
  });

  it("drops deltas while the tab is hidden rather than queueing them", async () => {
    const messages = attachFakePanel(panel, false);
    (panel as unknown as { _runId?: string })._runId = "run-1";
    messages.length = 0;

    store.appendEvents("run-1", [event(1), event(2)]);
    await vi.advanceTimersByTimeAsync(200);

    expect(messages.filter((m) => m.type === "theater_delta")).toHaveLength(0);
    expect((panel as unknown as { _staleWhileHidden: boolean })._staleWhileHidden).toBe(true);
  });

  it("does not read the store while ingesting a change", async () => {
    const messages = follow();
    const spies = (["readEvents", "getSteps", "listObservations", "listArtifacts", "listEventSegments"] as const)
      .map((method) => vi.spyOn(RunStore.prototype, method));
    for (const spy of spies) spy.mockClear();

    store.appendEvents("run-1", [event(1)]);
    // Before the flush timer fires: ingest alone must have touched nothing.
    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(messages.filter((m) => m.type === "theater_delta")).toHaveLength(1);
    for (const spy of spies) spy.mockRestore();
  });

  it("stops flushing once disposed", async () => {
    const messages = follow();
    store.appendEvents("run-1", [event(1)]);
    panel.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(messages.filter((m) => m.type === "theater_delta")).toHaveLength(0);
  });
});
