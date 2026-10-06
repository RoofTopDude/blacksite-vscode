/* The Map's legend card (bottom right), the full Map key behind it, and the
   Depth control the Advanced section embeds. Every swatch reuses the colour
   constants the renderer draws with, so neither can drift from the canvas. */

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { BookOpen, X } from "lucide-react";
import {
  LEGEND,
  RELATIONSHIP_LEGEND,
  SYMBOL_RELATION_LEGEND,
  ROLE_MARK_LEGEND,
  PREFERS_REDUCED_MOTION,
} from "./shared";
import { MapIconButton, MapSegmented } from "./ui";

export const ALTITUDE_BANDS: Array<{ band: MapAltitude; label: string; hint: string }> = [
  { band: "overview", label: "Overview", hint: "Whole-map altitude: codebases, folders, and the strongest routes" },
  { band: "modules", label: "Folders", hint: "Folder altitude: folder labels and structure" },
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
  // The display rail above reserves this height so the two never overlap. The legend grows
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
    <div ref={legendRef} className="map-legend pointer-events-auto absolute bottom-3 right-3" data-map-region="legend">
      {/* Altitude meter: names the semantic zoom band the camera is at (the
          same bands the label overlay crossfades through) and flies there on
          click — the "where am I in the zoom hierarchy?" answer. */}
      <div className="map-legend-head">
        <MapSegmented
          label="Zoom altitude"
          size="xs"
          value={activeBand}
          onChange={onAltitude}
          options={ALTITUDE_BANDS.map(({ band, label, hint }) => ({ value: band, label, title: hint }))}
        />
        <MapIconButton icon={BookOpen} label="Map key — what the regions, stars, lines, and motion mean" onClick={onOpenMapKey} />
      </div>
      {fileCount > 0 && !servicesLens && (
        <div className="map-legend-line" title="Files drawn and the import links between them">
          {fileCount.toLocaleString()} files · {importCount.toLocaleString()} imports
        </div>
      )}
      {relationshipCount > 0 && servicesLens && (
        <div className="map-legend-line">{relationshipCount.toLocaleString()} service edges · faint → solid = confidence</div>
      )}
      {gitHeat && (
        <div className="map-legend-line" title="With git heat on, warmer stars changed more recently and bigger ones change more often">
          <span className="h-1.5 w-8 shrink-0 rounded-full" style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }} aria-hidden />
          older → recent · size = churn
        </div>
      )}
      <div className="map-legend-grid" title="Pulses along the links show what the agent just did; a ring marks the file it is on right now">
        {(servicesLens ? RELATIONSHIP_LEGEND.map(({ label, kind }) => ({ label, color: RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6 })) : LEGEND.map(({ label, kind }) => ({ label, color: TRACE_COLORS[kind] }))).map(({ label, color }) => (
          <span key={label} className="map-legend-item">
            <span className="map-legend-dot" style={{ background: cssColor(color) }} aria-hidden />
            {label}
          </span>
        ))}
      </div>
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
    <div className="flex flex-col gap-1.5" data-map-region="depth">
      <span className="map-hint">Depth means</span>
      <div className="flex flex-wrap gap-1">
        {DEPTH_CHANNELS.map((channel) => {
          const on = display.depthChannel === channel && !flat;
          return (
            <button
              key={channel}
              type="button"
              className={`map-chip ${on ? "map-chip-on" : ""}`}
              aria-pressed={display.depthChannel === channel}
              data-map-control={`depth-channel-${channel}`}
              title={DEPTH_CHANNEL_HINTS[channel]}
              onClick={() => actions.setDisplay({
                depthChannel: channel,
                /* Picking a channel from a flat map is a request to see it. */
                ...(flat ? { depthIntensity: 1 } : {}),
              })}
            >
              {DEPTH_CHANNEL_LABELS[channel]}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-2xs text-[color:var(--map-text-3)]">
        <span className="shrink-0">Intensity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(display.depthIntensity * 100)}
          data-map-control="depth-intensity"
          aria-label="Depth intensity"
          className="min-w-0 flex-1 accent-[color:var(--primary)]"
          onChange={(e) => actions.setDisplay({ depthIntensity: Number(e.target.value) / 100 })}
        />
        <span className="w-8 shrink-0 text-right tabular-nums">{flat ? "Flat" : `${Math.round(display.depthIntensity * 100)}%`}</span>
      </label>
      <div className="map-hint">{flat ? "Depth off — every file draws flat" : DEPTH_CHANNEL_HINTS[display.depthChannel]}</div>
    </div>
  );
}

function KeySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="map-section-title !text-xs !text-[color:var(--map-text-2)]">{title}</h3>
      {children}
    </section>
  );
}

const keyText = "text-xs leading-relaxed text-[color:var(--map-text-3)]";
const keyRow = "flex items-center gap-2 text-xs text-[color:var(--map-text-3)]";

/** The full explainer behind the legend's key button — the answer to "why does
    the map look like this," always one click away rather than out-of-band. */
export function MapKeyPanel({ onClose }: { onClose: () => void }) {
  const motionNow = useMotionClock(true);
  return (
    <div className="map-panel map-card pointer-events-auto absolute bottom-3 right-3 z-10 flex max-h-[78%] w-[min(340px,calc(100%-24px))] flex-col gap-4 overflow-y-auto" data-map-region="map-key">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[color:var(--map-text)]">Map key</div>
        <MapIconButton icon={X} label="Close the map key" onClick={onClose} />
      </div>

      <KeySection title="Layout">
        <p className={keyText}>
          The map follows your folders. Each folder is one region, nested inside its parent&apos;s, so everything under
          a folder stays together and sibling folders never mix. Import links and declared dependencies only decide
          which neighbours sit closest and which way a folder faces.
        </p>
        <p className={keyText}>
          Large workspaces with several codebases give each codebase its own region with a wider gap around it.
          A very large flat folder is split into chunks that stay side by side.
        </p>
      </KeySection>

      <KeySection title="Regions">
        <p className={keyText}>
          A soft outline surrounds each folder&apos;s files. Its colour is a fixed hash of the folder path, the same in
          every session. The outline pattern names what the folder mostly holds: solid for source, dashed for tests,
          long dashes for config, dots for docs, short dashes for styles.
        </p>
      </KeySection>

      <KeySection title="Stars">
        <p className={keyText}>
          Every star is one file, coloured by its folder. Size and brightness grow with how connected it is and its
          size on disk. A ghosted star is filtered out by search or isolation, not deleted.
        </p>
        <div className={keyRow}>
          <span className="h-1.5 w-8 shrink-0 rounded-full" style={{ background: `linear-gradient(90deg, #33405e, ${cssColor(GIT_WARM_COLOR)})` }} />
          With git heat on: warmer means changed more recently
        </div>
      </KeySection>

      <KeySection title="Depth">
        <p className={keyText}>
          Stars sit at different distances: near ones are crisp, far ones fade, shrink slightly, and drift more slowly
          as you pan. Choose what distance means — folder nesting by default — under Display › Advanced, or set it
          to flat.
        </p>
      </KeySection>

      <KeySection title="Folded groups">
        <div className={keyRow}>
          <span className="h-3 w-3 shrink-0 rounded-full border border-slate-300/80" />
          A ringed star is a folded folder or codebase — double-click to step inside
        </div>
        <div className={keyRow}>
          <span className="h-2.5 w-2.5 shrink-0 rotate-45 border border-slate-300/80" />
          A diamond is a service in the Services lens
        </div>
      </KeySection>

      <KeySection title="Badges">
        <div className={keyRow}>
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-[#ffd66b]" />
          Gold ring: one of the most-connected files (a hub)
        </div>
        <div className={keyRow}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffd66b]" />
          Gold dot: the file has working-memory notes
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[color:var(--map-text-3)]">
          {ROLE_MARK_LEGEND.map(({ role, glyph }) => (
            <span key={role} className="flex items-center gap-1">
              <span className="font-mono" style={{ color: cssColor(FILE_ROLE_COLORS[role]) }}>{glyph}</span>
              {FILE_ROLE_LABELS[role].toLowerCase()}
            </span>
          ))}
        </div>
        <p className={keyText}>Badges appear once you zoom in close enough to read them. The corner mark names a file&apos;s job; plain source files carry none.</p>
      </KeySection>

      <KeySection title="Lines">
        <div className={keyRow}><MapKeySwatch color={IMPORT_EDGE_COLOR} /> Import between two files</div>
        {RELATIONSHIP_LEGEND.map(({ label, kind }) => (
          <div key={kind} className={keyRow}>
            <MapKeySwatch color={RELATIONSHIP_EDGE_COLORS[kind] ?? 0x8fa9d6} />
            {label} — thicker means more detections, brighter means more confident
          </div>
        ))}
        {SYMBOL_RELATION_LEGEND.map(({ label, relation }) => (
          <div key={relation} className={keyRow}>
            <MapKeySwatch color={SYMBOL_RELATION_COLORS[relation]} />
            {label} (language server)
          </div>
        ))}
        <div className={keyRow}><MapKeySwatch color={ANNOTATION_COLOR} dashed /> A note attached between two files</div>
      </KeySection>

      <KeySection title="Motion">
        <p className={keyText}>Each kind of relationship moves like the thing it is, so you can read the map by movement. These previews run the canvas&apos;s own animation.</p>
        {MOTION_LEGEND.map(({ label, signature, color }) => (
          <div key={label} className="flex items-start gap-2 text-xs text-[color:var(--map-text-3)]">
            <MotionSwatch signature={signature} color={color} now={motionNow} />
            <span className="leading-snug"><span className="text-[color:var(--map-text-2)]">{label}</span> — {MOTION_DESCRIPTIONS[signature.motion]}</span>
          </div>
        ))}
        <p className={keyText}>
          Stars breathe too: a file changed often and recently pulses visibly. A dashed line between two codebases is
          hidden coupling — they change in the same commits, but nothing structural connects them.
        </p>
      </KeySection>

      <KeySection title="Scope">
        <p className={keyText}>
          Double-click a folded group, or pick it in the outline, to step inside; the breadcrumb and Backspace take you
          back out. Inside a scope, areas fold into single stars when there is more than the focus budget to draw, and
          unfold around your selection and where the agent is working.
        </p>
      </KeySection>

      <KeySection title="Live activity">
        <p className={keyText}>
          Coloured pulses along a line mean the agent just read, wrote, edited, or ran something near that file; a
          steady ring marks the file it is on now. Parallel agents each get their own colour.
        </p>
        <div className="map-legend-grid">
          {LEGEND.map(({ label, kind }) => (
            <span key={kind} className="map-legend-item">
              <span className="map-legend-dot" style={{ background: cssColor(TRACE_COLORS[kind]) }} />
              {label}
            </span>
          ))}
        </div>
      </KeySection>
    </div>
  );
}
