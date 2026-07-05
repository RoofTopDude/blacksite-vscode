# Codebase Map — Design & Architecture

Status: shipped · Owner: Blacksite VS Code extension · View id: `blacksite.map`

The Codebase Map is a WebGL "star-map" of the workspace: every file is a star,
imports are the lines between them, folders are constellations, and the agent's
live activity ripples across it in real time. This doc explains how the whole
thing is wired and documents the four lenses layered on top of the base map:
**cluster collapse / expand-all**, the **git heat layer**, **service
relationships**, and **focus filtering** - plus the render-loop polish
(animated emphasis) they share.

---

## 1. The big picture

```text
 EXTENSION HOST (node)                         WEBVIEW (React + pixi, sandboxed)
 ─────────────────────                         ────────────────────────────────
 GraphIndexer ──enumerate files                store.ts  (useSyncExternalStore)
   ├─ scan imports                                  │  applyMessage(view, msg)
   ├─ d3-force layout                               │  actions.* → post()
   ├─ collectGitStats (git log)                     ▼
   └─ cache .blacksite/graph-cache.json         view-model.ts  (pure reducer)
        │                                           │  deriveDisplayGraph
        ▼                                           │  visibleNodeIds / gitHeatStats
 GraphProvider (WebviewViewProvider)                ▼
   ├─ _postState  ──── graph_state ───────▶     GraphApp.tsx  (HTML overlays)
   ├─ trace_batch / live_activity ───────▶         │
   ├─ symbols_state (lazy LSP) ──────────▶         ▼
   └─ onDidReceiveMessage ◀── ready / open /     PixiStage → renderer.ts
        rebuild / expand_symbols / ...             (non-React pixi scene)
```

**Host** owns all derived *data* (files, imports, layout positions, git stats)
and streams it to the webview as messages. It never sends UI state.

**Webview** owns all *view* state (selection, camera, collapse/filter/display
toggles) and rendering. It's split three ways:

- `view-model.ts` — a pure, unit-tested reducer + selectors. No DOM, no pixi.
- `store.ts` — a single module-level store; dispatches host messages through
  `applyMessage`, exposes `actions.*`, persists prefs to `localStorage`.
- `GraphApp.tsx` / `renderer.ts` — React draws the HTML overlays (panels,
  labels, search); `renderer.ts` owns the pixi WebGL scene. React only mounts
  the canvas and streams `view` in via `PixiStage`.

### Message contract

`lib/graph/protocol.ts` is the single source of truth for message shapes;
`graph-provider.ts` mirrors them (hand-typed per repo convention). Host→webview:
`graph_state`, `graph_indexing`, `annotations_changed`, `trace_batch`,
`live_activity`, `graph_config`, `symbols_state`. Webview→host: `ready`,
`refresh`, `rebuild_index`, `open_file`, `remove_annotation`, `expand_symbols`,
`collapse_symbols`.

---

## 2. Data model

`lib/graph/protocol.ts` (webview) and `graph/graph-model.ts` (host) define the
same node/edge shapes.

```ts
interface GraphNode {
  id: string;          // workspace-relative path, forward slashes; folder-qualified in multi-root
  dir: string;         // cluster key (adaptive: 1–6 path segments — see assignClusters)
  lang: string;        // extension bucket ("ts", "py", "css", …)
  sizeBytes: number;
  inDegree, outDegree: number;   // import fan-in / fan-out
  x, y: number;        // world-space layout position (from d3-force)
  z: number;           // depth cue in [0,1], log-scaled degree → star brightness

  // Git heat layer (host-attached; absent when not a git repo):
  churn?: number;         // commits in the recent window touching this file
  lastCommitAt?: number;  // epoch seconds of its most recent commit

  // Cluster/service super-nodes (webview-derived only; never sent by the host):
  kind?: "file" | "cluster" | "service";
  fileCount?: number;     // files a collapsed super-node stands in for
}

interface GraphEdge {
  id; from; to;
  kind: "import" | "ai" | "user" | "api" | "event" | "data" | "config";
  serviceFrom?, serviceTo?, label?, detail?, confidence?, evidence?;
}
```

### The display graph — the central pattern

The renderer never draws `view.nodes` / `view.edges` directly. It draws
`view.displayNodes` / `view.displayEdges`, a **derived** graph produced by
`deriveDisplayGraph(nodes, edges, collapsedClusters)`:

- Nothing collapsed → returns the input arrays *by reference* (zero cost, the
  renderer's `structureChanged` check short-circuits).
- Some clusters collapsed → files in those clusters are replaced by one
  synthetic super-node each; import edges are remapped onto whichever endpoint
  is visible.

Raw `nodes`/`edges` stay intact because trace/live-activity lookups key off
real file paths, and the host reconciles against real ids. Everything that
*draws or positions* reads the display graph; everything about true counts,
search, and file identity reads the raw graph. This split is what lets three
independent lenses coexist without fighting.

---

## 3. Host indexing pipeline

`graph/graph-indexer.ts`, `_rebuildOnce()`:

1. **Enumerate** — `vscode.workspace.findFiles` per root, excluding
   `node_modules/.git/dist/out/build/...`, filtered to code + docs/config
   extensions. If the true count exceeds `maxNodes` (default 4000),
   `sampleAcrossClusters` takes files round-robin across folders so deep
   subtrees aren't starved by an early-alphabet one.
2. **Scan imports** — regex import extraction (`import-scan.ts`) + specifier
   resolution against the file set (`resolve-imports.ts`) → in/out degree per
   file. Resolution runs against a **`ResolveContext`** built once per rebuild
   (`_buildResolveContext`): a basename index (Razor partials, Java FQCNs),
   tsconfig/jsconfig `paths`+`baseUrl` aliases (`tsconfig-paths.ts`, so
   `@app/*` / `~/lib/*` / baseUrl imports become real edges instead of dead
   ends), and `go.mod` module prefixes (`go-modules.ts`). Most specifiers name
   one file; a Go package import fans out to every source file in its
   directory, so the indexer resolves through `resolveSpecifierTargets` (a
   list) rather than the single-file `resolveSpecifier`. The same file set also
   feeds `relationship-indexer.ts`, which detects service-to-service API,
   event, data, and config edges from route providers/consumers and evidence
   snippets. Per-language coverage:
   TS/JS (relative + aliases), Vue/Svelte, Python (dotted + submodules), CSS/
   SCSS, C/C++ includes, Rust `mod`, Ruby, PHP, Go, Java, HTML assets, Razor/
   Blazor views, and Markdown doc-links (`doc-links.ts`).
3. **Cluster** — `assignClusters` adaptively splits any folder bigger than ~40
   files one path-segment deeper, so a giant package doesn't render as one blob.
4. **Git stats** — `_collectGit()` → `collectGitStats` per root (§5).
5. **Layout** — seeded d3-force (`graph/layout.ts`), ticked in chunks to stay
   responsive; previous positions seed the next run so the map is stable across
   re-indexes.
6. **Cache** — written to `.blacksite/graph-cache.json` (`schemaVersion`,
   currently **3**; a bump discards older caches so stale-but-"complete" data
   never suppresses a rebuild). Incremental edits (`_applyDirty`) rescan only
   dirty files; past ~10% churn it triggers a full rebuild.

A `FileSystemWatcher` drives debounced incremental updates; config changes and
folder add/remove re-push or rebuild.

---

## 4. Feature: cluster collapse / expand-all

**Goal:** on a big map, collapse folders into single super-nodes to read
structure at the folder level, then expand back to full file-to-file relations
on demand.

### Model (`view-model.ts`)

- State: `collapsedClusters: string[]` (dirs currently collapsed; empty = full
  file view, the default). `displayNodes` / `displayEdges` are derived from it.
- `deriveDisplayGraph`:
  - Each collapsed dir → one super-node at its members' **centroid**,
    `id = "▤" + dir` (the `▤` prefix can't start a real path), `kind:"cluster"`,
    `fileCount` = member count, `sizeBytes` summed, degree bounded so the star
    is big but within `graphNodeRadius`'s cap. Git churn is summed and
    `lastCommitAt` takes the max across members, so collapsed clusters still
    show heat.
  - Import edges are remapped: an endpoint in a collapsed cluster becomes the
    super-node id. Edges wholly inside one collapsed cluster are dropped;
    parallel remapped edges are merged.
- Mutations: `setClusterCollapsed(state, dir, on)`, `collapseAllClusters`,
  `expandAllClusters`, each re-running `withDisplayGraph`. On a fresh
  `graph_state`, collapsed dirs that no longer exist are pruned.

### Interaction

- **Toolbar → Clusters**: `Collapse` (every folder → super-node), `Expand all`
  (back to files), plus a live "N collapsed" hint.
- **Double-click a super-node** → `actions.activateNode` detects a cluster id and
  expands just that one (renderer's `onOpen` callback; a real file id opens the
  file instead).
- **Single-click** → selects, showing a `ClusterCard` (file count, crossing
  imports, git summary, Expand button).
- **Search stays over the raw file set**, so a file inside a collapsed cluster is
  still findable; picking it calls `flyToNode`, which auto-expands the
  containing cluster (deferred via `pendingFocusRef` until the node lands in
  `displayNodes`), then flies the camera to it. Follow-agent does the same.

---

## 5. Feature: git heat layer

**Goal:** turn the structural map into a "where is the work happening" map by
coloring recency and sizing churn.

### Host collection (`graph/git-log.ts`)

- `collectGitStats(rootPath)`:
  1. `git rev-parse --show-toplevel` to find the repo root (handles a workspace
     folder nested inside a larger repo, and multi-root).
  2. `git -c core.quotePath=false log -n 4000 --no-renames --no-merges
     --format=commit:%ct --name-only` — bounded to 4000 commits so it's fast and
     fits the 64 MB buffer.
  3. `parseGitLog(stdout)` (pure, unit-tested) aggregates per repo-relative path:
     `churn` = number of touching commits, `lastAt` = max commit epoch. Tolerant
     of git's blank-line interleaving; a `commit:<int>` marker can't collide with
     a path.
  4. Repo-relative paths are resolved to absolute and normalized
     (`normalizeAbsPath` — forward slashes, lowercased on win32 for case-
     insensitive matching against vscode paths).
- **Degrades to an empty map** on any failure (git absent, not a repo, timeout,
  oversized output). The indexer keys results by normalized absolute path and
  attaches `churn` / `lastCommitAt` to each node.

### Webview encoding (`renderer.ts`, `colors.ts`)

Toggled by the `showGitHeat` display option (Layers → "Git heat", off by
default). On each structural rebuild the renderer computes `gitHeatStats`
(max churn, oldest/newest commit) over the displayed nodes, then per node:

- **Tint** — `nodeBaseTint`: `mixColors(folderColor, GIT_WARM_COLOR,
  recencyFraction(lastCommitAt, oldest, newest) * 0.85)`. Recency is a *relative*
  spread over the visible commit-time range, so contrast holds whether the repo
  was last touched an hour or a year ago. No git data → stays the folder hue.
- **Size** — `applyNodeScales` multiplies the sprite scale by
  `1 + churnFraction(churn, maxChurn) * 0.7` (log-scaled).

The base tint lands in `baseTintById`, which the activity-trace pass modulates
*from* — so git heat and the agent's live activity coloring coexist rather than
overwrite each other. Node/cluster cards show `N recent commits · last 3d ago`;
a legend gradient + "No git history found" hint appear when the lens is on.

---

## 6. Feature: service relationships

**Goal:** collapse file-level detections into an operational service map: which
folders expose APIs, which callers consume them, and how strong the evidence is.

### Host collection (`relationship-indexer.ts`)

- Route providers and consumers are scanned from the indexed source files, then
  merged into `GraphEdge` records with `kind: "api" | "event" | "data" |
  "config"`.
- Edges carry `serviceFrom` / `serviceTo` folder ids, optional source/target
  file paths, a human label/detail, `confidence` in `[0,1]`, and short
  `evidence` strings. The webview uses those fields directly; no extra lookup
  is needed after a `graph_state` message arrives.

### Webview model and rendering

- `display.lens === "services"` switches `deriveDisplayGraph` into
  `deriveServiceGraph`: visible relationship edges synthesize `kind:"service"`
  nodes at each service centroid and remap edges onto those nodes.
- Layer toggles gate relationship families independently: APIs, Events, Data,
  and Config. The Services button is disabled until the host reports at least
  one relationship edge.
- `renderer.ts` draws service edges with `RELATIONSHIP_EDGE_COLORS`; stroke
  alpha/width scale by `confidence`, so tentative detections read faint and
  high-confidence links read solid. Import edges stay batched separately, so
  service arcs are not restroked as file-import lines.
- `GraphApp.tsx` adds a service legend, selected-edge labels for service arcs,
  and a `ServiceCard` showing inbound/outbound direction, peer service,
  confidence meter, evidence chips, and consumer/provider open-file actions.

---

## 7. Feature: focus filtering

**Goal:** narrow the field by language, connectivity, or neighborhood — without
losing the map's overall shape.

### Model (`view-model.ts`)

```ts
interface GraphFilter {
  langs: string[];       // active language buckets; empty = all
  minDegree: number;     // hide files below this in+out degree; 0 = off
  isolateDepth: number;  // with a selection, show only within N hops; 0 = off
}
```

- `visibleNodeIds(nodes, edges, annotations, filter, selectedId)` returns the
  set of ids that pass, or **null** when nothing is active (the renderer's
  "everything visible" fast path). Base lang/degree gates first; then, if
  isolate is on, intersect with `nodesWithinHops` (undirected BFS over
  imports + annotations from the selection). Cluster super-nodes bypass the
  lang/degree gates (they aggregate mixed files); the current selection is
  always kept visible so its card never dangles over a hidden star.
- `filterIsActive` treats isolate as inactive without a selection.
- `languageCounts` feeds the chips (present langs, ranked, clusters skipped).

### Rendering — ghost, don't remove

Filtered-out stars are **ghosted** (dimmed to `GHOST_ALPHA`), not deleted, so the
nebula/shape stays legible. `applyEmphasis` sets a ghost target for anything
outside `visibleIds` (unless it's hovered — hover peeks through). `drawEdges` and
`drawFocusEdges` cull edges into ghosts so filtering doesn't leave dangling
wires.

### Interaction

- **Toolbar → Filter**: language chips (toggle), a "Min links" stepper, and a
  `Clear` that appears when anything's active.
- **Node card → Isolate**: `Off / 1 / 2 / 3` hop buttons, rooted at the
  selection. Deselecting auto-clears isolate (`select` action) so the map never
  stays mysteriously filtered with nothing selected.

---

## 8. Rendering pipeline & the shared polish

`renderer.ts` owns a non-React pixi `Application`. Notable bits:

- **CSP** — VS Code webviews forbid `unsafe-eval`; `import "pixi.js/unsafe-eval"`
  swaps in eval-free polyfills before the app is constructed, or `app.init()`
  rejects on every real host.
- **Scene layers** (back to front): parallax starfields + nebulae → cluster
  edges → import edges → focus (spotlight) edges → symbol relations → annotations
  → traces → node sprites → symbol sprites → focus ring → live-activity rings.
- **CPU discipline** — the ticker is FPS-capped (40) and stops entirely when the
  document is hidden; under `prefers-reduced-motion` it also goes fully idle when
  nothing is animating.
- **Camera** — zoom floor derived from zoom-to-fit (huge maps must fit whole);
  auto-fits an untouched camera; flies back if a re-index moves content out from
  under a positioned camera. Covered by `graph-canvas-navigation.spec.ts`.

### Agent trace lanes

Trace events carry an optional `laneId` from delegated subagents. The trace
model derives streak edges per lane, never across lanes, and live activity uses
lane-qualified operation keys so concurrent subagents cannot clear each other's
in-flight markers. The parent agent keeps activity-kind colors (read/write/edit);
subagent lanes get deterministic colors from `agentLaneColor(laneId)`. Chat lane
cards and Map traces use the same helper, so a user can correlate a subagent in
the transcript with its heat, streaks, and live rings on the map.

### The motion pass (the fluidity all lenses share)

`motionPass(now)` is the single per-frame writer of sprite alpha, position, and
scale. Everything else only sets *targets*: `applyEmphasis` → `baseAlphaById`,
`applyNodeScales` → `baseScaleById`, the layout → `node.x/y`. The pass eases
live values toward those targets (pure helpers in `lib/graph/motion.ts`:
`approach`, `approachPoint`, `easeOutCubic`, `spawnOrigin`). Consequences:

- **Stars fly, never teleport.** Layout changes glide into place; expanding a
  cluster blooms its files outward from the super-node they were folded into
  (`spawnOrigin` resolves the fly-from point against the previous display
  graph), and collapsing reads as files gathering into one star.
- **Birth pop + fade-in** — genuinely-new sprites scale up with an ease-out
  (`BIRTH_MS`) and rise from alpha 0; existing sprites keep their live values,
  so a re-index never re-animates the whole field.
- **Eased hover** — the hover pop is a spring (`hoverLevelById`), not a snap;
  zoom-driven scale changes still track instantly because zoom updates the
  *target* and the multiplier sits on top.
- **Edge reveal** — the static edge/annotation/relation layers are drawn at
  target positions, so while stars are in flight those layers dip to
  `EDGE_REVEAL_DIM` and breathe back in on arrival, instead of showing wires
  anchored to empty space mid-morph.
- **Living focus** — while a node is hovered/selected the focus ring breathes
  with two orbiting arc accents and the spotlight edges carry slow outward
  pulses, redrawn per frame (incident edges only, capped). Dynamic overlays
  (focus, live rings, traces) read `posOf()` — the live position — so they
  track stars in flight.
- `prefers-reduced-motion` snaps everything to target immediately (no flight,
  no birth, static ring), and the pass reports whether anything is still
  settling so the ticker stays awake only while needed.

The HTML overlay mirrors this in CSS (`theme.css` "Map fluidity polish"): node/
cluster cards rise in (keyed by node id so switching selection replays the
entrance), the live chip drops in, controls get micro-transitions, and all of it
is disabled under reduced motion.

---

## 9. Persistence

`store.ts` persists to webview `localStorage`:

- `blacksite.map.display` — `display` options, `symbolsEnabled`,
  `collapsedClusters`, `filter`. (Search is deliberately excluded so a stale
  filter from a past session doesn't silently dim a different browsing session.)
- `blacksite.map.camera` — camera position, trailing-debounced (300 ms) so a
  pan gesture doesn't thrash `localStorage`.

Host config (`blacksite.graph.*`): `traceFadeSeconds`, `maxNodes`,
`traceShellEvents`.

---

## 10. File map

| Concern | File |
| --- | --- |
| Pure model, display graph, filter/git selectors | `src/webview/react/lib/graph/view-model.ts` |
| Message shapes | `src/webview/react/lib/graph/protocol.ts` |
| Colors + git heat fractions | `src/webview/react/lib/graph/colors.ts` |
| Store + actions + persistence | `src/webview/react/apps/graph/store.ts` |
| HTML overlays (panels, cards, controls, legend) | `src/webview/react/apps/graph/GraphApp.tsx` |
| pixi scene + emphasis/animation | `src/webview/react/apps/graph/scene/renderer.ts` |
| Host indexer + git wiring | `src/graph/graph-indexer.ts` |
| Import extraction (regex, per language) | `src/graph/import-scan.ts` |
| Specifier → file resolution + `ResolveContext` | `src/graph/resolve-imports.ts` |
| tsconfig/jsconfig path-alias resolution | `src/graph/tsconfig-paths.ts` |
| go.mod module-path resolution | `src/graph/go-modules.ts` |
| Markdown doc → code link resolution | `src/graph/doc-links.ts` |
| Git log collection + parser | `src/graph/git-log.ts` |
| Host model | `src/graph/graph-model.ts` |
| Force layout | `src/graph/layout.ts` |
| Provider (host↔webview) | `src/graph-provider.ts` |
| Tests | `tests/unit/graph-*.spec.ts` |

---

## 10. Staged next: history playback

The one enhancement not yet built. Traces are currently **ephemeral** (buffered
briefly, fade-pruned by `traceFadeSeconds`). A playback scrubber needs:

1. Host-side **retained** trace buffering (a bounded ring keyed by timestamp).
2. A protocol message to fetch a time window on demand.
3. A timeline UI + a renderer replay mode that drives the existing trace/heat
   animation from a scrubbed clock instead of `Date.now()`.

The display-graph and emphasis-easing patterns above are the seams it should
build on.
