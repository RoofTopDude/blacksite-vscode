import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunProvider } from "../../src/run-provider.js";
import type { ExecutionRun, RunEventInput } from "../../src/runs/run-model.js";
import { RunStore } from "../../src/runs/run-store.js";
import type { SequenceService } from "../../src/sequences/sequence-service.js";

function makeRun(): ExecutionRun {
  return {
    id: "run-1",
    sequenceId: "sequence-1",
    sequenceVersion: 1,
    status: "running",
    target: { adapterId: "browser", type: "route", id: "/settings" },
    adapterIds: ["browser"],
    ticketIds: [],
    workspaceFingerprint: "workspace",
    environmentFingerprint: "environment",
    stepIds: [],
    checkpointIds: [],
    keyObservationIds: [],
    retentionClass: "standard",
  };
}

function event(index: number): RunEventInput {
  return {
    channel: "log",
    type: "console",
    source: { adapterId: "browser", producer: "test" },
    entityRefs: [],
    inlinePayload: { index },
  };
}

interface PostedMessage extends Record<string, unknown> {
  type: string;
}

function attachFakeView(provider: RunProvider): PostedMessage[] {
  const messages: PostedMessage[] = [];
  const view = {
    webview: {
      postMessage(message: PostedMessage): Promise<boolean> {
        messages.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri(uri: { toString(): string }): { toString(): string } {
        return { toString: () => `webview:${uri.toString()}` };
      },
    },
  };
  (provider as unknown as { _view: typeof view })._view = view;
  return messages;
}

describe("RunProvider host boundaries", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-run-provider-"));
    store = new RunStore(root, {
      metadataMode: "json",
      maxEventsPerSegment: 1_000,
    }).open();
    store.createRun(makeRun());
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createProvider(): RunProvider {
    const sequences = {
      dispatch: vi.fn(),
      cancelRun: vi.fn(),
      setPinned: vi.fn(),
    } as unknown as SequenceService;
    return new RunProvider({} as never, store, sequences);
  }

  it("caps event-window requests and reports the full retained count", () => {
    store.appendEvents("run-1", Array.from({ length: 750 }, (_, index) => event(index)));
    const provider = createProvider();
    const messages = attachFakeView(provider);

    (provider as unknown as {
      _postEventWindow(runId: string, from: unknown, to: unknown): void;
    })._postEventWindow("run-1", 1, 750);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "run_event_window",
      runId: "run-1",
      totalEvents: 750,
      from: 1,
      to: 500,
    });
    expect(messages[0]?.events).toHaveLength(500);
    provider.dispose();
  });

  it("exposes webview URLs for scrubbable frames, and withholds them from unrelated artifacts", () => {
    const captured = store.putArtifact("run-1", Buffer.from("captured"), {
      mediaType: "image/png",
      observationId: "observation-1",
    });
    const unrelated = store.putArtifact("run-1", Buffer.from("unrelated"), {
      mediaType: "image/png",
      observationId: "observation-2",
    });
    store.putObservation({
      id: "observation-1",
      runId: "run-1",
      cursor: { sequenceNumber: 1 },
      visualArtifactIds: [captured.id],
      structuralArtifactIds: [],
      stateArtifactIds: [],
      eventRange: { firstSequenceNumber: 1, lastSequenceNumber: 1 },
      entityRefs: [],
      captureProfile: "diagnostic",
    });
    store.updateRun("run-1", { keyObservationIds: ["observation-1"] });

    const provider = createProvider();
    const messages = attachFakeView(provider);
    provider.refresh();

    const state = messages.find((message) => message.type === "runs_state");
    const artifacts = state?.artifacts as Array<{ id: string; url?: string }>;
    expect(artifacts.find((artifact) => artifact.id === captured.id)?.url)
      .toMatch(/^webview:file:/);
    expect(artifacts.find((artifact) => artifact.id === unrelated.id)?.url)
      .toBeUndefined();
    provider.dispose();
  });

  it("routes an explicit anomaly-ticket request with stable run evidence", async () => {
    const diagnostic = store.appendEvent("run-1", {
      channel: "diagnostic",
      type: "uncaught_exception",
      severity: "error",
      source: { adapterId: "browser", producer: "test" },
      entityRefs: [{
        scheme: "workspace-file",
        id: "src/app.ts",
        workspacePath: "src/app.ts",
      }],
    });
    const fileAnomaly = vi.fn();
    const provider = new RunProvider(
      {} as never,
      store,
      {
        dispatch: vi.fn(),
        cancelRun: vi.fn(),
        setPinned: vi.fn(),
      } as unknown as SequenceService,
      { fileAnomaly },
    );

    await (provider as unknown as {
      _onMessage(value: unknown): Promise<void>;
    })._onMessage({
      type: "file_anomaly_ticket",
      runId: "run-1",
      eventId: diagnostic.id,
    });

    expect(fileAnomaly).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: "run-1" }),
      event: expect.objectContaining({ id: diagnostic.id, type: "uncaught_exception" }),
      observation: undefined,
    });
    provider.dispose();
  });

  it("keeps a run without implicitly changing a baseline", async () => {
    const setPinned = vi.fn();
    const provider = new RunProvider(
      {} as never,
      store,
      {
        dispatch: vi.fn(),
        cancelRun: vi.fn(),
        setPinned,
      } as unknown as SequenceService,
    );

    await (provider as unknown as {
      _onMessage(value: unknown): Promise<void>;
    })._onMessage({ type: "pin_run", runId: "run-1", pinned: true });

    expect(setPinned).not.toHaveBeenCalled();
    expect(store.getRun("run-1")?.retentionClass).toBe("pinned");
    provider.dispose();
  });

  it("keeps an explicitly selected older run visible beyond the recent-run page", () => {
    const explicitlySelected: ExecutionRun = {
      ...makeRun(),
      status: "succeeded",
      startedAt: "2020-01-01T00:00:00.000Z",
      endedAt: "2020-01-01T00:00:01.000Z",
    };
    const recentRuns = Array.from({ length: 500 }, (_, index): ExecutionRun => ({
        ...makeRun(),
        id: `recent-${index}`,
        sequenceId: `sequence-recent-${index}`,
        status: "succeeded",
        startedAt: `2026-07-29T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        endedAt: `2026-07-29T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.500Z`,
      }));
    const fakeStore = {
      workspaceRoot: root,
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      listRuns: vi.fn(() => ({ runs: recentRuns, matched: recentRuns.length + 1 })),
      getRun: vi.fn((id: string) => (
        id === explicitlySelected.id
          ? explicitlySelected
          : recentRuns.find((run) => run.id === id)
      )),
      getSteps: vi.fn(() => []),
      listObservations: vi.fn(() => []),
      listEventSegments: vi.fn(() => []),
      listArtifacts: vi.fn(() => []),
    } as unknown as RunStore;
    const provider = new RunProvider(
      {} as never,
      fakeStore,
      {
        dispatch: vi.fn(),
        cancelRun: vi.fn(),
        setPinned: vi.fn(),
      } as unknown as SequenceService,
    );
    const messages = attachFakeView(provider);
    (provider as unknown as { _selectedRunId?: string })._selectedRunId = "run-1";

    provider.refresh();

    const state = messages.findLast((message) => message.type === "runs_state");
    expect(state?.selectedRun).toMatchObject({ id: "run-1" });
    expect(state?.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-1" }),
    ]));
    expect((state?.runs as unknown[])).toHaveLength(500);
    provider.dispose();
  });
});

/**
 * Scrubbing showed no screenshots, and it was never a decoding problem.
 *
 * A webview URI was minted only for the *selected* observation's artifacts, so every other frame
 * arrived with no `url` at all — the timeline was asking `<img>` to render a source that did not
 * exist. The mintable set is now the run's key observations (the bounded filmstrip the store
 * already curates) plus the current selection.
 */
describe("RunProvider — scrubbable artifact URLs", () => {
  let root: string;
  let store: RunStore;

  function observation(id: string, sequenceNumber: number, visualArtifactIds: string[]) {
    return {
      id, runId: "run-1",
      cursor: { sequenceNumber },
      visualArtifactIds, structuralArtifactIds: [], stateArtifactIds: [],
      eventRange: { firstSequenceNumber: sequenceNumber, lastSequenceNumber: sequenceNumber },
      entityRefs: [], captureProfile: "diagnostic" as const,
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-scrub-"));
    store = new RunStore(root);
    store.createRun(makeRun());
  });

  afterEach(() => {
    store.dispose?.();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createProvider(): RunProvider {
    return new RunProvider(
      { extensionUri: { fsPath: root, toString: () => root } } as never,
      store,
      {} as unknown as SequenceService,
    );
  }

  it("mints a URL for every key observation frame, not just the selected one", () => {
    const frames = [1, 2, 3].map((n) => store.putArtifact("run-1", Buffer.from(`frame-${n}`), {
      mediaType: "image/png", observationId: `observation-${n}`,
    }));
    frames.forEach((artifact, index) =>
      store.putObservation(observation(`observation-${index + 1}`, index + 1, [artifact.id])));
    store.updateRun("run-1", {
      keyObservationIds: ["observation-1", "observation-2", "observation-3"],
    });

    const provider = createProvider();
    const messages = attachFakeView(provider);
    provider.refresh();

    const state = messages.find((message) => message.type === "runs_state");
    const artifacts = state?.artifacts as Array<{ id: string; url?: string }>;
    // Every frame the scrubber can land on must be loadable, or the image blanks mid-scrub.
    for (const frame of frames) {
      expect(artifacts.find((a) => a.id === frame.id)?.url, frame.id).toMatch(/^webview:file:/);
    }
    provider.dispose();
  });

  /** The CAS is content-addressed and shared across every run in the workspace, so the mintable
   *  set stays bounded by the run's own curated observations. */
  it("withholds a URL from an artifact outside the key observations and the selection", () => {
    const kept = store.putArtifact("run-1", Buffer.from("kept"), {
      mediaType: "image/png", observationId: "observation-1",
    });
    const orphan = store.putArtifact("run-1", Buffer.from("orphan"), {
      mediaType: "image/png", observationId: "observation-99",
    });
    store.putObservation(observation("observation-1", 1, [kept.id]));
    store.updateRun("run-1", { keyObservationIds: ["observation-1"] });

    const provider = createProvider();
    const messages = attachFakeView(provider);
    provider.refresh();

    const artifacts = messages.find((m) => m.type === "runs_state")?.artifacts as Array<{ id: string; url?: string }>;
    expect(artifacts.find((a) => a.id === kept.id)?.url).toMatch(/^webview:file:/);
    expect(artifacts.find((a) => a.id === orphan.id)?.url).toBeUndefined();
    provider.dispose();
  });
});

/**
 * `_postState` rebuilds everything and reads an event window back off disk, so it must not run
 * per store mutation. The change event's `runId` was being discarded and `queueMicrotask` merged
 * nothing, because each mutation in the sequence loop lands in its own macrotask.
 */
describe("RunProvider — state refresh coalescing", () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-coalesce-"));
    store = new RunStore(root);
    store.createRun(makeRun());
  });

  afterEach(() => {
    vi.useRealTimers();
    store.dispose?.();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createProvider(): RunProvider {
    return new RunProvider(
      { extensionUri: { fsPath: root, toString: () => root } } as never,
      store,
      {} as unknown as SequenceService,
    );
  }

  /**
   * The mutations must be separated by macrotask boundaries, because that is the shape the real
   * sequence loop produces — it is heavily awaited, so every step's writes land in their own turn.
   * A synchronous burst would be coalesced even by the `queueMicrotask` this replaced, and would
   * pass against the bug.
   */
  it("collapses mutations spread across macrotasks into a single re-serialize", async () => {
    const provider = createProvider();
    (provider as unknown as { _selectedRunId?: string })._selectedRunId = "run-1";
    const messages = attachFakeView(provider);
    messages.length = 0;

    for (let i = 0; i < 25; i += 1) {
      store.appendEvents("run-1", [event(i)]);
      // Advance a real macrotask without crossing the debounce window.
      await vi.advanceTimersByTimeAsync(2);
    }
    await vi.advanceTimersByTimeAsync(500);

    expect(messages.filter((m) => m.type === "runs_state")).toHaveLength(1);
    provider.dispose();
  });

  it("ignores detail changes belonging to a run the user is not looking at", async () => {
    store.createRun({ ...makeRun(), id: "run-2" });
    const provider = createProvider();
    (provider as unknown as { _selectedRunId?: string })._selectedRunId = "run-1";
    const messages = attachFakeView(provider);
    messages.length = 0;

    store.appendEvents("run-2", [event(1)]);
    await vi.advanceTimersByTimeAsync(500);

    expect(messages.filter((m) => m.type === "runs_state")).toHaveLength(0);
    provider.dispose();
  });

  /** A new run changes the run *list*, so it must refresh regardless of what is selected. */
  it("still refreshes when a different run's lifecycle changes the list", async () => {
    const provider = createProvider();
    (provider as unknown as { _selectedRunId?: string })._selectedRunId = "run-1";
    const messages = attachFakeView(provider);
    messages.length = 0;

    store.createRun({ ...makeRun(), id: "run-3" });
    await vi.advanceTimersByTimeAsync(500);

    expect(messages.filter((m) => m.type === "runs_state").length).toBeGreaterThan(0);
    provider.dispose();
  });

  it("does not fire a queued refresh after disposal", async () => {
    const provider = createProvider();
    (provider as unknown as { _selectedRunId?: string })._selectedRunId = "run-1";
    const messages = attachFakeView(provider);
    messages.length = 0;

    store.appendEvents("run-1", [event(1)]);
    provider.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(messages.filter((m) => m.type === "runs_state")).toHaveLength(0);
  });
});
