/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useEffect, useRef, useState } from "react";
import { actions } from "../store";
import {
  ANNOTATION_COLOR,
  GIT_WARM_COLOR,
  IMPORT_EDGE_COLOR,
  RELATIONSHIP_EDGE_COLORS,
  SYMBOL_RELATION_COLORS,
  TRACE_COLORS,
  cssColor,
} from "@/lib/graph/colors";
import { FILE_ROLE_COLORS, FILE_ROLE_LABELS } from "@/lib/graph/file-role";
import { DEPTH_CHANNELS, DEPTH_CHANNEL_HINTS, DEPTH_CHANNEL_LABELS } from "@/lib/graph/depth";
import {
  MOTION_DESCRIPTIONS,
  flowParticles,
  signatureForEdgeKind,
  signatureForSymbolRelation,
  type FlowSignature,
} from "@/lib/graph/flow-signature";
import { altitudeBand, type GraphDisplayOptions, type MapAltitude } from "@/lib/graph/view-model";
import {
  LEGEND,
  RELATIONSHIP_LEGEND,
  SYMBOL_RELATION_LEGEND,
  ROLE_MARK_LEGEND,
  PREFERS_REDUCED_MOTION,
} from "./shared";

export const ALTITUDE_BANDS: Array<{ band: MapAltitude; label: string; hint: string }> = [
  { band: "overview", label: "Overview", hint: "Whole-map altitude: territories and the strongest routes" },
  { band: "modules", label: "Modules", hint: "Module altitude: hub labels and folder structure" },
  { band: "files", label: "Files", hint: "File altitude: individual stars, badges, and raw links" },
];

export function Legend({ fileCount, importCount, gitHeat, relationshipCount, servicesLens, zoomRatio, onAltitude, onOpenMapKey }: {
  fileCount: number;
  importCount: number;
  gitHeat: boolean;
  relationshipCount: number;
  servicesLens: boolean;
  zoomRatio: number;
  onAltitude: (band: MapAltitude) => void;
  onOpenMapKey: () => void;
}) {
  const activeBand = altitudeBand(zoomRatio);
  // The controls rail above reserves this height so the two never overlap. The legend grows
  // with the lens (services add a row per relationship kind), so a fixed reservation can't.
  const legendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const legend = legendRef.current;
    if (!legend) return;
    const observer = new ResizeObserver(() => {
      legend.parentElement?.style.setProperty("--map-legend-height", legend.offsetHeight + "px");
    });
    observer.observe(legend);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={legendRef} className="map-legend pointer-events-none absolute bottom-3 right-3 flex flex-col gap-0.5 px-2 py-1.5">
      <button
        className="pointer-events-auto mb-0.5 self-end rounded border border-border/60 px-1.5 py-0.5 text-2xs text-slate-300/85 hover:bg-white/10 hover:text-foreground"
        onClick={onOpenMapKey}
        title="What am I looking at? Explains territories, stars, lines, and activity."
      >
        ? Map key
      </button>
      {/* Altitude meter: names the semantic zoom band the camera is at (the
          same bands the label overlay crossfades through) and flies there on
          click — the "where am I in the zoom hierarchy?" answer. */}
      <div className="pointer-events-auto mb-0.5 flex items-center gap-0.5 border-b border-border/60 pb-1" role="group" aria-label="Zoom altitude">
        {ALTITUDE_BANDS.map(({ band, label, hint }) => (
          <button
            key={band}
            className={`rounded px-1 py-0.5 text-2xs uppercase tracking-wide transition-colors ${
              activeBand === band ? "bg-white/15 text-foreground" : "text-muted-foreground hover:bg-white/8 hover:text-foreground"
            }`}
            aria-pressed={activeBand === band}
            onClick={() => onAltitude(band)}
            title={hint}
          >
            {label}
          </button>
        ))}
      </div>
      {fileCount > 0 && !servicesLens && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-xs text-slate-300/85">
          {fileCount.toLocaleString()} files · {importCount.toLocaleString()} imports
        </div>
      )}
      {relationshipCount > 0 && (
        <div className="mb-0.5 border-b border-border/60 pb-1 text-xs text-slate-300/85">
          {relationshipCount.toLocaleString()} service edges
        </div>
      )}
      {gitHeat && (
        <div className="mb-0.5 flex items-center gap-1.5 border-b border-border/60 pb-1 text-xs text-muted-foreground">
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }}
          />
          older → recent · size = churn
        </div>
      )}
      {servicesLens && (
        <div className="mb-0.5 flex flex-col gap-0.5 border-b border-border/60 pb-1">
          {RELATIONSHIP_LEGEND.map(({ label, kind }) => (
            <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6) }} />
              {label}
            </div>
          ))}
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-px w-8 rounded-full bg-gradient-to-r from-white/10 to-white/70" />
            faint → solid · detection confidence
          </div>
        </div>
      )}
      {LEGEND.map(({ label, kind }) => (
        <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
          {label}
        </div>
      ))}
    </div>
  );
}

/** Motions the map key demonstrates, in the order they're worth learning:
 *  the two you see constantly, then the typed service traffic, then the
 *  language-server layer. Each pairs with the colour its edges are actually
 *  drawn in, so the swatch teaches colour and movement together. */
export const MOTION_LEGEND: Array<{ label: string; signature: FlowSignature; color: number }> = [
  { label: "Import", signature: signatureForEdgeKind("import"), color: IMPORT_EDGE_COLOR },
  { label: "API call", signature: signatureForEdgeKind("api"), color: RELATIONSHIP_EDGE_COLORS.api ?? IMPORT_EDGE_COLOR },
  { label: "Event", signature: signatureForEdgeKind("event"), color: RELATIONSHIP_EDGE_COLORS.event ?? IMPORT_EDGE_COLOR },
  { label: "Shared data", signature: signatureForEdgeKind("data"), color: RELATIONSHIP_EDGE_COLORS.data ?? IMPORT_EDGE_COLOR },
  { label: "Config ref", signature: signatureForEdgeKind("config"), color: RELATIONSHIP_EDGE_COLORS.config ?? IMPORT_EDGE_COLOR },
  { label: "Call", signature: signatureForSymbolRelation("call"), color: SYMBOL_RELATION_COLORS.call },
  { label: "Extends", signature: signatureForSymbolRelation("extends"), color: SYMBOL_RELATION_COLORS.extends },
  { label: "Reference", signature: signatureForSymbolRelation("reference"), color: SYMBOL_RELATION_COLORS.reference },
  { label: "Declared dependency", signature: signatureForEdgeKind("project_ref"), color: RELATIONSHIP_EDGE_COLORS.project_ref ?? IMPORT_EDGE_COLOR },
  /* Dashed between two codebases when nothing structural explains it: hidden coupling. */
  { label: "Changed together", signature: signatureForEdgeKind("cochange"), color: RELATIONSHIP_EDGE_COLORS.cochange ?? IMPORT_EDGE_COLOR },
];

/** A shared ~30fps clock for the motion key's swatches. One timer for the whole
 *  panel rather than one per swatch, and only while `active` — the key is a
 *  transient overlay and must not keep a repaint loop running behind it. */
export function useMotionClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || PREFERS_REDUCED_MOTION) return;
    const id = window.setInterval(() => setNow(Date.now()), 33);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** A live preview of one relationship's motion, driven by the *same*
 *  `flowParticles` the canvas uses — so the key can't drift from the map the
 *  way a hand-drawn CSS approximation would. Under reduced motion it renders a
 *  single static dot: the colour and the description still teach the mark. */
export function MotionSwatch({ signature, color, now }: { signature: FlowSignature; color: number; now: number }) {
  const particles = PREFERS_REDUCED_MOTION
    ? [{ t: 0.5, alpha: signature.intensity, radius: signature.radius, reverse: false }]
    : flowParticles(signature, 0, now);
  return (
    <span className="relative h-3 w-14 shrink-0 self-center overflow-hidden rounded-full">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2" style={{ background: cssColor(color), opacity: 0.28 }} />
      {particles.map((particle, index) => (
        <span
          key={index}
          className="absolute top-1/2 rounded-full"
          style={{
            left: `${particle.t * 100}%`,
            width: `${particle.radius * 2.4}px`,
            height: `${particle.radius * 2.4}px`,
            marginLeft: `${-particle.radius * 1.2}px`,
            marginTop: `${-particle.radius * 1.2}px`,
            background: cssColor(color),
            opacity: particle.alpha,
          }}
        />
      ))}
    </span>
  );
}

export function MapKeySwatch({ color, dashed }: { color: number; dashed?: boolean }) {
  return (
    <span
      className={`h-0 w-6 shrink-0 border-t-[1.5px] ${dashed ? "border-dashed" : "border-solid"}`}
      style={{ borderColor: cssColor(color) }}
    />
  );
}

/** The full explainer behind the "? Map key" button — this is the answer to
    "why does the map look like this," always one click away rather than
    something a user has to be told out-of-band. Every swatch here reuses the
    same color constants the renderer actually draws with, so it can't drift
    from what's on screen. */
/** Depth control: which axis the map's spatial depth cue encodes, and how hard.
    Depth is real here — haze, draw order, size falloff, edge recession, and
    parallax all read it — so which axis it spends that dimension on is a
    choice worth surfacing rather than hard-coding.

    The live caption is load-bearing, not decoration: without it somebody who
    changes the channel watches the whole map shift with no idea what they are
    now looking at. */
export function DepthSection({ display }: { display: GraphDisplayOptions }) {
  const flat = !(display.depthIntensity > 0);
  return (
    <div className="mt-1.5 flex flex-col gap-1" data-map-region="depth">
      <div className="map-eyebrow">Depth</div>
      <div className="flex flex-wrap gap-1">
        {DEPTH_CHANNELS.map((channel) => (
          <button
            key={channel}
            type="button"
            className={`map-layer-toggle ${display.depthChannel === channel && !flat ? "map-layer-toggle-on" : ""}`}
            aria-pressed={display.depthChannel === channel}
            data-map-control={`depth-channel-${channel}`}
            title={DEPTH_CHANNEL_HINTS[channel]}
            onClick={() => actions.setDisplay({
              depthChannel: channel,
              /* Picking a channel from a flat map is a request to see it. */
              ...(flat ? { depthIntensity: 1 } : {}),
            })}
          >
            <span>{DEPTH_CHANNEL_LABELS[channel]}</span>
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0">Intensity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(display.depthIntensity * 100)}
          data-map-control="depth-intensity"
          aria-label="Depth intensity"
          className="min-w-0 flex-1"
          onChange={(e) => actions.setDisplay({ depthIntensity: Number(e.target.value) / 100 })}
        />
        <span className="w-8 shrink-0 text-right tabular-nums">{flat ? "Flat" : `${Math.round(display.depthIntensity * 100)}%`}</span>
      </label>
      <div className="text-2xs text-muted-foreground">
        {flat ? "Depth off — every file draws flat" : DEPTH_CHANNEL_HINTS[display.depthChannel]}
      </div>
    </div>
  );
}

export function MapKeyPanel({ onClose }: { onClose: () => void }) {
  const motionNow = useMotionClock(true);
  return (
    <div className="map-panel pointer-events-auto absolute bottom-3 right-3 z-10 flex max-h-[75%] w-[min(320px,calc(100vw-24px))] flex-col gap-3 overflow-y-auto px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-base font-semibold text-foreground">Map key</div>
        <button className="rounded border border-border/60 px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-white/10 hover:text-foreground" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Territories</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Each soft bordered region is a top-level folder. Its color is a fixed hash of the folder path — the same
          folder is always the same hue, in every session. Overlapping regions just mean two folders' files sit
          close together in the layout; it isn't a conflict.
        </p>
        <p className="text-sm leading-snug text-muted-foreground">
          The border pattern names what a territory mostly holds: solid = source code, dashed = tests,
          long-dash = config, dotted = docs, short-dash = styles — with the hue leaning toward that
          purpose's color.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Stars</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Every star is one file, colored by its territory. Size and brightness scale with how connected it is,
          plus the file's size on disk — a heavily-imported or large file reads bigger and brighter. A dimmed,
          ghosted star has been filtered out by search or isolation, not deleted.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-8 rounded-full" style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }} />
          with git heat on: warmer = more recently changed
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Depth</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Stars sit at different distances. Near ones are crisp and full-size; far ones fade toward the
          background, shrink slightly, draw behind their neighbors, and drift a little more slowly as you pan.
          Set what distance means — folder nesting by default — under Layers &gt; Depth, or slide it to Flat
          to turn the whole cue off.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Aggregates</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-3 w-3 shrink-0 rounded-full border border-slate-300/80" />
          A ringed star is a whole folder collapsed into one — double-click it to unfold the files inside
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 shrink-0 rotate-45 border border-slate-300/80" />
          A diamond outline is a service in the Services lens — one node per deployable unit
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Badges</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Small glyphs on a star only appear once you're zoomed in close enough to read them.
        </p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-[#8fa9d6]" />
          A dot colored by file kind — code, markup, styles, data/config, or docs
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-[#ffd66b]" />
          A gold ring on the small fraction of files with the most connections — the hubs
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ffd66b]" />
          A gold dot — this file has agent working-memory notes attached; open it to read them
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="shrink-0">Role marks:</span>
          {ROLE_MARK_LEGEND.map(({ role, glyph }) => (
            <span key={role} className="flex items-center gap-1">
              <span className="font-mono text-xs" style={{ color: cssColor(FILE_ROLE_COLORS[role]) }}>{glyph}</span>
              {FILE_ROLE_LABELS[role].toLowerCase()}
            </span>
          ))}
        </div>
        <p className="text-xs leading-snug text-muted-foreground">
          A small shape in a star's lower-left corner names the file's job; plain source files carry none.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Lines</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapKeySwatch color={IMPORT_EDGE_COLOR} />
          Import between two files
        </div>
        {RELATIONSHIP_LEGEND.map(({ label, kind }) => (
          <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapKeySwatch color={RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6} />
            {label} relationship — thicker means more detections; brighter means higher detector confidence
          </div>
        ))}
        {SYMBOL_RELATION_LEGEND.map(({ label, relation }) => (
          <div key={relation} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapKeySwatch color={SYMBOL_RELATION_COLORS[relation]} />
            {label} (from the language server)
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapKeySwatch color={ANNOTATION_COLOR} dashed />
          A note an agent (or you) attached between two files
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Motion</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Relationships don't all move the same way — each one behaves like the thing it is, so you can read the
          map by movement before reading a single label. These previews run the exact animation the canvas does.
        </p>
        {MOTION_LEGEND.map(({ label, signature, color }) => (
          <div key={label} className="flex items-start gap-2 text-xs text-muted-foreground">
            <MotionSwatch signature={signature} color={color} now={motionNow} />
            <span className="leading-snug">
              <span className="text-slate-300">{label}</span> — {MOTION_DESCRIPTIONS[signature.motion]}
            </span>
          </div>
        ))}
        <p className="text-xs leading-snug text-muted-foreground">
          Stars breathe too: a file changed often and recently pulses visibly, while an untouched corner of the
          codebase sits almost perfectly still.
        </p>
        <p className="text-xs leading-snug text-muted-foreground">
          A dashed line between two codebases is <span className="text-slate-300">hidden coupling</span>: they keep
          changing in the same commits, but no import, route, or declared dependency connects them.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Codebases and scope</div>
        <p className="text-sm leading-snug text-muted-foreground">
          A large star with a ring and a label is a folded group — a codebase, project, or workspace folder — sized
          by how many files it holds. Double-click it (or pick it in the outline) to step inside; the breadcrumb at
          the top left and Backspace take you back out. Inside a scope, areas fold into single stars when there is
          more than the focus budget to draw, and unfold around what you select and where the agent is working.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live activity</div>
        <p className="text-sm leading-snug text-muted-foreground">
          Colored pulses flowing along a line mean an agent just read, wrote, edited, or ran a shell command near
          that file. A steady ring around a star means an agent is working on it right now. When several agents run
          in parallel, each gets its own identity color instead of the activity-kind color below.
        </p>
        {LEGEND.map(({ label, kind }) => (
          <div key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
