/* Status surfaces over the Map canvas: the agent's live activity, run
   playback, the keyboard sheet, and the language-server setup panel. */

import { useMemo, useState, type CSSProperties } from "react";
import { actions } from "../store";
import { activityColor, cssColor } from "@/lib/graph/colors";
import { baseName, traceKindVerb, type GraphViewState } from "@/lib/graph/view-model";
import type { LiveActivity } from "@/lib/graph/protocol";
import { useLiveClock } from "@/lib/use-live-clock";
import { ChevronDown, ChevronRight, Download, Keyboard, X } from "lucide-react";
import { compactDuration } from "./shared";
import { MapButton, MapIconButton, MapKbd } from "./ui";

export const SHORTCUTS: Array<[string, string]> = [
  ["Drag", "Pan the map"],
  ["Wheel", "Zoom in / out"],
  ["Click", "Select a file"],
  ["Double-click", "Open the file, or step into a folded group"],
  ["/", "Search"],
  ["Enter", "Open the selection"],
  ["F", "Fit the whole map"],
  ["+ −", "Zoom in / out"],
  ["W A S D", "Pan (Shift for a bigger step)"],
  ["Backspace", "Up one scope level"],
  ["Esc", "Clear selection or search"],
];

/** What the agent is doing on the map right now, driven by in-flight tool
    calls. Click it to fly to the file. Hidden while the agent is idle. */
export function LiveActivityChip({ live, onFocus }: { live: LiveActivity[]; onFocus?: (path: string) => void }) {
  const primary = live[0]; /* host sorts most-recent-first */
  const now = useLiveClock(Boolean(primary));
  if (!primary) return null;
  const color = cssColor(activityColor(primary.kind, primary.laneId));
  const extra = live.length - 1;
  const laneCount = new Set(live.map((item) => item.laneId ?? "main")).size;
  const elapsed = Math.max(0, now - primary.at);
  return (
    <button
      type="button"
      className="map-live-chip pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2"
      style={{ "--map-live-color": color } as CSSProperties}
      onClick={() => onFocus?.(primary.path)}
      title={`${primary.laneId ? "A delegated lane" : "The agent"} is ${traceKindVerb(primary.kind).toLowerCase()} ${primary.path}${primary.detail ? ` (${primary.detail})` : ""} — click to fly there`}
      aria-live="polite"
      data-map-region="live-activity"
    >
      <span className="map-live-dot" aria-hidden />
      <span className="map-live-verb">{traceKindVerb(primary.kind)}</span>
      <span className="map-live-target">{baseName(primary.path)}</span>
      {primary.detail && <span className="map-live-extra truncate">{primary.detail}</span>}
      {extra > 0 && <span className="map-live-extra">+{extra}</span>}
      {laneCount > 1 && <span className="map-live-extra">· {laneCount} lanes</span>}
      {elapsed >= 2000 && <span className="map-live-extra font-mono tabular-nums">{compactDuration(elapsed)}</span>}
    </button>
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
      className={`map-panel pointer-events-auto absolute left-1/2 z-20 -translate-x-1/2 !px-2 !py-1.5 ${view.liveActivity.length > 0 && !isPlayback ? "top-14" : "top-3"}`}
      aria-label="Execution run playback"
      data-map-region="run-playback"
    >
      <div className="flex items-center gap-2">
        <span className="map-live-pip" style={{ background: isPlayback ? "var(--primary)" : "var(--map-live)" }} aria-hidden />
        <label className="sr-only" htmlFor="map-run-selector">Execution run</label>
        <select
          id="map-run-selector"
          className="map-search-input !min-h-[26px] max-w-[220px] !px-2 text-xs"
          value={isPlayback ? playback.selectedRunId ?? "" : ""}
          onChange={(event) => {
            if (event.target.value) actions.selectRun(event.target.value);
          }}
          title="Replay a retained Execution Run's activity on the map"
        >
          <option value="" disabled>Live · replay a run…</option>
          {playback.summaries.map((summary) => (
            <option key={summary.id} value={summary.id}>
              {summary.title} · {summary.status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {isPlayback && (
          <MapButton size="xs" variant="ghost" onClick={() => actions.exitRunPlayback()} title="Return to live activity">Exit</MapButton>
        )}
      </div>
      {isPlayback && range && cursor !== null && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-10 text-right font-mono text-2xs text-[color:var(--map-text)]">{elapsed}</span>
          <input
            className="h-3 w-[min(260px,42vw)] accent-[color:var(--primary)]"
            type="range"
            min={range.from}
            max={range.to}
            step={Math.max(1, Math.floor((range.to - range.from) / 1000))}
            value={cursor}
            disabled={range.from === range.to}
            onChange={(event) => actions.seekRun(Number(event.target.value))}
            aria-label={`Run position, ${elapsed} of ${duration}`}
          />
          <span className="w-10 font-mono text-2xs text-[color:var(--map-text-3)]">{duration}</span>
          <span
            className="whitespace-nowrap text-2xs text-[color:var(--map-text-3)]"
            title={`${loadedEvents.toLocaleString()} events in the currently loaded window${totalEvents === undefined ? "" : ` of ${totalEvents.toLocaleString()} retained events`}`}
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
    <div className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center">
      {open && (
        <div className="map-panel map-card map-help-sheet" role="dialog" aria-label="Keyboard shortcuts">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key} className="contents">
              <span className="flex justify-end"><MapKbd>{key}</MapKbd></span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="map-help-toggle" onClick={onToggle} title="Keyboard shortcuts (?)" aria-expanded={open}>
        <Keyboard className="size-3.5" aria-hidden />
        {open ? "Hide keys" : "Keys"}
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
  return parts.length ? parts.join(" · ") : `Large workspace · showing ${view.nodes.length.toLocaleString()} files sampled across every folder`;
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
    <div className="map-panel map-card map-lsp-panel pointer-events-auto absolute left-3 w-[min(300px,calc(100%-24px))] !p-0" data-map-region="lsp">
      <div className="flex items-center gap-1 py-1 pl-3 pr-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold text-[color:var(--map-text)]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5 text-[color:var(--map-text-3)]" aria-hidden /> : <ChevronRight className="size-3.5 text-[color:var(--map-text-3)]" aria-hidden />}
          <span className="truncate">Light up more relationships</span>
        </button>
        <MapIconButton icon={X} label="Dismiss" onClick={() => setDismissed(true)} />
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-[color:var(--map-line)] px-3 pb-3 pt-2">
          {limited.length > 0 && (
            <>
              <p className="map-hint !text-xs">
                Imports are mapped automatically. <span className="text-[color:var(--map-text-2)]">Symbol-level</span> links
                (who calls or references what) come from each language&apos;s extension. Install one to reveal more for:
              </p>
              <div className="flex flex-col gap-1">
                {limited.map((item) => (
                  <div key={item.lang} className="flex items-center gap-2 text-xs" title={item.detail}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LSP_STATUS_COLOR[item.status] ?? "#8a8a93" }} aria-hidden />
                    <span className="text-[color:var(--map-text-2)]">{langLabel(item.lang)}</span>
                    <span className="text-[color:var(--map-text-3)]">{item.fileCount.toLocaleString()} files</span>
                  </div>
                ))}
              </div>
              {installable.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {installable.map((item) => (
                    <MapButton
                      key={item.recommendation}
                      size="xs"
                      icon={Download}
                      onClick={() => actions.installExtension(item.recommendation!)}
                      title={`Open ${item.recommendation} in the Extensions view`}
                    >
                      {EXTENSION_NAMES[item.recommendation!] ?? langLabel(item.lang)}
                    </MapButton>
                  ))}
                </div>
              )}
              <p className="map-hint">Then use Trace relationships on a file to pull in its symbol links.</p>
            </>
          )}
          {showBackgroundPrompt && (
            <div className={limited.length > 0 ? "flex flex-col gap-1.5 border-t border-[color:var(--map-line)] pt-2" : "flex flex-col gap-1.5"}>
              <p className="map-hint !text-xs">
                A working language server was found. <span className="text-[color:var(--map-text-2)]">Background indexing</span> maps
                these links across the whole repo instead of file by file.
              </p>
              <MapButton
                size="xs"
                className="self-start"
                onClick={() => actions.setBackgroundSymbols(true)}
                title="Sets blacksite.graph.backgroundSymbols — runs on an idle budget and pauses while you edit."
              >
                Enable background indexing
              </MapButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
