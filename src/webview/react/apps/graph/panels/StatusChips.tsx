/* Codebase Map panel module, split out of GraphApp.tsx (move-only; see
   docs/map-scale-implementation-plan.md B8). */

import { useMemo, useState } from "react";
import { actions } from "../store";
import { activityColor, cssColor } from "@/lib/graph/colors";
import { baseName, traceKindVerb, type GraphViewState } from "@/lib/graph/view-model";
import type { LiveActivity } from "@/lib/graph/protocol";
import { compactDuration } from "./shared";

export const SHORTCUTS: Array<[string, string]> = [
  ["Drag", "Pan the map"],
  ["Wheel", "Zoom in / out"],
  ["Click star", "Select a file"],
  ["Double-click star", "Open the file (or expand a cluster)"],
  ["Click minimap", "Jump the camera there"],
  ["/", "Search"],
  ["Enter", "Open selected / top match"],
  ["F", "Fit whole map"],
  ["+ / -", "Zoom in / out"],
  ["WASD / Arrows", "Pan (hold Shift for a bigger step)"],
  ["Esc", "Clear selection / search"],
];

/** Heads-up readout of what the agent is doing on the map right now, driven by
    in-flight tool calls. Hidden when the agent is idle. */
export function LiveActivityChip({ live }: { live: LiveActivity[] }) {
  if (live.length === 0) return null;
  const primary = live[0]; /* host sorts most-recent-first */
  if (!primary) return null;
  const color = cssColor(activityColor(primary.kind, primary.laneId));
  const extra = live.length - 1;
  const laneCount = new Set(live.map((item) => item.laneId ?? "main")).size;
  const laneLabel = primary.laneId ? "lane" : "main";
  return (
    <div className="map-live-chip pointer-events-none absolute left-1/2 top-3 -translate-x-1/2" role="status" aria-live="polite">
      <span className="map-live-dot" style={{ color, background: color }} />
      <span className="whitespace-nowrap text-xs text-foreground">
        <span style={{ color }}>{laneLabel}</span>{" "}
        <span className="text-muted-foreground">{traceKindVerb(primary.kind)}</span>{" "}
        <strong className="font-mono font-semibold">{baseName(primary.path)}</strong>
        {primary.detail && <span className="text-muted-foreground"> · {primary.detail}</span>}
        {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
        {laneCount > 1 && <span className="text-muted-foreground"> · {laneCount} lanes</span>}
      </span>
    </div>
  );
}

/** Compact spatial playback control. The full evidence inspector belongs to
    Run Explorer; the Map only selects a run and projects one bounded time
    window onto file territory. */
export function RunPlaybackControls({ view }: { view: GraphViewState }) {
  const playback = view.runPlayback;
  if (playback.summaries.length === 0) return null;
  const selected = playback.selectedRunId
    ? playback.summaries.find((summary) => summary.id === playback.selectedRunId)
    : undefined;
  const isPlayback = playback.mode === "playback" && Boolean(playback.selectedRunId);
  const range = playback.range;
  const cursor = playback.cursorAt;
  const elapsed = range && cursor !== null ? compactDuration(cursor - range.from) : "0.0s";
  const duration = range ? compactDuration(range.to - range.from) : "0.0s";
  const loadedEvents = playback.window?.events.length ?? 0;
  const totalEvents = selected?.eventCount;
  const eventReadout = totalEvents === undefined
    ? `${loadedEvents.toLocaleString()} ev`
    : `${loadedEvents.toLocaleString()}/${totalEvents.toLocaleString()} ev`;

  return (
    <section
      className={`map-panel pointer-events-auto absolute left-1/2 z-20 -translate-x-1/2 px-2 py-1.5 ${view.liveActivity.length > 0 && !isPlayback ? "top-12" : "top-3"}`}
      aria-label="Execution run playback"
      data-map-region="run-playback"
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isPlayback ? "bg-violet-300" : "bg-emerald-300"}`} aria-hidden />
        <label className="sr-only" htmlFor="map-run-selector">Execution run</label>
        <select
          id="map-run-selector"
          className="max-w-[220px] rounded border border-white/10 bg-black/50 px-1.5 py-0.5 text-xs text-foreground"
          value={isPlayback ? playback.selectedRunId ?? "" : ""}
          onChange={(event) => {
            if (event.target.value) actions.selectRun(event.target.value);
          }}
          title="Project retained run activity onto the Codebase Map"
        >
          <option value="" disabled>Live · select a run</option>
          {playback.summaries.map((summary) => (
            <option key={summary.id} value={summary.id}>
              {summary.title} · {summary.status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {isPlayback && (
          <button
            className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-white/15 hover:text-foreground"
            onClick={() => actions.exitRunPlayback()}
            title="Return to live activity"
          >
            Exit
          </button>
        )}
      </div>
      {isPlayback && range && cursor !== null && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="w-10 text-right font-mono text-2xs text-violet-200">{elapsed}</span>
          <input
            className="h-3 w-[min(260px,42vw)] accent-violet-300"
            type="range"
            min={range.from}
            max={range.to}
            step={Math.max(1, Math.floor((range.to - range.from) / 1000))}
            value={cursor}
            disabled={range.from === range.to}
            onChange={(event) => actions.seekRun(Number(event.target.value))}
            aria-label={`Run position, ${elapsed} of ${duration}`}
          />
          <span className="w-10 font-mono text-2xs text-muted-foreground">{duration}</span>
          <span
            className="whitespace-nowrap text-2xs text-muted-foreground"
            title={`${loadedEvents.toLocaleString()} events in the currently loaded bounded window${totalEvents === undefined ? "" : ` of ${totalEvents.toLocaleString()} retained events`}`}
          >
            {eventReadout}
          </span>
        </div>
      )}
    </section>
  );
}

export function HelpChip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1">
      {open && (
        <div className="mb-1 flex flex-col gap-1 rounded-md border border-border bg-black/80 px-2.5 py-2 backdrop-blur">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <kbd className="min-w-[42px] rounded border border-white/15 bg-white/5 px-1 py-0.5 text-center font-mono text-2xs text-slate-200">{key}</kbd>
              {label}
            </div>
          ))}
        </div>
      )}
      <button
        className="rounded-md border border-border bg-black/60 px-2 py-1 text-xs text-muted-foreground backdrop-blur hover:bg-white/10 hover:text-foreground"
        onClick={onToggle}
        title="Keyboard shortcuts (?)"
        aria-expanded={open}
      >
        {open ? "Hide keys" : "? Keys"}
      </button>
    </div>
  );
}

export function capacityWarning(view: GraphViewState): string {
  const parts: string[] = [];
  if (view.indexedTruncated) parts.push(`indexed cap reached (${view.indexedFileCount.toLocaleString()} files scanned)`);
  if (view.renderedTruncated) parts.push(`render cap reached (${view.renderedNodeCount.toLocaleString()} stars shown)`);
  if (view.relationshipTruncated) {
    // relationshipTruncated also fires when the *candidate* provider/consumer/
    // event/data pool was capped before cross-matching even ran (e.g. every
    // call site belongs to one service, so nothing crosses services) — in
    // that case relationshipEdgeCount can be 0, and "0 edges shown" would
    // read as nonsensical rather than as the capacity notice it's meant to be.
    parts.push(
      view.relationshipEdgeCount > 0
        ? `relationship cap reached (${view.relationshipEdgeCount.toLocaleString()} edges shown)`
        : "relationship detection capped (too many API/event/data call sites to fully cross-match)",
    );
  }
  return parts.length ? parts.join(" - ") : `Large workspace - showing ${view.nodes.length.toLocaleString()} files sampled across every folder`;
}







/** Human labels so the onboarding panel reads in plain language, not lang codes
    and marketplace ids. */
const LANG_NAMES: Record<string, string> = {
  py: "Python", go: "Go", rs: "Rust", java: "Java", cs: "C#",
  cshtml: "Razor", razor: "Blazor / Razor", c: "C", cpp: "C++",
  h: "C headers", hpp: "C++ headers", cc: "C++", cxx: "C++", hxx: "C++ headers", hh: "C++ headers",
  rb: "Ruby", php: "PHP", vue: "Vue", svelte: "Svelte",
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  dart: "Dart", kt: "Kotlin", kts: "Kotlin", scala: "Scala", sc: "Scala", lua: "Lua", ex: "Elixir", exs: "Elixir",
};
const EXTENSION_NAMES: Record<string, string> = {
  "ms-python.python": "Python",
  "golang.go": "Go",
  "rust-lang.rust-analyzer": "rust-analyzer",
  "redhat.java": "Java Language Support",
  "ms-dotnettools.csharp": "C# Dev Kit",
  "ms-vscode.cpptools": "C/C++",
  "Shopify.ruby-lsp": "Ruby LSP",
  "bmewburn.vscode-intelephense-client": "PHP Intelephense",
  "Vue.volar": "Vue (Official)",
  "svelte.svelte-vscode": "Svelte",
  "Dart-Code.dart-code": "Dart",
  "fwcd.kotlin": "Kotlin Language",
  "scalameta.metals": "Metals",
  "sumneko.lua": "Lua",
  "JakeBecker.elixir-ls": "ElixirLS",
};
const LSP_STATUS_COLOR: Record<string, string> = {
  available: "#8db4a8", limited: "#c4b08d", unknown: "#8aa6c0", missing: "#c78b94",
};
export const langLabel = (lang: string): string => LANG_NAMES[lang] ?? lang.toUpperCase();

/** Onboarding panel that explains, in plain terms, how to get richer symbol
    relationships and offers a one-click path to each fix. Dismissible +
    collapsible so it never nags. Import/include relationships work without
    any of this — only the richer symbol/reference edges need a language
    server, and only whole-repo coverage (vs. file-by-file) needs background
    indexing on top of that. */
export function LspDiagnostics({ view }: { view: GraphViewState }) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(true);
  const limited = useMemo(
    // Only languages that actually have an extension to install belong in this "install to
    // light up more" panel. The host clears `recommendation` once a language's extension is
    // installed, so an installed-but-still-warming server never surfaces here as a false nag.
    () => view.lspSupport
      .filter((item) => Boolean(item.recommendation) && (item.status === "missing" || item.status === "limited" || item.status === "unknown"))
      .slice(0, 5),
    [view.lspSupport],
  );
  // A working server for at least one language means background indexing (off by default —
  // it's the highest-cost layer) would actually have something to sweep across the repo.
  const hasWorkingLsp = useMemo(
    () => view.lspSupport.some((item) => item.status === "available" || item.status === "limited"),
    [view.lspSupport],
  );
  const showBackgroundPrompt = hasWorkingLsp && view.config.backgroundSymbols !== true;
  if (dismissed || (limited.length === 0 && !showBackgroundPrompt)) return null;
  const installable = [...new Map(limited.filter((i) => i.recommendation).map((i) => [i.recommendation!, i])).values()];
  return (
    <div className="map-panel map-lsp-panel pointer-events-auto absolute left-3 top-[178px] w-[min(310px,calc(100vw-24px))] px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <button className="flex items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)}>
          <span className="text-sm">{open ? "▾" : "▸"}</span>
          <span className="text-sm font-semibold text-foreground">Light up more relationships</span>
        </button>
        <button
          className="shrink-0 text-sm leading-none text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      {open && (
        <>
          {limited.length > 0 && (
            <>
              <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Imports and includes are mapped automatically. <strong className="text-foreground/90">Symbol-level</strong>{" "}
                links (who calls or references what) come from each language&apos;s VS Code extension. Install one to
                reveal more edges for these files:
              </div>
              <div className="mt-1.5 flex flex-col gap-1">
                {limited.map((item) => (
                  <div key={item.lang} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: LSP_STATUS_COLOR[item.status] ?? "#8a8a93" }}
                      title={item.detail}
                    />
                    <span className="text-foreground/90">{langLabel(item.lang)}</span>
                    <span className="text-muted-foreground">· {item.fileCount.toLocaleString()} files</span>
                  </div>
                ))}
              </div>
              {installable.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {installable.map((item) => (
                    <button
                      key={item.recommendation}
                      className="map-tool-button !py-0.5 flex items-center gap-1"
                      onClick={() => actions.installExtension(item.recommendation!)}
                      title={`Open ${item.recommendation} in the Extensions view`}
                    >
                      <span className="text-xs">↓</span>
                      Install {EXTENSION_NAMES[item.recommendation!] ?? langLabel(item.lang)}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-2xs text-muted-foreground">
                Then use <span className="text-foreground/80">Trace relationships</span> on a file to pull in its symbol links.
              </div>
            </>
          )}
          {showBackgroundPrompt && (
            <div className={limited.length > 0 ? "mt-2.5 border-t border-border/40 pt-2" : "mt-1.5"}>
              <div className="text-xs leading-relaxed text-muted-foreground">
                A working language server was found. Turning on{" "}
                <strong className="text-foreground/90">background indexing</strong> maps these links across the
                whole repo automatically, instead of file-by-file via Trace relationships.
              </div>
              <button
                className="map-tool-button !py-0.5 mt-1.5"
                onClick={() => actions.setBackgroundSymbols(true)}
                title="Sets blacksite.graph.backgroundSymbols — runs on an idle budget and pauses while you edit."
              >
                Enable background indexing
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
