/**
 * Theater state.
 *
 * Same shape as apps/runs/store.ts — a module-level mutable object behind `useSyncExternalStore`
 * with a version counter — chosen for the same reason: a live trace produces far too many updates
 * to rebuild an immutable state object per event.
 *
 * What differs is the update model. The sidebar replaces its arrays wholesale on every push; this
 * appends, so it has to care about ordering, overlap and gaps. That logic lives in delta.ts and is
 * tested there; this file is the plumbing around it.
 */
import { useSyncExternalStore } from "react";
import { post, onMessage } from "@/lib/bridge";
import type {
  ExecutionRun,
  ObservationBundle,
  RunArtifact,
  RunAnnotation,
  RunComparison,
  RunEvent,
  RunFocus,
  RunStep,
  TraceOverview,
} from "../runs/protocol";
import {
  isTheaterHostMessage,
  type InspectionReport,
  type RunWatermark,
  type TheaterWebviewMessage,
} from "./messages";
import { applyDelta, mergeById, type TraceWindow } from "./delta";

export interface TheaterState {
  loading: boolean;
  runId?: string;
  generation: number;
  run?: ExecutionRun;
  steps: RunStep[];
  observations: ObservationBundle[];
  artifacts: RunArtifact[];
  events: RunEvent[];
  /** The independently advancing live tail. `events` is the detail window currently on screen. */
  tailEvents: RunEvent[];
  overview?: TraceOverview;
  annotations: RunAnnotation[];
  agentFocus?: RunFocus;
  followAgent: boolean;
  userHasScrubbed: boolean;
  lastSequence: number;
  totalEvents: number;
  watermark?: RunWatermark;
  /** Local memory begins here; earlier events were dropped by the ring buffer or by the host. */
  truncatedBefore?: number;
  /** A gap was detected and a fresh baseline has been requested. Surfaced in the UI rather than
   *  hidden, because a timeline quietly missing events is worse than one that says so. */
  reconnecting: boolean;
  /** Playhead follows the newest event until the user scrubs away from the tail. */
  following: boolean;
  playheadSequence: number;
  /** Arrives once the run settles; the stage swaps to it in place. */
  inspection?: InspectionReport;
  /** Whether the user is looking at the report or back at the replay. */
  showInspection: boolean;
  playing: boolean;
  playbackRate: 0.5 | 1 | 2 | 4;
  inspectorTab: "overview" | "events" | "console" | "network" | "state" | "assertions" | "artifacts";
  comparison?: RunComparison;
  comparisonMode: "two-up" | "wipe" | "overlay" | "heatmap";
  comparisonEnvironmentMismatch: boolean;
  error?: string;
}

export const theaterState: TheaterState = {
  loading: true,
  generation: 0,
  steps: [],
  observations: [],
  artifacts: [],
  events: [],
  tailEvents: [],
  annotations: [],
  lastSequence: 0,
  totalEvents: 0,
  reconnecting: false,
  following: true,
  followAgent: true,
  userHasScrubbed: false,
  playheadSequence: 0,
  showInspection: false,
  playing: false,
  playbackRate: 1,
  inspectorTab: "overview",
  comparisonMode: "two-up",
  comparisonEnvironmentMismatch: false,
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

export function useTheaterStore(): TheaterState {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return theaterState;
}

function send(message: TheaterWebviewMessage): void {
  post(message);
}

function currentWindow(): TraceWindow {
  return {
    events: theaterState.tailEvents,
    lastSequence: theaterState.lastSequence,
    generation: theaterState.generation,
    ...(theaterState.truncatedBefore !== undefined ? { truncatedBefore: theaterState.truncatedBefore } : {}),
  };
}

function handleMessage(message: unknown): void {
  if (!isTheaterHostMessage(message)) return;

  switch (message.type) {
    case "theater_attach": {
      theaterState.loading = false;
      theaterState.runId = message.runId;
      theaterState.generation = message.generation;
      theaterState.run = message.run;
      theaterState.steps = message.steps;
      theaterState.observations = message.observations;
      theaterState.artifacts = message.artifacts;
      theaterState.events = message.events;
      theaterState.tailEvents = message.events;
      theaterState.overview = message.overview;
      theaterState.annotations = message.annotations;
      theaterState.totalEvents = message.totalEvents;
      theaterState.watermark = message.watermark;
      theaterState.lastSequence = message.events.at(-1)?.sequenceNumber ?? 0;
      // An attach only carries the tail, so anything before it is genuinely not in memory.
      theaterState.truncatedBefore = message.events[0]?.sequenceNumber;
      theaterState.reconnecting = false;
      theaterState.error = undefined;
      // A fresh baseline resumes following: the user's scroll position refers to a trace this
      // view no longer holds, so pretending to preserve it would be a lie.
      theaterState.following = true;
      theaterState.userHasScrubbed = false;
      theaterState.playheadSequence = theaterState.lastSequence;
      theaterState.inspection = undefined;
      theaterState.showInspection = false;
      theaterState.playing = false;
      theaterState.inspectorTab = "overview";
      theaterState.comparison = undefined;
      theaterState.comparisonEnvironmentMismatch = false;
      bump();
      return;
    }

    case "theater_delta": {
      if (message.runId !== theaterState.runId) return;
      const outcome = applyDelta(currentWindow(), message);
      if (outcome.kind === "stale") return;
      if (outcome.kind === "gap") {
        theaterState.reconnecting = true;
        bump();
        send({ type: "theater_resync" });
        return;
      }

      theaterState.tailEvents = outcome.events;
      theaterState.lastSequence = outcome.lastSequence;
      theaterState.truncatedBefore = outcome.truncatedBefore;
      theaterState.steps = mergeById(theaterState.steps, message.steps);
      theaterState.observations = mergeById(theaterState.observations, message.observations);
      theaterState.artifacts = mergeById(theaterState.artifacts, message.artifacts);
      if (message.run) theaterState.run = message.run;
      if (message.watermark) {
        theaterState.watermark = message.watermark;
        theaterState.totalEvents = Math.max(theaterState.totalEvents, message.watermark.eventCount);
      }
      if (theaterState.following) {
        theaterState.events = outcome.events;
        theaterState.playheadSequence = outcome.lastSequence;
      }
      bump();
      return;
    }

    case "theater_window": {
      if (message.runId !== theaterState.runId || message.generation !== theaterState.generation) return;
      theaterState.events = message.events;
      theaterState.truncatedBefore = message.events[0]?.sequenceNumber;
      theaterState.totalEvents = message.totalEvents;
      theaterState.following = false;
      if (message.anchorSequence !== undefined) theaterState.playheadSequence = message.anchorSequence;
      bump();
      return;
    }

    case "theater_agent_focus": {
      if (message.focus.runId !== theaterState.runId) return;
      theaterState.agentFocus = message.focus;
      if (theaterState.followAgent && message.focus.sequenceNumber !== undefined) {
        theaterState.playheadSequence = message.focus.sequenceNumber;
        if (!theaterState.events.some((event) => event.sequenceNumber === message.focus.sequenceNumber) && theaterState.runId) {
          send({ type: "theater_seek", runId: theaterState.runId, sequenceNumber: message.focus.sequenceNumber });
        }
      }
      bump();
      return;
    }

    case "theater_annotations": {
      if (message.runId !== theaterState.runId) return;
      theaterState.annotations = message.annotations;
      bump();
      return;
    }

    case "theater_comparison": {
      if (message.runId !== theaterState.runId) return;
      theaterState.comparison = message.comparison;
      theaterState.comparisonEnvironmentMismatch = message.environmentMismatch;
      bump();
      return;
    }

    case "theater_inspection": {
      if (message.runId !== theaterState.runId) return;
      theaterState.inspection = message.report;
      // Surfaced automatically: the run is over, so what the user wants next is what it did.
      theaterState.showInspection = true;
      theaterState.inspectorTab = "overview";
      bump();
      return;
    }

    case "theater_error": {
      theaterState.loading = false;
      theaterState.error = message.message;
      bump();
      return;
    }
  }
}

export const theaterActions = {
  /** Scrub. Leaving the tail stops follow mode; returning to it resumes, which is the behaviour
   *  every media transport has and therefore the one nobody has to be taught. */
  seek(sequenceNumber: number): void {
    theaterState.playheadSequence = sequenceNumber;
    theaterState.following = sequenceNumber >= theaterState.lastSequence;
    theaterState.userHasScrubbed = !theaterState.following;
    if (!theaterState.following) theaterState.followAgent = false;
    bump();
  },

  seekTimestamp(monotonicTimestampNs: string): void {
    if (!theaterState.runId) return;
    theaterState.following = false;
    theaterState.userHasScrubbed = true;
    bump();
    send({ type: "theater_seek", runId: theaterState.runId, monotonicTimestampNs });
  },

  setFollowing(following: boolean): void {
    theaterState.following = following;
    if (following) {
      theaterState.events = theaterState.tailEvents;
      theaterState.playheadSequence = theaterState.lastSequence;
      theaterState.userHasScrubbed = false;
    }
    bump();
  },

  setFollowAgent(follow: boolean): void {
    theaterState.followAgent = follow;
    bump();
  },

  askAgent(): void {
    if (!theaterState.runId) return;
    const event = theaterState.events.find((candidate) => candidate.sequenceNumber === theaterState.playheadSequence);
    const observation = [...theaterState.observations]
      .reverse()
      .find((candidate) => candidate.cursor.sequenceNumber <= theaterState.playheadSequence);
    send({
      type: "theater_ask_agent",
      runId: theaterState.runId,
      sequenceNumber: theaterState.playheadSequence,
      ...(event ? { eventId: event.id } : {}),
      ...(observation ? { observationId: observation.id } : {}),
    });
  },

  annotate(body: string, kind: RunAnnotation["kind"] = "note"): void {
    if (!theaterState.runId || !body.trim()) return;
    const event = theaterState.events.find((candidate) => candidate.sequenceNumber === theaterState.playheadSequence);
    send({
      type: "theater_annotate",
      runId: theaterState.runId,
      sequenceNumber: theaterState.playheadSequence,
      body: body.trim(),
      kind,
      ...(event ? { eventId: event.id, stepId: event.stepId } : {}),
    });
  },

  keepRun(): void {
    if (theaterState.runId) send({ type: "theater_keep_run", runId: theaterState.runId });
  },

  setBaseline(): void {
    if (theaterState.runId) send({ type: "theater_set_baseline", runId: theaterState.runId });
  },

  compareBaseline(): void {
    if (theaterState.runId) send({ type: "theater_compare_baseline", runId: theaterState.runId });
  },

  setComparisonMode(mode: TheaterState["comparisonMode"]): void {
    theaterState.comparisonMode = mode;
    bump();
  },

  openMap(): void {
    if (theaterState.runId) send({ type: "theater_open_map", runId: theaterState.runId, sequenceNumber: theaterState.playheadSequence });
  },

  fileAnomaly(): void {
    if (!theaterState.runId) return;
    const event = theaterState.events.find((candidate) => candidate.sequenceNumber === theaterState.playheadSequence);
    const observation = [...theaterState.observations].reverse().find((candidate) => candidate.cursor.sequenceNumber <= theaterState.playheadSequence);
    send({ type: "theater_file_anomaly", runId: theaterState.runId, ...(event ? { eventId: event.id } : {}), ...(observation ? { observationId: observation.id } : {}) });
  },

  preserveArtifact(artifactId: string, preserved: boolean): void {
    if (!theaterState.runId) return;
    send({ type: "theater_preserve_artifact", runId: theaterState.runId, artifactId, preserved });
  },

  flagVideoFrame(artifactId: string, observationId: string, timeMs: number, dataUrl: string): void {
    if (!theaterState.runId) return;
    send({
      type: "theater_flag_video_frame",
      runId: theaterState.runId,
      artifactId,
      observationId,
      sequenceNumber: theaterState.playheadSequence,
      timeMs,
      dataUrl,
    });
  },

  requestWindow(from: number, to: number): void {
    if (!theaterState.runId) return;
    send({ type: "theater_window", runId: theaterState.runId, from, to });
  },

  selectRun(runId: string): void {
    send({ type: "theater_select_run", runId });
  },

  cancel(): void {
    send({ type: "theater_cancel" });
  },

  setShowInspection(show: boolean): void {
    theaterState.showInspection = show;
    bump();
  },

  setPlaying(playing: boolean): void {
    theaterState.playing = playing;
    if (playing && theaterState.playheadSequence >= theaterState.lastSequence) {
      theaterState.playheadSequence = theaterState.events[0]?.sequenceNumber ?? theaterState.playheadSequence;
      theaterState.following = false;
    }
    bump();
  },

  setPlaybackRate(rate: 0.5 | 1 | 2 | 4): void {
    theaterState.playbackRate = rate;
    bump();
  },

  setInspectorTab(tab: TheaterState["inspectorTab"]): void {
    theaterState.inspectorTab = tab;
    bump();
  },

  dismissError(): void {
    theaterState.error = undefined;
    bump();
  },
};

export function initTheaterStore(): void {
  onMessage(handleMessage);
  send({ type: "theater_ready" });
}
