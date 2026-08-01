import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Code2,
  Columns2,
  ExternalLink,
  Flag,
  Film,
  GitCompareArrows,
  ImageIcon,
  Map as MapIcon,
  Network,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  TicketPlus,
  X,
  ZoomIn,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import type {
  EntityRef,
  ExecutionRun,
  ObservationBundle,
  RunArtifact,
  RunComparison,
  RunComparisonSide,
  RunEvent,
  RunEventChannel,
  RunStatus,
  RunStep,
} from "./protocol";
import {
  initRunsStore,
  runActions,
  type EvidenceTab,
  useRunsStore,
} from "./store";
import {
  buildEventTracks,
  eventLabel,
  eventsForObservation,
  formatRunDuration,
  humanize,
  isTicketableEvent,
  navigationAnchors,
  nextAnchor,
  observationForSequence,
  runCoverage,
  runTitle,
  visualArtifactsForObservation,
  type EventTrack,
  type NavigationAnchor,
} from "./view-model";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "created",
  "validating",
  "awaiting_approval",
  "running",
]);

const EVIDENCE_TABS: Array<{ id: EvidenceTab; label: string; icon: typeof TerminalSquare }> = [
  { id: "logs", label: "Logs", icon: TerminalSquare },
  { id: "network", label: "Network", icon: Network },
  { id: "state", label: "State", icon: Code2 },
];

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function formatBytes(value: number | undefined): string {
  if (!value || value < 1) return "";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value >= 10_240 ? 0 : 1)} KB`;
  return `${(value / 1_048_576).toFixed(value >= 10_485_760 ? 0 : 1)} MB`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function stringifyPayload(payload: unknown): string {
  if (payload === undefined) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function eventChannelsForTab(tab: EvidenceTab): RunEventChannel[] {
  switch (tab) {
    case "logs":
      return ["log", "application_event", "diagnostic"];
    case "network":
      return ["network"];
    case "state":
      return ["state", "assertion", "metric", "filesystem"];
  }
}

function entityTitle(entity: EntityRef): string {
  return entity.label || entity.workspacePath || entity.id;
}

function isCodeEntity(entity: EntityRef): boolean {
  return entity.scheme === "workspace-file" || entity.scheme === "code-symbol";
}

function EmptyMessage({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="runs-empty">
      <span className="runs-empty-icon" aria-hidden>{icon}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="runs-metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function artifactSource(artifact: RunArtifact | undefined): string | undefined {
  return artifact?.thumbnailUrl || artifact?.url;
}

function ArtifactPreview({
  artifact,
  label,
  onZoom,
  compact = false,
}: {
  artifact: RunArtifact | undefined;
  label: string;
  onZoom: (artifact: RunArtifact) => void;
  compact?: boolean;
}) {
  const source = artifactSource(artifact);
  if (!artifact) {
    return (
      <div className={cn("runs-artifact-placeholder", compact && "is-compact")}>
        <ImageIcon aria-hidden />
        <span>No visual observation</span>
      </div>
    );
  }
  if (!source) {
    return (
      <div className={cn("runs-artifact-placeholder", compact && "is-compact")}>
        <ImageIcon aria-hidden />
        <span>{artifact.fileName || artifact.kind || "Artifact metadata retained"}</span>
        <small>Preview URL not loaded</small>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn("runs-artifact-button", compact && "is-compact")}
      onClick={() => onZoom(artifact)}
      title={`Open ${label} at full resolution`}
    >
      <img
        src={source}
        alt={label}
        loading="lazy"
        decoding="async"
      />
      <span className="runs-artifact-zoom"><ZoomIn aria-hidden />Zoom</span>
    </button>
  );
}

function ArtifactLightbox({
  artifact,
  onClose,
}: {
  artifact: RunArtifact | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!artifact) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [artifact, onClose]);

  if (!artifact) return null;
  const source = artifact.url || artifact.thumbnailUrl;
  return (
    <div
      className="runs-lightbox fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={artifact.fileName || "Run artifact preview"}
      onClick={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      {source
        ? <img src={source} alt={artifact.fileName || "Run artifact"} />
        : <div className="runs-artifact-placeholder"><ImageIcon aria-hidden />Preview unavailable</div>}
      <div className="runs-lightbox-caption">
        <span>{artifact.fileName || artifact.kind || artifact.id}</span>
        <span>{formatBytes(artifact.byteLength)}</span>
      </div>
      <Button
        className="runs-lightbox-close"
        variant="secondary"
        size="icon"
        onClick={onClose}
        title="Close preview"
        aria-label="Close preview"
      >
        <X />
      </Button>
    </div>
  );
}

function EventDetails({
  event,
  observationId,
  onOpenEntity,
  onFileTicket,
}: {
  event: RunEvent;
  observationId: string;
  onOpenEntity: (entity: EntityRef) => void;
  onFileTicket: (eventId: string, observationId: string) => void;
}) {
  const payload = stringifyPayload(event.inlinePayload);
  const ticketable = isTicketableEvent(event);
  return (
    <details className="runs-event-row" data-severity={event.severity || "info"}>
      <summary>
        <span className="runs-event-sequence">#{event.sequenceNumber}</span>
        <span className="runs-event-type">{humanize(event.type)}</span>
        <span className="runs-event-label">{eventLabel(event)}</span>
        {event.wallClockTimestamp && <time>{formatTimestamp(event.wallClockTimestamp)}</time>}
      </summary>
      <div className="runs-event-detail">
        <div className="runs-event-detail-head">
          <div className="runs-event-meta">
            <span>{humanize(event.channel)}</span>
            {event.source?.producer && <span>{event.source.producer}</span>}
            {event.laneId && <span>Lane {event.laneId}</span>}
          </div>
          {ticketable && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onFileTicket(event.id, observationId)}
              title="File a ticket with this run diagnostic attached"
            >
              <TicketPlus data-icon="inline-start" />
              File ticket
            </Button>
          )}
        </div>
        {payload && <pre>{payload}</pre>}
        {event.entityRefs.length > 0 && (
          <div className="runs-entity-list">
            {event.entityRefs.map((entity) => (
              <button
                type="button"
                key={`${entity.scheme}:${entity.id}`}
                onClick={() => onOpenEntity(entity)}
                title={`Open ${entityTitle(entity)}`}
              >
                <ExternalLink aria-hidden />
                <span>{entityTitle(entity)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function ObservationInspector({
  observation,
  events,
  artifacts,
  tab,
  onTab,
  onZoom,
}: {
  observation: ObservationBundle | undefined;
  events: RunEvent[];
  artifacts: RunArtifact[];
  tab: EvidenceTab;
  onTab: (tab: EvidenceTab) => void;
  onZoom: (artifact: RunArtifact) => void;
}) {
  const visuals = visualArtifactsForObservation(observation, artifacts);
  const visibleChannels = eventChannelsForTab(tab);
  const tabEvents = events.filter((event) => visibleChannels.includes(event.channel));
  const structuralArtifacts = observation
    ? [...observation.structuralArtifactIds, ...observation.stateArtifactIds]
      .map((id) => artifacts.find((artifact) => artifact.id === id))
      .filter((artifact): artifact is RunArtifact => Boolean(artifact))
    : [];

  if (!observation) {
    return (
      <aside className="runs-panel runs-inspector">
        <EmptyMessage
          icon={<Camera />}
          title="No observation selected"
          detail="Choose a step, event marker, anomaly, or checkpoint to inspect synchronized evidence."
        />
      </aside>
    );
  }

  return (
    <aside className="runs-panel runs-inspector">
      <div className="runs-panel-header">
        <div>
          <span className="eyebrow">Observation</span>
          <h2>{shortId(observation.id)}</h2>
        </div>
        <div className="runs-cursor-chip">#{observation.cursor.sequenceNumber}</div>
      </div>

      <ArtifactPreview
        artifact={visuals[0]}
        label={`Observation ${shortId(observation.id)}`}
        onZoom={onZoom}
      />

      {visuals.length > 1 && (
        <div className="runs-artifact-strip" aria-label="Additional visual artifacts">
          {visuals.map((artifact, index) => (
            <button
              type="button"
              key={artifact.id}
              onClick={() => onZoom(artifact)}
              title={artifact.fileName || `Visual artifact ${index + 1}`}
            >
              {artifactSource(artifact)
                ? <img src={artifact.thumbnailUrl || artifact.url} alt="" loading="lazy" decoding="async" />
                : <ImageIcon aria-hidden />}
            </button>
          ))}
        </div>
      )}

      <div className="runs-observation-meta">
        <span>{humanize(observation.captureProfile || "standard")} capture</span>
        <span>
          Events {observation.eventRange.firstSequenceNumber}–{observation.eventRange.lastSequenceNumber}
        </span>
        {observation.stateDigest && <span title={observation.stateDigest}>State {shortId(observation.stateDigest)}</span>}
      </div>

      {observation.entityRefs.length > 0 && (
        <section className="runs-inspector-section">
          <div className="runs-section-title">
            <span>Entity provenance</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => runActions.openOnMap(observation.entityRefs[0])}
            >
              <MapIcon data-icon="inline-start" />
              Show on map
            </Button>
          </div>
          <div className="runs-entity-list">
            {observation.entityRefs.map((entity) => (
              <button
                type="button"
                key={`${entity.scheme}:${entity.id}`}
                onClick={() => isCodeEntity(entity)
                  ? runActions.openEntity(entity)
                  : runActions.openOnMap(entity)}
                title={`${entity.scheme}: ${entityTitle(entity)}`}
              >
                {isCodeEntity(entity) ? <Code2 aria-hidden /> : <ExternalLink aria-hidden />}
                <span>{entityTitle(entity)}</span>
                <small>{humanize(entity.scheme)}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <Separator />

      <div className="runs-tab-list" role="tablist" aria-label="Observation evidence">
        {EVIDENCE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={cn("tab-strip-item", tab === id && "is-active")}
            onClick={() => onTab(id)}
          >
            <Icon aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div className="runs-evidence" role="tabpanel">
        {tab === "state" && structuralArtifacts.length > 0 && (
          <div className="runs-structural-list">
            {structuralArtifacts.map((artifact) => (
              <div key={artifact.id}>
                <Code2 aria-hidden />
                <span>{artifact.fileName || artifact.kind || shortId(artifact.id)}</span>
                <small>{formatBytes(artifact.byteLength)}</small>
              </div>
            ))}
          </div>
        )}
        {tabEvents.length === 0 && !(tab === "state" && structuralArtifacts.length > 0)
          ? (
            <EmptyMessage
              icon={tab === "network" ? <Network /> : tab === "state" ? <Code2 /> : <TerminalSquare />}
              title={`No ${tab} evidence in this window`}
              detail="The selected observation has no retained events on this channel."
            />
          )
          : tabEvents.map((event) => (
            <EventDetails
              key={event.id}
              event={event}
              observationId={observation.id}
              onOpenEntity={runActions.openEntity}
              onFileTicket={runActions.fileAnomalyTicket}
            />
          ))}
      </div>
    </aside>
  );
}

function positionFor(sequenceNumber: number, from: number, to: number): number {
  if (to <= from) return 50;
  return Math.max(0, Math.min(100, ((sequenceNumber - from) / (to - from)) * 100));
}

function stepBounds(step: RunStep, from: number, to: number): { left: number; width: number } | undefined {
  const start = step.startCursor?.sequenceNumber;
  const end = step.endCursor?.sequenceNumber ?? start;
  if (start === undefined || end === undefined || end < from || start > to) return undefined;
  const left = positionFor(Math.max(from, start), from, to);
  const right = positionFor(Math.min(to, Math.max(start, end)), from, to);
  return { left, width: Math.max(1.2, right - left) };
}

function StepTrack({
  steps,
  from,
  to,
  selectedSequence,
  onSelect,
}: {
  steps: RunStep[];
  from: number;
  to: number;
  selectedSequence: number;
  onSelect: (sequenceNumber: number) => void;
}) {
  return (
    <div className="runs-track-row">
      <div className="runs-track-label"><Flag aria-hidden />Steps</div>
      <div className="runs-track-lane">
        <div className="runs-track-cursor" style={{ left: `${positionFor(selectedSequence, from, to)}%` }} />
        {steps.map((step) => {
          const bounds = stepBounds(step, from, to);
          if (!bounds) return null;
          const sequence = step.startCursor?.sequenceNumber ?? step.endCursor?.sequenceNumber ?? from;
          return (
            <button
              type="button"
              key={step.id}
              className="runs-step-segment"
              data-status={step.status}
              style={{ left: `${bounds.left}%`, width: `${bounds.width}%` }}
              onClick={() => onSelect(sequence)}
              title={`${step.ordinal + 1}. ${step.title || step.declaredAction?.type || step.id} · ${step.status}`}
              aria-label={`Step ${step.ordinal + 1}: ${step.status}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function EventTrackRow({
  track,
  from,
  to,
  selectedSequence,
  onSelect,
}: {
  track: EventTrack;
  from: number;
  to: number;
  selectedSequence: number;
  onSelect: (sequenceNumber: number) => void;
}) {
  return (
    <div className="runs-track-row">
      <div className="runs-track-label"><Activity aria-hidden />{track.label}</div>
      <div className="runs-track-lane">
        <div className="runs-track-cursor" style={{ left: `${positionFor(selectedSequence, from, to)}%` }} />
        {track.events.map((event) => (
          <button
            type="button"
            key={event.id}
            className="runs-event-marker"
            data-severity={event.severity || "info"}
            data-selected={event.sequenceNumber === selectedSequence}
            style={{ left: `${positionFor(event.sequenceNumber, from, to)}%` }}
            onClick={() => onSelect(event.sequenceNumber)}
            title={`#${event.sequenceNumber} · ${humanize(event.type)} · ${eventLabel(event)}`}
            aria-label={`Event ${event.sequenceNumber}: ${humanize(event.type)}`}
          />
        ))}
      </div>
    </div>
  );
}

function AnchorNavigation({
  kind,
  anchors,
  selectedSequence,
  onSelect,
}: {
  kind: NavigationAnchor["kind"];
  anchors: NavigationAnchor[];
  selectedSequence: number;
  onSelect: (anchor: NavigationAnchor) => void;
}) {
  const count = anchors.filter((anchor) => anchor.kind === kind).length;
  const label = kind === "anomaly" ? "Anomaly" : "Checkpoint";
  const Icon = kind === "anomaly" ? AlertTriangle : Flag;
  const navigate = (direction: 1 | -1): void => {
    const anchor = nextAnchor(anchors, kind, selectedSequence, direction);
    if (anchor) onSelect(anchor);
  };
  return (
    <div className="runs-anchor-nav">
      <span><Icon aria-hidden />{label}<b>{count}</b></span>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={count === 0}
        onClick={() => navigate(-1)}
        title={`Previous ${label.toLowerCase()}`}
        aria-label={`Previous ${label.toLowerCase()}`}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={count === 0}
        onClick={() => navigate(1)}
        title={`Next ${label.toLowerCase()}`}
        aria-label={`Next ${label.toLowerCase()}`}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

function Timeline({
  run,
  steps,
  events,
  totalEvents,
  selectedSequence,
  from,
  to,
  pending,
  anchors,
  onSelectAnchor,
}: {
  run: ExecutionRun;
  steps: RunStep[];
  events: RunEvent[];
  totalEvents: number;
  selectedSequence: number;
  from: number;
  to: number;
  pending: boolean;
  anchors: NavigationAnchor[];
  onSelectAnchor: (anchor: NavigationAnchor) => void;
}) {
  const tracks = buildEventTracks(events);
  const safeFrom = totalEvents > 0 ? Math.max(1, from || 1) : 0;
  const safeTo = totalEvents > 0 ? Math.max(safeFrom, to || totalEvents) : 0;

  return (
    <section className="runs-panel runs-timeline">
      <div className="runs-panel-header">
        <div>
          <span className="eyebrow">Windowed trace</span>
          <h2>Timeline</h2>
        </div>
        <span className="runs-window-readout">
          {pending && <RefreshCw className="runs-spin" aria-hidden />}
          {totalEvents > 0 ? `${safeFrom}–${safeTo} of ${formatCount(totalEvents)}` : "No events"}
        </span>
      </div>

      <div className="runs-timeline-toolbar">
        <div className="runs-window-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={totalEvents === 0 || safeFrom <= 1 || pending}
            onClick={() => runActions.shiftWindow(-1)}
            title="Previous event window"
            aria-label="Previous event window"
          >
            <ArrowLeft />
          </Button>
          <input
            type="range"
            min={totalEvents > 0 ? 1 : 0}
            max={Math.max(1, totalEvents)}
            step={1}
            disabled={totalEvents === 0}
            value={Math.max(totalEvents > 0 ? 1 : 0, Math.min(totalEvents || 0, selectedSequence))}
            onChange={(event) => runActions.previewSequence(Number(event.currentTarget.value))}
            onPointerUp={(event) => runActions.commitSequence(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                runActions.commitSequence(Number(event.currentTarget.value));
              }
            }}
            aria-label={`Run cursor for ${runTitle(run)}`}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={totalEvents === 0 || safeTo >= totalEvents || pending}
            onClick={() => runActions.shiftWindow(1)}
            title="Next event window"
            aria-label="Next event window"
          >
            <ArrowRight />
          </Button>
        </div>
        <div className="runs-anchor-group">
          <AnchorNavigation
            kind="anomaly"
            anchors={anchors}
            selectedSequence={selectedSequence}
            onSelect={onSelectAnchor}
          />
          <AnchorNavigation
            kind="checkpoint"
            anchors={anchors}
            selectedSequence={selectedSequence}
            onSelect={onSelectAnchor}
          />
        </div>
      </div>

      <div className="runs-tracks" aria-label="Run event tracks">
        {totalEvents === 0
          ? (
            <EmptyMessage
              icon={<Activity />}
              title="This run has no retained events"
              detail="Step and observation metadata can still be inspected."
            />
          )
          : (
            <>
              <div className="runs-track-axis">
                <span>{safeFrom}</span>
                <span>{Math.round((safeFrom + safeTo) / 2)}</span>
                <span>{safeTo}</span>
              </div>
              <StepTrack
                steps={steps}
                from={safeFrom}
                to={safeTo}
                selectedSequence={selectedSequence}
                onSelect={runActions.commitSequence}
              />
              {tracks.map((track) => (
                <EventTrackRow
                  key={track.channel}
                  track={track}
                  from={safeFrom}
                  to={safeTo}
                  selectedSequence={selectedSequence}
                  onSelect={runActions.commitSequence}
                />
              ))}
            </>
          )}
      </div>
    </section>
  );
}

function ComparisonSideView({
  title,
  side,
  onZoom,
}: {
  title: string;
  side: RunComparisonSide | undefined;
  onZoom: (artifact: RunArtifact) => void;
}) {
  const artifact = side?.observation
    ? visualArtifactsForObservation(side.observation, side.artifacts)[0]
    : side?.artifacts.find((candidate) => candidate.mediaType?.startsWith("image/"));
  return (
    <section className="runs-comparison-side">
      <div className="runs-comparison-side-header">
        <div>
          <span className="eyebrow">{title}</span>
          <strong>{side ? shortId(side.runId) : "Not aligned"}</strong>
        </div>
        {side?.observation && <span>#{side.observation.cursor.sequenceNumber}</span>}
      </div>
      <ArtifactPreview
        artifact={artifact}
        label={`${title} comparison observation`}
        onZoom={onZoom}
        compact
      />
      <div className="runs-comparison-meta">
        {side?.step && <span>Step {side.step.ordinal + 1} · {humanize(side.step.status)}</span>}
        {side?.events.length
          ? <span>{side.events.length} synchronized events</span>
          : <span>No synchronized events</span>}
      </div>
    </section>
  );
}

function ComparisonPanel({
  comparison,
  alignmentId,
  runs,
  onZoom,
}: {
  comparison: RunComparison;
  alignmentId: string | undefined;
  runs: ExecutionRun[];
  onZoom: (artifact: RunArtifact) => void;
}) {
  const alignment = comparison.alignments.find((candidate) => candidate.id === alignmentId)
    ?? comparison.alignments[0];
  const leftRun = runs.find((run) => run.id === comparison.leftRunId);
  const rightRun = runs.find((run) => run.id === comparison.rightRunId);
  const summary = comparison.summary;
  return (
    <section className="runs-panel runs-comparison">
      <div className="runs-comparison-header">
        <div>
          <span className="eyebrow">Side-by-side comparison</span>
          <h2>{leftRun ? runTitle(leftRun) : shortId(comparison.leftRunId)} ↔ {rightRun ? runTitle(rightRun) : shortId(comparison.rightRunId)}</h2>
        </div>
        <div className="runs-comparison-controls">
          <Select
            value={alignment?.id || ""}
            options={comparison.alignments.map((candidate) => ({
              value: candidate.id,
              label: candidate.label,
              hint: candidate.confidence === undefined ? undefined : `${Math.round(candidate.confidence * 100)}%`,
            }))}
            onChange={runActions.selectComparisonAlignment}
            placeholder="No aligned observations"
            ariaLabel="Comparison alignment"
          />
          <Button variant="ghost" size="icon-sm" onClick={runActions.closeComparison} title="Close comparison" aria-label="Close comparison">
            <X />
          </Button>
        </div>
      </div>
      {summary && (
        <div className="runs-comparison-summary">
          <span data-kind="changed">{summary.changed} changed</span>
          <span data-kind="added">{summary.added} added</span>
          <span data-kind="removed">{summary.removed} removed</span>
          {summary.unchanged !== undefined && <span>{summary.unchanged} unchanged</span>}
        </div>
      )}
      {alignment
        ? (
          <>
            <div className="runs-comparison-grid">
              <ComparisonSideView title="Baseline / left" side={alignment.left} onZoom={onZoom} />
              <ComparisonSideView title="Current / right" side={alignment.right} onZoom={onZoom} />
            </div>
            {alignment.changes.length > 0 && (
              <div className="runs-change-list">
                {alignment.changes.map((change, index) => (
                  <div key={`${change.channel}:${change.kind}:${index}`} data-kind={change.kind} data-severity={change.severity}>
                    <span>{humanize(change.channel)}</span>
                    <strong>{humanize(change.kind)}</strong>
                    <p>{change.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )
        : (
          <EmptyMessage
            icon={<Columns2 />}
            title="No aligned observations"
            detail="The comparison completed without a shared semantic step or surface."
          />
        )}
    </section>
  );
}

function RunHeader({
  run,
  runs,
  steps,
  totalEvents,
  compareRunId,
  setCompareRunId,
  refreshing,
  comparisonPending,
}: {
  run: ExecutionRun;
  runs: ExecutionRun[];
  steps: RunStep[];
  totalEvents: number;
  compareRunId: string;
  setCompareRunId: (value: string) => void;
  refreshing: boolean;
  comparisonPending: boolean;
}) {
  const coverage = runCoverage(run, steps);
  const compareOptions = runs
    .filter((candidate) => candidate.id !== run.id)
    .map((candidate) => ({
      value: candidate.id,
      label: runTitle(candidate),
      hint: humanize(candidate.status),
    }));
  const baseline = run.baselineRunId
    ? runs.find((candidate) => candidate.id === run.baselineRunId)
    : undefined;
  const isPinned = run.retentionClass === "pinned";
  const isActive = ACTIVE_RUN_STATUSES.has(run.status);

  return (
    <header className="runs-header">
      <div className="runs-title-row">
        <div className="runs-brand">
          <span className="runs-brand-icon"><Activity aria-hidden /></span>
          <div>
            <span className="eyebrow">Execution evidence</span>
            <h1>Execution Runs</h1>
          </div>
        </div>
        <div className="runs-header-status">
          <StatusBadge status={run.status} />
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={refreshing}
            onClick={runActions.refresh}
            title="Refresh runs"
            aria-label="Refresh runs"
          >
            <RefreshCw className={cn(refreshing && "runs-spin")} />
          </Button>
        </div>
      </div>

      <div className="runs-run-picker">
        <Select
          value={run.id}
          options={runs.map((candidate) => ({
            value: candidate.id,
            label: runTitle(candidate),
            hint: [
              humanize(candidate.status),
              candidate.planId && candidate.phaseId ? `${candidate.planId}/${candidate.phaseId}` : undefined,
              candidate.ticketIds?.[0] ? `ticket ${candidate.ticketIds[0]}` : undefined,
              candidate.parentRunId ? "lineage" : undefined,
            ].filter(Boolean).join(" · "),
          }))}
          onChange={runActions.selectRun}
          ariaLabel="Selected execution run"
        />
      </div>

      <Button className="runs-open-workbench" variant="default" size="sm" onClick={runActions.openWorkbench}>
        <Film data-icon="inline-start" /> Open full workbench
      </Button>

      <div className="runs-primary-actions">
        <Button variant={isPinned ? "secondary" : "ghost"} size="sm" onClick={runActions.togglePinned}>
          {isPinned ? <PinOff data-icon="inline-start" /> : <Pin data-icon="inline-start" />}
          {isPinned ? "Unkeep" : "Keep"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => runActions.openOnMap()}>
          <MapIcon data-icon="inline-start" /> Map
        </Button>
        {isActive && (
          <Button variant="ghost" size="sm" onClick={runActions.cancelRun} className="runs-cancel-action">
            <CircleStop data-icon="inline-start" /> Cancel
          </Button>
        )}
      </div>

      <details className="runs-compare-disclosure">
        <summary><GitCompareArrows aria-hidden /><span>Compare this run</span><ChevronDown className="runs-disclosure-chevron" aria-hidden /></summary>
        <div className="runs-compare-controls">
          <Select
            value={compareRunId}
            options={compareOptions}
            onChange={setCompareRunId}
            placeholder="Compare with…"
            disabled={compareOptions.length === 0 || comparisonPending}
            ariaLabel="Run to compare"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!compareRunId || comparisonPending}
            onClick={() => runActions.compareWith(compareRunId)}
          >
            {comparisonPending ? <RefreshCw className="runs-spin" data-icon="inline-start" /> : <GitCompareArrows data-icon="inline-start" />}
            Compare
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!baseline || baseline.id === run.id || comparisonPending}
            onClick={() => baseline && runActions.compareWith(baseline.id)}
            title={baseline ? `Compare against ${runTitle(baseline)}` : "This run has no assigned baseline"}
          >
            <RotateCcw data-icon="inline-start" />
            {baseline ? "Baseline" : "No baseline"}
          </Button>
        </div>
      </details>

      <div className="runs-summary-row">
        <Metric label="Steps" value={`${coverage.completed}/${coverage.total}`} tone="ok" />
        <Metric label="Events" value={formatCount(run.summary?.eventCount ?? totalEvents)} />
        <Metric
          label="Issues"
          value={(run.summary?.warningCount ?? 0) + (run.summary?.errorCount ?? 0) + coverage.failed}
          tone={(run.summary?.errorCount ?? 0) + coverage.failed > 0 ? "error" : (run.summary?.warningCount ?? 0) > 0 ? "warning" : undefined}
        />
        <Metric label="Duration" value={formatRunDuration(run)} />
      </div>
    </header>
  );
}

function RunDigest({ run, steps }: { run: ExecutionRun; steps: RunStep[] }) {
  const ordered = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const findings = run.summary?.keyFindings?.slice(0, 3) ?? [];
  return (
    <section className="runs-digest" aria-label="Run at a glance">
      <div className="runs-digest-heading">
        <div><span className="eyebrow">At a glance</span><h2>{humanize(run.status)}</h2></div>
        <span>{run.summary?.replayability ?? "R0"} replay</span>
      </div>
      {run.summary?.failure?.message && (
        <div className="runs-digest-alert" role="status"><AlertTriangle aria-hidden /><span>{run.summary.failure.message}</span></div>
      )}
      <div className="runs-step-list">
        {ordered.map((step) => (
          <div key={step.id} className="runs-step-row" data-status={step.status}>
            <span className="runs-step-index">{step.ordinal + 1}</span>
            <span className="runs-step-title">{step.title || step.declaredAction?.type || `Step ${step.ordinal + 1}`}</span>
            <span className="runs-step-status">{humanize(step.status)}</span>
          </div>
        ))}
      </div>
      {findings.length > 0 && (
        <div className="runs-findings"><span className="eyebrow">Key findings</span>{findings.map((finding) => <p key={finding}>{finding}</p>)}</div>
      )}
    </section>
  );
}

export function RunExplorer() {
  const store = useRunsStore();
  const [compareRunId, setCompareRunId] = useState("");
  const [lightboxArtifact, setLightboxArtifact] = useState<RunArtifact>();

  useEffect(() => {
    initRunsStore();
  }, []);

  useEffect(() => {
    if (compareRunId && store.runs.some((run) => run.id === compareRunId && run.id !== store.selectedRun?.id)) return;
    const baseline = store.selectedRun?.baselineRunId;
    const fallback = baseline && baseline !== store.selectedRun?.id
      ? baseline
      : store.runs.find((run) => run.id !== store.selectedRun?.id)?.id;
    setCompareRunId(fallback || "");
  }, [compareRunId, store.runs, store.selectedRun]);

  const selectedObservation = useMemo(
    () => store.observations.find((observation) => observation.id === store.selectedObservationId),
    [store.observations, store.selectedObservationId],
  );
  const activeObservation = useMemo(
    () => selectedObservation
      ?? observationForSequence(store.observations, store.selectedSequenceNumber),
    [selectedObservation, store.observations, store.selectedSequenceNumber],
  );
  const synchronizedEvents = useMemo(
    () => eventsForObservation(activeObservation, store.events),
    [activeObservation, store.events],
  );
  const anchors = useMemo(
    () => navigationAnchors(store.steps, store.observations, store.events),
    [store.events, store.observations, store.steps],
  );

  const selectAnchor = (anchor: NavigationAnchor): void => {
    if (anchor.observationId) runActions.selectObservation(anchor.observationId);
    else runActions.commitSequence(anchor.sequenceNumber);
  };

  if (store.loading && !store.selectedRun) {
    return (
      <div className="runs-root">
        <div className="runs-loading">
          <span className="runs-brand-icon"><Activity aria-hidden /></span>
          <RefreshCw className="runs-spin" aria-hidden />
          <strong>Loading execution runs…</strong>
        </div>
      </div>
    );
  }

  if (!store.selectedRun) {
    return (
      <div className="runs-root">
        <header className="runs-header runs-empty-header">
          <div className="runs-brand">
            <span className="runs-brand-icon"><Activity aria-hidden /></span>
            <div><span className="eyebrow">Execution evidence</span><h1>Run Explorer</h1></div>
          </div>
          <Button variant="outline" size="sm" onClick={runActions.refresh}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </header>
        <main className="runs-zero-state">
          <EmptyMessage
            icon={<CheckCircle2 />}
            title="No retained execution runs"
            detail="Run a bounded sequence to capture synchronized visuals, logs, network activity, state, and diagnostics."
          />
        </main>
      </div>
    );
  }

  const selectedRun = store.selectedRun;
  return (
    <div className="runs-root">
      <RunHeader
        run={selectedRun}
        runs={store.runs}
        steps={store.steps}
        totalEvents={store.totalEvents}
        compareRunId={compareRunId}
        setCompareRunId={setCompareRunId}
        refreshing={store.refreshing}
        comparisonPending={store.comparisonPending}
      />

      {store.error && (
        <div className="runs-error" role="alert">
          <AlertTriangle aria-hidden />
          <span>{store.error}</span>
          <Button variant="ghost" size="icon-xs" onClick={runActions.clearError} title="Dismiss error" aria-label="Dismiss error">
            <X />
          </Button>
        </div>
      )}

      <main className="runs-content">
        {store.comparison && (
          <ComparisonPanel
            comparison={store.comparison}
            alignmentId={store.comparisonAlignmentId}
            runs={store.runs}
            onZoom={setLightboxArtifact}
          />
        )}

        <RunDigest run={selectedRun} steps={store.steps} />

        <details className="runs-evidence-disclosure">
          <summary>
            <span><Activity aria-hidden /><span><strong>Quick evidence</strong><small>Timeline, captures, and synchronized events</small></span></span>
            <ChevronDown className="runs-disclosure-chevron" aria-hidden />
          </summary>
          <div className="runs-workspace">
            <Timeline
              run={selectedRun}
              steps={store.steps}
              events={store.events}
              totalEvents={store.totalEvents}
              selectedSequence={store.selectedSequenceNumber}
              from={store.window.from}
              to={store.window.to}
              pending={store.windowPending}
              anchors={anchors}
              onSelectAnchor={selectAnchor}
            />
            <ObservationInspector
              observation={activeObservation}
              events={synchronizedEvents}
              artifacts={store.artifacts}
              tab={store.evidenceTab}
              onTab={runActions.setEvidenceTab}
              onZoom={setLightboxArtifact}
            />
          </div>
        </details>
      </main>

      <ArtifactLightbox artifact={lightboxArtifact} onClose={() => setLightboxArtifact(undefined)} />
    </div>
  );
}
