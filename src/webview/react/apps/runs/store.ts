import { useSyncExternalStore } from "react";

import { onMessage, post } from "@/lib/bridge";
import {
  isRunsHostMessage,
  type EntityRef,
  type ExecutionRun,
  type ObservationBundle,
  type RunArtifact,
  type RunComparison,
  type RunEvent,
  type RunStep,
  type RunsWebviewMessage,
} from "./protocol";
import {
  DEFAULT_EVENT_WINDOW_SIZE,
  eventWindowFromEvents,
  observationForSequence,
  windowAround,
} from "./view-model";

export type EvidenceTab = "logs" | "network" | "state";

export interface RunsStoreState {
  loading: boolean;
  refreshing: boolean;
  runs: ExecutionRun[];
  selectedRun?: ExecutionRun;
  steps: RunStep[];
  observations: ObservationBundle[];
  events: RunEvent[];
  totalEvents: number;
  artifacts: RunArtifact[];
  selectedObservationId?: string;
  selectedSequenceNumber: number;
  window: { from: number; to: number };
  windowPending: boolean;
  evidenceTab: EvidenceTab;
  comparison?: RunComparison;
  comparisonPending: boolean;
  comparisonAlignmentId?: string;
  error?: string;
}

export const runsState: RunsStoreState = {
  loading: true,
  refreshing: false,
  runs: [],
  steps: [],
  observations: [],
  events: [],
  totalEvents: 0,
  artifacts: [],
  selectedSequenceNumber: 0,
  window: { from: 0, to: 0 },
  windowPending: false,
  evidenceTab: "logs",
  comparisonPending: false,
};

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

export function useRunsStore(): RunsStoreState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return runsState;
}

function send(message: RunsWebviewMessage): void {
  post(message);
}

function preferredObservation(
  run: ExecutionRun | undefined,
  observations: ObservationBundle[],
  currentId: string | undefined,
): ObservationBundle | undefined {
  const matching = run
    ? observations.filter((observation) => observation.runId === run.id)
    : observations;
  const current = matching.find((observation) => observation.id === currentId);
  if (current) return current;
  for (const id of run?.keyObservationIds ?? []) {
    const key = matching.find((observation) => observation.id === id);
    if (key) return key;
  }
  return [...matching].sort((left, right) =>
    left.cursor.sequenceNumber - right.cursor.sequenceNumber)[0];
}

function handleMessage(message: unknown): void {
  if (!isRunsHostMessage(message)) return;
  switch (message.type) {
    case "runs_state": {
      const previousRunId = runsState.selectedRun?.id;
      const selectedRun = message.selectedRun
        ?? message.runs.find((run) => run.id === previousRunId)
        ?? message.runs[0];
      const runChanged = selectedRun?.id !== previousRunId;
      const selectedObservation = preferredObservation(
        selectedRun,
        message.observations,
        runChanged ? undefined : runsState.selectedObservationId,
      );

      runsState.loading = false;
      runsState.refreshing = false;
      runsState.runs = message.runs;
      runsState.selectedRun = selectedRun;
      runsState.steps = message.steps;
      runsState.observations = message.observations;
      runsState.events = [...message.events].sort((left, right) =>
        left.sequenceNumber - right.sequenceNumber);
      runsState.totalEvents = Math.max(0, message.totalEvents);
      runsState.artifacts = message.artifacts;
      runsState.selectedObservationId = selectedObservation?.id;
      runsState.selectedSequenceNumber = selectedObservation?.cursor.sequenceNumber
        ?? runsState.events[0]?.sequenceNumber
        ?? 0;
      runsState.window = eventWindowFromEvents(runsState.events, runsState.totalEvents);
      runsState.windowPending = false;
      runsState.error = undefined;
      if (runsState.comparison
        && selectedRun
        && runsState.comparison.leftRunId !== selectedRun.id
        && runsState.comparison.rightRunId !== selectedRun.id) {
        runsState.comparison = undefined;
        runsState.comparisonAlignmentId = undefined;
      }
      bump();
      break;
    }
    case "run_event_window":
      if (message.runId !== runsState.selectedRun?.id) return;
      runsState.events = [...message.events].sort((left, right) =>
        left.sequenceNumber - right.sequenceNumber);
      runsState.totalEvents = Math.max(0, message.totalEvents);
      runsState.window = {
        from: Math.max(0, message.from),
        to: Math.max(message.from, message.to),
      };
      runsState.windowPending = false;
      runsState.error = undefined;
      bump();
      break;
    case "run_comparison":
      runsState.comparison = message.comparison;
      runsState.comparisonPending = false;
      runsState.comparisonAlignmentId = message.comparison.alignments[0]?.id;
      runsState.error = undefined;
      bump();
      break;
    case "run_error":
      runsState.loading = false;
      runsState.refreshing = false;
      runsState.windowPending = false;
      runsState.comparisonPending = false;
      runsState.error = message.message;
      bump();
      break;
  }
}

function requestWindow(sequenceNumber: number): void {
  const run = runsState.selectedRun;
  if (!run || runsState.totalEvents <= 0) return;
  const next = windowAround(sequenceNumber, runsState.totalEvents, DEFAULT_EVENT_WINDOW_SIZE);
  runsState.window = next;
  runsState.windowPending = true;
  bump();
  send({
    type: "request_event_window",
    runId: run.id,
    from: next.from,
    to: next.to,
  });
}

function selectObservation(observation: ObservationBundle, notifyHost: boolean): void {
  const run = runsState.selectedRun;
  if (!run || observation.runId !== run.id) return;
  runsState.selectedObservationId = observation.id;
  runsState.selectedSequenceNumber = observation.cursor.sequenceNumber;
  bump();
  if (notifyHost) {
    send({
      type: "select_observation",
      runId: run.id,
      observationId: observation.id,
    });
  }
  const sequenceNumber = observation.cursor.sequenceNumber;
  if (sequenceNumber < runsState.window.from || sequenceNumber > runsState.window.to) {
    requestWindow(sequenceNumber);
  }
}

export const runActions = {
  refresh(): void {
    runsState.refreshing = true;
    runsState.error = undefined;
    bump();
    send({ type: "refresh" });
  },

  selectRun(runId: string): void {
    if (runId === runsState.selectedRun?.id) return;
    const selectedRun = runsState.runs.find((run) => run.id === runId);
    runsState.selectedRun = selectedRun;
    runsState.steps = [];
    runsState.observations = [];
    runsState.events = [];
    runsState.artifacts = [];
    runsState.totalEvents = selectedRun?.summary?.eventCount ?? 0;
    runsState.selectedObservationId = undefined;
    runsState.selectedSequenceNumber = 0;
    runsState.window = { from: 0, to: 0 };
    runsState.loading = true;
    runsState.comparison = undefined;
    runsState.comparisonAlignmentId = undefined;
    runsState.error = undefined;
    bump();
    send({ type: "select_run", runId });
  },

  selectObservation(observationId: string): void {
    const observation = runsState.observations.find((candidate) => candidate.id === observationId);
    if (observation) selectObservation(observation, true);
  },

  previewSequence(sequenceNumber: number): void {
    const safeSequence = Math.max(1, Math.min(runsState.totalEvents || 1, Math.round(sequenceNumber)));
    runsState.selectedSequenceNumber = safeSequence;
    const observation = observationForSequence(runsState.observations, safeSequence);
    if (observation) runsState.selectedObservationId = observation.id;
    bump();
  },

  commitSequence(sequenceNumber: number): void {
    const safeSequence = Math.max(1, Math.min(runsState.totalEvents || 1, Math.round(sequenceNumber)));
    const observation = observationForSequence(runsState.observations, safeSequence);
    if (observation) {
      selectObservation(observation, true);
      return;
    }
    runsState.selectedSequenceNumber = safeSequence;
    bump();
    requestWindow(safeSequence);
  },

  shiftWindow(direction: 1 | -1): void {
    if (!runsState.selectedRun || runsState.totalEvents <= 0) return;
    const span = Math.max(1, runsState.window.to - runsState.window.from + 1);
    const center = direction === 1
      ? runsState.window.to + Math.ceil(span / 2)
      : runsState.window.from - Math.ceil(span / 2);
    requestWindow(Math.max(1, Math.min(runsState.totalEvents, center)));
  },

  setEvidenceTab(tab: EvidenceTab): void {
    if (runsState.evidenceTab === tab) return;
    runsState.evidenceTab = tab;
    bump();
  },

  compareWith(rightRunId: string): void {
    const leftRunId = runsState.selectedRun?.id;
    if (!leftRunId || !rightRunId || leftRunId === rightRunId) return;
    runsState.comparisonPending = true;
    runsState.comparison = undefined;
    runsState.comparisonAlignmentId = undefined;
    runsState.error = undefined;
    bump();
    send({ type: "compare_runs", leftRunId, rightRunId });
  },

  selectComparisonAlignment(id: string): void {
    runsState.comparisonAlignmentId = id;
    bump();
  },

  closeComparison(): void {
    runsState.comparison = undefined;
    runsState.comparisonAlignmentId = undefined;
    runsState.comparisonPending = false;
    bump();
  },

  togglePinned(): void {
    const run = runsState.selectedRun;
    if (!run) return;
    const pinned = run.retentionClass !== "pinned";
    runsState.selectedRun = { ...run, retentionClass: pinned ? "pinned" : "standard" };
    runsState.runs = runsState.runs.map((candidate) =>
      candidate.id === run.id ? { ...candidate, retentionClass: pinned ? "pinned" : "standard" } : candidate);
    bump();
    send({ type: "pin_run", runId: run.id, pinned });
  },

  cancelRun(): void {
    const run = runsState.selectedRun;
    if (!run) return;
    send({ type: "cancel_run", runId: run.id });
  },

  fileAnomalyTicket(eventId?: string, observationId?: string): void {
    const run = runsState.selectedRun;
    if (!run || (!eventId && !observationId)) return;
    send({
      type: "file_anomaly_ticket",
      runId: run.id,
      eventId,
      observationId,
    });
  },

  openEntity(entity: EntityRef): void {
    send({ type: "open_entity", entity });
  },

  openOnMap(entity?: EntityRef): void {
    const run = runsState.selectedRun;
    if (!run) return;
    send({
      type: "open_on_map",
      runId: run.id,
      sequenceNumber: runsState.selectedSequenceNumber || undefined,
      entity,
    });
  },

  clearError(): void {
    runsState.error = undefined;
    bump();
  },
};

let initialized = false;

export function initRunsStore(): void {
  if (initialized) return;
  initialized = true;
  onMessage(handleMessage);
  send({ type: "ready" });
}
